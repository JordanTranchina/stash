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

  test('keeps only url/user_id/source/highlight — no client-derived title', () => {
    const req = StashSave.buildScrapeRequest({
      user_id: 'user-1',
      url: 'https://example.com/article',
      source: 'share-target',
      highlight: null,
      title: 'should be ignored',
      site_name: 'should be ignored',
    });
    expect(req).toEqual({
      url: 'https://example.com/article',
      user_id: 'user-1',
      source: 'share-target',
      highlight: null,
    });
    expect(req).not.toHaveProperty('title');
    expect(req).not.toHaveProperty('site_name');
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
      user_id: 'u1',
      source: 'share-target',
      highlight: null,
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://fake.supabase.co/functions/v1/save-page');
    expect(calls[0].opts.method).toBe('POST');
    const body = JSON.parse(calls[0].opts.body);
    expect(body.url).toBe('https://example.com');
    expect(body.user_id).toBe('u1');
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
    const ok = await sandbox.self.StashSave.saveViaScrape({ url: 'x', user_id: 'u' });
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Share-target URL extraction (mirrors web/save.html)
// ---------------------------------------------------------------------------

describe('share-target URL extraction', () => {
  // Mirrors the logic in save.html's DOMContentLoaded handler.
  function resolveSharedUrl(pUrl, pText) {
    pUrl = pUrl || '';
    pText = pText || '';
    if (!pUrl && pText) {
      const match = pText.match(/https?:\/\/[^\s]+/);
      if (match) pUrl = match[0];
    }
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
});
