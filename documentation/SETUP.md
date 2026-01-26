# Stash Setup Guide

A simple, self-hosted Pocket replacement with Chrome extension, web app, and cross-device sync.

## Quick Start (15 minutes)

### 1. Set Up Supabase (Free Tier)

1. Go to [supabase.com](https://supabase.com) and sign in with GitHub
2. Create a new project (free tier includes 500MB database, unlimited API requests)
3. Go to **SQL Editor** and run the contents of `supabase/schema.sql`
4. Go to **Project Settings > API** and copy:
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
     USER_ID: 'your-user-id', // After step 3
   };
   ```

### 3. Create Your User Account

1. Go to Supabase > **Authentication** > **Users**
2. Click "Add user" > "Create new user"
3. Enter your email and password
4. Copy the user ID (UUID) and add it to your config files

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
2. Enter your user ID
3. Drag the bookmarklet to your bookmarks bar

### iOS Shortcut (Save from Safari)

See `ios-shortcut/README.md` for setup instructions.

## Features

- **Save articles** - Full text extraction with Readability
- **Save highlights** - Select text and save snippets
- **Kindle import** - Upload My Clippings.txt to import all your book highlights
- **Full-text search** - Search across all your saved content
- **Tags & folders** - Organize your saves
- **Cross-device sync** - Access anywhere via web app
- **PWA support** - Install as an app on mobile

## Importing Kindle Highlights

To import your Kindle highlights:

1. Connect your Kindle to your computer via USB
2. Find `My Clippings.txt` in the `documents` folder
3. Open the Stash web app and click "Import Kindle" in the sidebar
4. Drag and drop the file (or click to browse)
5. Review the highlights and click "Import"

The importer automatically detects duplicates, so you can re-import anytime without creating duplicates.

## Troubleshooting

### Extension not saving
- Verify your Supabase credentials in `config.js`
- Check the browser console (F12) for errors
- Make sure your user ID is correct

### Web app not loading
- Verify the same credentials in `web/config.js`
- Check that the schema was created correctly
- Look for errors in the browser console

### CORS errors
- Make sure you're using the `anon` key, not the `service_role` key
- Supabase handles CORS automatically for the anon key

## Weekly Digest Email (Optional)

Get a weekly email with summaries of everything you saved, plus random Kindle highlights to revisit.

### Setting Up Email (Resend)

1. Create a free account at [resend.com](https://resend.com)
2. Add and verify a domain (or use their testing domain)
3. Create an API key and copy it
4. In Supabase, go to **Project Settings > Edge Functions**
5. Add a secret named `RESEND_API_KEY` with your API key
6. Update the `from` email in `supabase/functions/send-digest/index.ts` to match your verified domain

### Deploying the Edge Function

```bash
# Install Supabase CLI if you haven't
npm install -g supabase

# Login and link your project
supabase login
supabase link --project-ref your-project-id

# Deploy the digest function
supabase functions deploy send-digest
```

### Setting Up Scheduled Sending

To send digest emails automatically, set up a cron job:

**Option A: Supabase pg_cron (Recommended)**

In the SQL Editor, run:
```sql
-- Enable pg_cron extension (if not already enabled)
create extension if not exists pg_cron;

-- Schedule digest to run every hour (it checks user preferences)
select cron.schedule(
  'send-weekly-digest',
  '0 * * * *', -- Every hour at minute 0
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_ID.supabase.co/functions/v1/send-digest',
    headers := '{"Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb
  );
  $$
);
```

**Option B: External Cron (GitHub Actions, etc.)**

Create a GitHub Action that calls the Edge Function hourly.

### Enabling Digest in the App

1. Click "Digest Settings" in the sidebar
2. Toggle "Enable weekly digest"
3. Enter your email address
4. Choose your preferred day and time (UTC)
5. Save

## Multi-User Setup

By default, Stash runs in single-user mode (hardcoded USER_ID). To enable multi-user:

1. Remove the `USER_ID` from config files
2. Enable Supabase Auth in your project
3. Users will need to sign up/sign in
4. Row Level Security (RLS) ensures users only see their own data

## License

MIT - Do whatever you want with it!
