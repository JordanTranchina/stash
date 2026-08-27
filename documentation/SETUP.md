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

## Analytics (optional)

Stash can send usage events (saves, sorting, search, reading progress, etc.) to
[PostHog](https://posthog.com) so you can see how you actually use your own
reading list — no signal is sent anywhere unless you configure it.

**Why PostHog:** its free tier includes 1M events/month and 5k session
replays/month with no time limit and no credit card required — for a
single-user app that's effectively unlimited. It also self-hosts if you'd
rather not use their cloud. (Alternatives if you want to compare: Umami is
fully open-source and free to self-host, but its cloud free tier caps at 3
websites/100k events; Mixpanel's free tier is generous on paper but is
priced per Monthly Tracked User, a metric that doesn't map well onto "one
person, forever.")

To enable it:

1. Create a free account at [posthog.com](https://posthog.com) (or self-host)
   and create a project.
2. Copy the **Project API Key** from Project Settings.
3. Paste it into `POSTHOG_API_KEY` in `web/config.js` and `extension/config.js`
   (then run `npm run sync:firefox-extension` if you edited the extension
   config). Set `POSTHOG_HOST` to match your project's region
   (`https://us.i.posthog.com` or `https://eu.i.posthog.com`), or your
   self-hosted instance's URL.
4. Reload the extension / web app. Events start flowing immediately; leaving
   `POSTHOG_API_KEY` blank disables analytics entirely (the default).

Stash posts directly to PostHog's HTTP capture API via `fetch` (see
`web/analytics.js` / `extension/analytics.js`) rather than loading their JS
SDK — this keeps it CSP-safe inside the Manifest V3 extension, which can't
load remotely-hosted code, and keeps the web app's footprint small.

### Events tracked out of the box

| Event | Fired when | Key properties |
|---|---|---|
| `save_created` | An article/highlight is saved, from any client | `source` (extension/manual/import/share-target/mobile-web), `duplicate`, `save_id` (absent on a duplicate, and on `import`) |
| `save_archived` / `save_unarchived` | A save is archived or restored | `via` (swipe/reading_pane/undo) |
| `article_opened` | The reading pane opens | `save_id`, `has_audio`, `word_count` |
| `article_read_progress` | Scroll position crosses 25/50/75/100% | `save_id`, `percent`, `dwell_seconds` (since the pane opened), `word_count` |
| `sort_changed` | The sort order is changed | `sort`, `view` |
| `search_performed` | Any debounced search runs, including one that returns nothing | `result_count` (0 when nothing matched), `query_length` |
| `audio_played` | TTS/podcast audio playback starts | `save_id` |
| `import_completed` | A CSV/Kindle import finishes | `total`, `imported`, `failed` |
| `theme_changed` | Light/dark mode is toggled | `theme` |

### Suggested stats to build in PostHog

Once events are flowing, a few dashboards/insights worth building:

- **Save → read funnel**: `save_created` → `article_opened` → `article_read_progress` (percent=75), joined on `save_id`, 14-day conversion window. Shows what fraction of what you save you actually finish — the core "read it later" question. Break down step 1 by `source`. Filter the read step to `dwell_seconds >= word_count / 10` (or a flat floor like 20s) so a scroll-to-bottom flick doesn't count as a read.
- **Save source breakdown**: pie/bar of `save_created` by `source`, to see whether you save more from the extension, mobile share sheet, or manual paste.
- **Time-to-read**: time delta between a save's `save_created` and its first `article_opened`, to see how long things sit in the queue.
- **Read-it-never rate**: saves with no `article_opened` event after N days — candidates for pruning or for a "stale saves" reminder.
- **Search usage**: trend of `search_performed` over time and whether `result_count` is often 0 (a sign the search needs work).
- **Daily/weekly active usage**: any event at all, grouped by day, as a simple habit tracker for the app itself.
- **Import health**: `imported`/`failed` ratio on `import_completed`, useful when bulk-importing from Pocket/Instapaper/Omnivore.

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

## Multi-User Setup

By default, Stash runs in single-user mode (hardcoded USER_ID). To enable multi-user:

1. Remove the `USER_ID` from config files
2. Enable Supabase Auth in your project
3. Users will need to sign up/sign in
4. Row Level Security (RLS) ensures users only see their own data

## License

MIT - Do whatever you want with it!
