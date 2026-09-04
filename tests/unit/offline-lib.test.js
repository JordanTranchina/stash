/**
 * Unit tests for web/offline-lib.js — the shared helper that finds every
 * image URL a save's reading view can render, used by app.js's offline
 * image prefetcher.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStashOffline() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'offline-lib.js'),
    'utf8'
  );
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.self.StashOffline;
}

describe('StashOffline.extractImageUrls', () => {
  const StashOffline = loadStashOffline();

  test('collects markdown inline images plus the thumbnail image_url', () => {
    const save = {
      image_url: 'https://example.com/thumb.jpg',
      content: 'Some text ![a photo](https://example.com/a.jpg) more text ![](https://example.com/b.png "caption")',
    };
    expect(StashOffline.extractImageUrls(save)).toEqual([
      'https://example.com/thumb.jpg',
      'https://example.com/a.jpg',
      'https://example.com/b.png',
    ]);
  });

  test('dedupes repeated URLs', () => {
    const save = {
      image_url: 'https://example.com/a.jpg',
      content: '![one](https://example.com/a.jpg) ![two](https://example.com/a.jpg)',
    };
    expect(StashOffline.extractImageUrls(save)).toEqual(['https://example.com/a.jpg']);
  });

  test('ignores data: URIs and non-http(s) schemes', () => {
    const save = {
      content: '![inline](data:image/png;base64,AAAA) ![ftp](ftp://example.com/x.jpg)',
    };
    expect(StashOffline.extractImageUrls(save)).toEqual([]);
  });

  test('returns an empty array for a save with no content or thumbnail', () => {
    expect(StashOffline.extractImageUrls({})).toEqual([]);
    expect(StashOffline.extractImageUrls(null)).toEqual([]);
  });

  test('handles multiple images across a realistic article body', () => {
    const save = {
      content: [
        '# Title',
        '',
        'Intro paragraph.',
        '',
        '![Figure 1](https://cdn.example.com/fig1.jpg)',
        '',
        'More text with a [regular link](https://example.com/not-an-image) that should be ignored.',
        '',
        '![Figure 2](https://cdn.example.com/fig2.jpg "Figure 2 caption")',
      ].join('\n'),
    };
    expect(StashOffline.extractImageUrls(save)).toEqual([
      'https://cdn.example.com/fig1.jpg',
      'https://cdn.example.com/fig2.jpg',
    ]);
  });
});
