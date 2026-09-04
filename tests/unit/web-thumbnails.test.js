/**
 * Unit tests for the card/article image helpers in web/app.js.
 *
 * app.js is a browser script that instantiates StashApp on load, so the class
 * is loaded through Node's vm module with the trailing instantiation stripped:
 * that gives the real prototype methods to test against without running the
 * constructor (which needs a full DOM and a Supabase client).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStashApp() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'app.js'),
    'utf8'
  );
  // Drop everything from the instantiation onward, then hand the class back out.
  const marker = '// Initialize app';
  const index = source.indexOf(marker);
  if (index === -1) throw new Error('app.js no longer ends with the init block');
  const classOnly = `${source.slice(0, index)}\nglobalThis.StashApp = StashApp;`;

  const sandbox = { console, window: {}, document: {}, navigator: {}, CONFIG: {} };
  vm.createContext(sandbox);
  vm.runInContext(classOnly, sandbox);
  return sandbox.StashApp;
}

const StashApp = loadStashApp();
// Methods under test are pure string helpers, so a bare object is enough.
const app = Object.create(StashApp.prototype);

describe('escapeHtml', () => {
  test('escapes the characters that break out of an attribute', () => {
    expect(app.escapeHtml('a"b')).toBe('a&quot;b');
    expect(app.escapeHtml("a'b")).toBe('a&#39;b');
  });

  test('escapes the characters that break out of a text node', () => {
    expect(app.escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  test('returns an empty string for empty input', () => {
    expect(app.escapeHtml('')).toBe('');
    expect(app.escapeHtml(null)).toBe('');
    expect(app.escapeHtml(undefined)).toBe('');
  });
});

describe('safeImageUrl', () => {
  test('keeps an https URL', () => {
    expect(app.safeImageUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  test('upgrades http to https so the page has no mixed content', () => {
    expect(app.safeImageUrl('http://example.com/a.jpg')).toBe('https://example.com/a.jpg');
    expect(app.safeImageUrl('HTTP://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  test('escapes quotes in the URL', () => {
    expect(app.safeImageUrl('https://example.com/a.jpg?x="y')).toBe(
      'https://example.com/a.jpg?x=&quot;y'
    );
  });

  test('treats a protocol-relative URL as https', () => {
    expect(app.safeImageUrl('//example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  test('drops anything that is not http(s)', () => {
    expect(app.safeImageUrl('javascript:alert(1)')).toBe('');
    expect(app.safeImageUrl('data:image/png;base64,AAAA')).toBe('');
    // Site-relative paths resolve against this app's origin, not the article's,
    // so they only ever 404; the monogram tile is the better answer.
    expect(app.safeImageUrl('/resources/images/a.png')).toBe('');
    expect(app.safeImageUrl('')).toBe('');
    expect(app.safeImageUrl(null)).toBe('');
  });
});

describe('cardThumb', () => {
  test('defers loading of the thumbnail and reserves its box', () => {
    const html = app.cardThumb({ image_url: 'https://example.com/a.jpg', site_name: 'Example' });
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('width="96"');
    expect(html).toContain('height="96"');
    expect(html).toContain('src="https://example.com/a.jpg"');
  });

  test('falls back to a monogram tile when the URL is unusable', () => {
    const html = app.cardThumb({ image_url: 'javascript:alert(1)', site_name: 'Example' });
    expect(html).toContain('save-card-thumb-fallback');
    expect(html).not.toContain('<img');
  });

  test('falls back to a monogram tile when there is no image at all', () => {
    const html = app.cardThumb({ site_name: 'Example' });
    expect(html).toContain('save-card-thumb-fallback');
  });

  test('a quote in the site name cannot break out of the data attribute', () => {
    const html = app.cardThumb({
      image_url: 'https://example.com/a.jpg',
      site_name: '" onload="alert(1)',
    });
    // The quote is escaped, so the injected text stays inside data-seed
    // instead of becoming a new attribute.
    expect(html).toContain('data-seed="&quot; onload=&quot;alert(1)"');
    expect(html).not.toContain('onload="alert(1)"');
  });
});
