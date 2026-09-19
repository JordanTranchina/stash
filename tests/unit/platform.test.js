/**
 * Unit tests for web/platform.js — the one seam between the three builds of
 * the Stash client (browser tab, installed PWA, native iOS/Android shell).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'web', 'platform.js'),
  'utf8'
);

// Load platform.js into a sandbox standing in for `self`. `capacitor` mimics
// the bridge the native shells inject before any page script runs; omit it to
// get the web build.
function loadPlatform({ capacitor, navigator, matchMedia, origin = 'https://stash.example' } = {}) {
  const sandbox = {
    URL,
    URLSearchParams,
    console,
    navigator: navigator || {},
    location: { origin },
    history: { back: jest.fn() },
    open: jest.fn(),
    document: { addEventListener: jest.fn(), visibilityState: 'visible' },
    matchMedia: matchMedia || (() => ({ matches: false })),
  };
  sandbox.self = sandbox;
  if (capacitor) sandbox.Capacitor = capacitor;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { StashPlatform: sandbox.StashPlatform, sandbox };
}

// Let every queued microtask run. The share-intent read crosses a vm realm
// boundary (a host promise resolved inside the sandbox), which takes more
// than a fixed number of ticks to settle.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// A Capacitor bridge with the given plugins registered.
function nativeBridge(platformName, plugins = {}) {
  return {
    isNativePlatform: () => true,
    getPlatform: () => platformName,
    Plugins: plugins,
  };
}

// Minimal stand-in for a plugin that emits events: records listeners so a test
// can fire them.
function listenerPlugin(extra = {}) {
  const listeners = {};
  return {
    listeners,
    addListener: (event, cb) => {
      listeners[event] = cb;
    },
    ...extra,
  };
}

describe('platform detection', () => {
  test('no bridge means the web build', () => {
    const { StashPlatform } = loadPlatform();
    expect(StashPlatform.isNative()).toBe(false);
    expect(StashPlatform.name()).toBe('web');
    expect(StashPlatform.isIOS()).toBe(false);
    expect(StashPlatform.isAndroid()).toBe(false);
  });

  test('reports ios and android from the bridge', () => {
    expect(loadPlatform({ capacitor: nativeBridge('ios') }).StashPlatform.isIOS()).toBe(true);
    expect(loadPlatform({ capacitor: nativeBridge('android') }).StashPlatform.isAndroid()).toBe(true);
  });

  test('a bridge reporting the web platform is not native', () => {
    const capacitor = { isNativePlatform: () => false, getPlatform: () => 'web', Plugins: {} };
    const { StashPlatform } = loadPlatform({ capacitor });
    expect(StashPlatform.isNative()).toBe(false);
    expect(StashPlatform.name()).toBe('web');
  });
});

describe('isInstalled', () => {
  test('false in a plain browser tab', () => {
    expect(loadPlatform().StashPlatform.isInstalled()).toBe(false);
  });

  test('true for an installed PWA (display-mode) and for iOS Safari standalone', () => {
    const displayMode = loadPlatform({ matchMedia: () => ({ matches: true }) });
    expect(displayMode.StashPlatform.isInstalled()).toBe(true);

    const iosSafari = loadPlatform({ navigator: { standalone: true } });
    expect(iosSafari.StashPlatform.isInstalled()).toBe(true);
  });

  test('always true in a native shell — the App Store already installed it', () => {
    const { StashPlatform } = loadPlatform({ capacitor: nativeBridge('ios') });
    expect(StashPlatform.isInstalled()).toBe(true);
  });
});

describe('service worker and OAuth redirect', () => {
  test('the web build registers a worker and redirects to its own origin', () => {
    const { StashPlatform } = loadPlatform();
    expect(StashPlatform.shouldRegisterServiceWorker()).toBe(true);
    expect(StashPlatform.oauthRedirectTo()).toBe('https://stash.example');
  });

  test('native builds skip the worker and redirect through the custom scheme', () => {
    const { StashPlatform } = loadPlatform({ capacitor: nativeBridge('android') });
    expect(StashPlatform.shouldRegisterServiceWorker()).toBe(false);
    expect(StashPlatform.oauthRedirectTo()).toBe('stash://auth/callback');
  });
});

describe('parseDeepLink', () => {
  const { StashPlatform } = loadPlatform();

  test('reads a share link, host-style and path-style alike', () => {
    const expected = { kind: 'share', url: 'https://example.com/a', title: 'A post', text: '' };
    expect(StashPlatform.parseDeepLink('stash://share?url=https%3A%2F%2Fexample.com%2Fa&title=A%20post'))
      .toEqual(expected);
    expect(StashPlatform.parseDeepLink('stash:///share?url=https%3A%2F%2Fexample.com%2Fa&title=A%20post'))
      .toEqual(expected);
  });

  test('reads an OAuth callback and an open-save link', () => {
    const callback = 'stash://auth/callback#access_token=abc&refresh_token=def';
    expect(StashPlatform.parseDeepLink(callback)).toEqual({ kind: 'auth', url: callback });
    expect(StashPlatform.parseDeepLink('stash://open?id=123')).toEqual({ kind: 'open', id: '123' });
  });

  test('ignores other schemes, unknown routes and junk', () => {
    expect(StashPlatform.parseDeepLink('https://example.com/share?url=x').kind).toBe('unknown');
    expect(StashPlatform.parseDeepLink('stash://nope').kind).toBe('unknown');
    expect(StashPlatform.parseDeepLink('not a url').kind).toBe('unknown');
    expect(StashPlatform.parseDeepLink('').kind).toBe('unknown');
  });
});

describe('parseSendIntent', () => {
  const { StashPlatform } = loadPlatform();

  test('normalizes a link share to the deep-link shape', () => {
    expect(StashPlatform.parseSendIntent({ url: 'https://example.com', title: 'Example' }))
      .toEqual({ kind: 'share', url: 'https://example.com', title: 'Example', text: '' });
  });

  test('passes a text-only share through for the app to extract a URL from', () => {
    expect(StashPlatform.parseSendIntent({ description: 'Read this https://example.com/x' }))
      .toEqual({ kind: 'share', url: '', title: '', text: 'Read this https://example.com/x' });
  });

  test('an empty or missing intent is unknown', () => {
    expect(StashPlatform.parseSendIntent(null).kind).toBe('unknown');
    expect(StashPlatform.parseSendIntent({}).kind).toBe('unknown');
  });
});

describe('onShare', () => {
  test('ios: routes the Share Extension deep link to the handler', () => {
    const app = listenerPlugin();
    const { StashPlatform } = loadPlatform({ capacitor: nativeBridge('ios', { App: app }) });
    const handler = jest.fn();
    StashPlatform.onShare(handler);

    app.listeners.appUrlOpen({ url: 'stash://share?url=https%3A%2F%2Fexample.com' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'share', url: 'https://example.com' })
    );

    // A non-share deep link on the same event must not be treated as a save.
    handler.mockClear();
    app.listeners.appUrlOpen({ url: 'stash://auth/callback#access_token=x' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('android: reads the launch intent on cold start and on later shares', async () => {
    const sendIntent = listenerPlugin({
      checkSendIntentReceived: jest.fn().mockResolvedValue({ url: 'https://example.com/a' }),
    });
    const { StashPlatform } = loadPlatform({
      capacitor: nativeBridge('android', { SendIntent: sendIntent }),
    });
    const handler = jest.fn();
    StashPlatform.onShare(handler);

    await flush();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'share', url: 'https://example.com/a' })
    );

    handler.mockClear();
    sendIntent.checkSendIntentReceived.mockResolvedValue({ description: 'https://example.com/b' });
    sendIntent.listeners.sendIntentReceived();
    await flush();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'share', text: 'https://example.com/b' })
    );
  });

  test('does nothing on the web build', () => {
    const { StashPlatform } = loadPlatform();
    expect(() => StashPlatform.onShare(jest.fn())).not.toThrow();
  });
});

describe('onBackButton', () => {
  function setup(canGoBack) {
    const app = listenerPlugin({ minimizeApp: jest.fn() });
    const loaded = loadPlatform({ capacitor: nativeBridge('android', { App: app }) });
    return { app, canGoBack, ...loaded };
  }

  test('a handled press stops there', () => {
    const { app, sandbox } = setup(true);
    sandbox.StashPlatform.onBackButton(() => true);
    app.listeners.backButton({ canGoBack: true });
    expect(sandbox.history.back).not.toHaveBeenCalled();
    expect(app.minimizeApp).not.toHaveBeenCalled();
  });

  test('an unhandled press goes back in history when it can', () => {
    const { app, sandbox } = setup(true);
    sandbox.StashPlatform.onBackButton(() => false);
    app.listeners.backButton({ canGoBack: true });
    expect(sandbox.history.back).toHaveBeenCalled();
  });

  test('an unhandled press at the root minimizes rather than doing nothing', () => {
    const { app, sandbox } = setup(false);
    sandbox.StashPlatform.onBackButton(() => false);
    app.listeners.backButton({ canGoBack: false });
    expect(app.minimizeApp).toHaveBeenCalled();
  });

  test('iOS has no back button to bind', () => {
    const app = listenerPlugin();
    const { StashPlatform } = loadPlatform({ capacitor: nativeBridge('ios', { App: app }) });
    StashPlatform.onBackButton(() => true);
    expect(app.listeners.backButton).toBeUndefined();
  });
});

describe('openExternal', () => {
  test('web opens a new tab', async () => {
    const { StashPlatform, sandbox } = loadPlatform();
    await expect(StashPlatform.openExternal('https://example.com')).resolves.toBe(true);
    expect(sandbox.open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener');
  });

  test('native uses the in-app browser instead of navigating the app WebView', async () => {
    const Browser = { open: jest.fn().mockResolvedValue(undefined) };
    const { StashPlatform, sandbox } = loadPlatform({ capacitor: nativeBridge('ios', { Browser }) });
    await StashPlatform.openExternal('https://example.com');
    expect(Browser.open).toHaveBeenCalledWith({ url: 'https://example.com' });
    expect(sandbox.open).not.toHaveBeenCalled();
  });

  test('falls back to window.open when the Browser plugin fails', async () => {
    const Browser = { open: jest.fn().mockRejectedValue(new Error('no')) };
    const { StashPlatform, sandbox } = loadPlatform({ capacitor: nativeBridge('ios', { Browser }) });
    await StashPlatform.openExternal('https://example.com');
    expect(sandbox.open).toHaveBeenCalled();
  });

  test('an empty url is a no-op', async () => {
    const { StashPlatform, sandbox } = loadPlatform();
    await expect(StashPlatform.openExternal('')).resolves.toBe(false);
    expect(sandbox.open).not.toHaveBeenCalled();
  });
});

describe('share', () => {
  test('prefers the native sheet, falls back to the Web Share API', async () => {
    const Share = { share: jest.fn().mockResolvedValue(undefined) };
    const native = loadPlatform({ capacitor: nativeBridge('android', { Share }) });
    await expect(native.StashPlatform.share({ url: 'https://example.com' })).resolves.toBe(true);
    expect(Share.share).toHaveBeenCalled();

    const webShare = jest.fn().mockResolvedValue(undefined);
    const web = loadPlatform({ navigator: { share: webShare } });
    await expect(web.StashPlatform.share({ url: 'https://example.com' })).resolves.toBe(true);
    expect(webShare).toHaveBeenCalled();
  });

  test('resolves false when there is nothing to share with', async () => {
    const { StashPlatform } = loadPlatform();
    await expect(StashPlatform.share({ url: 'https://example.com' })).resolves.toBe(false);
  });
});

describe('status bar and splash screen', () => {
  test('a theme change reaches the native status bar', async () => {
    const StatusBar = {
      setStyle: jest.fn().mockResolvedValue(undefined),
      setBackgroundColor: jest.fn().mockResolvedValue(undefined),
    };
    const { StashPlatform } = loadPlatform({ capacitor: nativeBridge('android', { StatusBar }) });
    await StashPlatform.setStatusBarTheme('dark');
    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: 'DARK' });
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({ color: '#000000' });
  });

  test('a failing plugin never breaks boot', async () => {
    const StatusBar = { setStyle: jest.fn().mockRejectedValue(new Error('nope')) };
    const SplashScreen = { hide: jest.fn().mockRejectedValue(new Error('nope')) };
    const { StashPlatform } = loadPlatform({
      capacitor: nativeBridge('ios', { StatusBar, SplashScreen }),
    });
    await expect(StashPlatform.setStatusBarTheme('light')).resolves.toBeUndefined();
    await expect(StashPlatform.hideSplash()).resolves.toBeUndefined();
  });

  test('both are no-ops on the web build', async () => {
    const { StashPlatform } = loadPlatform();
    await expect(StashPlatform.setStatusBarTheme('dark')).resolves.toBeUndefined();
    await expect(StashPlatform.hideSplash()).resolves.toBeUndefined();
  });
});
