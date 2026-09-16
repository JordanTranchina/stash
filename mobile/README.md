# Stash native apps (iOS + Android)

Native shells for the Stash client, built with [Capacitor](https://capacitorjs.com).

They are not a second implementation of Stash. Both apps load the *same* files
the PWA is deployed from — `web/` — inside a native WebView. Every difference
between the three builds (browser tab, installed PWA, native app) is decided at
runtime in `web/platform.js`. So a change to the app's UI, its list, its reading
pane, or its save path ships to all three at once, and there is no native UI code
to keep in step. The only native source in this repo is the iOS Share Extension
under `native/ios/` — about a hundred lines whose whole job is to hand a shared
link to the web layer.

See [documentation/MOBILE_APPS.md](../documentation/MOBILE_APPS.md) for why it
is built this way, what each platform's share path looks like, and what the
apps need from Supabase before sign-in works on a device.

## What you need

| | iOS | Android |
|---|---|---|
| Machine | macOS | macOS, Linux or Windows |
| Tooling | Xcode 15+, CocoaPods | Android Studio (Giraffe+), JDK 17+ |
| Node | 20+ | 20+ |

## First run

```bash
cd mobile
npm install
npm run init        # builds www/, generates ios/ + android/, applies overlays, syncs
```

`npm run init` is the whole setup. It:

1. **builds `www/`** from `web/` (`scripts/build-www.js`),
2. **generates `ios/` and `android/`** with `npx cap add`,
3. **applies the native overlays** (`scripts/apply-native-overlays.js`),
4. **runs `cap sync`** to install the plugins' native code.

Then open each project:

```bash
npm run open:ios        # Xcode
npm run open:android    # Android Studio
```

Android is ready to run at this point. iOS needs one manual step, below.

## After changing anything in `web/`

```bash
npm run sync
```

That rebuilds `www/`, re-applies the overlays and re-runs `cap sync`. Nothing in
`ios/`, `android/` or `www/` is checked in — they are all generated, and all
three are gitignored. **Never edit files in those directories**: edit `web/` or
`mobile/native/` and re-sync, or the change disappears on the next regeneration.

## The one manual iOS step: the Share Extension target

Adding a target rewrites Xcode's `.pbxproj`, which is not worth scripting.
`npm run sync` copies the sources into `ios/App/ShareExtension/`; wiring them up
is a one-time click-through, in Xcode:

1. **File > New > Target… > Share Extension**. Name it `ShareExtension`, set the
   bundle identifier to `com.stash.app.share`, and let Xcode add it to the `App`
   project. Decline the "Activate scheme?" prompt.
2. Xcode generates its own `ShareViewController.swift`, `Info.plist` and
   `MainInterface.storyboard`. **Delete all three** (Move to Trash), then drag
   `ios/App/ShareExtension/ShareViewController.swift` and
   `ios/App/ShareExtension/Info.plist` in, with the `ShareExtension` target
   ticked. Set Build Settings > Info.plist File to `ShareExtension/Info.plist`.
3. Set the extension target's **iOS Deployment Target** to match the app's.
4. Build and run. "Save to Stash" is now in the share sheet.

There is nothing to repeat here: `npm run sync` overwrites the two source files
in place, and the target keeps pointing at them.

## Signing and store builds

Both apps are configured as `com.stash.app` (`capacitor.config.json`). Change
`appId` there *before* the first `cap add` if you are shipping your own build —
after that, the identifier is baked into the generated projects and changing it
means regenerating them.

- **iOS** — set your team in Xcode > Signing & Capabilities for both the `App`
  and `ShareExtension` targets, then Product > Archive.
- **Android** — `android/app/build.gradle` holds `versionCode`/`versionName`;
  build a release bundle with `./gradlew bundleRelease` from `android/`.

## Known gap

The reading font (PT Serif) is still loaded from Google Fonts, so on a first,
fully-offline launch the reading pane falls back to the system serif until the
font has been fetched once. Everything else — app shell, Supabase client,
Markdown renderer — is bundled and works offline from the first launch.

## Layout

```
mobile/
├── capacitor.config.json     # app id, name, plugin config, URL schemes
├── package.json              # Capacitor deps (native only — never bundled into www/)
├── native/
│   ├── android/
│   │   └── intent-filters.xml    # ACTION_SEND + stash:// filters, merged into the manifest
│   └── ios/ShareExtension/       # the only native Stash source: share sheet -> stash://share
└── scripts/
    ├── build-www.js              # web/ -> www/ (drops the SW, vendors the CDN scripts)
    └── apply-native-overlays.js  # re-applies the above to the generated projects
```
