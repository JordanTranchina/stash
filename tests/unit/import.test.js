/**
 * Unit tests for web/import-lib.js — the CSV parser used by the Settings
 * "Import from CSV" flow to bring a reading list over from Pocket, Instapaper,
 * Omnivore, and generic exports.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadStashImport() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'import-lib.js'),
    'utf8'
  );
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.self.StashImport;
}

const StashImport = loadStashImport();

describe('StashImport.parseCsv — Pocket export', () => {
  const csv = [
    'title,url,time_added,tags,status',
    'Local-First Software,https://inkandswitch.com/local-first,1700000000,software,unread',
    'AI and the Future,https://www.wired.com/ai,1700000100,,archive',
  ].join('\n');

  test('extracts url, title, tags, and time_added from named columns', () => {
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      url: 'https://inkandswitch.com/local-first',
      title: 'Local-First Software',
      tags: 'software',
      time_added: '1700000000',
      created_at: new Date(1700000000 * 1000).toISOString(),
    });
    expect(rows[1].url).toBe('https://www.wired.com/ai');
    expect(rows[1].title).toBe('AI and the Future');
  });

  test('normalizes Pocket epoch-second time_added into an ISO created_at', () => {
    const rows = StashImport.parseCsv(csv);
    expect(rows[0].created_at).toBe('2023-11-14T22:13:20.000Z');
    expect(rows[1].created_at).toBe(new Date(1700000100 * 1000).toISOString());
  });
});

describe('StashImport.parseCsv — Instapaper export', () => {
  // Instapaper uses uppercase headers and a Folder/Selection column.
  const csv = [
    'URL,Title,Selection,Folder',
    'https://example.com/a,"Article, with comma",a quote,Unread',
    'https://example.com/b,Another Article,,Starred',
  ].join('\r\n');

  test('handles uppercase headers, CRLF line endings, and quoted commas', () => {
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].url).toBe('https://example.com/a');
    expect(rows[0].title).toBe('Article, with comma');
    expect(rows[0].tags).toBe('Unread'); // Folder maps to tags
    expect(rows[1].url).toBe('https://example.com/b');
  });
});

describe('StashImport.parseCsv — Readwise Reader export', () => {
  // Readwise Reader's export uses a bare "created" column (ISO timestamp).
  const csv = [
    'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
    '123,Some Article,,An excerpt,https://example.com/a,Unsorted,,2025-05-25T00:17:46.679Z,,,false',
  ].join('\n');

  test('recognizes the bare "created" column as the save-date column', () => {
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://example.com/a');
    expect(rows[0].created_at).toBe('2025-05-25T00:17:46.679Z');
  });
});

describe('StashImport.parseCsv — generic / headerless', () => {
  test('infers the URL column when there is no recognizable header row', () => {
    const csv = 'My Title,https://example.com/x\nOther,https://example.com/y';
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      url: 'https://example.com/x',
      title: 'My Title',
    });
  });

  test('finds the URL when it is in the first column', () => {
    const csv = 'https://example.com/x,My Title';
    const rows = StashImport.parseCsv(csv);
    expect(rows[0].url).toBe('https://example.com/x');
    expect(rows[0].title).toBe('My Title');
  });
});

describe('StashImport.parseCsv — edge cases', () => {
  test('returns [] for empty input', () => {
    expect(StashImport.parseCsv('')).toEqual([]);
    expect(StashImport.parseCsv(null)).toEqual([]);
  });

  test('skips rows without a valid http(s) URL', () => {
    const csv = [
      'title,url',
      'No URL here,',
      'Bad scheme,ftp://example.com/file',
      'Good one,https://example.com/ok',
    ].join('\n');
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://example.com/ok');
  });

  test('deduplicates repeated URLs, keeping the first', () => {
    const csv = [
      'title,url',
      'First,https://example.com/dup',
      'Second,https://example.com/dup',
      'Third,https://example.com/other',
    ].join('\n');
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('First');
    expect(rows.map(r => r.url)).toEqual([
      'https://example.com/dup',
      'https://example.com/other',
    ]);
  });

  test('strips a UTF-8 BOM before the header row', () => {
    const csv = '﻿title,url\nHello,https://example.com/z';
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://example.com/z');
  });

  test('handles quoted fields containing newlines', () => {
    const csv = 'title,url\n"Multi\nline title",https://example.com/nl';
    const rows = StashImport.parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Multi\nline title');
    expect(rows[0].url).toBe('https://example.com/nl');
  });

  test('leaves created_at null when there is no time column', () => {
    const csv = 'title,url\nHello,https://example.com/z';
    expect(StashImport.parseCsv(csv)[0].created_at).toBeNull();
  });
});

describe('StashImport.parseTimestamp', () => {
  test('parses Unix epoch seconds (Pocket)', () => {
    expect(StashImport.parseTimestamp('1700000000')).toBe('2023-11-14T22:13:20.000Z');
  });

  test('parses Unix epoch milliseconds', () => {
    expect(StashImport.parseTimestamp('1700000000000')).toBe('2023-11-14T22:13:20.000Z');
  });

  test('parses an ISO date string', () => {
    expect(StashImport.parseTimestamp('2024-01-15T10:30:00Z')).toBe('2024-01-15T10:30:00.000Z');
  });

  test('returns null for empty or unparseable values', () => {
    expect(StashImport.parseTimestamp('')).toBeNull();
    expect(StashImport.parseTimestamp(null)).toBeNull();
    expect(StashImport.parseTimestamp('not a date')).toBeNull();
  });

  test('rejects out-of-range values (e.g. a raw 0 timestamp)', () => {
    expect(StashImport.parseTimestamp('0')).toBeNull();
  });
});
