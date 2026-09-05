// Minimal usage-analytics client, shared by the background script, popup and
// content script.
//
// MV3 forbids remotely-hosted code, so a vendored analytics SDK isn't an
// option here — this posts directly to PostHog's HTTP capture API instead,
// the same way sentry-lite.js hand-rolls a REST client rather than pulling in
// an official SDK (see that file for the fuller rationale).
//
// Loaded via importScripts (Chrome service worker) or a <script> tag
// (Firefox event page, popup.html), so it attaches to `self` rather than
// using CommonJS/ESM exports — same pattern as web/db.js.
(function (global) {
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
  // { source: 'extension', duplicate: false }). Never let analytics itself
  // throw or block the caller — same "fire and forget" contract as
  // SentryLite.captureException.
  function capture(event, properties) {
    // Every tracked event doubles as a logbuffer.js breadcrumb (the "Recent
    // logs" a bug report ships), independent of whether PostHog is actually
    // configured — see web/analytics.js for the same fix and issue #107.
    if (typeof console !== 'undefined' && console.info) {
      try { console.info('[event] ' + event, properties || {}); } catch (e) {}
    }
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

  global.StashAnalytics = { init, capture };
})(typeof self !== 'undefined' ? self : this);
