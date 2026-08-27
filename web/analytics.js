// Minimal usage-analytics client for the web app, save.html (mobile Quick
// Save / PWA share target) and sw.js (Background Sync drain of queued
// offline saves).
//
// Posts directly to PostHog's HTTP capture API via fetch rather than loading
// the official posthog-js SDK — keeps this identical to extension/analytics.js
// (which can't load remote code under MV3) so save/read/sort events are
// tracked the same way from every client. See extension/sentry-lite.js for
// the fuller rationale behind hand-rolling a REST client instead.
//
// Exposed on `self` so it works both in a page (self === window) and inside
// the Service Worker (imported via importScripts) — same pattern as db.js
// and save-lib.js.
(function (root) {
  let host = null;
  let apiKey = null;
  let distinctId = 'stash-user';

  function init(key, hostUrl, userId) {
    if (!key) return; // not configured — capture() stays a silent no-op
    apiKey = key;
    host = (hostUrl || 'https://us.i.posthog.com').replace(/\/+$/, '');
    if (userId) distinctId = userId;
  }

  // `properties` is a plain object of event-specific context (e.g.
  // { source: 'manual', duplicate: false }). Never let analytics itself
  // throw or block the caller.
  function capture(event, properties) {
    if (!apiKey) return;
    const body = {
      api_key: apiKey,
      event,
      distinct_id: distinctId,
      properties: Object.assign({ $lib: 'stash-analytics-lite' }, properties),
      timestamp: new Date().toISOString(),
    };
    fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  root.StashAnalytics = { init, capture };

  // Self-init from config.js, which is always loaded first (see
  // index.html/save.html script order). No-ops if POSTHOG_API_KEY is blank.
  if (typeof CONFIG !== 'undefined' && CONFIG.POSTHOG_API_KEY) {
    init(CONFIG.POSTHOG_API_KEY, CONFIG.POSTHOG_HOST, CONFIG.USER_ID);
  }
})(typeof self !== 'undefined' ? self : this);
