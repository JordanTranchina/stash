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

test('popup opens on the sign-in form when there is no session', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page.locator('header h1')).toHaveText('Stash');
  // Saving is attributed to a signed-in user, so a fresh profile lands on the
  // auth view rather than the library.
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#signin-btn')).toBeVisible();
  await expect(page.locator('#main-view')).toBeHidden();

  await page.close();
});

test('popup no longer carries a save button — the toolbar icon is the save', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // Saving moved to a single click on the toolbar icon, so neither the save
  // button nor the post-save "View in Stash" shortcut exists any more.
  await expect(page.locator('#save-page-btn')).toHaveCount(0);
  await expect(page.locator('#view-in-stash-btn')).toHaveCount(0);

  await page.close();
});

test('signed-in controls live in the main view, behind the session', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // Present in the DOM but gated on the main view, which stays hidden until a
  // session exists. Right-clicking the toolbar icon reaches the same actions.
  await expect(page.locator('#open-app-link')).toHaveText(/Open Stash App/);
  await expect(page.locator('#signout-btn')).toHaveCount(1);
  await expect(page.locator('#signout-btn')).toBeHidden();

  await page.close();
});

test('the toolbar icon has no default popup, so a click saves', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8')
  );
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.action.default_icon).toBeTruthy();
});
