#!/usr/bin/env node
// Zips extension/ and extension-firefox/ into versioned archives ready to
// upload to the Chrome Web Store Developer Dashboard and Firefox Add-on
// Developer Hub (see documentation/STORE_LISTING.md for the submission
// steps that consume these files).
//
// Run after bumping the "version" field in both manifest.json files and
// after `npm run sync:firefox-extension`:
//   node scripts/package-extension.js
//
// Shells out to the system `zip` binary (present by default on macOS and
// Linux; on Windows, use WSL or Git Bash) rather than adding a zip library
// dependency for a one-off release script.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Dev-only files that don't belong in a store upload. zip's -x patterns
// match the full path stored in the archive, so match at any depth.
const EXCLUDE = ['create-icons.html', '*/create-icons.html', '.DS_Store', '*/.DS_Store'];

const TARGETS = [
  { name: 'chrome', dir: 'extension' },
  { name: 'firefox', dir: 'extension-firefox' },
];

function readVersion(dir) {
  const manifestPath = path.join(ROOT, dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.version;
}

function packageTarget({ name, dir }) {
  const version = readVersion(dir);
  const srcDir = path.join(ROOT, dir);
  const zipName = `stash-${name}-v${version}.zip`;
  const zipPath = path.join(DIST, zipName);

  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const args = ['-r', '-X', zipPath, '.'];
  for (const pattern of EXCLUDE) args.push('-x', pattern);

  execFileSync('zip', args, { cwd: srcDir, stdio: 'inherit' });
  console.log(`Wrote ${path.relative(ROOT, zipPath)}`);
}

fs.mkdirSync(DIST, { recursive: true });

try {
  for (const target of TARGETS) packageTarget(target);
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('\nThe `zip` command was not found on this system.');
    console.error('macOS/Linux ship it by default; on Windows, run this from WSL or Git Bash.');
    process.exit(1);
  }
  throw err;
}
