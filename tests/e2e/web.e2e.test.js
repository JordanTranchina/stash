/**
 * E2E tests for the Stash web app key flows using Puppeteer.
 *
 * Loads web/index.html directly as a file:// URL in headless Chrome.
 * Tests the web UI execution of Key Flows:
 *   - Flow 1: Sign in and session transition
 *   - Flow 3: In-app + button article ingestion
 *   - Flow 4: Reading pane inspection
 *   - Flow 5: Archiving an article
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

  // Block CDN/network requests so the test runs entirely locally
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Inject mock globals BEFORE each page load so app.js / config.js can find them
  await page.evaluateOnNewDocument(() => {
    let authCallback = null;
    let mockSession = null;
    const mockSaves = [
      {
        id: 'save-101',
        title: 'Initial Test Article',
        url: 'https://example.test/article-101',
        excerpt: 'Initial test article excerpt for web E2E',
        content: '<p>Full content of the initial test article in reading pane.</p>',
        is_archived: false,
        read_percent: 0,
        site_name: 'Example News',
        author: 'Alice Tester',
        created_at: new Date().toISOString(),
      },
    ];

    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: mockSession }, error: null }),
          onAuthStateChange: (cb) => {
            authCallback = cb;
            cb(mockSession ? 'SIGNED_IN' : 'SIGNED_OUT', mockSession);
            return { data: { subscription: { unsubscribe: () => { } } } };
          },
          signInWithPassword: async ({ email, password }) => {
            if (password === 'wrong-password') {
              return { data: {}, error: { message: 'Invalid login credentials' } };
            }
            mockSession = {
              access_token: 'fake-jwt-token-123',
              user: { id: 'user-e2e-1', email: email },
            };
            if (authCallback) authCallback('SIGNED_IN', mockSession);
            return { data: { user: mockSession.user, session: mockSession }, error: null };
          },
          signOut: async () => {
            mockSession = null;
            if (authCallback) authCallback('SIGNED_OUT', null);
            return { error: null };
          },
        },
        from: (table) => {
          if (table === 'saves') {
            return {
              select: () => ({
                order: () => ({
                  limit: async () => ({
                    data: mockSaves.filter((s) => !s.is_archived),
                    error: null,
                  }),
                }),
                eq: (field, val) => ({
                  single: async () => ({
                    data: mockSaves.find((s) => s[field] === val) || null,
                    error: null,
                  }),
                  order: () => ({
                    limit: async () => ({
                      data: mockSaves.filter((s) => s[field] === val),
                      error: null,
                    }),
                  }),
                }),
              }),
              insert: async (row) => {
                const newSave = {
                  id: 'save-' + Date.now(),
                  title: row.title || 'Untitled',
                  url: row.url,
                  content: row.content || 'Content',
                  excerpt: row.excerpt || '',
                  is_archived: false,
                  read_percent: 0,
                  created_at: new Date().toISOString(),
                  ...row,
                };
                mockSaves.push(newSave);
                return { data: [newSave], error: null };
              },
              update: (updates) => ({
                eq: (field, val) => {
                  const save = mockSaves.find((s) => s[field] === val);
                  if (save) Object.assign(save, updates);
                  return { execute: async () => ({}), error: null };
                },
              }),
            };
          }
          return {
            select: () => ({
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
              eq: () => ({ single: async () => ({ data: null, error: null }) }),
            }),
            insert: async () => ({ data: [], error: null }),
            update: () => ({ eq: () => ({ execute: async () => ({}) }) }),
          };
        },
        storage: {
          from: () => ({
            upload: async () => ({ data: {}, error: null }),
            getPublicUrl: () => ({ data: { publicUrl: 'https://cdn.example.com/file' } }),
          }),
        },
      }),
    };

    // Mock StashSave for manual addition
    window.StashSave = {
      extractUrlFromText: (t) => t,
      buildScrapeRequest: (data) => data,
      saveViaScrapeDetailed: async (req) => {
        mockSaves.push({
          id: 'manual-' + Date.now(),
          title: 'Manual Added Article',
          url: req.url,
          content: 'Manually added article body',
          excerpt: 'Manual excerpt',
          is_archived: false,
          read_percent: 0,
          created_at: new Date().toISOString(),
        });
        return { ok: true, duplicate: false };
      },
    };

    window.SUPABASE_URL = 'https://fake.supabase.co';
    window.SUPABASE_ANON_KEY = 'fake-anon-key';

    window.addEventListener = (...args) => {
      if (args[0] === 'beforeinstallprompt') return;
      EventTarget.prototype.addEventListener.apply(window, args);
    };
  });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('Stash Web App — Key Flows E2E', () => {
  beforeEach(async () => {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
  });

  test('Flow 1: Auth screen renders and handles invalid vs valid sign-in', async () => {
    expect(await page.title()).toBe('Stash');

    const authScreen = await page.$('#auth-screen');
    expect(authScreen).not.toBeNull();

    // Invalid credentials attempt
    await page.type('#email', 'alice@example.test');
    await page.type('#password', 'wrong-password');
    await page.click('#signin-btn');

    await page.waitForFunction(
      () => document.getElementById('auth-error')?.textContent.length > 0,
      { timeout: 5000 }
    );
    const errorText = await page.$eval('#auth-error', (el) => el.textContent);
    expect(errorText).toContain('Invalid login credentials');

    // Valid credentials attempt
    await page.$eval('#password', (el) => (el.value = ''));
    await page.type('#password', 'Correct-Password-123');
    await page.click('#signin-btn');

    // Main screen should now be visible and auth screen hidden
    await page.waitForFunction(
      () => !document.getElementById('main-screen')?.classList.contains('hidden'),
      { timeout: 5000 }
    );
    const isMainVisible = await page.$eval('#main-screen', (el) => !el.classList.contains('hidden'));
    expect(isMainVisible).toBe(true);
  });

  test('Flow 3: Adding an article via + button modal', async () => {
    // Sign in first
    await page.type('#email', 'alice@example.test');
    await page.type('#password', 'Correct-Password-123');
    await page.click('#signin-btn');
    await page.waitForFunction(
      () => !document.getElementById('main-screen')?.classList.contains('hidden'),
      { timeout: 5000 }
    );

    // Open add URL modal via header + button
    await page.click('#header-add-btn');
    const isModalOpen = await page.$eval('#add-url-modal', (el) => !el.classList.contains('hidden'));
    expect(isModalOpen).toBe(true);

    // Enter URL and save
    await page.type('#add-url-url', 'https://example.test/new-article');
    await page.click('#add-url-save-btn');

    // Wait for success status
    await page.waitForFunction(
      () => document.getElementById('add-url-status')?.classList.contains('success'),
      { timeout: 5000 }
    );
    const statusText = await page.$eval('#add-url-status', (el) => el.textContent);
    expect(statusText).toContain('Saved');
  });

  test('Flow 4 & 5: Reading an article and archiving it', async () => {
    // Sign in
    await page.type('#email', 'alice@example.test');
    await page.type('#password', 'Correct-Password-123');
    await page.click('#signin-btn');
    await page.waitForFunction(
      () => !document.getElementById('main-screen')?.classList.contains('hidden'),
      { timeout: 5000 }
    );

    // Wait for card in saves container
    await page.waitForSelector('.save-card', { timeout: 5000 });
    const cardTitle = await page.$eval('.save-card-title', (el) => el.textContent);
    expect(cardTitle).toContain('Test Article');

    // Click card to open reading pane (Flow 4)
    await page.click('.save-card');
    await page.waitForFunction(
      () => {
        const pane = document.getElementById('reading-pane');
        return pane && !pane.classList.contains('hidden');
      },
      { timeout: 5000 }
    );

    const readingTitle = await page.$eval('#reading-title', (el) => el.textContent);
    expect(readingTitle).toContain('Test Article');

    // Click archive button in reading pane (Flow 5)
    await page.click('#archive-btn');

    // Reading pane should close after archiving
    await page.waitForFunction(
      () => {
        const pane = document.getElementById('reading-pane');
        return pane && pane.classList.contains('hidden');
      },
      { timeout: 5000 }
    );
    const isPaneHidden = await page.$eval('#reading-pane', (el) => el.classList.contains('hidden'));
    expect(isPaneHidden).toBe(true);
  });
});

