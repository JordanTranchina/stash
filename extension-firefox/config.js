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
};

// Don't edit below this line
if (typeof module !== "undefined") {
  module.exports = CONFIG;
}
