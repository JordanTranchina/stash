// Stash Configuration
// Replace these with your Supabase project details

const CONFIG = {
  // Your Supabase project URL (from Project Settings > API)
  SUPABASE_URL: "https://jntnmvxkirrosxjquuoy.supabase.co",

  // Your Supabase anon/public key (from Project Settings > API)
  SUPABASE_ANON_KEY: "sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s",

  // Your web app URL (after deploying to Vercel/Netlify)
  WEB_APP_URL: "https://stash-lemon-zeta.vercel.app",

  // Your user ID from Supabase (Authentication > Users)
  // For multi-user mode, this can be removed and auth will be required
  USER_ID: "6c7a3a96-16cd-4702-ac7b-0c7a4a81346d",

  // Sentry DSN for error reporting from the background script (see
  // sentry-lite.js). A Sentry DSN isn't a secret, so it's safe to commit
  // like the Supabase anon key above. Leave blank to disable.
  SENTRY_DSN: "https://54bdb933e682bf9d4c9a1103da24fe87@o4511824474210304.ingest.us.sentry.io/4511824499441664",

  // PostHog project API key for usage analytics (saves — see analytics.js).
  // Like the Sentry DSN above, a PostHog API key is write-only and safe to
  // commit. Leave blank to disable. See documentation/SETUP.md.
  POSTHOG_API_KEY: "phc_srWbtErFLCzbZcMKmQ48mU8cf77CKG522dyPvoUnRGE3",

  // PostHog ingestion host: 'https://us.i.posthog.com' (US cloud, default)
  // or 'https://eu.i.posthog.com' (EU cloud) — match your project's region.
  POSTHOG_HOST: "https://us.i.posthog.com",
};

// Don't edit below this line
if (typeof module !== "undefined") {
  module.exports = CONFIG;
}
