// Lightweight log capture for the extension's "Report a bug" flow.
//
// Wraps console.* into a ring buffer persisted to chrome.storage.local (key
// `stash_logs`) so it survives the MV3 service worker being torn down between
// events, and remembers the last uncaught error. Nothing is sent from here —
// background.js snapshots this when the user opens the reporter.
//
// Loaded first: via importScripts() in extension/background.js (Chrome SW) and
// as the first background.scripts entry in extension-firefox/manifest.json.
// Also loaded by report.html so the reporter page captures its own errors.
(function (root) {
  var STORAGE_KEY = 'stash_logs';
  var MAX_LOGS = 200;
  var MAX_MSG = 2000;
  var logs = [];
  var lastError = null;
  var hydrated = false;

  var REDACTIONS = [
    [/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]'],
    [/(apikey|access_token|refresh_token|api_key)["'\s:=]+[A-Za-z0-9._\-]+/gi, '$1=[redacted]'],
    [/sb_(publishable|secret)_[A-Za-z0-9_\-]+/g, 'sb_[redacted]'],
    [/eyJ[A-Za-z0-9._\-]{20,}/g, '[jwt-redacted]'],
  ];

  function redact(text) {
    var out = String(text);
    for (var i = 0; i < REDACTIONS.length; i++) out = out.replace(REDACTIONS[i][0], REDACTIONS[i][1]);
    return out;
  }

  function stringifyArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || (arg.name + ': ' + arg.message);
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function persist() {
    if (!hasStorage()) return;
    try {
      var payload = {};
      payload[STORAGE_KEY] = { logs: logs.slice(-MAX_LOGS), lastError: lastError };
      chrome.storage.local.set(payload);
    } catch (e) { /* storage full / unavailable — keep going */ }
  }

  function hydrate(cb) {
    if (hydrated || !hasStorage()) { cb && cb(); return; }
    try {
      chrome.storage.local.get([STORAGE_KEY], function (res) {
        var stored = res && res[STORAGE_KEY];
        if (stored && Array.isArray(stored.logs)) {
          logs = stored.logs.concat(logs).slice(-MAX_LOGS);
          if (!lastError && stored.lastError) lastError = stored.lastError;
        }
        hydrated = true;
        cb && cb();
      });
    } catch (e) { hydrated = true; cb && cb(); }
  }
  hydrate();

  function record(level, args) {
    var msg = redact(Array.prototype.map.call(args, stringifyArg).join(' '));
    if (msg.length > MAX_MSG) msg = msg.slice(0, MAX_MSG) + '…';
    logs.push({ t: new Date().toISOString(), level: level, msg: msg });
    if (logs.length > MAX_LOGS) logs.shift();

    // Every console.error() doubles as "last error" capture, not just the
    // call sites that remember to call noteError() explicitly — most
    // failures here are handled promise rejections (an awaited storage/fetch
    // error, not a thrown exception), which never reach the addEventListener
    // hooks below (see web/logbuffer.js for the same fix, issue #107).
    if (level === 'error') {
      var errArg;
      for (var i = 0; i < args.length; i++) {
        if (args[i] instanceof Error) { errArg = args[i]; break; }
      }
      noteError(msg, errArg ? errArg.stack || '' : '', 'console.error');
    }

    persist();
  }

  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      try { record(level, arguments); } catch (e) { /* never break the caller */ }
      original.apply(null, arguments);
    };
  });

  function noteError(message, stack, sourceHint) {
    lastError = {
      message: redact(message || 'Unknown error'),
      stack: redact(stack || ''),
      source: sourceHint || '',
      t: new Date().toISOString(),
    };
    persist();
  }

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('error', function (e) {
      var err = e && e.error;
      noteError((err && err.message) || e.message, (err && err.stack) || '',
        [e.filename, e.lineno].filter(Boolean).join(':'));
    });
    root.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      noteError((r && r.message) || String(r), (r && r.stack) || '', 'unhandledrejection');
    });
  }

  root.StashLog = {
    getLogs: function () { return logs.slice(); },
    getLastError: function () { return lastError; },
    noteError: noteError,
    redact: redact,
    // Resolves to { logs, lastError } including anything persisted from a prior
    // worker lifetime. background.js uses this when building a report.
    snapshot: function () {
      return new Promise(function (resolve) {
        hydrate(function () { resolve({ logs: logs.slice(), lastError: lastError }); });
      });
    },
  };
})(typeof self !== 'undefined' ? self : this);
