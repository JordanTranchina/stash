/**
 * Unit tests for the bot-wall handling in the save-page Edge Function.
 *
 * Sites such as Axios and OpenAI sit behind Cloudflare bot protection and
 * answer every server-side fetch with a challenge page (usually HTTP 403,
 * sometimes 200). save-page used to keep such saves as a bare link. It now
 * spots the challenge page and falls back to the Internet Archive's newest
 * capture of the same article.
 *
 * supabase/functions/save-page/index.ts is a Deno/TypeScript edge function, so
 * (as in x-save-page.test.js) the pure helpers are mirrored here and tested in
 * Node. Keep these in sync with the originals.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers mirrored from supabase/functions/save-page/index.ts
// ---------------------------------------------------------------------------

const BOT_WALL_RE = /<title>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>|\/cdn-cgi\/challenge-platform\/|window\._cf_chl_opt/i;

function isBotWall(html) {
  return !!html && BOT_WALL_RE.test(html);
}

function waybackRawUrl(snapshotUrl) {
  if (!snapshotUrl) return null;
  const match = String(snapshotUrl).match(/^https?:\/\/web\.archive\.org\/web\/(\d+)\/(.+)$/);
  return match ? `https://web.archive.org/web/${match[1]}id_/${match[2]}` : null;
}

// ---------------------------------------------------------------------------

describe('isBotWall', () => {
  test('recognises the Cloudflare block page Axios serves', () => {
    const html = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>…</body></html>';
    expect(isBotWall(html)).toBe(true);
  });

  test('recognises the Cloudflare "Just a moment..." challenge', () => {
    const html = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(isBotWall(html)).toBe(true);
  });

  test('recognises a challenge page by its challenge-platform script alone', () => {
    const html = '<html><head><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></head></html>';
    expect(isBotWall(html)).toBe(true);
  });

  test('does not flag a normal article', () => {
    const html = '<html><head><title>Introducing GPT-5</title></head><body><article><p>Just a moment... we want to explain Cloudflare.</p></article></body></html>';
    expect(isBotWall(html)).toBe(false);
  });

  test('does not flag empty HTML', () => {
    expect(isBotWall('')).toBe(false);
  });
});

describe('waybackRawUrl', () => {
  test('rewrites a snapshot URL to the raw id_ form', () => {
    expect(waybackRawUrl('http://web.archive.org/web/20250807170000/https://openai.com/index/introducing-gpt-5/'))
      .toBe('https://web.archive.org/web/20250807170000id_/https://openai.com/index/introducing-gpt-5/');
  });

  test('keeps the query string of the archived URL', () => {
    expect(waybackRawUrl('https://web.archive.org/web/20250101000000/https://www.axios.com/a?b=1'))
      .toBe('https://web.archive.org/web/20250101000000id_/https://www.axios.com/a?b=1');
  });

  test.each([null, undefined, '', 'https://example.com/not-wayback'])('returns null for %p', (input) => {
    expect(waybackRawUrl(input)).toBeNull();
  });
});
