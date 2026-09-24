/**
 * E2E test for the Stash web app using Puppeteer.
 *
 * Loads web/index.html directly as a file:// URL in headless Chrome.
 * Injects a mock Supabase client before the page scripts run, so the
 * app initialises without real credentials or network access.
 */

'use strict';

const puppeteer = require('puppeteer');
const path = require('path');

let browser;
let page;

const INDEX_URL = `file://${path.resolve(__dirname, '../../web/index.html')}`;

beforeAll(async () => {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
    ],
  });
  page = await browser.newPage();

  // Block all CDN/network requests — the app loads libs from cdn.jsdelivr.net
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    // Abort CDN requests; we inject the mock ourselves below
    if (url.startsWith('http://') || url.startsWith('https://')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Inject mock globals BEFORE each page load so app.js / config.js can find them
  await page.evaluateOnNewDocument(() => {
    // Mock Supabase client
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: (cb) => {
            cb('SIGNED_OUT', null);
            return { data: { subscription: { unsubscribe: () => {} } } };
          },
          signInWithPassword: async () => ({
            data: {},
            error: { message: 'Invalid credentials' },
          }),
        },
        from: () => ({
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
            eq: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
          insert: async () => ({ data: [{ id: 'new-1' }], error: null }),
          update: () => ({
            eq: () => ({ execute: async () => ({}) }),
          }),
        }),
        storage: {
          from: () => ({
            upload: async () => ({ data: {}, error: null }),
            getPublicUrl: () => ({ data: { publicUrl: 'https://cdn.example.com/file' } }),
          }),
        },
      }),
    };

    // Mock config values the app reads at startup
    window.SUPABASE_URL = 'https://fake.supabase.co';
    window.SUPABASE_ANON_KEY = 'fake-anon-key';

    // Silence any console errors from missing features
    window.addEventListener = (...args) => {
      if (args[0] === 'beforeinstallprompt') return;
      EventTarget.prototype.addEventListener.apply(window, args);
    };
  });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('Stash Web App — Auth Screen', () => {
  beforeEach(async () => {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Give scripts a moment to execute
    await new Promise((r) => setTimeout(r, 500));
  });

  test('page title is "Stash"', async () => {
    const title = await page.title();
    expect(title).toBe('Stash');
  });

  test('auth screen element exists in DOM', async () => {
    const authScreen = await page.$('#auth-screen');
    expect(authScreen).not.toBeNull();
  });

  test('sign-in button exists', async () => {
    const signInBtn = await page.$('#signin-btn');
    expect(signInBtn).not.toBeNull();
  });

  test('email and password inputs are present', async () => {
    const email = await page.$('#email');
    const password = await page.$('#password');
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
  });

  test('main app screen exists in DOM', async () => {
    const mainScreen = await page.$('#main-screen');
    expect(mainScreen).not.toBeNull();
  });

  test('viewport and apple status bar meta tags configure edge-to-edge PWA', async () => {
    const viewport = await page.$eval('meta[name="viewport"]', (el) => el.getAttribute('content'));
    expect(viewport).toContain('viewport-fit=cover');

    const statusBarStyle = await page.$eval(
      'meta[name="apple-mobile-web-app-status-bar-style"]',
      (el) => el.getAttribute('content')
    );
    expect(statusBarStyle).toBe('black-translucent');
  });

  test('main-header renders with base padding on iPad viewport', async () => {
    // iPad Air portrait width is 820px
    await page.setViewport({ width: 820, height: 1180 });
    const headerPaddingTop = await page.$eval('.main-header', (el) => {
      return window.getComputedStyle(el).paddingTop;
    });
    // In headless browser where safe-area-inset-top is 0px, calc(12px + 0px) resolves to 12px
    expect(headerPaddingTop).toBe('12px');
  });
});

describe('Stash Web App — reading display options on a phone viewport', () => {
  beforeEach(async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => {
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('main-screen').classList.remove('hidden');
      document.getElementById('reading-body').innerHTML = '<p>body</p>'.repeat(20);
      const pane = document.getElementById('reading-pane');
      pane.classList.remove('hidden');
      pane.classList.add('open');
    });
    await page.click('#reading-style-btn');
  });

  afterAll(async () => {
    await page.setViewport({ width: 800, height: 600, isMobile: false, hasTouch: false });
  });

  test('popover stays within the viewport', async () => {
    const { left, right, width } = await page.evaluate(() => {
      const r = document.getElementById('reading-style-popover').getBoundingClientRect();
      return { left: r.left, right: r.right, width: window.innerWidth };
    });
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(width);
  });

  test('choosing a theme applies it app-wide without dismissing the popover', async () => {
    await page.click('#reading-theme-segmented [data-theme-choice="sepia"]');
    const hidden = await page.$eval('#reading-style-popover', (e) => e.classList.contains('hidden'));
    const attr = await page.$eval('html', (e) => e.getAttribute('data-theme'));
    expect(hidden).toBe(false);
    expect(attr).toBe('sepia');
  });

  test('the backdrop dismisses the popover', async () => {
    await page.mouse.click(195, 120);
    const hidden = await page.$eval('#reading-style-popover', (e) => e.classList.contains('hidden'));
    expect(hidden).toBe(true);
  });
});

describe('Stash Web App — reading Theme control and app-wide Settings toggle stay in sync', () => {
  beforeEach(async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // localStorage persists across goto() on the same origin, so each test
    // would otherwise inherit the previous test's theme/font choice.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => {
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('main-screen').classList.remove('hidden');
      document.getElementById('reading-body').innerHTML = '<p>body</p>'.repeat(20);
      const pane = document.getElementById('reading-pane');
      pane.classList.remove('hidden');
      pane.classList.add('open');
    });
    await page.click('#reading-style-btn');
  });

  afterAll(async () => {
    await page.setViewport({ width: 800, height: 600, isMobile: false, hasTouch: false });
  });

  test('clicking a reading Theme option checks only that option', async () => {
    await page.click('#reading-theme-segmented [data-theme-choice="dark"]');
    const checked = await page.$$eval(
      '#reading-theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.themeChoice)
    );
    expect(checked).toEqual(['dark']);
  });

  test('clicking a reading Theme option does not check every font option', async () => {
    await page.click('#reading-theme-segmented [data-theme-choice="sepia"]');
    const checked = await page.$$eval(
      '#reading-font-family-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.readingFontChoice)
    );
    expect(checked).toEqual(['sans']);
  });

  test('clicking a font option does not check every Theme option', async () => {
    await page.click('#reading-font-family-segmented [data-reading-font-choice="serif"]');
    const checked = await page.$$eval(
      '#reading-theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.themeChoice)
    );
    expect(checked).toEqual(['auto']);
  });

  test('picking a theme from the reading popover also checks it in Settings', async () => {
    await page.click('#reading-theme-segmented [data-theme-choice="dark"]');
    const checked = await page.$$eval(
      '#theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.themeChoice)
    );
    expect(checked).toEqual(['dark']);
  });

  test('picking a theme from the reading popover applies app-wide, outside the reading pane too', async () => {
    await page.click('#reading-theme-segmented [data-theme-choice="sepia"]');
    const attr = await page.$eval('html', (e) => e.getAttribute('data-theme'));
    expect(attr).toBe('sepia');
  });

  test('picking a font from the reading popover does not touch the app-wide theme', async () => {
    await page.click('#reading-font-family-segmented [data-reading-font-choice="serif"]');
    const checked = await page.$$eval(
      '#theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.themeChoice)
    );
    expect(checked).toEqual(['auto']);
  });
});

describe('Stash Web App — select saves for a custom podcast (#133)', () => {
  const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

  beforeEach(async () => {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate((ids) => {
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('main-screen').classList.remove('hidden');
      const app = window.stashApp;
      app.saves = ids.map((id, i) => ({
        id,
        title: `Article ${i}`,
        url: `https://example.com/${i}`,
        site_name: 'Example',
        created_at: '2026-09-01T00:00:00Z',
      }));
      app.renderSaves();
    }, Array.from({ length: 10 }, (_, i) => uuid(i)));
  });

  // el.click() rather than page.click(): a card near the bottom of the small
  // test viewport sits under the fixed select bar, so a mouse click at its
  // centre would land on the bar instead.
  const clickCard = (id) => page.$eval(`#saves-container .save-card[data-id="${id}"]`, (el) => el.click());
  // Same for the bar's own buttons: other fixed banners (e.g. the install
  // prompt) can sit over the bottom of the viewport in this test page.
  const clickBar = (sel) => page.$eval(sel, (el) => el.click());
  const barState = () => page.evaluate(() => ({
    hidden: document.getElementById('select-bar').classList.contains('hidden'),
    count: document.getElementById('select-bar-count').textContent,
    makeDisabled: document.getElementById('select-bar-make').disabled,
    selected: [...document.querySelectorAll('#saves-container .save-card.selected')].map((e) => e.dataset.id),
  }));

  test('the Select button opens the select bar with Make podcast disabled', async () => {
    expect((await barState()).hidden).toBe(true);
    await page.click('#header-select-btn');
    const state = await barState();
    expect(state.hidden).toBe(false);
    expect(state.count).toBe('Pick 2 to 8 saves');
    expect(state.makeDisabled).toBe(true);
    expect(await page.$eval('#header-select-btn', (e) => e.getAttribute('aria-pressed'))).toBe('true');
  });

  test('tapping cards selects them instead of opening the reader', async () => {
    await page.click('#header-select-btn');
    await clickCard(uuid(0));
    let state = await barState();
    expect(state.selected).toEqual([uuid(0)]);
    expect(state.makeDisabled).toBe(true);
    expect(await page.$eval('#reading-pane', (e) => e.classList.contains('open'))).toBe(false);

    await clickCard(uuid(1));
    state = await barState();
    expect(state.count).toBe('2 selected');
    expect(state.makeDisabled).toBe(false);

    await clickCard(uuid(0));
    expect((await barState()).selected).toEqual([uuid(1)]);
  });

  test('selection survives a re-render and stops at 8 saves', async () => {
    await page.click('#header-select-btn');
    for (let i = 0; i < 9; i++) await clickCard(uuid(i));
    await page.evaluate(() => window.stashApp.renderSaves());
    const state = await barState();
    expect(state.selected).toHaveLength(8);
    expect(state.selected).not.toContain(uuid(8));
  });

  test('Make podcast posts the picked save ids and leaves select mode', async () => {
    await page.evaluate(() => {
      window.__podcastRequests = [];
      window.stashApp.getAccessToken = async () => 'fake-token';
      window.fetch = async (url, init) => {
        // Analytics also calls fetch; keep only the podcast request.
        if (String(url).includes('/functions/v1/request-podcast')) {
          window.__podcastRequests.push({ url, body: init.body });
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      };
    });
    await page.click('#header-select-btn');
    await clickCard(uuid(2));
    await clickCard(uuid(0));
    await clickBar('#select-bar-make');
    await page.waitForFunction(() => window.__podcastRequests.length === 1);

    const [req] = await page.evaluate(() => window.__podcastRequests);
    expect(req.url).toMatch(/\/functions\/v1\/request-podcast$/);
    expect(JSON.parse(req.body)).toEqual({ saveIds: [uuid(2), uuid(0)] });

    await page.waitForFunction(() => document.getElementById('select-bar').classList.contains('hidden'));
    expect((await barState()).selected).toEqual([]);
  });

  test('Cancel leaves select mode and clears the selection', async () => {
    await page.click('#header-select-btn');
    await clickCard(uuid(0));
    await clickBar('#select-bar-cancel');
    const state = await barState();
    expect(state.hidden).toBe(true);
    expect(state.selected).toEqual([]);
  });
});
