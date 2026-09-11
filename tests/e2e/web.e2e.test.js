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

describe('Stash Web App — Reading Mode & In-Article Customization', () => {
  beforeEach(async () => {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
  });

  test('Reading mode button exists in reading footer', async () => {
    const btn = await page.$('#reading-mode-btn');
    expect(btn).not.toBeNull();
    const text = await page.evaluate(el => el.textContent, btn);
    expect(text).toContain('Reading mode');
  });

  test('Reading mode bottom sheet modal and controls exist', async () => {
    const sheet = await page.$('#reading-mode-sheet');
    expect(sheet).not.toBeNull();

    const pills = await page.$$('.font-pill-btn');
    expect(pills.length).toBe(4);

    const slider = await page.$('#reader-font-slider');
    expect(slider).not.toBeNull();
    const min = await page.evaluate(el => el.min, slider);
    const max = await page.evaluate(el => el.max, slider);
    expect(min).toBe('100');
    expect(max).toBe('175');

    const badge = await page.$('#reader-font-badge');
    expect(badge).not.toBeNull();

    const swatches = await page.$$('.theme-swatch-btn');
    expect(swatches.length).toBe(3);
  });

  test('Settings tab has Reading Preferences (Global Defaults) and Account sections', async () => {
    const accountSection = await page.$('#settings-account-section');
    expect(accountSection).not.toBeNull();

    const fontRow = await page.$('#settings-reader-font-row');
    const scaleRow = await page.$('#settings-reader-scale-row');
    const themeRow = await page.$('#settings-reader-theme-row');
    const syncToggle = await page.$('#settings-reader-sync-toggle');

    expect(fontRow).not.toBeNull();
    expect(scaleRow).not.toBeNull();
    expect(themeRow).not.toBeNull();
    expect(syncToggle).not.toBeNull();
  });

  test('Tapping reading-mode-btn opens bottom sheet', async () => {
    // Initially sheet has hidden class
    const initialHidden = await page.evaluate(() => {
      const sheet = document.getElementById('reading-mode-sheet');
      return sheet.classList.contains('hidden');
    });
    expect(initialHidden).toBe(true);

    // Click Reading mode button
    await page.evaluate(() => {
      document.getElementById('reading-mode-btn').click();
    });

    // Sheet should now be open (no longer hidden)
    const afterClickHidden = await page.evaluate(() => {
      const sheet = document.getElementById('reading-mode-sheet');
      return sheet.classList.contains('hidden');
    });
    expect(afterClickHidden).toBe(false);

    // Clicking close button hides sheet
    await page.evaluate(() => {
      document.getElementById('close-reading-mode-sheet-btn').click();
    });
    const afterCloseHidden = await page.evaluate(() => {
      const sheet = document.getElementById('reading-mode-sheet');
      return sheet.classList.contains('hidden');
    });
    expect(afterCloseHidden).toBe(true);
  });

  test('Selecting font, scale, and theme applies reactive styles and updates settings parity', async () => {
    // 1. Select Serif font pill
    await page.evaluate(() => {
      const serifBtn = document.querySelector('.font-pill-btn[data-font="serif"]');
      serifBtn.click();
    });

    const fontPillActive = await page.evaluate(() => {
      const btn = document.querySelector('.font-pill-btn[data-font="serif"]');
      const pane = document.getElementById('reading-pane');
      const fontVal = document.getElementById('settings-reader-font-val');
      return {
        hasActiveClass: btn.classList.contains('active'),
        readerFontVar: pane.style.getPropertyValue('--reader-font'),
        settingsText: fontVal.textContent,
      };
    });

    expect(fontPillActive.hasActiveClass).toBe(true);
    expect(fontPillActive.readerFontVar).toContain('Merriweather');
    expect(fontPillActive.settingsText).toBe('Serif');

    // 2. Adjust slider scale to 150%
    await page.evaluate(() => {
      const slider = document.getElementById('reader-font-slider');
      slider.value = 150;
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('change'));
    });

    const scaleActive = await page.evaluate(() => {
      const pane = document.getElementById('reading-pane');
      const badge = document.getElementById('reader-font-badge');
      const scaleVal = document.getElementById('settings-reader-scale-val');
      return {
        scaleVar: pane.style.getPropertyValue('--reader-scale'),
        scaleNumVar: pane.style.getPropertyValue('--reader-scale-num'),
        badgeText: badge.textContent,
        settingsText: scaleVal.textContent,
      };
    });

    expect(scaleActive.scaleVar).toBe('150%');
    expect(scaleActive.scaleNumVar).toBe('1.5');
    expect(scaleActive.badgeText).toBe('150%');
    expect(scaleActive.settingsText).toBe('150%');

    // 3. Select Sepia theme swatch
    await page.evaluate(() => {
      const sepiaBtn = document.querySelector('.theme-swatch-btn[data-theme="sepia"]');
      sepiaBtn.click();
    });

    const themeActive = await page.evaluate(() => {
      const btn = document.querySelector('.theme-swatch-btn[data-theme="sepia"]');
      const pane = document.getElementById('reading-pane');
      const themeVal = document.getElementById('settings-reader-theme-val');
      const stored = JSON.parse(localStorage.getItem('stash_reader_settings') || '{}');
      return {
        hasActiveClass: btn.classList.contains('active'),
        readerBgVar: pane.style.getPropertyValue('--reader-bg'),
        readerTextVar: pane.style.getPropertyValue('--reader-text'),
        settingsText: themeVal.textContent,
        storedTheme: stored.theme,
        storedFont: stored.font,
        storedScale: stored.scale,
      };
    });

    expect(themeActive.hasActiveClass).toBe(true);
    expect(themeActive.readerBgVar).toBe('#F5EADB');
    expect(themeActive.readerTextVar).toBe('#2D241E');
    expect(themeActive.settingsText).toBe('Sepia');
    expect(themeActive.storedTheme).toBe('sepia');
    expect(themeActive.storedFont).toBe('serif');
    expect(themeActive.storedScale).toBe(150);
  });
});
