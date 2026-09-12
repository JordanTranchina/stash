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

  test('choosing a theme applies it without dismissing the popover', async () => {
    await page.click('#reading-theme-segmented [data-reading-theme-choice="sepia"]');
    const hidden = await page.$eval('#reading-style-popover', (e) => e.classList.contains('hidden'));
    const attr = await page.$eval('#reading-pane', (e) => e.getAttribute('data-reading-theme'));
    expect(hidden).toBe(false);
    expect(attr).toBe('sepia');
  });

  test('the backdrop dismisses the popover', async () => {
    await page.mouse.click(195, 120);
    const hidden = await page.$eval('#reading-style-popover', (e) => e.classList.contains('hidden'));
    expect(hidden).toBe(true);
  });
});

describe('Stash Web App — reading vs. app-wide theme controls stay independent', () => {
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

  test('clicking a reading theme option checks only that option', async () => {
    await page.click('#reading-theme-segmented [data-reading-theme-choice="dark"]');
    const checked = await page.$$eval(
      '#reading-theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.readingThemeChoice)
    );
    expect(checked).toEqual(['dark']);
  });

  test('clicking a reading theme option does not check every font option', async () => {
    await page.click('#reading-theme-segmented [data-reading-theme-choice="sepia"]');
    const checked = await page.$$eval(
      '#reading-font-family-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.readingFontChoice)
    );
    expect(checked).toEqual(['sans']);
  });

  test('clicking a reading font option does not check every theme option', async () => {
    await page.click('#reading-font-family-segmented [data-reading-font-choice="serif"]');
    const checked = await page.$$eval(
      '#reading-theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.readingThemeChoice)
    );
    expect(checked).toEqual(['auto']);
  });

  test('the app-wide Settings theme toggle is unaffected by reading controls', async () => {
    await page.click('#reading-theme-segmented [data-reading-theme-choice="dark"]');
    await page.click('#reading-font-family-segmented [data-reading-font-choice="serif"]');
    const checked = await page.$$eval(
      '#theme-segmented .theme-segment-btn[aria-checked="true"]',
      (els) => els.map((e) => e.dataset.themeChoice)
    );
    expect(checked).toEqual(['auto']);
  });
});
