# Native mobile apps (iOS + Android)

Stash ships as native apps on the App Store and Google Play without a second
codebase. This document explains the shape of that, what runs where, and what
you must configure before the apps work on a device.

Build and run instructions live in [`mobile/README.md`](../mobile/README.md).

## One client, three builds

There is exactly one Stash client: the vanilla-JS app in `web/`. It runs in
three places.

| Build | How it loads `web/` | Offline story | Share sheet |
|---|---|---|---|
| Browser tab | From the deployed static host | Service Worker cache | — |
| Installed PWA | Same, from the home screen | Service Worker cache | Web Share Target (`save.html`) |
| Native iOS/Android | From the app bundle (`mobile/www`) | Assets are on disk already | OS share sheet -> `stash://` / `ACTION_SEND` |

`mobile/www` is a copy of `web/`, made by `mobile/scripts/build-www.js` on every
sync. The files are byte-identical apart from two mechanical rewrites the build
script performs and one omission:

- `sw.js` and `manifest.json` are left out. A native build's assets are already
  on disk, so a Service Worker would only add a stale second copy of the app
  shell, and the PWA manifest's install and share-target metadata is replaced by
  `Info.plist` and `AndroidManifest.xml`.
- The three CDN `<script>` tags (Supabase client, `marked`, Sentry) are
  downloaded into `www/vendor/` and rewritten to point there. A native app has
  to open — and open offline — before it has ever reached the network.

Nothing else is transformed. There is no bundler, no transpiler and no build
step for the app's own code, exactly as in the rest of the repo.

## The seam: `web/platform.js`

Every behavioural difference between the three builds goes through one module,
`StashPlatform`, which feature-detects Capacitor's bridge (`window.Capacitor`)
and falls back to plain browser behaviour when there isn't one. It answers:

| Question | Web | Native |
|---|---|---|
| `isInstalled()` | display-mode / `navigator.standalone` | always true — the App Store installed it |
| `shouldRegisterServiceWorker()` | true | false |
| `oauthRedirectTo()` | `location.origin` | `stash://auth/callback` |
| `openExternal(url)` | new tab | in-app browser (SFSafariViewController / Custom Tab) |
| `share(payload)` | Web Share API | native share sheet |
| `onShare(cb)` | — | `stash://share` deep link (iOS) / `ACTION_SEND` (Android) |
| `onBackButton(cb)` | — | Android hardware back |
| `setStatusBarTheme(t)` | `<meta name="theme-color">` (in `app.js`) | native status bar |
| `hideSplash()` | — | dismisses the launch image |

`app.js` calls into it from `bindNativeShell()`, and each call is a no-op on the
web, so all three builds keep one init path.

Deliberately, `platform.js` never imports the Capacitor JS packages. Capacitor's
native bridge registers every installed plugin on `window.Capacitor.Plugins`
before any page script runs, so calling through that object needs no bundler.
The packages in `mobile/package.json` exist only so `npx cap sync` can install
each plugin's *native* code; they never reach the web assets.

## Saving from the share sheet

Both platforms converge on the same handler, `app.js`'s `handleNativeShare()`,
which posts to the **`save-page` Edge Function** — the same ingestion path the
PWA share target, the bookmarklet and the browser extensions use. So a native
save gets the same Readability extraction, the same URL dedupe, and the same
offline queueing (IndexedDB via `db.js`, drained on resume) as every other
client. No client-specific save logic exists.

**iOS.** A share extension (`mobile/native/ios/ShareExtension/`) is the only
native Stash source in the repo. It reduces whatever was shared to a URL plus an
optional title, opens `stash://share?url=…&title=…`, and exits. It saves
nothing itself.

**Android.** `MainActivity` declares an `ACTION_SEND` (`text/plain`) intent
filter and runs as `singleTask`, so a share reuses the running app. The
`send-intent` plugin reads the intent — both on cold start, which is the common
case, and via its `sendIntentReceived` event when the app was already open.

Shared text is rarely a bare URL ("Title https://…" is typical on Android), so
the link is pulled out with `StashSave.extractUrlFromText()`, the same extractor
`save.html` uses for the PWA share target.

## Sign-in on a device

Google refuses OAuth inside an embedded WebView, and a WebView cannot be a
redirect target. So on native, `signInWithGoogle()` asks Supabase for the
consent URL without navigating (`skipBrowserRedirect`), opens it in the system
browser, and waits for `stash://auth/callback`. `handleAuthDeepLink()` completes
the exchange — a PKCE `code` or fragment tokens, both accepted — and
`onAuthStateChange` takes it from there.

**This requires one Supabase change.** In your project, under
**Authentication > URL Configuration > Redirect URLs**, add:

```
stash://auth/callback
```

Without it Supabase rejects the redirect and Google sign-in fails on device with
no useful error. Email/password sign-in works without this step.

## Deep links

The `stash://` scheme is registered by both shells and routed by
`StashPlatform.parseDeepLink()`:

| Link | Effect |
|---|---|
| `stash://share?url=…&title=…&text=…` | save the shared link (iOS Share Extension) |
| `stash://auth/callback#…` or `?code=…` | complete an OAuth sign-in |
| `stash://open?id=<save id>` | open that save's reading pane |

`stash://open` is the native counterpart of the web app's `?open=<id>` deep
link, and both now resolve through the same `openSaveById()`.

## What is and isn't checked in

`mobile/ios/`, `mobile/android/`, `mobile/www/` and `mobile/node_modules/` are
all generated and all gitignored. What is checked in is everything needed to
regenerate them: the Capacitor config, the plugin list, the two overlay sources
under `mobile/native/`, and the two scripts that apply them.

That is a deliberate trade. Committing the generated Xcode and Gradle projects
is the more common Capacitor practice, but it would put thousands of
machine-written files under review in a repo whose entire premise is "no build
step, read the source". `apply-native-overlays.js` makes the alternative safe:
every customization Stash needs on top of the stock templates is re-applied
idempotently by `npm run sync`, and covered by
`tests/unit/mobile-build.test.js`.

The one thing the script cannot do is add the iOS Share Extension *target* to
the Xcode project — that is a one-time click-through documented in
`mobile/README.md`.

## How the apps are tested

Three layers, all in CI:

1. **`tests/unit/platform.test.js`** — the platform seam: detection, deep-link
   routing, share-intent normalization, the back button, and every web
   fallback. Runs in the existing Jest unit job.
2. **`tests/unit/mobile-build.test.js`** — the build and overlay scripts, run
   against the real `web/index.html` and `save.html`, so a CDN `<script>`
   changing shape fails loudly instead of shipping an app that needs the
   network to start. Also covers the manifest/plist overlays' idempotency and
   the bundle verifier's own logic.
3. **`.github/workflows/mobile-build.yml`** — an actual compile of both apps
   (`gradlew assembleDebug`, `xcodebuild -sdk iphonesimulator`) on every PR
   touching `web/` or `mobile/`, followed by checks on the *built artifacts*:
   the bundled web client is complete and CDN-free, the APK manifest declares
   `ACTION_SEND` and `stash://`, and the `.app` registers `stash://`. The debug
   APK is uploaded as a build artifact.

Because the iOS Share Extension target is added to the Xcode project by hand,
the app build does not compile it; CI type-checks `ShareViewController.swift`
against the iOS SDK separately so that source is still covered.

## Store submission

Neither app is submitted yet. The listing copy, privacy policy and support URLs
in [STORE_LISTING.md](STORE_LISTING.md) and
[PRIVACY_POLICY.md](PRIVACY_POLICY.md) apply to the mobile apps as they do to
the extensions. Two mobile-specific notes for whoever submits:

- **Apple** requires an account-deletion path for any app with sign-in, and will
  ask what the app does with the articles it fetches.
- **Google Play** requires a Data Safety declaration; Stash collects the URLs
  and article text you save, plus optional Sentry crash reports and PostHog
  usage analytics (both disabled by blanking their keys in `web/config.js`).
