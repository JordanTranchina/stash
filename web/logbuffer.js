// Lightweight in-memory log capture for the "Report a bug" flow.
//
// Wraps console.log/info/warn/error into a capped ring buffer and remembers the
// most recent uncaught error, so a bug report can ship "what just happened"
// without any always-on logging pipeline. Nothing is sent anywhere from here —
// bug-report.js reads getLogs()/getLastError()/getEnv() when the user submits.
//
// Load this FIRST (before app.js) in index.html / save.html so it captures the
// earliest console output. Runs alongside sentry-init.js — it does not replace
// Sentry's automatic capture.
//
// Exposed on `self` (page context: self === window) to match analytics.js/db.js.
(function (root) {
  var MAX_LOGS = 200;
  var MAX_MSG = 2000;
  var logs = [];
  var lastError = null;

  // Redact obvious secrets so a pasted issue can't leak a live token. Covers
  // "Bearer <jwt>", apikey/access_token/refresh_token assignments, and the
  // publishable-key prefix Supabase uses.
  var REDACTIONS = [
    [/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]"],
    [/(apikey|access_token|refresh_token|api_key)["'\s:=]+[A-Za-z0-9._\-]+/gi, "$1=[redacted]"],
    [/sb_(publishable|secret)_[A-Za-z0-9_\-]+/g, "sb_[redacted]"],
    [/eyJ[A-Za-z0-9._\-]{20,}/g, "[jwt-redacted]"],
  ];

  function redact(text) {
    var out = String(text);
    for (var i = 0; i < REDACTIONS.length; i++) {
      out = out.replace(REDACTIONS[i][0], REDACTIONS[i][1]);
    }
    return out;
  }

  function stringifyArg(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || (arg.name + ": " + arg.message);
    try {
      return JSON.stringify(arg);
    } catch (e) {
      return String(arg);
    }
  }

  function record(level, args) {
    var msg = redact(Array.prototype.map.call(args, stringifyArg).join(" "));
    if (msg.length > MAX_MSG) msg = msg.slice(0, MAX_MSG) + "…";
    logs.push({ t: new Date().toISOString(), level: level, msg: msg });
    if (logs.length > MAX_LOGS) logs.shift();

    // Every console.error() doubles as "last error" capture, not just the
    // handful of call sites that remember to call StashLog.noteError()
    // explicitly. Most of this app's failures are handled Supabase/fetch
    // rejections (an awaited { error } result, not a thrown exception), so
    // they never reach the window 'error'/'unhandledrejection' listeners
    // below — console.error was the only place they were ever reported, and
    // a bug filed right after one previously showed "Last error: (none
    // captured)" because nothing had wired it through (issue #107).
    if (level === "error") {
      var errArg;
      for (var i = 0; i < args.length; i++) {
        if (args[i] instanceof Error) { errArg = args[i]; break; }
      }
      noteError(msg, errArg ? errArg.stack || "" : "", "console.error");
    }
  }

  ["log", "info", "warn", "error"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      try {
        record(level, arguments);
      } catch (e) {
        /* never let logging break the caller */
      }
      original.apply(null, arguments);
    };
  });

  function noteError(message, stack, sourceHint) {
    lastError = {
      message: redact(message || "Unknown error"),
      stack: redact(stack || ""),
      source: sourceHint || "",
      t: new Date().toISOString(),
    };
  }

  if (typeof root.addEventListener === "function") {
    root.addEventListener("error", function (e) {
      var err = e && e.error;
      noteError(
        (err && err.message) || e.message,
        (err && err.stack) || "",
        [e.filename, e.lineno].filter(Boolean).join(":"),
      );
    });
    root.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      noteError(
        (r && r.message) || String(r),
        (r && r.stack) || "",
        "unhandledrejection",
      );
    });
  }

  // Best-effort UA breakdown for the issue template's Desktop / Smartphone
  // blocks. The Edge Function re-derives this authoritatively; this copy exists
  // so the client can show the user what will be attached (and to be testable).
  function parseUserAgent(ua) {
    var s = ua || "";
    var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(s);
    var os = "unknown";
    var m;
    if ((m = s.match(/iPhone OS (\d+[_.]\d+)/))) os = "iOS " + m[1].replace(/_/g, ".");
    else if ((m = s.match(/CPU OS (\d+[_.]\d+)/))) os = "iPadOS " + m[1].replace(/_/g, ".");
    else if ((m = s.match(/Android (\d+(?:\.\d+)?)/))) os = "Android " + m[1];
    else if (/Windows NT 10/.test(s)) os = "Windows 10/11";
    else if ((m = s.match(/Mac OS X (\d+[_.]\d+)/))) os = "macOS " + m[1].replace(/_/g, ".");
    else if (/Windows/.test(s)) os = "Windows";
    else if (/Mac OS X/.test(s)) os = "macOS";
    else if (/Linux/.test(s)) os = "Linux";

    var browser = "unknown";
    if ((m = s.match(/Edg\/(\d+)/))) browser = "Edge " + m[1];
    else if ((m = s.match(/OPR\/(\d+)/))) browser = "Opera " + m[1];
    else if ((m = s.match(/Firefox\/(\d+)/))) browser = "Firefox " + m[1];
    else if ((m = s.match(/CriOS\/(\d+)/))) browser = "Chrome " + m[1];
    else if ((m = s.match(/Chrome\/(\d+)/))) browser = "Chrome " + m[1];
    else if (/Safari/.test(s)) browser = (m = s.match(/Version\/(\d+)/)) ? "Safari " + m[1] : "Safari";

    var device = "unknown";
    if (/iPhone/.test(s)) device = "iPhone";
    else if (/iPad/.test(s)) device = "iPad";
    else if ((m = s.match(/;\s?([^;)]+)\sBuild\//))) device = m[1].trim();

    return { isMobile: isMobile, os: os, browser: browser, device: device };
  }

  root.StashLog = {
    // Copy so callers can't mutate the buffer.
    getLogs: function () {
      return logs.slice();
    },
    getLastError: function () {
      return lastError;
    },
    // Manually stamp an error (e.g. a caught-and-handled failure the user is
    // about to report). app.js passes the toast message here.
    noteError: function (message, stack, sourceHint) {
      noteError(message, stack, sourceHint);
    },
    redact: redact,
    parseUserAgent: parseUserAgent,
    getEnv: function (currentView) {
      return {
        version: (typeof root.STASH_VERSION !== "undefined" && root.STASH_VERSION) || null,
        url: (root.location && root.location.href) || "",
        userAgent: (root.navigator && root.navigator.userAgent) || "",
        view: currentView || "",
        online: root.navigator ? root.navigator.onLine : null,
        language: (root.navigator && root.navigator.language) || "",
        screen: root.screen ? root.screen.width + "x" + root.screen.height : "",
      };
    },
  };
})(typeof self !== "undefined" ? self : this);
