#!/usr/bin/env node
// Applies Stash's native-side customizations to the generated Capacitor
// projects under mobile/ios and mobile/android.
//
// Those two directories are produced by `npx cap add ios|android` and are not
// checked in, so anything Stash needs on top of the stock template lives in
// mobile/native/ and is re-applied by this script after every regeneration.
// Every step is idempotent: running it twice changes nothing the second time,
// so `npm run sync` can call it unconditionally.
//
// What it does:
//   Android — merges the share (ACTION_SEND) and stash:// deep-link intent
//             filters into MainActivity, makes that activity singleTask so a
//             share reuses the running app instead of stacking a second copy,
//             and applies the app's compileSdk to the plugin modules (see
//             native/android/plugin-compile-sdk.gradle for why).
//   iOS     — copies the Share Extension sources into the Xcode project's
//             directory and registers the stash:// URL scheme in Info.plist.
//
// The one thing it cannot do is add the Share Extension *target* to the Xcode
// project file: that is a one-time click in Xcode, and scripting a .pbxproj
// rewrite would be far more fragile than the four steps in README.md.

'use strict';

const fs = require('fs');
const path = require('path');

const MOBILE = path.join(__dirname, '..');
const NATIVE = path.join(MOBILE, 'native');
const URL_SCHEME = 'stash';

// ---------------------------------------------------------------- Android

const ANDROID_MANIFEST = path.join(MOBILE, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

// Marker that tells an already-patched manifest from a freshly generated one.
const ANDROID_MARKER = 'android:scheme="stash"';

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}

// The explanatory comment at the top of native/android/intent-filters.xml is
// for whoever maintains that file; only the elements belong in the generated
// manifest, under one line saying where they came from.
function intentFilterElements(filters) {
  return filters.replace(/<!--[\s\S]*?-->/g, '').trim();
}

// Insert the shared intent filters just before MainActivity's closing tag, and
// force singleTask launch mode. Returns the patched XML, or the input
// unchanged when the filters are already there.
function patchAndroidManifest(xml, filters) {
  if (xml.includes(ANDROID_MARKER)) return xml;

  const activityClose = xml.lastIndexOf('</activity>');
  if (activityClose === -1) {
    throw new Error('apply-native-overlays: no <activity> found in AndroidManifest.xml');
  }

  // Cut at the start of the closing tag's own line so the inserted block sets
  // its own indentation instead of inheriting half a line of it.
  const lineStart = xml.lastIndexOf('\n', activityClose) + 1;
  const block =
    indent('<!-- Added by mobile/scripts/apply-native-overlays.js from mobile/native/android/intent-filters.xml -->', 12) + '\n' +
    indent(intentFilterElements(filters), 12) + '\n';

  let patched = xml.slice(0, lineStart) + block + xml.slice(lineStart);

  // A share must land in the running app, not a second task on top of it.
  if (/android:launchMode="[^"]*"/.test(patched)) {
    patched = patched.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
  } else {
    patched = patched.replace(
      /(<activity\b[^>]*?)(\s*>)/,
      '$1\n            android:launchMode="singleTask"$2'
    );
  }
  return patched;
}

const ANDROID_BUILD_GRADLE = path.join(MOBILE, 'android', 'build.gradle');

// Marker for the compileSdk overlay below.
const GRADLE_MARKER = 'rootProject.ext.compileSdkVersion';

// Append the plugin-compileSdk block to the generated root build.gradle.
// Returns the input unchanged when it is already there.
function patchAndroidBuildGradle(gradle, block) {
  if (gradle.includes(GRADLE_MARKER)) return gradle;
  return `${gradle.trimEnd()}\n\n${block.trim()}\n`;
}

function applyAndroid() {
  if (!fs.existsSync(ANDROID_MANIFEST)) {
    console.log('android/ not generated yet — skipping (run `npx cap add android` first)');
    return;
  }
  const filters = fs.readFileSync(path.join(NATIVE, 'android', 'intent-filters.xml'), 'utf8');
  const xml = fs.readFileSync(ANDROID_MANIFEST, 'utf8');
  const patched = patchAndroidManifest(xml, filters);
  if (patched === xml) {
    console.log('android: intent filters already applied');
    return;
  }
  fs.writeFileSync(ANDROID_MANIFEST, patched);
  console.log('android: merged share + deep-link intent filters into MainActivity');
}

function applyAndroidBuildGradle() {
  if (!fs.existsSync(ANDROID_BUILD_GRADLE)) return;
  const block = fs.readFileSync(path.join(NATIVE, 'android', 'plugin-compile-sdk.gradle'), 'utf8');
  const gradle = fs.readFileSync(ANDROID_BUILD_GRADLE, 'utf8');
  const patched = patchAndroidBuildGradle(gradle, block);
  if (patched === gradle) {
    console.log('android: plugin compileSdk override already applied');
    return;
  }
  fs.writeFileSync(ANDROID_BUILD_GRADLE, patched);
  console.log("android: applied the app's compileSdk to the plugin modules");
}

// -------------------------------------------------------------------- iOS

const IOS_APP_DIR = path.join(MOBILE, 'ios', 'App');
const IOS_INFO_PLIST = path.join(IOS_APP_DIR, 'App', 'Info.plist');

const URL_TYPES_BLOCK = `	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.stash.app</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>${URL_SCHEME}</string>
			</array>
		</dict>
	</array>
`;

// Register the stash:// scheme by inserting a CFBundleURLTypes entry into the
// app's Info.plist. Returns the input unchanged when it is already declared.
function patchIosInfoPlist(plist) {
  if (plist.includes('CFBundleURLTypes')) return plist;
  const close = plist.lastIndexOf('</dict>');
  if (close === -1) throw new Error('apply-native-overlays: malformed Info.plist');
  return plist.slice(0, close) + URL_TYPES_BLOCK + plist.slice(close);
}

function applyIos() {
  if (!fs.existsSync(IOS_APP_DIR)) {
    console.log('ios/ not generated yet — skipping (run `npx cap add ios` first)');
    return;
  }

  const plist = fs.readFileSync(IOS_INFO_PLIST, 'utf8');
  const patched = patchIosInfoPlist(plist);
  if (patched !== plist) {
    fs.writeFileSync(IOS_INFO_PLIST, patched);
    console.log(`ios: registered the ${URL_SCHEME}:// URL scheme`);
  } else {
    console.log(`ios: ${URL_SCHEME}:// URL scheme already registered`);
  }

  const src = path.join(NATIVE, 'ios', 'ShareExtension');
  const dest = path.join(IOS_APP_DIR, 'ShareExtension');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
  console.log('ios: copied Share Extension sources to ios/App/ShareExtension');
  console.log('     (add the extension target in Xcode once — see mobile/README.md)');
}

if (require.main === module) {
  try {
    applyAndroid();
    applyAndroidBuildGradle();
    applyIos();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { patchAndroidManifest, patchAndroidBuildGradle, intentFilterElements, patchIosInfoPlist, ANDROID_MARKER, URL_SCHEME };
