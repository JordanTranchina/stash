# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stash is a self-hosted, single-user "read it later" app (Pocket/Instapaper replacement). There is no build step and no backend server you run yourself: static/vanilla JS clients (browser extensions, a PWA web app) talk directly to a Supabase project (Postgres + REST + Auth + Storage + Edge Functions) over HTTPS. A separate Python pipeline (`podcast/`) turns saved articles into an AI-narrated podcast ("Listen Later") via a daily GitHub Action.

Single-user mode is the default: `USER_ID` is hardcoded in each client's `config.js` and all requests use the Supabase `anon` key, with Postgres Row Level Security enforcing per-user isolation. Multi-user mode (real Supabase Auth sign-in) exists but is secondary — see `documentation/SETUP.md`.

## Commands

```bash
npm install                  # installs Jest, Playwright, Puppeteer (test-only deps; no app deps to build)
npm test                     # Jest unit tests (tests/unit/**/*.test.js)
npm run test:e2e             # Jest e2e tests, Puppeteer driving web/index.html as a file:// URL (tests/e2e)
npm run test:extension       # Playwright e2e tests, loads the unpacked MV3 extension (tests/extension-e2e)
npm run test:all             # unit + e2e Jest suites together
npm run sync:firefox-extension  # copies extension/ -> extension-firefox/ (see "Two extension builds" below)
```

Run a single Jest test: `npx jest tests/unit/save.test.js -t "name of test"`
Run a single Playwright test: `npx playwright test tests/extension-e2e/extension.spec.js -g "name of test"`

Python (podcast pipeline), from `podcast/`:
```bash
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -v                 # all podcast tests
python -m pytest tests/test_script.py -v   # single file
python -m pytest tests/test_script.py -k "test_name" -v  # single test
```
`podcast/tests/conftest.py` stubs out the `supabase` package (its native `pyroaring` dependency may not build in all environments) before collection — individual test files mock the Supabase calls they need on top of that.

There is no lint/typecheck script configured in this repo.

## Architecture

### The clients all share one Supabase backend

Every client (Chrome extension, Firefox extension, web PWA, bookmarklet, iOS Shortcut) writes/reads the same Postgres tables directly via Supabase's REST API (PostgREST), gated by RLS policies keyed on `auth.uid()`. There is no custom app server. Each client has its own `config.js` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and (in single-user mode) a hardcoded `USER_ID` — see `documentation/SETUP.md` for provisioning steps. `supabase/schema.sql` is the source of truth for tables (`saves`, `folders`, `tags`, `save_tags`, `user_preferences`) and RLS policies; `supabase/migrations/` holds incremental changes applied after the initial schema.

### Two extension builds share one codebase

`extension/` (Chrome) and `extension-firefox/` (Firefox) are near-duplicates because Chrome's MV3 background must be a `service_worker` while Firefox's MV3 background is a non-worker event page (`background.scripts`) — only `manifest.json` differs between them. `extension/background.js` guards its `importScripts('config.js', 'supabase.js')` call with `typeof importScripts === 'function'` so the identical file runs in both contexts (Firefox already has those globals from `background.scripts`).

**Convention: never hand-edit `extension-firefox/` files other than `manifest.json`.** Edit `extension/` and run `npm run sync:firefox-extension`, which copies everything except `manifest.json` from `extension/` into `extension-firefox/`. `tests/unit/firefox-extension.test.js` exists specifically to catch drift between the two.

### Web app (`web/`) — vanilla JS, no framework, no build

- `app.js` — one large `StashApp` class driving the whole UI (list rendering, reading pane, search, theming, font size, audio player for TTS/podcast playback, swipe-to-archive, import modal, podcast settings modal). It talks to Supabase via the official `@supabase/supabase-js` client (loaded as a `<script>` in `index.html`), unlike the extensions' hand-rolled `SupabaseClient`.
- `db.js` — IndexedDB wrapper exposed as `self.StashDB` (not `window.StashDB`) so the exact same file can be `importScripts()`'d into the service worker (`sw.js`, for Background Sync) as well as loaded normally in page context.
- `save-lib.js` / `save.html` — the PWA's "share target" ingestion path (e.g. iOS/Android share sheet), including `StashSave.buildScrapeRequest`, which normalizes a share payload before sending it to the `save-page` Edge Function.
- `import-lib.js` — client-side CSV/Kindle "My Clippings.txt" import parsing.
- `sw.js` — service worker for offline caching and background sync of pending saves queued while offline.
- Config precedence: `config.js` is checked in with real (public, RLS-protected) credentials for the deployed instance; `config.local.js` is gitignored for local overrides and is not auto-loaded by any file, so wire it up manually per environment if you use it.

### Supabase Edge Functions (`supabase/functions/`, Deno + TypeScript)

Server-side logic that can't run in a browser extension or needs the `service_role` key lives here:
- `save-page` — the largest function. Fetches a URL server-side, strips redirect-wrapper interstitials (Google/Facebook/link-shortener redirect pages, via `REDIRECT_WRAPPER_HOSTS`) to find the real article, and runs Mozilla `Readability` (via `linkedom`) to extract clean article content. This is what `save-lib.js`'s share-target path and mobile saves hit — extension saves instead extract client-side via `extension/content.js` + `extension/Readability.js`.
- `save-kindle` — imports parsed Kindle "My Clippings.txt" highlights.
- `podcast-rss` — serves the `podcast_episodes` table as an RSS 2.0 feed for podcast apps.
- `podcast-chapters` — serves chapter marker data for an episode.

Edge Functions pin dependencies via full URLs (`esm.sh`, `deno.land/std`) in each `index.ts`; there's no separate package manifest to update.

### Podcast pipeline (`podcast/`, Python, run by GitHub Actions)

Daily pipeline (`.github/workflows/podcast.yml`, cron 8:00 AM UTC + manual `workflow_dispatch`) that turns recent saves into a two-host conversational podcast episode:
1. `youtube_sync.py` — polls a user-owned Unlisted YouTube playlist (official YouTube Data API, no scraping) and inserts new videos as saves. Idempotent; skips cleanly if `YOUTUBE_API_KEY`/`YOUTUBE_SYNC_PLAYLIST_ID` secrets are absent.
2. `extract.py` — pulls recent unarchived saves from Supabase. YouTube-URL saves are resolved to a transcript via `youtube-transcript-api` (`youtube.py`) and the transcript is cached back onto the save's `content` so it's fetched only once; if no captions are available (or the host IP is rate-limited) it falls back to whatever content the save already had rather than failing the run.
3. `script.py` — sends article text to Gemini (`gemini-2.5-flash-lite` by default, overridable via `GEMINI_MODEL`; chosen for free-tier quota) to produce two-host dialogue JSON. Host names/personas/tone are pulled from `user_preferences` per-user (`fetch_podcast_preferences`), falling back to `DEFAULT_PODCAST_PREFS`.
4. TTS via `edge-tts` renders each dialogue line to an audio clip.
5. `assembly.py` — stitches clips with `ffmpeg` into one MP3 with chapter metadata.
6. The episode uploads to Supabase Storage and a row is written to `podcast_episodes`; `podcast-rss`/`podcast-chapters` Edge Functions serve it out.

Required secrets (GitHub Actions / local `.env` via `python-dotenv`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `USER_ID`, `GEMINI_API_KEY`, and optionally `YOUTUBE_API_KEY`/`YOUTUBE_SYNC_PLAYLIST_ID`. See `documentation/CLOUD_DEPLOYMENT.md` for where each secret is configured across GitHub/Vercel/Supabase.

### Other clients

- `bookmarklet/` — a single JS bookmarklet (`save-page.js`) for saving from any browser without an extension.
- `ios-shortcut/` — Apple Shortcut for saving from Safari's share sheet on iOS (see its own `README.md`).
- `tts/` — a standalone local Edge-TTS generator script (`tts.py`) plus a `launchd` plist (`com.stash.tts.plist`) for running it as a background service on macOS.

## Testing conventions

- Jest config lives inline in `package.json` (`testEnvironment: node`, explicit `testMatch` for `tests/unit` and `tests/e2e`, transform disabled — plain JS, no Babel/TS transform).
- Unit tests for browser-only files (e.g. `save-lib.js`) load the source with Node's `vm` module into a sandboxed context (`{ self: {}, CONFIG: {...} }`) rather than requiring it, since these files attach to `self`/`window` and aren't CommonJS modules.
- `tests/e2e/web.e2e.test.js` drives `web/index.html` directly as a `file://` URL under Puppeteer with a mocked Supabase client injected before page scripts run — no real network/credentials needed.
- `tests/extension-e2e/` uses Playwright's `chromium.launchPersistentContext` with `--headless=new` (the only combination that lets Chromium load an unpacked extension headlessly); set `PW_CHROME_EXECUTABLE` to point at a local Chromium if not using Playwright's bundled one.
- CI (`.github/workflows/pr-test.yml`) runs four independent jobs on every PR into `main`: pytest for `podcast/`, Jest unit tests, Jest e2e tests, and Playwright extension e2e tests.
