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
