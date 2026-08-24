# Stash Setup Guide

A simple, self-hosted Pocket replacement with Chrome extension, web app, and cross-device sync.

## Quick Start (15 minutes)

### 1. Set Up Supabase (Free Tier)

1. Go to [supabase.com](https://supabase.com) and sign in with GitHub
2. Create a new project (free tier includes 500MB database, unlimited API requests)
3. Go to **SQL Editor** and run the contents of `supabase/schema.sql`
4. In the same SQL Editor, run each file in `supabase/migrations/` in filename
   order. `schema.sql` only covers the original tables; everything added since
   (podcast episodes, reading progress, URL de-duplication) lives in these
   migrations, and they're written to be safe to re-run.
5. Go to **Project Settings > API** and copy:
   - Project URL (e.g., `https://xxxxx.supabase.co`)
   - `anon` public key

### 2. Configure the Extension

1. Open `extension/config.js`
2. Replace the placeholder values:
   ```js
   const CONFIG = {
     SUPABASE_URL: 'https://your-project.supabase.co',
     SUPABASE_ANON_KEY: 'your-anon-key-here',
     WEB_APP_URL: 'https://your-stash-app.vercel.app', // After step 5
   };
   ```

No user ID goes in config. Every client signs in, and the signed-in session
decides whose saves you're looking at.

### 3. Set Up Sign-In

Stash signs people in two ways: **Continue with Google**, and email/password
as a fallback. Set up Google first — it's the path everyone but you will use.

**Google Cloud Console**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project
2. **APIs & Services > OAuth consent screen**: choose **External**, fill in the app name, support email, and developer contact
3. **APIs & Services > Credentials > Create credentials > OAuth client ID**
4. Application type: **Web application**
5. Under **Authorized redirect URIs**, add:
   ```
   https://<your-project>.supabase.co/auth/v1/callback
   ```
6. Copy the **Client ID** and **Client secret**

**Supabase**

7. Go to **Authentication > Providers > Google**, enable it, and paste in the client ID and secret
8. Go to **Authentication > URL Configuration** and add your deployed domain (e.g. `https://your-stash-app.vercel.app`) under **Redirect URLs**. Without this, Google sends people back to the wrong place after sign-in. Add `http://localhost:3000` too if you run the web app locally.
9. Go to **Authentication > Policies** (Password settings) and turn on **leaked password protection**. It's off by default, and email/password is still a live sign-in path, so leave it on.

### 3b. Invite Yourself

Sign-up is invite-only. A trigger on `auth.users` checks the address against
the `allowed_emails` table, and anything not listed gets an "invite-only"
error at sign-up — Google sign-in included.

To let someone in, insert their email:

```sql
insert into allowed_emails (email) values ('friend@example.com');
```

Do this for your own address before your first sign-in, or you'll lock
yourself out of your own install. Then open the web app and sign in.

### 4. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension` folder

### 5. Deploy the Web App

**Option A: Vercel (Recommended)**
1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click "New Project" > Import your repo
4. Set the root directory to `web`
5. Deploy (it's free for personal use)

**Option B: Local Only**
```bash
cd web
python3 -m http.server 3000
```
Then open http://localhost:3000

### 6. Update Config with Web App URL

After deploying, update `extension/config.js` with your web app URL.

## Using Stash

### Chrome Extension

- **Save a page**: Click the Stash icon or right-click > "Save page to Stash"
- **Save a highlight**: Select text > right-click > "Save highlight to Stash"

### Web App

- Works on any device (Mac, iPhone, iPad)
- Add to home screen on mobile for app-like experience
- Full-text search across all saved content
- Organize with tags and folders

### Bookmarklet (for other browsers)

1. Open `bookmarklet/install.html` in your browser
2. Enter your web app URL
3. Drag the bookmarklet to your bookmarks bar

The bookmarklet hands the page to the web app's quick-save window, which is
already signed in — so it works in any browser without storing a token.

### iOS Shortcut (Save from Safari)

See `ios-shortcut/README.md` for setup instructions.

## Features

- **Save articles** - Full text extraction with Readability
- **Save highlights** - Select text and save snippets
- **Full-text search** - Search across all your saved content
- **Tags & folders** - Organize your saves
- **Cross-device sync** - Access anywhere via web app
- **PWA support** - Install as an app on mobile

## Troubleshooting

### Extension not saving
- Verify your Supabase credentials in `config.js`
- Open the extension popup and check you're signed in — saves fail with "Sign in to Stash to save" when the session is gone
- Check the browser console (F12) for errors

### "Invite only" error at sign-up
- The address isn't in `allowed_emails`. Add it (see step 3b) and try again.

### Web app not loading
- Verify the same credentials in `web/config.js`
- Check that the schema was created correctly
- Look for errors in the browser console

### CORS errors
- Make sure you're using the `anon` key, not the `service_role` key
- Supabase handles CORS automatically for the anon key

## Adding Other People

Multi-user is the only mode. Row Level Security means each account sees only
its own saves, so sharing an install with friends and family is just a matter
of letting them sign up:

1. Add their email to `allowed_emails` (see step 3b)
2. Send them the web app URL
3. They sign in with Google (or with a password) and they're in

### What to hand people

- **The web app.** Add to home screen on a phone and it's a real app, including a "Save to Stash" entry in the iOS/Android share sheet.
- **The bookmarklet**, for saving from a desktop browser.

### What not to hand people

The browser extension isn't part of this. Neither build is published to the
Chrome Web Store or AMO, so installing it means Developer Mode and "Load
unpacked" — and in Chrome an unpacked extension has to be re-loaded fairly
often. That's fine for you and a non-starter for anyone else. Between the PWA
share target and the bookmarklet, saving is covered without it; the extension
stays a power tool until a store listing is worth the review cycle.

## License

MIT - Do whatever you want with it!
