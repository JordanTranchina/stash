// Stash offline-images helper.
//
// Shared between the web app (app.js, which does the actual prefetching) and
// the Service Worker (sw.js, which needs the cache name so it doesn't wipe
// downloaded article images on every app-shell cache version bump). Exposed
// on `self` so it works both in a page (self === window) and inside the
// Service Worker (imported via importScripts).
(function (root) {
  // Separate from the app-shell cache (CACHE_NAME in sw.js) so bumping the
  // app-shell cache version on a deploy never evicts already-downloaded
  // article images.
  const IMAGE_CACHE_NAME = 'stash-images-v1';

  // Markdown image syntax, as produced by htmlToMarkdown() in
  // supabase/functions/save-page/index.ts: ![alt](url) or ![alt](url "title").
  const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)/g;

  // Every image URL a save's reading view can render: the article body's
  // inline images plus the card/og:image thumbnail. Absolute http(s) URLs
  // only — data: URIs are already inline and need no caching, and anything
  // without a scheme isn't fetchable as-is.
  function extractImageUrls(save) {
    if (!save) return [];
    const urls = new Set();

    if (save.image_url && /^https?:\/\//i.test(save.image_url)) {
      urls.add(save.image_url);
    }

    const content = save.content || '';
    let match;
    MARKDOWN_IMAGE_RE.lastIndex = 0;
    while ((match = MARKDOWN_IMAGE_RE.exec(content)) !== null) {
      const url = match[1];
      if (/^https?:\/\//i.test(url)) urls.add(url);
    }

    return Array.from(urls);
  }

  root.StashOffline = { IMAGE_CACHE_NAME, extractImageUrls };
})(self);
