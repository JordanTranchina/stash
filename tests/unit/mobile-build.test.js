/**
 * Unit tests for the mobile/ build scripts — the two mechanical rewrites that
 * turn web/ into the native apps' bundled assets, and the overlays that
 * re-apply Stash's native customizations to the generated Capacitor projects.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const build = require('../../mobile/scripts/build-www.js');
const overlays = require('../../mobile/scripts/apply-native-overlays.js');

const WEB = path.join(__dirname, '..', '..', 'web');
const allVendored = new Set(build.VENDORED.map((asset) => asset.file));

function readWeb(file) {
  return fs.readFileSync(path.join(WEB, file), 'utf8');
}

describe('build-www rewrites the real web/ pages', () => {
  // index.html and save.html are the two pages the native shells load; if a
  // CDN <script> in either one ever changes shape, rewriteHtml throws rather
  // than silently shipping an app that needs the network to start.
  for (const page of ['index.html', 'save.html']) {
    test(`${page}: every CDN script becomes a local vendor copy`, () => {
      const out = build.rewriteHtml(readWeb(page), allVendored);

      for (const asset of build.VENDORED) {
        expect(out).not.toContain(asset.src);
      }
      expect(out).toContain('<script src="vendor/supabase.js"></script>');
      expect(out).toContain('<script src="vendor/sentry.min.js"></script>');
      // The app's own scripts are untouched — same files, same order.
      expect(out).toContain('<script src="platform.js"></script>');
      expect(out).toContain('<script src="save-lib.js"></script>');
    });
  }

  test('index.html: marked is vendored too and the PWA manifest link is dropped', () => {
    const out = build.rewriteHtml(readWeb('index.html'), allVendored);
    expect(out).toContain('<script src="vendor/marked.min.js"></script>');
    expect(out).not.toContain('rel="manifest"');
  });

  test('an asset that failed to download is dropped, not left pointing at a CDN', () => {
    const available = new Set(['supabase.js', 'marked.min.js']); // Sentry missing
    const out = build.rewriteHtml(readWeb('index.html'), available);
    expect(out).not.toContain('sentry-cdn.com');
    expect(out).not.toContain('vendor/sentry.min.js');
    expect(out).toContain('vendor/supabase.js');
  });

  test('a CDN tag that no longer matches fails the build loudly', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>';
    // Simulate the rewrite missing it by leaving a second, differently-quoted copy.
    const drifted = `${html}\n<script src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'></script>`;
    expect(() => build.rewriteHtml(drifted, allVendored)).toThrow(/still referenced/);
  });

  test('the Service Worker and PWA manifest are excluded from the native bundle', () => {
    expect(build.EXCLUDED.has('sw.js')).toBe(true);
    expect(build.EXCLUDED.has('manifest.json')).toBe(true);
  });

  test('every shared file the app needs at runtime is copied, not excluded', () => {
    for (const file of ['app.js', 'platform.js', 'save-lib.js', 'db.js', 'config.js', 'styles.css']) {
      expect(build.EXCLUDED.has(file)).toBe(false);
    }
  });
});

describe('Android manifest overlay', () => {
  const FILTERS = fs.readFileSync(
    path.join(__dirname, '..', '..', 'mobile', 'native', 'android', 'intent-filters.xml'),
    'utf8'
  );

  // Trimmed to the shape `npx cap add android` generates.
  const GENERATED = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity
            android:configChanges="orientation"
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  test('merges the share and deep-link filters into MainActivity', () => {
    const patched = overlays.patchAndroidManifest(GENERATED, FILTERS);
    expect(patched).toContain('android.intent.action.SEND');
    expect(patched).toContain('android:scheme="stash"');
    // The launcher filter it was generated with survives.
    expect(patched).toContain('android.intent.category.LAUNCHER');
    // Filters land inside the activity, not after it.
    expect(patched.indexOf('android:scheme="stash"')).toBeLessThan(patched.indexOf('</activity>'));
  });

  test('forces singleTask so a share reuses the running app', () => {
    expect(overlays.patchAndroidManifest(GENERATED, FILTERS)).toContain('android:launchMode="singleTask"');
  });

  test('replaces an existing launchMode rather than adding a second one', () => {
    const withMode = GENERATED.replace('android:exported="true"', 'android:exported="true"\n            android:launchMode="singleTop"');
    const patched = overlays.patchAndroidManifest(withMode, FILTERS);
    expect(patched).not.toContain('singleTop');
    expect(patched.match(/android:launchMode=/g)).toHaveLength(1);
  });

  test('is idempotent — running sync twice changes nothing', () => {
    const once = overlays.patchAndroidManifest(GENERATED, FILTERS);
    expect(overlays.patchAndroidManifest(once, FILTERS)).toBe(once);
  });

  test('fails loudly if the generated manifest has no activity to patch', () => {
    expect(() => overlays.patchAndroidManifest('<manifest></manifest>', FILTERS)).toThrow(/no <activity>/);
  });
});

describe('iOS Info.plist overlay', () => {
  const GENERATED = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Stash</string>
</dict>
</plist>`;

  test('registers the stash:// URL scheme', () => {
    const patched = overlays.patchIosInfoPlist(GENERATED);
    expect(patched).toContain('CFBundleURLSchemes');
    expect(patched).toContain('<string>stash</string>');
    // Inserted inside the root dict, so the plist still parses.
    expect(patched.trimEnd().endsWith('</plist>')).toBe(true);
    expect(patched).toContain('<key>CFBundleDisplayName</key>');
  });

  test('is idempotent', () => {
    const once = overlays.patchIosInfoPlist(GENERATED);
    expect(overlays.patchIosInfoPlist(once)).toBe(once);
  });

  test('fails loudly on a malformed plist', () => {
    expect(() => overlays.patchIosInfoPlist('not a plist')).toThrow(/malformed Info.plist/);
  });
});

describe('verify-bundle: what a built app must contain', () => {
  const os = require('os');
  const verify = require('../../mobile/scripts/verify-bundle.js');

  // Builds a directory that looks like the assets unpacked from a built APK
  // or .app, so the checker can be run against a known-good bundle and then
  // against damaged variants of it.
  function makeBundle(mutate = () => {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-bundle-'));
    for (const rel of verify.expectedFiles()) {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rel.endsWith('.html') ? '<html></html>' : '');
    }
    mutate(dir);
    return dir;
  }

  test('expects the real web/ files, plus the vendored scripts', () => {
    const expected = verify.expectedFiles();
    expect(expected).toEqual(expect.arrayContaining([
      'index.html', 'save.html', 'app.js', 'platform.js', 'save-lib.js',
      'db.js', 'config.js', 'styles.css',
      'vendor/supabase.js', 'vendor/marked.min.js',
    ]));
    // Derived from web/, so nested assets come along too.
    expect(expected.some((file) => file.startsWith('icons/'))).toBe(true);
    // Web-only files are not expected in a native bundle.
    expect(expected).not.toContain('sw.js');
    expect(expected).not.toContain('manifest.json');
    // Sentry is optional — build-www drops it rather than failing.
    expect(expected).not.toContain('vendor/sentry.min.js');
  });

  test('passes a complete bundle', () => {
    const dir = makeBundle();
    expect(verify.verifyBundle(dir)).toEqual({ missing: [], forbidden: [], indexRefsCdn: [] });
  });

  test('catches a web asset that never made it into the app', () => {
    const dir = makeBundle((d) => fs.rmSync(path.join(d, 'app.js')));
    expect(verify.verifyBundle(dir).missing).toEqual(['app.js']);
  });

  test('catches a vendored script that never made it into the app', () => {
    const dir = makeBundle((d) => fs.rmSync(path.join(d, 'vendor', 'supabase.js')));
    expect(verify.verifyBundle(dir).missing).toEqual(['vendor/supabase.js']);
  });

  test('catches a Service Worker or PWA manifest leaking into a native build', () => {
    const dir = makeBundle((d) => {
      fs.writeFileSync(path.join(d, 'sw.js'), '');
      fs.writeFileSync(path.join(d, 'manifest.json'), '{}');
    });
    expect(verify.verifyBundle(dir).forbidden.sort()).toEqual(['manifest.json', 'sw.js']);
  });

  test('catches a shipped page that still loads a script over the network', () => {
    const cdn = build.VENDORED[0].src;
    const dir = makeBundle((d) => {
      fs.writeFileSync(path.join(d, 'index.html'), `<script src="${cdn}"></script>`);
    });
    expect(verify.verifyBundle(dir).indexRefsCdn).toEqual([`index.html -> ${cdn}`]);
  });
});
