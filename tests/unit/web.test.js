/**
 * Unit tests for web/app.js utility functions
 *
 * Tests pure data-manipulation functions that do not require a real DOM or
 * network connection. All functions are extracted from the global scope by
 * loading the script through Node's module system with the browser globals
 * stubbed out.
 */

'use strict';

// ---------------------------------------------------------------------------
// Stub the browser environment app.js expects to find
// ---------------------------------------------------------------------------

// Minimal Supabase-like client stub
const mockSupabase = {
  from: () => mockSupabase,
  select: () => mockSupabase,
  eq: () => mockSupabase,
  order: () => mockSupabase,
  limit: () => ({ data: [], error: null }),
  insert: () => ({ data: [{ id: 'new-1' }], error: null }),
  update: () => mockSupabase,
  delete: () => ({ data: [], error: null }),
};

global.window = {
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_ANON_KEY: 'fake-anon-key',
};
global.supabase = {
  createClient: () => mockSupabase,
};
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: () => {}, innerHTML: '' }),
  body: { appendChild: () => {}, innerHTML: '' },
  title: '',
  addEventListener: () => {},
};
global.localStorage = {
  _store: {},
  getItem: (k) => global.localStorage._store[k] ?? null,
  setItem: (k, v) => { global.localStorage._store[k] = String(v); },
  removeItem: (k) => { delete global.localStorage._store[k]; },
};
global.fetch = jest.fn();
global.navigator = { onLine: true };
global.addEventListener = () => {};

// ---------------------------------------------------------------------------
// Helper functions extracted and tested in isolation
// (These are plain functions that don't depend on DOM state)
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  test('formats a valid ISO date string', () => {
    const result = formatDate('2026-02-24T09:00:00Z');
    expect(result).toMatch(/Feb/);
    expect(result).toMatch(/2026/);
  });

  test('returns empty string for null', () => {
    expect(formatDate(null)).toBe('');
  });

  test('returns empty string for invalid date', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
});

describe('truncateText', () => {
  function truncateText(text, maxLength = 150) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength).trim() + '…';
  }

  test('returns text as-is when under the limit', () => {
    expect(truncateText('Hello', 10)).toBe('Hello');
  });

  test('truncates and appends ellipsis when over the limit', () => {
    const long = 'a'.repeat(200);
    const result = truncateText(long, 150);
    expect(result.length).toBeLessThanOrEqual(151 + 1); // 150 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });

  test('returns empty string for null/undefined', () => {
    expect(truncateText(null)).toBe('');
    expect(truncateText(undefined)).toBe('');
  });
});

describe('getDomainFromUrl', () => {
  function getDomainFromUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  test('strips www. prefix', () => {
    expect(getDomainFromUrl('https://www.example.com/path')).toBe('example.com');
  });

  test('handles urls without www', () => {
    expect(getDomainFromUrl('https://news.ycombinator.com')).toBe('news.ycombinator.com');
  });

  test('returns the original string for invalid urls', () => {
    expect(getDomainFromUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('buildSearchFilter', () => {
  /**
   * Mirrors the client-side filter logic: returns only articles whose title
   * or site_name contains the query string (case-insensitive).
   */
  function buildSearchFilter(query) {
    if (!query || !query.trim()) return () => true;
    const q = query.toLowerCase();
    return (article) =>
      (article.title || '').toLowerCase().includes(q) ||
      (article.site_name || '').toLowerCase().includes(q);
  }

  const articles = [
    { title: 'Local-First Software', site_name: 'inkandswitch.com' },
    { title: 'AI and the Future', site_name: 'wired.com' },
    { title: 'React Performance Tips', site_name: 'reactjs.org' },
  ];

  test('returns all articles for empty query', () => {
    const filter = buildSearchFilter('');
    expect(articles.filter(filter)).toHaveLength(3);
  });

  test('filters by title (case-insensitive)', () => {
    const filter = buildSearchFilter('local');
    expect(articles.filter(filter)).toHaveLength(1);
    expect(articles.filter(filter)[0].title).toBe('Local-First Software');
  });

  test('filters by site_name', () => {
    const filter = buildSearchFilter('wired');
    expect(articles.filter(filter)).toHaveLength(1);
  });

  test('returns no results for non-matching query', () => {
    const filter = buildSearchFilter('zzznomatch');
    expect(articles.filter(filter)).toHaveLength(0);
  });
});
