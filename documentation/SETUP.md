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
| `import_completed` | A CSV import finishes | `total`, `imported`, `failed` |
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
