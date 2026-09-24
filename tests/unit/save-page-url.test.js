/**
 * Unit tests for URL validation in the save-page Edge Function (issue #167).
 *
 * An iOS Shortcut whose request body still held the placeholder text instead
 * of the URLs variable sent the literal word "URLs" as the url. That reached
 * new URL()/fetch() and failed as a 500 "Invalid URL: 'URLs'" in Sentry.
 * save-page now runs the url through normalizeSaveUrl() first and answers a
 * clear 400 when it holds no link.
 *
 * supabase/functions/save-page/index.ts is a Deno/TypeScript edge function, so
 * (as in x-save-page.test.js) the helper is mirrored here and tested in Node.
 * Keep it in sync with the original.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helper mirrored from supabase/functions/save-page/index.ts
// ---------------------------------------------------------------------------

const BARE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d{2,5})?(?:[\/?#]\S*)?$/i;

function normalizeSaveUrl(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const trimPunctuation = (u) => u.replace(/[)\]}>.,;:!?'"]+$/, '');
  const scheme = raw.match(/https?:\/\/[^\s]+/i);
  let candidate = '';
  if (scheme) candidate = trimPunctuation(scheme[0]);
  else if (BARE_HOST_RE.test(trimPunctuation(raw))) candidate = 'https://' + trimPunctuation(raw);
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return candidate;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizeSaveUrl', () => {
  test('rejects the literal Shortcut placeholder "URLs"', () => {
    expect(normalizeSaveUrl('URLs')).toBeNull();
  });

  test('rejects other text with no link', () => {
    expect(normalizeSaveUrl('hello world')).toBeNull();
    expect(normalizeSaveUrl('   ')).toBeNull();
    expect(normalizeSaveUrl('Node.js is great')).toBeNull();
  });

  test('rejects non-string input', () => {
    expect(normalizeSaveUrl(['https://example.com'])).toBeNull();
    expect(normalizeSaveUrl({ url: 'https://example.com' })).toBeNull();
    expect(normalizeSaveUrl(42)).toBeNull();
  });

  test('rejects non-http schemes', () => {
    expect(normalizeSaveUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSaveUrl('file:///etc/passwd')).toBeNull();
  });

  test('keeps a plain http(s) URL exactly as sent', () => {
    expect(normalizeSaveUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeSaveUrl('  http://example.com/a?b=1  ')).toBe('http://example.com/a?b=1');
  });

  test('pulls the link out of shared text', () => {
    expect(normalizeSaveUrl('Great read https://example.com/post.')).toBe('https://example.com/post');
    expect(normalizeSaveUrl('Title\nhttps://share.google/abc')).toBe('https://share.google/abc');
  });

  test('adds https to a bare host', () => {
    expect(normalizeSaveUrl('example.com/article')).toBe('https://example.com/article');
  });
});
