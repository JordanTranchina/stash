/**
 * Unit tests for PWA install platform detection and instructions in web/app.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStashApp() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'app.js'),
    'utf8'
  );
  const marker = '// Initialize app';
  const index = source.indexOf(marker);
  if (index === -1) throw new Error('app.js no longer ends with the init block');
  const classOnly = `${source.slice(0, index)}\nglobalThis.StashApp = StashApp;`;

  const sandbox = {
    console,
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    CONFIG: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(classOnly, sandbox);
  return { StashApp: sandbox.StashApp, sandbox };
}

describe('PWA install platform detection & steps', () => {
  let StashApp;
  let sandbox;
  let app;

  beforeEach(() => {
    const loaded = loadStashApp();
    StashApp = loaded.StashApp;
    sandbox = loaded.sandbox;
    app = Object.create(StashApp.prototype);
  });

  function setNavigator({ userAgent, platform = '', maxTouchPoints = 0 }) {
    sandbox.navigator.userAgent = userAgent;
    sandbox.navigator.platform = platform;
    sandbox.navigator.maxTouchPoints = maxTouchPoints;
  }

  describe('isIOS', () => {
    test('identifies iPhone', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
      });
      expect(app.isIOS()).toBe(true);
    });

    test('identifies iPad with legacy iPad UA', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        platform: 'iPad',
        maxTouchPoints: 5,
      });
      expect(app.isIOS()).toBe(true);
    });

    test('identifies modern iPadOS (Macintosh UA with touch points)', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      });
      expect(app.isIOS()).toBe(true);
    });

    test('does not misidentify desktop macOS Mac (0 touch points)', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      });
      expect(app.isIOS()).toBe(false);
    });

    test('does not misidentify Android', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.105 Mobile Safari/537.36',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      });
      expect(app.isIOS()).toBe(false);
    });
  });

  describe('detectInstallPlatform', () => {
    test('detects iOS Safari on iPhone', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('ios-safari');
    });

    test('detects iOS Safari on modern iPad (iPadOS 13+)', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('ios-safari');
    });

    test('detects non-Safari iOS browser (Chrome on iPhone / CriOS)', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('ios-other');
    });

    test('detects non-Safari iOS browser on iPad (Chrome on iPad / CriOS)', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('ios-other');
    });

    test('detects non-Safari iOS browser (Firefox on iPhone / FxiOS)', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/123.0 Mobile/15E148 Safari/605.1.15',
        platform: 'iPhone',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('ios-other');
    });

    test('detects Android Chrome', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.105 Mobile Safari/537.36',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('android-chrome');
    });

    test('detects Android Firefox', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:123.0) Gecko/123.0 Firefox/123.0',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      });
      expect(app.detectInstallPlatform()).toBe('android-firefox');
    });

    test('detects desktop macOS Safari', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      });
      expect(app.detectInstallPlatform()).toBe('mac-safari');
    });

    test('detects desktop Firefox on macOS', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      });
      expect(app.detectInstallPlatform()).toBe('desktop-firefox');
    });

    test('detects desktop Firefox on Windows', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        platform: 'Win32',
        maxTouchPoints: 0,
      });
      expect(app.detectInstallPlatform()).toBe('desktop-firefox');
    });

    test('detects desktop Chrome on Windows', () => {
      setNavigator({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        platform: 'Win32',
        maxTouchPoints: 0,
      });
      expect(app.detectInstallPlatform()).toBe('desktop-chrome');
    });
  });

  describe('getInstallSteps', () => {
    test('ios-safari returns share and home steps without a warning note', () => {
      const res = app.getInstallSteps('ios-safari');
      expect(res.note).toBeUndefined();
      expect(res.steps.length).toBeGreaterThanOrEqual(3);
      expect(res.steps[0].icon).toBe('share');
      expect(res.steps[1].icon).toBe('home');
      expect(res.steps[0].text).toContain('Share');
    });

    test('ios-other notes that only Safari can install apps', () => {
      const res = app.getInstallSteps('ios-other');
      expect(res.note).toContain('only Safari can install apps');
      expect(res.steps[0].text).toContain('Open this page in Safari');
    });

    test('desktop-firefox returns note and empty steps', () => {
      const res = app.getInstallSteps('desktop-firefox');
      expect(res.note).toContain("Firefox on a computer can't install apps");
      expect(res.steps).toEqual([]);
    });

    test('mac-safari returns Add to Dock instructions', () => {
      const res = app.getInstallSteps('mac-safari');
      expect(res.steps.some(s => s.text.includes('Add to Dock'))).toBe(true);
    });

    test('android-chrome returns menu and install steps', () => {
      const res = app.getInstallSteps('android-chrome');
      expect(res.steps.some(s => s.icon === 'menu')).toBe(true);
      expect(res.steps.some(s => s.text.includes('Install app'))).toBe(true);
    });
  });

  describe('installStepIcon', () => {
    test('returns SVG markup for known icon names', () => {
      expect(app.installStepIcon('share')).toContain('<svg');
      expect(app.installStepIcon('menu')).toContain('<svg');
      expect(app.installStepIcon('home')).toContain('<svg');
      expect(app.installStepIcon('desktop')).toContain('<svg');
    });

    test('returns empty string for unknown icon names', () => {
      expect(app.installStepIcon('nonexistent')).toBe('');
    });
  });
});
