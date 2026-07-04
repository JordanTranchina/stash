// End-to-end tests for the Stash Chrome extension (#15).
//
// Loads the unpacked MV3 extension into Chromium via a persistent context and
// verifies it registers a background service worker and that the popup renders.
//
// Chromium can't load extensions in the legacy headless mode, so we launch with
// `--headless=new` (works in CI without a display). In this dev environment set
//   PW_CHROME_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
// to reuse the preinstalled browser; in CI Playwright's bundled Chromium is used.

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXTENSION_PATH = path.join(__dirname, '..', '..', 'extension');

let context;
let extensionId;

test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-ext-'));

  context = await chromium.launchPersistentContext(userDataDir, {
    // headless:false + --headless=new is the combination that lets Chromium
    // load extensions without a display.
    headless: false,
    executablePath: process.env.PW_CHROME_EXECUTABLE || undefined,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  // MV3 background is a service worker; its URL contains the extension id.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extensionId = sw.url().split('/')[2];
});

test.afterAll(async () => {
  await context?.close();
});

test('extension loads and registers a background service worker', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('popup renders the main view with a Save button', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page.locator('header h1')).toHaveText('Stash');
  // Single-user mode skips auth and shows the main view immediately.
  await expect(page.locator('#main-view')).toBeVisible();
  await expect(page.locator('#save-page-btn')).toBeVisible();
  await expect(page.locator('#auth-view')).toBeHidden();

  await page.close();
});

test('popup exposes the Open Stash App link and sign-out control', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page.locator('#open-app-link')).toHaveText(/Open Stash App/);
  await expect(page.locator('#signout-btn')).toBeVisible();

  await page.close();
});
