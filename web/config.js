// Stash Web App Configuration
// Replace these with your Supabase project details

const CONFIG = {
  // Your Supabase project URL (from Project Settings > API)
  SUPABASE_URL: 'https://jntnmvxkirrosxjquuoy.supabase.co',

  // Your Supabase anon/public key (from Project Settings > API)
  SUPABASE_ANON_KEY: 'sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s',

  // GitHub Actions workflow that generates a podcast episode. The "Generate
  // Podcast Now" button deep-links here so you can trigger a run on demand
  // (the workflow has workflow_dispatch enabled). Update the owner/repo to match
  // your fork.
  PODCAST_WORKFLOW_URL: 'https://github.com/JordanTranchina/stash/actions/workflows/podcast.yml',

  // Sentry DSN for client-side error reporting. A Sentry DSN isn't a secret
  // (it's write-only, meant to be public), so it's safe to commit like the
  // Supabase anon key above. Leave blank to disable error reporting.
  SENTRY_DSN: 'https://54bdb933e682bf9d4c9a1103da24fe87@o4511824474210304.ingest.us.sentry.io/4511824499441664',

  // PostHog project API key for usage analytics (saves, sorting, search,
  // reading progress — see analytics.js). Like the Sentry DSN above, a
  // PostHog API key is write-only and safe to commit. Leave blank to disable
  // analytics. See documentation/SETUP.md for how to get one.
  POSTHOG_API_KEY: 'phc_srWbtErFLCzbZcMKmQ48mU8cf77CKG522dyPvoUnRGE3',

  // PostHog ingestion host: 'https://us.i.posthog.com' (US cloud, default)
  // or 'https://eu.i.posthog.com' (EU cloud) — match your project's region.
  POSTHOG_HOST: 'https://us.i.posthog.com',
};
