#!/usr/bin/env node
// Builds mobile/www — the web assets the native iOS and Android shells load —
// out of web/, the same directory the PWA is deployed from.
//
// This is a copy, not a fork: every behavioural difference between the native
// apps and the PWA lives at runtime in web/platform.js, so the files here stay
// byte-identical to the deployed ones except for two mechanical rewrites:
//
//   1. The Service Worker is left out. A native build's assets are already on
//      disk; a worker would only add a stale second copy of the app shell.
//   2. The three CDN <script> tags are vendored into www/vendor/ and rewritten
//      to point there. A native app has to open — and open offline — before it
//      has ever seen the network, which a CDN-hosted Supabase client can't do.
//
// Run from mobile/: `npm run build` (or `npm run sync`, which also runs the
// native overlays and `cap sync`).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const WWW = path.join(__dirname, '..', 'www');
const VENDOR_DIR = 'vendor';

// Files in web/ that have no meaning inside a native shell.
//   sw.js          — see (1) above.
//   manifest.json  — PWA install/share-target metadata; the native apps get
//                    both from their own manifests (Info.plist,
//                    AndroidManifest.xml).
//   bookmarklet.html / auth-popup.html — desktop-browser install surfaces.
const EXCLUDED = new Set(['sw.js', 'manifest.json', 'bookmarklet.html', 'auth-popup.html', '.gitignore']);

// Third-party scripts that must be on disk for a cold, offline launch. Keyed
// by the exact src in web/*.html so a CDN bump upstream fails loudly here
// (missing rewrite -> the assertion at the end of rewriteHtml) instead of
// silently shipping an app that needs the network to start.
const VENDORED = [
  {
    src: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    file: 'supabase.js',
    required: true,
  },
  {
    src: 'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
    file: 'marked.min.js',
    required: true,
  },
  {
    // Error reporting only: the app is fully usable without it, so a failed
    // download degrades to "no Sentry in this build" rather than failing.
    src: 'https://browser.sentry-cdn.com/10.69.0/bundle.min.js',
    file: 'sentry.min.js',
    required: false,
  },
];

// Point every vendored <script> at its local copy. `available` is the set of
// files that actually downloaded; a vendored script that didn't is dropped
// rather than left pointing at a CDN the app may not be able to reach.
function rewriteHtml(html, available) {
  let out = html;
  for (const asset of VENDORED) {
    const tag = new RegExp(`\\s*<script[^>]*src="${escapeRegExp(asset.src)}"[^>]*></script>`, 'g');
    if (available.has(asset.file)) {
      out = out.replace(tag, `\n  <script src="${VENDOR_DIR}/${asset.file}"></script>`);
    } else {
      out = out.replace(tag, '');
    }
  }

  // The PWA manifest isn't copied into the bundle, so drop the link rather
  // than shipping a 404 on every launch.
  out = out.replace(/\s*<link rel="manifest"[^>]*>/g, '');

  for (const asset of VENDORED) {
    if (out.includes(asset.src)) {
      throw new Error(
        `build-www: ${asset.src} is still referenced after rewriting. ` +
        'Its <script> tag in web/ probably changed shape — update VENDORED in this script.'
      );
    }
  }
  return out;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Which files get the HTML rewrite. Everything else is copied verbatim.
function isHtml(file) {
  return file.endsWith('.html');
}

function copyTree(src, dest, { relative = '' } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!relative && EXCLUDED.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to, { relative: path.join(relative, entry.name) });
    else fs.copyFileSync(from, to);
  }
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) throw new Error(`empty response for ${url}`);
  fs.writeFileSync(destPath, body);
}

async function vendorAssets() {
  const dir = path.join(WWW, VENDOR_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const available = new Set();

  for (const asset of VENDORED) {
    const dest = path.join(dir, asset.file);
    try {
      await download(asset.src, dest);
      available.add(asset.file);
      console.log(`  vendored ${asset.file}`);
    } catch (err) {
      if (asset.required) {
        throw new Error(
          `build-www: could not vendor ${asset.src} (${err.message}). ` +
          'The native app cannot start offline without it.'
        );
      }
      console.warn(`  skipped ${asset.file}: ${err.message}`);
    }
  }
  return available;
}

async function build() {
  fs.rmSync(WWW, { recursive: true, force: true });
  copyTree(WEB, WWW);
  console.log(`Copied web/ -> ${path.relative(ROOT, WWW)}`);

  const available = await vendorAssets();

  for (const entry of fs.readdirSync(WWW, { withFileTypes: true })) {
    if (!entry.isFile() || !isHtml(entry.name)) continue;
    const file = path.join(WWW, entry.name);
    fs.writeFileSync(file, rewriteHtml(fs.readFileSync(file, 'utf8'), available));
  }
  console.log('Rewrote CDN script tags to local vendor copies');
}

if (require.main === module) {
  build().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { EXCLUDED, VENDORED, VENDOR_DIR, rewriteHtml, build };
