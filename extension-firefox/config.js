// Stash Configuration
// Replace these with your Supabase project details

const CONFIG = {
  // Your Supabase project URL (from Project Settings > API)
  SUPABASE_URL: "https://jntnmvxkirrosxjquuoy.supabase.co",

  // Your Supabase anon/public key (from Project Settings > API)
  SUPABASE_ANON_KEY: "sb_publishable_56A0I5tN0tvybD2yJ81UKQ_Fn2ibI1s",

  // Your web app URL (after deploying to Vercel/Netlify)
  WEB_APP_URL: "https://stash-lemon-zeta.vercel.app",
};

// Don't edit below this line
if (typeof module !== "undefined") {
  module.exports = CONFIG;
}
