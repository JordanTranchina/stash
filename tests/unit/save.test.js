/**
 * Unit tests for the mobile save/ingestion path.
 *
 * Covers:
 *   1. web/save-lib.js — the shared helper that builds the scrape request sent
 *      to the save-page Edge Function (the fix that makes mobile saves actually
 *      ingest the article instead of storing the shared link).
 *   2. The share-target URL extraction logic from web/save.html, which has to
 *      cope with share sheets that cram "Title https://…" into the `text` field.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// 1. Load web/save-lib.js in a sandbox and exercise StashSave
// ---------------------------------------------------------------------------

function loadStashSave(config) {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'save-lib.js'),
    'utf8'
  );
  const sandbox = { self: {}, CONFIG: config };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.self.StashSave;
}

describe('StashSave.buildScrapeRequest', () => {
  const StashSave = loadStashSave({});

  test('passes title through as a fallback but ignores other client-derived fields', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com/article',
      source: 'share-target',
      highlight: null,
      title: 'Shared page title',
      site_name: 'should be ignored',
    });
    expect(req).toEqual({
      url: 'https://example.com/article',
      source: 'share-target',
      highlight: null,
      // Included as a fallback title only; the server prefers the scraped
      // title and uses this just for pages it can't scrape.
      title: 'Shared page title',
    });
    expect(req).not.toHaveProperty('site_name');
  });

  test('omits title when not provided (a successful scrape derives its own)', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com/article',
      source: 'share-target',
    });
    expect(req).not.toHaveProperty('title');
  });

  test('defaults source to mobile-web and highlight to null', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com',
    });
    expect(req.source).toBe('mobile-web');
    expect(req.highlight).toBeNull();
  });

  test('preserves a genuine user note as the highlight', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com',
      source: 'mobile-web',
      highlight: 'my note',
    });
    expect(req.highlight).toBe('my note');
  });

  test('omits created_at when not provided (live shares keep now())', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com',
    });
    expect(req).not.toHaveProperty('created_at');
  });

  test('includes created_at when provided (CSV import preserves save date)', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com',
      source: 'import',
      created_at: '2023-11-14T22:13:20.000Z',
    });
    expect(req.created_at).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('StashSave.saveViaScrape', () => {
  const CONFIG = {
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
  };

  test('POSTs the request to the save-page Edge Function and returns ok', async () => {
    const calls = [];
    const sandbox = {
      self: {},
      CONFIG,
      fetch: (url, opts) => {
        calls.push({ url, opts });
        return Promise.resolve({ ok: true });
      },
    };
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'web', 'save-lib.js'),
      'utf8'
    );
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const ok = await sandbox.self.StashSave.saveViaScrape({
      url: 'https://example.com',
      source: 'share-target',
      highlight: null,
    }, 'access-token-123');

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://fake.supabase.co/functions/v1/save-page');
    expect(calls[0].opts.method).toBe('POST');
    // The user is derived from the JWT server-side, so the token — not a
    // client-supplied id — is what attributes the save.
    expect(calls[0].opts.headers.Authorization).toBe('Bearer access-token-123');
    const body = JSON.parse(calls[0].opts.body);
    expect(body.url).toBe('https://example.com');
    expect(body).not.toHaveProperty('user_id');
  });

  test('refuses to send a save with no access token, flagging it as a sign-in problem', async () => {
    const sandbox = {
      self: {},
      CONFIG,
      fetch: () => {
        throw new Error('should not have been called');
      },
    };
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'web', 'save-lib.js'),
      'utf8'
    );
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    await expect(
      sandbox.self.StashSave.saveViaScrape({ url: 'https://example.com' })
    ).rejects.toMatchObject({ noSession: true });
  });

  test('returns false when the function responds non-ok', async () => {
    const sandbox = {
      self: {},
      CONFIG,
      fetch: () => Promise.resolve({ ok: false }),
    };
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'web', 'save-lib.js'),
      'utf8'
    );
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const ok = await sandbox.self.StashSave.saveViaScrape({ url: 'x' }, 'access-token-123');
    expect(ok).toBe(false);
  });
});

describe('StashSave.saveViaScrapeDetailed', () => {
  const CONFIG = {
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
  };

  function loadWithFetch(fetchImpl) {
    const sandbox = { self: {}, CONFIG, fetch: fetchImpl };
    const code = fs.readFileSync(
      path.join(__dirname, '..', '..', 'web', 'save-lib.js'),
      'utf8'
    );
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.self.StashSave;
  }

  test('reports a duplicate when the server merged the save into an existing one', async () => {
    const StashSave = loadWithFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, duplicate: true }) })
    );
    const result = await StashSave.saveViaScrapeDetailed({ url: 'x' }, 'access-token-123');
    expect(result).toEqual({ ok: true, duplicate: true });
  });

  test('reports a fresh save as not a duplicate', async () => {
    const StashSave = loadWithFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, duplicate: false }) })
    );
    expect(await StashSave.saveViaScrapeDetailed({ url: 'x' }, 'access-token-123')).toEqual({
      ok: true,
      duplicate: false,
    });
  });

  test('a save with an unreadable body still counts as saved', async () => {
    const StashSave = loadWithFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) })
    );
    expect(await StashSave.saveViaScrapeDetailed({ url: 'x' }, 'access-token-123')).toEqual({
      ok: true,
      duplicate: false,
    });
  });

  test('a non-ok response is not a save', async () => {
    const StashSave = loadWithFetch(() => Promise.resolve({ ok: false }));
    expect(await StashSave.saveViaScrapeDetailed({ url: 'x' }, 'access-token-123')).toEqual({
      ok: false,
      duplicate: false,
    });
  });

  test('saveViaScrape still answers with a plain boolean', async () => {
    const StashSave = loadWithFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ duplicate: true }) })
    );
    expect(await StashSave.saveViaScrape({ url: 'x' }, 'access-token-123')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Share-target / paste URL extraction (StashSave.extractUrlFromText, used
//    by save.html's share-target + clipboard fallback and app.js's Add URL
//    modal paste button, paste event, and Save fallback)
// ---------------------------------------------------------------------------

describe('StashSave.extractUrlFromText', () => {
  const StashSave = loadStashSave({});

  // Mirrors save.html's "explicit url param wins, else extract from text" logic.
  function resolveSharedUrl(pUrl, pText) {
    pUrl = pUrl || '';
    pText = pText || '';
    if (!pUrl && pText) pUrl = StashSave.extractUrlFromText(pText);
    return pUrl;
  }

  test('uses the explicit url param when present', () => {
    expect(resolveSharedUrl('https://share.google/abc', 'Some Title')).toBe(
      'https://share.google/abc'
    );
  });

  test('extracts a URL embedded after the title in the text field', () => {
    const text =
      'The Dune keypad device can be your meeting controller and more | TechCrunch https://share.google/YgYwRsilx54VxAM4B';
    expect(resolveSharedUrl('', text)).toBe('https://share.google/YgYwRsilx54VxAM4B');
  });

  test('extracts a URL when the text starts with it', () => {
    expect(resolveSharedUrl('', 'https://example.com/post extra words')).toBe(
      'https://example.com/post'
    );
  });

  test('returns empty string when no URL is anywhere in the share', () => {
    expect(resolveSharedUrl('', 'just a plain title, no link')).toBe('');
  });

  test('returns empty string for empty/undefined input', () => {
    expect(StashSave.extractUrlFromText('')).toBe('');
    expect(StashSave.extractUrlFromText(undefined)).toBe('');
  });

  test('passes a bare URL straight through', () => {
    expect(StashSave.extractUrlFromText('https://example.com/article')).toBe(
      'https://example.com/article'
    );
  });

  test('strips a trailing closing paren picked up from surrounding text', () => {
    expect(
      StashSave.extractUrlFromText('[Updates] Patch Notes (All Platforms) (https://example.com/patch-notes)')
    ).toBe('https://example.com/patch-notes');
  });

  test('strips trailing sentence punctuation', () => {
    expect(StashSave.extractUrlFromText('Check this out: https://example.com/foo.')).toBe(
      'https://example.com/foo'
    );
  });

  test('strips angle brackets around a Markdown-style link', () => {
    expect(StashSave.extractUrlFromText('See <https://example.com/bar> for details')).toBe(
      'https://example.com/bar'
    );
  });

  test('takes the target out of a Markdown link, not the label', () => {
    expect(
      StashSave.extractUrlFromText('[www.example.com](https://www.example.com/piece)')
    ).toBe('https://www.example.com/piece');
  });

  // A browser's address bar accepts a bare host, and share sheets sometimes
  // strip the protocol, so these are links a person plainly meant.
  test('assumes https for a bare host pasted on its own', () => {
    expect(StashSave.extractUrlFromText('example.com')).toBe('https://example.com');
    expect(StashSave.extractUrlFromText('www.example.com')).toBe('https://www.example.com');
    expect(StashSave.extractUrlFromText('  example.com  ')).toBe('https://example.com');
  });

  test('keeps the path, query and port on a bare host', () => {
    expect(StashSave.extractUrlFromText('example.com/a/b?c=1#d')).toBe(
      'https://example.com/a/b?c=1#d'
    );
    expect(StashSave.extractUrlFromText('sub.example.co.uk:8443/x')).toBe(
      'https://sub.example.co.uk:8443/x'
    );
  });

  test('strips trailing punctuation from a bare host', () => {
    expect(StashSave.extractUrlFromText('example.com.')).toBe('https://example.com');
  });

  test('finds a www. host inside a sentence', () => {
    expect(StashSave.extractUrlFromText('check out www.example.com its good')).toBe(
      'https://www.example.com'
    );
  });

  // Without a scheme or a www. prefix, a dotted token mid-sentence is far more
  // likely to be prose than a link, so it is only honoured on its own.
  test('does not treat a dotted word inside a sentence as a host', () => {
    expect(StashSave.extractUrlFromText('I rewrote it in Node.js last week')).toBe('');
    expect(StashSave.extractUrlFromText('open report.pdf and tell me')).toBe('');
  });

  test('does not treat version numbers or abbreviations as hosts', () => {
    expect(StashSave.extractUrlFromText('1.2.3')).toBe('');
    expect(StashSave.extractUrlFromText('e.g')).toBe('');
    expect(StashSave.extractUrlFromText('etc.')).toBe('');
  });

  test('still returns empty for text with nothing link-shaped in it', () => {
    expect(StashSave.extractUrlFromText('just a plain title, no link')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. Slug-title fallback (mirrors titleFromUrl in save-page/index.ts)
//
// When a page can't be scraped (Medium and other bot-blocked/paywalled sites
// return 403 to the server fetch) the save-page function saves the link anyway
// and derives a readable title from the URL slug instead of "Untitled".
// ---------------------------------------------------------------------------

describe('slug title fallback', () => {
  function titleFromUrl(u) {
    try {
      const slug = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
      const cleaned = slug
        .replace(/\.(html?|php|aspx?)$/i, '')
        .replace(/-[0-9a-f]{6,}$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (!cleaned) return '';
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    } catch {
      return '';
    }
  }

  test('turns a Medium slug (with trailing hash id) into a readable title', () => {
    expect(
      titleFromUrl('https://medium.com/@ZacThePM/keep-your-tape-straight-dc0aba7a1df9')
    ).toBe('Keep your tape straight');
  });

  test('cleans a plain hyphenated slug', () => {
    expect(titleFromUrl('https://example.com/blog/how-to-fold-a-map')).toBe(
      'How to fold a map'
    );
  });

  test('strips a file extension', () => {
    expect(titleFromUrl('https://example.com/posts/my-article.html')).toBe(
      'My article'
    );
  });

  test('returns empty string for a slugless URL so callers fall back to Untitled', () => {
    expect(titleFromUrl('https://example.com/')).toBe('');
  });
});
