/**
 * Unit tests for extension/background.js core logic
 *
 * Rather than loading the full service worker (which depends on Chrome APIs),
 * we extract and test the pure-logic helper patterns in isolation by directly
 * defining them here as they appear in background.js. This validates behavior
 * without needing a real Chrome environment.
 */

'use strict';

// ---------------------------------------------------------------------------
// Functions mirroring background.js logic — tested in pure-JS isolation
// ---------------------------------------------------------------------------

/**
 * Mirrors the voice-selection logic from script.py's generate_audio, 
 * and future extension voice playback features.
 */
function getSpeakerVoice(speaker) {
  return speaker === 'Alex' ? 'en-US-AndrewNeural' : 'en-US-AvaNeural';
}

/**
 * Mirrors the hostname extraction used in saveHighlight / savePage
 * to produce a human-readable site_name.
 */
function extractSiteName(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'unknown';
  }
}

/**
 * Mirrors the article payload construction in savePage.
 */
function buildSavePayload(userId, tab, article) {
  return {
    user_id: userId,
    url: tab.url,
    title: article.title,
    content: article.content,
    excerpt: article.excerpt,
    site_name: article.siteName || extractSiteName(tab.url),
    author: article.author || null,
    published_at: article.publishedTime || null,
    image_url: article.imageUrl || null,
    source: 'extension',
  };
}

/**
 * Mirrors the highlight payload construction.
 */
function buildHighlightPayload(userId, tab, selectionText) {
  return {
    user_id: userId,
    url: tab.url,
    title: tab.title,
    highlight: selectionText,
    site_name: extractSiteName(tab.url),
    source: 'extension',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractSiteName', () => {
  test('strips www. prefix', () => {
    expect(extractSiteName('https://www.example.com/article')).toBe('example.com');
  });

  test('handles subdomains without www', () => {
    expect(extractSiteName('https://news.ycombinator.com')).toBe('news.ycombinator.com');
  });

  test('returns "unknown" for an invalid URL', () => {
    expect(extractSiteName('not-a-url')).toBe('unknown');
  });
});

describe('buildSavePayload', () => {
  const userId = 'user-abc';
  const tab = { url: 'https://example.com/article', title: 'Example Article' };
  const article = {
    title: 'The Real Title',
    content: 'Full article body...',
    excerpt: 'A short excerpt.',
    siteName: 'example.com',
    author: 'Jane Doe',
    publishedTime: '2026-01-01',
    imageUrl: 'https://example.com/img.png',
  };

  test('includes user_id and source', () => {
    const payload = buildSavePayload(userId, tab, article);
    expect(payload.user_id).toBe(userId);
    expect(payload.source).toBe('extension');
  });

  test('uses article.siteName when provided', () => {
    const payload = buildSavePayload(userId, tab, article);
    expect(payload.site_name).toBe('example.com');
  });

  test('falls back to extractSiteName when siteName is missing', () => {
    const articleNoSite = { ...article, siteName: null };
    const payload = buildSavePayload(userId, tab, articleNoSite);
    expect(payload.site_name).toBe('example.com');
  });

  test('sets author to null when not provided', () => {
    const articleNoAuthor = { ...article, author: undefined };
    const payload = buildSavePayload(userId, tab, articleNoAuthor);
    expect(payload.author).toBeNull();
  });
});

describe('buildHighlightPayload', () => {
  const userId = 'user-abc';
  const tab = { url: 'https://www.news.com/story', title: 'Big News Story' };

  test('includes selection text as highlight', () => {
    const payload = buildHighlightPayload(userId, tab, 'Key insight here.');
    expect(payload.highlight).toBe('Key insight here.');
  });

  test('extracts site_name from tab url', () => {
    const payload = buildHighlightPayload(userId, tab, 'text');
    expect(payload.site_name).toBe('news.com');
  });

  test('sets source to extension', () => {
    const payload = buildHighlightPayload(userId, tab, 'text');
    expect(payload.source).toBe('extension');
  });
});

// ---------------------------------------------------------------------------
// Duplicate saves
//
// The dedup trigger added in supabase/migrations/20260824010000_saves_url_dedup.sql
// suppresses the INSERT for a URL that's already stashed (bumping the existing
// save's date instead), so PostgREST hands back an empty representation.
// savePage reads that empty array as "already saved" rather than as a failure.
// ---------------------------------------------------------------------------

/** Mirrors the duplicate detection in background.js savePage. */
function isDuplicateInsert(result) {
  return Array.isArray(result) && result.length === 0;
}

describe('duplicate save detection', () => {
  test('an empty insert result means the save was deduplicated', () => {
    expect(isDuplicateInsert([])).toBe(true);
  });

  test('a returned row means a new save was created', () => {
    expect(isDuplicateInsert([{ id: 'save-1' }])).toBe(false);
  });

  test('a non-array response is never treated as a duplicate', () => {
    expect(isDuplicateInsert(null)).toBe(false);
    expect(isDuplicateInsert(undefined)).toBe(false);
    expect(isDuplicateInsert({ id: 'save-1' })).toBe(false);
  });

  test('background.js reports duplicates instead of claiming a fresh save', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'extension', 'background.js'),
      'utf8'
    );
    expect(source).toContain('Array.isArray(result) && result.length === 0');
    expect(source).toContain('Already saved');
    // Highlights are exempt from dedup — several highlights from one page are
    // distinct saves, so saveHighlight must not report them as duplicates.
    const highlightFn = source.slice(
      source.indexOf('async function saveHighlight'),
      source.indexOf('async function savePage')
    );
    expect(highlightFn).not.toContain('duplicate');
  });
});
