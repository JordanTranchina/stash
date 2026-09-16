// Stash platform abstraction.
//
// Stash ships the same vanilla-JS client three ways: as a browser tab, as an
// installed PWA, and — since the native apps landed — inside a Capacitor
// WebView on iOS and Android. The three builds run byte-identical files from
// web/; this module is the one seam between them. Everything that a native
// shell does differently (open a link outside the app, receive a share-sheet
// intent, follow an OAuth redirect back through a custom URL scheme, react to
// the Android hardware back button, tint the status bar, dismiss the splash
// screen) goes through StashPlatform, which degrades to plain browser
// behaviour when no native bridge is present.
//
// There is no build step here, and there is no bundler, so this file never
// imports the Capacitor JS packages. Capacitor's native bridge registers every
// installed plugin on `window.Capacitor.Plugins` before any page script runs,
// so calling through that object is both sufficient and dependency-free. The
// npm packages under mobile/package.json still matter — `npx cap sync` needs
// them to install each plugin's native code — but they never reach the web
// bundle.
//
// Exposed on `self` (like db.js, save-lib.js and offline-lib.js) so the same
// file loads in a page and in the Service Worker without change.
(function (root) {
  // Names as Capacitor's getPlatform() reports them.
  const WEB = 'web';
  const IOS = 'ios';
  const ANDROID = 'android';

  // Custom URL scheme registered by both native shells. It carries two kinds
  // of deep link back into the app:
  //   stash://auth/callback#access_token=…  — Supabase OAuth returning from
  //     the system browser (a WebView can't be the OAuth redirect target).
  //   stash://share?url=…&title=…&text=…    — the iOS Share Extension handing
  //     over what the user shared.
  const URL_SCHEME = 'stash';

  function bridge() {
    return (typeof root.Capacitor !== 'undefined' && root.Capacitor) || null;
  }

  function plugin(name) {
    const cap = bridge();
    return (cap && cap.Plugins && cap.Plugins[name]) || null;
  }

  // True only inside a native shell. Capacitor sets isNativePlatform(); older
  // bridges only had isNative. Anything else (tab, installed PWA, test
  // sandbox) is the web platform.
  function isNative() {
    const cap = bridge();
    if (!cap) return false;
    if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
    return cap.isNative === true;
  }

  function name() {
    const cap = bridge();
    if (!cap || !isNative()) return WEB;
    return (typeof cap.getPlatform === 'function' && cap.getPlatform()) || WEB;
  }

  const isIOS = () => name() === IOS;
  const isAndroid = () => name() === ANDROID;

  // The Service Worker is the PWA's offline story. A native build has no use
  // for it: its assets are already on disk inside the app bundle, saves queue
  // through the same IndexedDB store (db.js) that the app drains on resume,
  // and registering a worker against the capacitor:// origin only adds a
  // second, stale copy of the app shell to reason about.
  function shouldRegisterServiceWorker() {
    return !isNative();
  }

  // The "Install this app" affordances (Settings row, home toast) exist to get
  // a browser tab onto the home screen. Inside a native app the user already
  // did that — via the App Store — so the app reports itself as installed.
  function isInstalled() {
    if (isNative()) return true;
    if (typeof root.matchMedia === 'function' && root.matchMedia('(display-mode: standalone)').matches) return true;
    return !!(root.navigator && root.navigator.standalone === true);
  }

  // Where Supabase should send an OAuth round trip. On the web that is the
  // page's own origin; in a native shell it has to be the custom scheme,
  // because the system browser cannot redirect back into a WebView. Add this
  // exact value to Supabase Auth > URL Configuration > Redirect URLs before
  // Google sign-in works on device (see documentation/MOBILE_APPS.md).
  function oauthRedirectTo() {
    if (isNative()) return `${URL_SCHEME}://auth/callback`;
    return root.location ? root.location.origin : undefined;
  }

  // Open a link the user is meant to read *outside* the reading pane (the
  // original article, the podcast feed, the GitHub Actions workflow). In a
  // browser that is a new tab. In a native app it must not be the app's own
  // WebView — navigating it away leaves no way back — so it goes to an
  // in-app browser view (iOS SFSafariViewController / Android Custom Tab),
  // falling back to window.open if the Browser plugin is missing.
  async function openExternal(url) {
    if (!url) return false;
    const browser = isNative() && plugin('Browser');
    if (browser) {
      try {
        await browser.open({ url });
        return true;
      } catch (e) {
        // Fall through to window.open rather than swallowing the tap.
      }
    }
    if (typeof root.open === 'function') {
      root.open(url, '_blank', 'noopener');
      return true;
    }
    return false;
  }

  // Dismiss an in-app browser view opened by openExternal. Used after an
  // OAuth round trip, where the callback page has done its job and the user
  // should be back in the app. No-op on web, where the tab is the user's.
  async function closeExternal() {
    const browser = isNative() && plugin('Browser');
    if (!browser || typeof browser.close !== 'function') return;
    try {
      await browser.close();
    } catch (e) {
      // Already closed (the usual case when the user dismissed it themselves).
    }
  }

  // Native share sheet where there is one, the Web Share API otherwise.
  // Resolves false when neither exists so callers can fall back to copying.
  async function share(payload) {
    const sharePlugin = isNative() && plugin('Share');
    if (sharePlugin) {
      try {
        await sharePlugin.share(payload);
        return true;
      } catch (e) {
        return false;
      }
    }
    if (root.navigator && typeof root.navigator.share === 'function') {
      try {
        await root.navigator.share(payload);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  // Parse a stash:// deep link into something the app can act on without
  // knowing the scheme. Pure and exported for its own sake so the routing is
  // unit-testable without a bridge.
  //   stash://share?url=…&title=…&text=…  -> { kind: 'share', … }
  //   stash://auth/callback#access_token= -> { kind: 'auth', url }
  //   stash://open?id=<uuid>              -> { kind: 'open', id }
  // Anything else (including a non-stash URL) is { kind: 'unknown' }, which
  // callers ignore.
  function parseDeepLink(rawUrl) {
    if (!rawUrl) return { kind: 'unknown' };
    let parsed;
    try {
      parsed = new URL(String(rawUrl));
    } catch (e) {
      return { kind: 'unknown' };
    }
    if (parsed.protocol !== `${URL_SCHEME}:`) return { kind: 'unknown' };

    // "stash://share?x=1" parses with host "share" and an empty path, while
    // "stash:///share?x=1" parses with an empty host and path "/share" —
    // both spellings turn up depending on which side built the URL, so treat
    // host and first path segment as the same slot.
    const route = (parsed.host || parsed.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
    const params = parsed.searchParams;

    if (route === 'share') {
      return {
        kind: 'share',
        url: params.get('url') || '',
        title: params.get('title') || '',
        text: params.get('text') || '',
      };
    }
    if (route === 'auth') return { kind: 'auth', url: String(rawUrl) };
    if (route === 'open') return { kind: 'open', id: params.get('id') || '' };
    return { kind: 'unknown' };
  }

  // Normalize an Android send-intent payload to the same shape a share deep
  // link produces. The plugin reports the shared item in `url` for a link
  // share and in `title`/`description` for a text share, and Android apps are
  // inconsistent about which they use, so every field is passed along and the
  // caller (app.js) picks a URL out of them with StashSave.extractUrlFromText.
  function parseSendIntent(intent) {
    if (!intent) return { kind: 'unknown' };
    const url = intent.url || '';
    const title = intent.title || '';
    const text = intent.description || intent.text || '';
    if (!url && !title && !text) return { kind: 'unknown' };
    return { kind: 'share', url, title, text };
  }

  // Register a handler for every inbound share, however it arrives:
  //   iOS      — the Share Extension opens stash://share?… (appUrlOpen).
  //   Android  — the send-intent plugin fires sendIntentReceived, and the
  //              same intent is also readable on cold start, which is when a
  //              share usually launches the app.
  // Handlers get the { kind: 'share', url, title, text } shape above.
  function onShare(handler) {
    if (typeof handler !== 'function' || !isNative()) return;

    const app = plugin('App');
    if (app && typeof app.addListener === 'function') {
      app.addListener('appUrlOpen', (event) => {
        const link = parseDeepLink(event && event.url);
        if (link.kind === 'share') handler(link);
      });
    }

    const sendIntent = plugin('SendIntent');
    if (sendIntent) {
      if (typeof sendIntent.addListener === 'function') {
        sendIntent.addListener('sendIntentReceived', () => {
          readSendIntent(sendIntent, handler);
        });
      }
      // Cold start: the intent that launched the app is waiting to be read.
      readSendIntent(sendIntent, handler);
    }
  }

  function readSendIntent(sendIntent, handler) {
    if (!sendIntent || typeof sendIntent.checkSendIntentReceived !== 'function') return;
    Promise.resolve(sendIntent.checkSendIntentReceived())
      .then((result) => {
        const parsed = parseSendIntent(result);
        if (parsed.kind === 'share') handler(parsed);
      })
      .catch(() => {});
  }

  // Register a handler for the non-share deep links (OAuth callback, "open
  // this save"). Kept separate from onShare so the two concerns stay legible
  // at the call site even though both ride appUrlOpen.
  function onDeepLink(handler) {
    if (typeof handler !== 'function' || !isNative()) return;
    const app = plugin('App');
    if (!app || typeof app.addListener !== 'function') return;
    app.addListener('appUrlOpen', (event) => {
      const link = parseDeepLink(event && event.url);
      if (link.kind === 'auth' || link.kind === 'open') handler(link);
    });
  }

  // Android's hardware/gesture back button. The handler returns true when it
  // consumed the press (it closed a pane or a modal); returning false lets
  // the shell decide, which means going back in history if it can and
  // otherwise minimizing the app — never a silent no-op the user reads as a
  // frozen app. iOS has no such button, so this is a no-op there.
  function onBackButton(handler) {
    if (typeof handler !== 'function' || !isAndroid()) return;
    const app = plugin('App');
    if (!app || typeof app.addListener !== 'function') return;
    app.addListener('backButton', (event) => {
      if (handler()) return;
      if (event && event.canGoBack && root.history) {
        root.history.back();
        return;
      }
      if (typeof app.minimizeApp === 'function') app.minimizeApp();
      else if (typeof app.exitApp === 'function') app.exitApp();
    });
  }

  // Fires when the app returns to the foreground. The web equivalent is
  // visibilitychange, so callers get one hook for "we may have missed
  // realtime updates while backgrounded, re-sync now".
  function onResume(handler) {
    if (typeof handler !== 'function') return;
    const app = isNative() && plugin('App');
    if (app && typeof app.addListener === 'function') {
      app.addListener('appStateChange', (state) => {
        if (state && state.isActive) handler();
      });
      return;
    }
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', () => {
        if (root.document.visibilityState === 'visible') handler();
      });
    }
  }

  // Keep the native status bar legible against the app's current theme. The
  // web build does the same job with <meta name="theme-color">, which app.js
  // already updates; this is the native half of that call.
  async function setStatusBarTheme(theme) {
    const statusBar = isNative() && plugin('StatusBar');
    if (!statusBar) return;
    try {
      // Capacitor's Style.Dark means "dark content on a light bar", so the
      // names read backwards against the app's own light/dark theme.
      await statusBar.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' });
      if (isAndroid() && typeof statusBar.setBackgroundColor === 'function') {
        await statusBar.setBackgroundColor({ color: theme === 'dark' ? '#000000' : '#ffffff' });
      }
    } catch (e) {
      // A themed status bar is cosmetic; never let it break boot.
    }
  }

  // Dismiss the launch image once the app has actually painted. Called from
  // app.js after the first render so the user never sees a blank WebView
  // between the splash screen and the list.
  async function hideSplash() {
    const splash = isNative() && plugin('SplashScreen');
    if (!splash || typeof splash.hide !== 'function') return;
    try {
      await splash.hide();
    } catch (e) {
      // Splash auto-hides on a timer too, so a failure here is harmless.
    }
  }

  root.StashPlatform = {
    WEB, IOS, ANDROID, URL_SCHEME,
    isNative, name, isIOS, isAndroid,
    isInstalled, shouldRegisterServiceWorker, oauthRedirectTo,
    openExternal, closeExternal, share,
    parseDeepLink, parseSendIntent,
    onShare, onDeepLink, onBackButton, onResume,
    setStatusBarTheme, hideSplash,
  };
})(self);
