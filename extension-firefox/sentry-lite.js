// Minimal Sentry error reporter for the extension's background script.
//
// MV3 forbids remotely-hosted code, so the official Sentry SDK (loaded from
// a CDN in the web app) isn't an option here — this posts directly to
// Sentry's HTTP ingest API instead, the same way supabase.js hand-rolls a
// REST client rather than pulling in the official Supabase SDK.
//
// Loaded via importScripts (Chrome service worker) or background.scripts
// (Firefox event page), so it attaches to `self` rather than using
// CommonJS/ESM exports — same pattern as web/db.js.
(function (global) {
  let host = null;
  let projectId = null;
  let publicKey = null;

  function init(dsn) {
    if (!dsn) return;
    try {
      const u = new URL(dsn);
      host = u.host;
      publicKey = u.username;
      projectId = u.pathname.replace(/^\//, '');
    } catch (e) {
      console.warn('SentryLite: invalid DSN, error reporting disabled');
    }
  }

  function captureException(err, opts) {
    if (!host) return; // not configured — silent no-op
    const error = err instanceof Error ? err : new Error(String(err));
    const event = {
      event_id: crypto.randomUUID().replace(/-/g, ''),
      timestamp: new Date().toISOString(),
      platform: 'javascript',
      level: 'error',
      exception: {
        values: [{
          type: error.name || 'Error',
          value: error.message,
          stacktrace: error.stack ? { frames: [{ filename: '<extension>', in_app: true }] } : undefined,
        }],
      },
      tags: { source: 'extension', ...(opts && opts.tags) },
    };

    // Never let error reporting itself throw or block the caller.
    fetch(`https://${host}/api/${projectId}/store/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=stash-extension/1.0, sentry_key=${publicKey}`,
      },
      body: JSON.stringify(event),
    }).catch(() => {});
  }

  global.SentryLite = { init, captureException };
})(typeof self !== 'undefined' ? self : this);
