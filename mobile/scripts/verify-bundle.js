#!/usr/bin/env node
// Checks that a built native app really contains the Stash web client.
//
// `gradlew assembleDebug` and `xcodebuild build` both succeed on an app whose
// WebView would open to a blank screen: a missing asset, a half-copied www/, a
// CDN script that never got vendored. This script is what turns those builds
// into a test. CI extracts the shipped bundle (assets/public/ from the APK,
// App.app/public/ from the .app) and points this at it.
//
// The expectation is derived from web/ and from build-www.js's own rules
// rather than restated as a list, so a file added to the web client is
// automatically required in the native builds too — no second inventory to
// keep in step.
//
//   node scripts/verify-bundle.js <dir>

'use strict';

const fs = require('fs');
const path = require('path');

const { EXCLUDED, VENDORED, VENDOR_DIR } = require('./build-www.js');

const WEB = path.join(__dirname, '..', '..', 'web');

// Every path (relative, POSIX-style) the bundle must contain: all of web/
// minus what build-www drops, plus the vendored copies of the scripts that
// used to come from a CDN.
function expectedFiles(webDir = WEB) {
  const files = [];

  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && EXCLUDED.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  })(webDir, '');

  for (const asset of VENDORED) {
    // Sentry is optional (build-www drops it rather than failing when the
    // download is unavailable), so it is not required to be present.
    if (asset.required) files.push(`${VENDOR_DIR}/${asset.file}`);
  }

  return files;
}

// Files that must NOT be in a native bundle, with the reason, so a regression
// in build-www is reported as more than "unexpected file".
const FORBIDDEN = {
  'sw.js': 'the Service Worker is web-only — a native bundle must not register one',
  'manifest.json': 'the PWA manifest is replaced by Info.plist / AndroidManifest.xml',
};

// Returns { missing, forbidden, indexRefsCdn } — all empty on a good bundle.
function verifyBundle(dir) {
  const missing = expectedFiles().filter((file) => !fs.existsSync(path.join(dir, ...file.split('/'))));
  const forbidden = Object.keys(FORBIDDEN).filter((file) => fs.existsSync(path.join(dir, file)));

  // The app must not need the network to boot: no CDN <script> may survive in
  // the shipped HTML.
  const indexRefsCdn = [];
  for (const page of ['index.html', 'save.html']) {
    const file = path.join(dir, page);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    for (const asset of VENDORED) {
      if (html.includes(asset.src)) indexRefsCdn.push(`${page} -> ${asset.src}`);
    }
  }

  return { missing, forbidden, indexRefsCdn };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/verify-bundle.js <bundled-assets-dir>');
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    console.error(`verify-bundle: ${dir} does not exist — the build produced no web assets`);
    process.exit(1);
  }

  const { missing, forbidden, indexRefsCdn } = verifyBundle(dir);
  let failed = false;

  for (const file of missing) {
    console.error(`missing from the built app: ${file}`);
    failed = true;
  }
  for (const file of forbidden) {
    console.error(`should not be in the built app: ${file} — ${FORBIDDEN[file]}`);
    failed = true;
  }
  for (const ref of indexRefsCdn) {
    console.error(`built app still loads a script over the network: ${ref}`);
    failed = true;
  }

  if (failed) process.exit(1);
  console.log(`verify-bundle: ${expectedFiles().length} expected files present in ${dir}`);
}

if (require.main === module) main();

module.exports = { expectedFiles, verifyBundle, FORBIDDEN };
