#!/usr/bin/env node
// Copies the browser-agnostic extension files from extension/ into
// extension-firefox/, keeping the two builds' shared logic in sync.
//
// extension/manifest.json (Chrome, MV3 service worker) and
// extension-firefox/manifest.json (Firefox, MV3 event page) are
// intentionally different and are never touched by this script.
//
// icons/ is skipped too: ImgBot optimizes the two copies independently, so
// copying one over the other silently reverts whichever was compressed more
// recently. The icons are identical artwork; only their byte size diverges.
//
// Run after changing anything under extension/ other than manifest.json:
//   node scripts/sync-firefox-extension.js

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'extension');
const DEST = path.join(__dirname, '..', 'extension-firefox');

const SKIP = new Set(['manifest.json', 'icons']);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(SRC, DEST);
console.log(`Synced shared extension files from ${SRC} to ${DEST}`);
