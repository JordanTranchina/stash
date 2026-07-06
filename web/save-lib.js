// Stash shared save helper.
//
// Used by the mobile Quick Save page (save.html), the web app (app.js) and the
// Service Worker (sw.js). Every mobile/PWA save is routed through the
// `save-page` Edge Function so the article is fully scraped server-side with
// Readability — the same ingestion path the Chrome extension and bookmarklet
// use. Previously these saves inserted only the shared title/URL straight into
// the `saves` table, so nothing was ever ingested and the shared snippet was
// all you got. This gives the Pocket-style experience: share a link, get the
// whole article.
//
// Exposed on `self` so it works both in a page (self === window) and inside the
// Service Worker (imported via importScripts).
(function (root) {
  const FUNCTION_PATH = '/functions/v1/save-page';

  // Build the request the save-page function expects from a raw share. Only the
  // URL is required — the scraper derives title, excerpt, content, image and
  // site name from the fetched page. `highlight` is an optional user note kept
  // alongside the scraped article (it is NOT the article body). `created_at` is
  // an optional ISO timestamp (used by CSV import to preserve the original save
  // date); it is only included when provided so live shares keep now().
  function buildScrapeRequest({ url, user_id, source, highlight, created_at }) {
    const request = {
      url: url,
      user_id: user_id,
      source: source || 'mobile-web',
      highlight: highlight || null,
    };
    if (created_at) request.created_at = created_at;
    return request;
  }

  // POST a scrape request to the save-page Edge Function. Resolves to true on a
  // successful save, false otherwise. Throws on network failure so callers can
  // fall back to the offline queue.
  async function saveViaScrape(request) {
    const res = await fetch(`${CONFIG.SUPABASE_URL}${FUNCTION_PATH}`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    return res.ok;
  }

  root.StashSave = { FUNCTION_PATH, buildScrapeRequest, saveViaScrape };
})(self);
