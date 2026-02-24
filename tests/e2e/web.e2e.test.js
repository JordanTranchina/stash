/**
 * E2E test for the Stash web app using Puppeteer.
 *
 * This test loads the web app's index.html in a real Chrome browser,
 * intercepts all Supabase network calls, and verifies that the auth screen
 * renders with the correct elements. No real Supabase credentials are needed.
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  page = await browser.newPage();

  // Intercept Supabase calls so the page doesn't make real API requests
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('supabase') || url.includes('cdn.jsdelivr')) {
      req.respond({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.supabase = {
            createClient: () => ({
              auth: {
                getSession: async () => ({ data: { session: null }, error: null }),
                onAuthStateChange: (cb) => { cb('SIGNED_OUT', null); return { data: { subscription: { unsubscribe: () => {} } } }; },
                signInWithPassword: async () => ({ data: {}, error: { message: 'Invalid credentials' } }),
              },
              from: () => ({ select: async () => ({ data: [], error: null }) }),
            })
          };
        `,
      });
    } else {
      req.continue();
    }
  });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('Stash Web App — Auth Screen', () => {
  beforeEach(async () => {
    await page.goto(INDEX_URL, { waitUntil: 'networkidle0', timeout: 15000 });
  });

  test('page title is "Stash"', async () => {
    const title = await page.title();
    expect(title).toBe('Stash');
  });

  test('auth screen is visible on first load', async () => {
    const authScreen = await page.$('#auth-screen');
    expect(authScreen).not.toBeNull();
    const isVisible = await page.evaluate((el) => {
      const styles = window.getComputedStyle(el);
      return styles.display !== 'none' && styles.visibility !== 'hidden';
    }, authScreen);
    expect(isVisible).toBe(true);
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

  test('main app screen is hidden initially', async () => {
    const mainScreen = await page.$('#main-screen');
    const hasHidden = await page.evaluate(
      (el) => el.classList.contains('hidden'),
      mainScreen
    );
    expect(hasHidden).toBe(true);
  });
});
