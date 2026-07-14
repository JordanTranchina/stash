/**
 * Unit tests for the Firefox build of the extension (extension-firefox/).
 *
 * extension-firefox/ mirrors extension/ (the Chrome build) file-for-file
 * except for manifest.json, which is intentionally different: Firefox's MV3
 * background runs as a non-worker event page (background.scripts) rather
 * than a service_worker, and needs browser_specific_settings.gecko.id.
 * Everything else is kept in sync via scripts/sync-firefox-extension.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CHROME_DIR = path.join(__dirname, '..', '..', 'extension');
const FIREFOX_DIR = path.join(__dirname, '..', '..', 'extension-firefox');

const firefoxManifest = JSON.parse(
  fs.readFileSync(path.join(FIREFOX_DIR, 'manifest.json'), 'utf8')
);

describe('extension-firefox/manifest.json', () => {
  test('is manifest v3', () => {
    expect(firefoxManifest.manifest_version).toBe(3);
  });

  test('declares a Firefox add-on ID', () => {
    expect(firefoxManifest.browser_specific_settings?.gecko?.id).toEqual(
      expect.stringMatching(/^.+@.+$/)
    );
  });

  test('uses a background event page (scripts), not a service_worker', () => {
    expect(firefoxManifest.background.service_worker).toBeUndefined();
    expect(firefoxManifest.background.scripts).toEqual(
      expect.arrayContaining(['config.js', 'supabase.js', 'background.js'])
    );
  });

  test('requests the scripting permission needed by chrome.scripting.executeScript', () => {
    expect(firefoxManifest.permissions).toContain('scripting');
  });

  test('registers the same content scripts as the Chrome build', () => {
    const chromeManifest = JSON.parse(
      fs.readFileSync(path.join(CHROME_DIR, 'manifest.json'), 'utf8')
    );
    expect(firefoxManifest.content_scripts).toEqual(chromeManifest.content_scripts);
  });
});

describe('shared files between extension/ and extension-firefox/', () => {
  const sharedFiles = [
    'Readability.js',
    'background.js',
    'content.js',
    'config.js',
    'popup.css',
    'popup.html',
    'popup.js',
    'supabase.js',
  ];

  test.each(sharedFiles)('%s is byte-for-byte identical (run `npm run sync:firefox-extension`)', (file) => {
    const chromeContents = fs.readFileSync(path.join(CHROME_DIR, file));
    const firefoxContents = fs.readFileSync(path.join(FIREFOX_DIR, file));
    expect(firefoxContents.equals(chromeContents)).toBe(true);
  });
});

describe('extension/background.js', () => {
  test('guards importScripts so the same file works as a Firefox event page', () => {
    const source = fs.readFileSync(path.join(CHROME_DIR, 'background.js'), 'utf8');
    expect(source).toMatch(/typeof importScripts === 'function'/);
  });
});
