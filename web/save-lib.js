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
  // alongside the scraped article (it is NOT the article body). `title` is an
  // optional fallback title (from a share sheet or the manual form) used only
  // when the server can't scrape one itself — e.g. a bot-blocked or paywalled
  // page saved as a bare link; a successful scrape always prefers the real
  // page title. `created_at` is an optional ISO timestamp (used by CSV import
  // to preserve the original save date); it is only included when provided so
  // live shares keep now(). There is no user_id field — the Edge Function
  // derives the owner from the caller's JWT, so a save can never be attributed
  // to anyone but the signed-in user.
  function buildScrapeRequest({ url, source, highlight, created_at, title }) {
    const request = {
      url: url,
      source: source || 'mobile-web',
      highlight: highlight || null,
    };
    if (title) request.title = title;
    if (created_at) request.created_at = created_at;
    return request;
  }

  // POST a scrape request to the save-page Edge Function. `accessToken` is the
  // signed-in user's Supabase access token — the function reads the user from
  // it, so a save without one has no owner and is refused here rather than
  // being sent. Resolves to `{ ok, duplicate }`: `duplicate` is true when the
  // URL was already stashed, in which case the server bumped the existing
  // save's date instead of creating a second copy (see
  // supabase/migrations/20260824_saves_url_dedup.sql). Throws on network
  // failure (and on a missing token) so callers can tell a retry-later failure
  // from a rejection; the thrown Error carries `.noSession = true` for the
  // missing-token case so callers can prompt a sign-in instead of queueing.
  async function saveViaScrapeDetailed(request, accessToken) {
    if (!accessToken) {
      const err = new Error('Not signed in: a save needs a Supabase access token');
      err.noSession = true;
      throw err;
    }
    const res = await fetch(`${CONFIG.SUPABASE_URL}${FUNCTION_PATH}`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) return { ok: false, duplicate: false };

    // A save that succeeded but returned an unreadable body is still a save;
    // only the "was it a duplicate?" detail is lost.
    try {
      const body = await res.json();
      return { ok: true, duplicate: Boolean(body && body.duplicate) };
    } catch (e) {
      return { ok: true, duplicate: false };
    }
  }

  // Boolean-only form, for callers (offline queue drain, share sheet) that only
  // need to know whether the save landed.
  async function saveViaScrape(request, accessToken) {
    const { ok } = await saveViaScrapeDetailed(request, accessToken);
    return ok;
  }

  // Pull the first URL out of arbitrary shared/pasted text. Share sheets and
  // clipboard pastes are rarely a bare link — e.g. Android/Google share text
  // is "Title https://share.google/…", and forwarding a Slack message pastes
  // the whole "[Updates] Patch Notes (All Platforms) https://…" line. Returns
  // '' when no URL is found so callers can fall back to treating the input as
  // a literal (invalid) URL and showing a real error.
  function extractUrlFromText(text) {
    if (!text) return '';
    const match = String(text).match(/https?:\/\/[^\s]+/);
    if (!match) return '';
    // Share text often wraps the link in surrounding punctuation
    // ("(link)", "link.", "<link>") that isn't part of the URL itself.
    return match[0].replace(/[)\]}>.,;:!?'"]+$/, '');
  }

  root.StashSave = { FUNCTION_PATH, buildScrapeRequest, saveViaScrape, saveViaScrapeDetailed, extractUrlFromText };
})(self);
