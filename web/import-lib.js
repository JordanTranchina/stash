// Stash CSV import helper.
//
// Parses the CSV export from common read-it-later services (Pocket, Instapaper,
// Omnivore, Readwise Reader, and generic url/title exports) into a normalized
// list of { url, title, tags, time_added } rows. Each row is then re-ingested
// through the save-page Edge Function — the same scraping path the extension
// and mobile share sheet use — so imported articles arrive with full content.
//
// Exposed on `self` so it works in a page (self === window) and can be loaded
// standalone in Node for unit tests (see tests/unit/import.test.js).
(function (root) {
  const URL_RE = /^https?:\/\//i;

  // Split raw CSV text into rows of fields. Honors double-quoted values that
  // may contain commas, newlines, or escaped ("") quotes, and copes with both
  // \n and \r\n line endings.
  function parseRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
          else inQuotes = false;
        } else {
          field += c;
        }
        continue;
      }

      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++; // swallow \n of a \r\n pair
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }

    // Flush a trailing field/row when the file doesn't end with a newline.
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // Index of the first header whose normalized name is in `candidates`.
  function findColumn(headers, candidates) {
    for (let i = 0; i < headers.length; i++) {
      if (candidates.includes(headers[i].trim().toLowerCase())) return i;
    }
    return -1;
  }

  // Parse a read-it-later CSV export into normalized rows. Auto-detects the URL
  // and title columns across Pocket / Instapaper / Omnivore / generic formats.
  // Rows without a usable http(s) URL are skipped; duplicate URLs are removed,
  // keeping the first occurrence.
  function parseCsv(text) {
    if (!text) return [];
    text = text.replace(/^﻿/, ''); // strip UTF-8 BOM some exporters prepend

    const rows = parseRows(text).filter(r => r.some(f => f.trim() !== ''));
    if (rows.length === 0) return [];

    const headers = rows[0].map(h => h.trim());
    const HEADER_RE = /^(url|link|href|title|name|time_added|timeadded|saved|date|created_at|tags|tag|folder|status|selection)$/i;
    const looksLikeHeader = headers.some(h => HEADER_RE.test(h));

    let urlIdx, titleIdx, tagsIdx, timeIdx, dataRows;
    if (looksLikeHeader) {
      urlIdx = findColumn(headers, ['url', 'link', 'href']);
      titleIdx = findColumn(headers, ['title', 'name']);
      tagsIdx = findColumn(headers, ['tags', 'tag', 'folder']);
      timeIdx = findColumn(headers, ['time_added', 'timeadded', 'saved', 'date', 'created_at']);
      dataRows = rows.slice(1);
    } else {
      // No header row — infer the URL column from the first record's contents.
      urlIdx = -1;
      const first = rows[0];
      for (let i = 0; i < first.length; i++) {
        if (URL_RE.test(first[i].trim())) { urlIdx = i; break; }
      }
      titleIdx = urlIdx === 0 ? 1 : 0;
      tagsIdx = -1;
      timeIdx = -1;
      dataRows = rows;
    }

    if (urlIdx === -1) return [];

    const seen = new Set();
    const out = [];
    for (const r of dataRows) {
      const url = (r[urlIdx] || '').trim();
      if (!URL_RE.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        title: titleIdx !== -1 ? (r[titleIdx] || '').trim() : '',
        tags: tagsIdx !== -1 ? (r[tagsIdx] || '').trim() : '',
        time_added: timeIdx !== -1 ? (r[timeIdx] || '').trim() : '',
      });
    }
    return out;
  }

  root.StashImport = { parseCsv, parseRows };
})(self);
