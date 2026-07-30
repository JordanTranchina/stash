// Initializes the Sentry SDK loaded via CDN in index.html/save.html. Split
// out so both entry points share one init call instead of duplicating it
// inline. No-ops if CONFIG.SENTRY_DSN is blank.
if (typeof Sentry !== 'undefined' && typeof CONFIG !== 'undefined' && CONFIG.SENTRY_DSN) {
  Sentry.init({ dsn: CONFIG.SENTRY_DSN, environment: 'production' });
}
