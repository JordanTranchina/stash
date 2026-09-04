// End-to-end tests for X (Twitter) article extraction.
//
// X's web client is a React SPA with essentially no <p> tags, so Readability
// scores X's own chrome (the "Log in or sign up" wall, the "Relevant people"
// sidebar) above the post itself and a save lands with none of the article in
// it. extension/content.js therefore reads X's DOM directly before falling back
// to Readability — these tests pin that behaviour down against fixtures shaped
// like X's real markup.
//
// Requests to x.com are fulfilled from local fixtures, so the tests need no
// network and no X account, but the page still runs at a genuine
// https://x.com/... origin — which matters, because the extractor keys off the
// hostname and the /<handle>/status/<id> path.
//
// Same launch constraints as extension.spec.js: Chromium can't load extensions
// in legacy headless mode, so we use --headless=new.

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXTENSION_PATH = path.join(__dirname, '..', '..', 'extension');
const FIXTURES = path.join(__dirname, 'fixtures');

let context;

// One persistent browser context is shared by the whole file, so tests must not
// open tabs concurrently — they'd race each other for the extension's view of
// which tab is which.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-x-'));

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: process.env.PW_CHROME_EXECUTABLE || undefined,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
});

test.afterAll(async () => {
  await context?.close();
});

// Serve `html` for the navigation and run the content script's extractor
// against it, going through the same chrome.tabs.sendMessage path background.js
// uses so the test covers the real wiring rather than a re-implementation.
async function extractFrom(url, html) {
  const page = await context.newPage();

  await page.route('**/*', (route) => {
    if (route.request().isNavigationRequest()) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.abort();
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const [sw] = context.serviceWorkers();
  const article = await sw.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === targetUrl);
    if (!tab) throw new Error(`no tab for ${targetUrl}`);

    // Content scripts run at document_idle, so the tab can briefly exist with
    // no listener attached yet.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await chrome.tabs.sendMessage(tab.id, { action: 'extractArticle' });
      } catch (e) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('content script never responded');
  }, url);

  await page.close();
  return article;
}

function extractFromFixture(url, fixture) {
  return extractFrom(url, fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'));
}

test('a thread is saved as the full thread text, not X chrome', async () => {
  const article = await extractFromFixture(
    'https://x.com/janedev/status/1234567890123456789',
    'x-thread.html'
  );

  // Every post in the thread, in order.
  expect(article.content).toContain('Why our build got 10x faster');
  expect(article.content).toContain('Incremental compilation alone cut 40 seconds');
  expect(article.content).toContain('caching node_modules properly in CI');

  // Someone else's reply is not part of the article.
  expect(article.content).not.toContain('Check out my newsletter');

  // None of X's own furniture leaks into the body.
  expect(article.content).not.toContain('Trending now');
  expect(article.content).not.toContain('Who to follow');
  expect(article.content).not.toContain('Post your reply');
  expect(article.content).not.toMatch(/\bNotifications\b/);

  // Inline photos survive as Markdown so they render in the reading view.
  expect(article.content).toContain('![](https://pbs.twimg.com/media/AAA');
});

test('thread metadata is usable in the library list', async () => {
  const article = await extractFromFixture(
    'https://x.com/janedev/status/1234567890123456789',
    'x-thread.html'
  );

  // og:title is only ever "Jane Dev (@janedev) on X", which is useless in a
  // reading list — the post's opening line is the real headline.
  expect(article.title).toBe(
    'Why our build got 10x faster. A thread on what actually moved the needle.'
  );
  expect(article.author).toBe('Jane Dev');
  expect(article.siteName).toBe('X');
  expect(article.publishedTime).toBe('2026-08-01T14:02:00.000Z');
  expect(article.imageUrl).toContain('pbs.twimg.com/media/AAA');
});

test('a handle-less /i/web/status URL still excludes other people\'s replies', async () => {
  // These URLs carry no @handle, so the thread author has to come from the
  // first post on the page instead of from the path.
  const article = await extractFromFixture(
    'https://x.com/i/web/status/1234567890123456789',
    'x-thread.html'
  );

  expect(article.content).toContain('Why our build got 10x faster');
  expect(article.content).toContain('caching node_modules properly in CI');
  expect(article.content).not.toContain('Check out my newsletter');
});

test('a long-form X Article is saved with its body and headings', async () => {
  const article = await extractFromFixture(
    'https://x.com/janedev/article/9876543210',
    'x-article.html'
  );

  expect(article.title).toBe('The long slow death of the build step');
  expect(article.author).toBe('Jane Dev');
  expect(article.publishedTime).toBe('2026-07-19T09:30:00.000Z');

  expect(article.content).toContain('For a decade the build step was a fact of life');
  expect(article.content).toContain('Native ES modules landed everywhere');
  expect(article.content).toContain('You trade a build step for a much larger runtime surface');

  // Section headings are kept.
  expect(article.content).toContain('What changed');
  expect(article.content).toContain('What it costs');

  // Sidebar/nav chrome is stripped.
  expect(article.content).not.toContain('Trending now');
  expect(article.content).not.toContain('Subscribe to Premium');
  expect(article.content).not.toContain('Post your reply');

  expect(article.imageUrl).toContain('pbs.twimg.com/media/HEADER');
});

test('non-X pages still go through the normal Readability path', async () => {
  const paragraph =
    '<p>This is a paragraph of a perfectly ordinary article that Readability ' +
    'should handle without any X-specific help at all.</p>';
  const article = await extractFrom(
    'https://example.com/news/a-normal-article',
    `<!DOCTYPE html><html><head><title>A Normal Article</title>
     <meta property="og:site_name" content="Example Times"></head><body>
     <article><h1>A Normal Article</h1>${paragraph.repeat(6)}</article>
     </body></html>`
  );

  expect(article.content).toContain('perfectly ordinary article');
  expect(article.siteName).toBe('Example Times');
});
