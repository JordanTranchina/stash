// Stash Web App Configuration
// Replace these with your Supabase project details

const CONFIG = {
  // Your Supabase project URL (from Project Settings > API)
  SUPABASE_URL: 'https://jntnmvxkirrosxjquuoy.supabase.co',

  // Your Supabase anon/public key (from Project Settings > API)
  SUPABASE_ANON_KEY: 'sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s',

  // Your user ID from Supabase (Authentication > Users)
  // For multi-user mode, this can be removed and auth will be required
  USER_ID: '6c7a3a96-16cd-4702-ac7b-0c7a4a81346d',

  // GitHub Actions workflow that generates a podcast episode. The "Generate
  // Podcast Now" button deep-links here so you can trigger a run on demand
  // (the workflow has workflow_dispatch enabled). Update the owner/repo to match
  // your fork.
  PODCAST_WORKFLOW_URL: 'https://github.com/JordanTranchina/stash/actions/workflows/podcast.yml',
};
