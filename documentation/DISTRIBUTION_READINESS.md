# Distribution Readiness

_Assessment date: 2026-08-24. **Phases 0 and 1 shipped and deployed to
production 2026-08-30** (PR #77). Target: hand Stash to a handful of friends
(and your mom) as a hosted product — no self-hosting, no config files, no
GitHub._

## Status at a glance

| | |
|---|---|
| **B1** Database publicly writable | **Fixed and deployed** |
| **B2** No sign-in path in the web app | Fixed |
| **B3** Edge Functions trust the body's `user_id` | Fixed |
| **B4** Podcast feed is global | Fixed |
| **B5** Podcast pipeline is single-tenant | Open — planned, see Phase 2 |
| **B6** Clients are per-user build artifacts | Fixed |
| Storage has no retention | Open — planned, see Phase 2 |

B1 is closed: the public-write policies are gone in production and RLS is the
only path to the data. The remaining work is Phase 2 (per-user podcast) and the
storage bill.

## Verdict (original, 2026-08-24)

**Not ready to send today, but the gap is narrower than it looks — roughly 3–5
focused days.** Almost none of the missing work is in the reading experience,
which is genuinely good. It's all in the identity layer: right now Stash has no
login at all, and the database is deliberately wired so that *anyone holding a
key that ships in this public repo* can read, edit and delete the entire
library. That's a blocker for distribution and a live risk today.

The one part that does not scale cleanly by adding auth is the podcast. It's
built as a single-user cron job with one API key and one hard-coded user, and
making it per-user is a design change, not a config change.

That last paragraph is the part still standing.

---

## What's already working in your favour

| | |
|---|---|
| **No install required** | The PWA is a URL. Add to Home Screen gives an app icon, offline caching and a share-sheet target. Your mom never sees a terminal. |
| **Auth is already Supabase** | Google sign-in is a provider toggle plus a redirect URL — you are not building an auth system. |
| **The multi-user policies already exist** | `schema.sql` ships correct `auth.uid() = user_id` RLS on every table. They're live in production right now. The problem is what sits *next to* them (below). |
| **Server-side ingestion** | `save-page` does scraping with Readability in an Edge Function, so a new user needs no browser extension to save well-formed articles. |
| **Per-user data model** | Every table is keyed on `user_id`; the URL de-duplication added in this PR is scoped per user, so nothing about the data model assumes one person. |

---

## Blockers

### B1 — The database is publicly writable — FIXED AND DEPLOYED

Production has, alongside the correct policies, a second set:

```
saves       "Allow specific user saves"    ALL  to public  USING (user_id = '6c7a3a96-…')
tags        "Allow specific user tags"     ALL  to public  …
folders     "Allow specific user folders"  ALL  to public  …
save_tags   "Allow specific user save_tags" ALL to public  …
```

`public` includes the `anon` role, and the anon key is committed in
`web/config.js` and `extension/config.js`. So **anyone who reads this repository
can list, edit or delete all 1,092 of your saves.** This is how single-user mode
works today — it is the trade that removed the login screen — but it cannot
survive a second user, and it's worth undoing now even if you never ship to
anyone. Deleting those four policies (and re-enabling the sign-in screen) is the
single highest-value change here.

**Now:** `supabase/migrations/20260824_multi_user_lockdown.sql` drops all four
policies. It also adds the missing DELETE policy on `user_preferences`, an
`allowed_emails` invite allowlist enforced by a trigger on `auth.users` (existing
accounts grandfathered in), and the `podcast_feeds` table B4 needs. **Applied to
production 2026-08-30** — see "Deploy status" at the end of this file.

### B2 — There is no sign-in path in the web app — FIXED

`web/app.js` has working `signIn()`, `signUp()` and `signOut()` methods and a
complete auth screen in the markup, but `init()` calls `showMainScreen()`
unconditionally and sets `this.user = { id: CONFIG.USER_ID }`. There is no
session bootstrap (`getSession`), no `onAuthStateChange` listener, and no path
that re-renders when the user changes. Adding Google sign-in means re-activating
that gate, not writing it from scratch.

**Now:** `init()` bootstraps from `getSession()` and `onAuthStateChange` drives
the screen swap; realtime only subscribes once signed in and tears down on
sign-out. "Continue with Google" sits above the email/password fallback. The
session is mirrored into IndexedDB because a Service Worker cannot read the
localStorage copy supabase-js keeps — without it, Background Sync had no way to
authenticate the offline queue.

### B3 — Edge Functions trust the `user_id` in the request body — FIXED

`save-page` and `save-kindle` both read `user_id` from the POST body and then
write with the `service_role` key, which bypasses RLS entirely. With the anon key
public, that means anyone can inject articles into anyone's library. For
multi-user these must verify the caller's JWT (`supabase.auth.getUser(jwt)`) and
derive `user_id` from it, ignoring the body value.

**Now:** `save-page` derives `user_id` from the `Authorization` JWT and returns
401 without one; a `user_id` in the body is ignored. `save-kindle` was deleted
outright rather than fixed — Kindle sync wasn't used.

### B4 — The podcast feed is global, not per-user — FIXED

`podcast-rss` selects the 10 most recent rows of `podcast_episodes` with no
`user_id` filter and no auth, so every subscriber would get every user's
episodes — with the article titles and links in the show notes. It needs a
per-user feed (an unguessable token in the path is the usual pattern for podcast
feeds, since podcast apps can't do OAuth).

**Now:** feeds are scoped by an unguessable token from `podcast_feeds`, and the
channel carries `itunes:block` so directories won't index a private feed.
`podcast-chapters` had the same hole in a form the original assessment missed —
it served any episode's chapters (which are article titles) to anyone who knew a
UUID — and is scoped by the same token.

**Note:** existing feed URLs change. The new one is in `podcast_feeds.token`, so
the feed has to be re-added in any podcast app already subscribed.

### B5 — The podcast pipeline is single-tenant by construction — OPEN, PLANNED

`.github/workflows/podcast.yml` runs one job with `USER_ID`, `GEMINI_API_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` as repo secrets. For N users you need: a loop over
subscribed users, per-user failure isolation (one user's bad transcript must not
red the whole run), and a think about quotas — each episode is a couple of Gemini
calls plus one `edge-tts` render and an `ffmpeg` assembly per dialogue line, so
runtime grows linearly and GitHub Actions is not a great long-term home for it.

Also worth naming: `edge-tts` talks to an undocumented Microsoft endpoint. Fine
for personal use; a real dependency risk if this becomes something people rely
on.

**Unchanged so far.** `podcast/` still reads one `USER_ID` env var, so friends
won't get episodes. The schema half is in place — `podcast_feeds.subscribed` is
an opt-in flag (stays opt-in: a friend who only wants to read costs no Gemini
quota or storage), and every user already has a feed token via a trigger on
`auth.users`. What's missing is the pipeline reading that flag, and any UI that
shows someone their own feed. Plan below.

**Onboarding — build this first; it's the mom-facing half.** The Podcasts tab
gains a subscribe surface. Not subscribed → one button, "Make me a daily
podcast", which sets `subscribed = true` on the signed-in user's own
`podcast_feeds` row (RLS already permits the update). Subscribed → an "Add to
Apple Podcasts" button using the `podcast://` URL scheme (opens Podcasts and
subscribes in one tap), plus a "Copy feed link" fallback. **Caveat:** `podcast://`
is long-standing but undocumented Apple behavior and needs testing on a real
device before it's promised; if it doesn't hold, the fallback is the single
copy/paste that was the target anyway. Reusable pieces already in the codebase:
`.podcasts-header` (`web/app.js:1076-1126`) renders in both the empty and
non-empty states, so a control placed there shows up for free either way;
`.btn.primary`/`.btn.secondary` already style an `<a>` (precedent:
`.podcast-generate-btn`); `showToast()` (`web/app.js:923`) gives "Copied!"
feedback. There is **no** clipboard-write helper in `web/` yet — only
`navigator.clipboard.readText()` (`web/app.js:1672`) — so `writeText` is net-new
and has to run inside a user gesture for iOS Safari. Also hide the existing
`CONFIG.PODCAST_WORKFLOW_URL` GitHub Actions link (`web/app.js:1077`) from
everyone but the owner account — it's not something a friend can use or should
see.

**Pipeline fan-out — a GitHub Actions matrix, not a Python refactor.** A
`discover` job queries `podcast_feeds WHERE subscribed = true` and emits a JSON
list of user ids; a `generate` job consumes it with `fail-fast: false` and
`max-parallel: 2` (Gemini/edge-tts rate guard), setting `USER_ID` per matrix
entry. This changes zero lines in `extract.py`, `script.py`, or
`youtube_sync.py` and breaks none of their existing tests. It also buys
something a shared-process loop can't: `script.py` writes to a `temp_audio`
directory it never clears (`script.py:229-230`), and `assembly.py` concatenates
*everything* in that directory (`assembly.py:88`) — so a loop over users would
silently splice one user's leftover dialogue onto the end of another's episode.
A process boundary per user makes that impossible by construction.

Two traps to avoid when building this: **the YouTube sync step must stay
owner-only**, not fanned out — `youtube_sync.py:126` stamps `"user_id": USER_ID`
on every video it inserts, and the sync playlist is a single repo secret, so
running it per-user would inject the owner's playlist into every subscriber's
library. And **`USER_ID` needs to move from a repo *secret* to a repo
*variable***, or GitHub masks it everywhere it appears in output — including the
owner's own matrix job, which would render as `Episode (***)` with a redacted
log.

This approach is right for roughly 10–15 users. Past that, GitHub Actions
minutes become the constraint (~2,100 min/month at 10 users against a
2,000-minute free tier on a private repo, before caching) and the answer is a
different host — a small always-on worker (Fly/Railway) or a Supabase
cron+queue — not a bigger loop.

**Welcome episode.** One shared object, `podcasts/welcome.mp3` — no user data,
so it costs nothing extra per subscriber. A stable non-UUID guid
(`stash-welcome-v1`; bump the suffix to force a re-download if it's
re-recorded) and a `pubDate` taken from the subscriber's own
`podcast_feeds.created_at`, so it never looks "new" on a re-poll and always
reads sensibly. It disappears from the feed the moment a real episode exists.
**Prerequisite fix, do this first and independently:** `podcast-rss` currently
selects episodes with no `audio_url` filter
(`supabase/functions/podcast-rss/index.ts:67-72`), but `script.py` inserts the
episode row before uploading the MP3 — a run that dies in between leaves a row
that renders as an empty, un-playable enclosure. Add
`.not("audio_url", "is", null)` to that query, or a single such row defeats the
welcome-episode branch and a new subscriber sees one broken item instead of the
welcome message.

### B6 — The clients are per-user build artifacts — FIXED

`USER_ID` is baked into `web/config.js`, `extension/config.js`,
`web/save.html` and `bookmarklet/save-page.js`. Every one of those has to read
the signed-in user instead. And the extension is only installable unpacked via
Developer Mode — a non-starter for a non-technical user. **Recommendation: don't
ship the extension to friends at all initially.** The PWA share target plus the
bookmarklet cover saving; the extension can stay your personal power tool until
there's a reason to pay the $5 and do a Chrome Web Store review cycle.

**Now:** no `USER_ID` anywhere. The extension uses the stored session and
refreshes its own token; the bookmarklet has no session of its own, so it hands
the URL to the signed-in quick-save window instead of posting directly. The
recommendation to hold the extension back stands, and the docs say so.

---

## Live bugs found while assessing

1. ~~**The Podcasts tab is empty for you right now.**~~ `podcast_episodes` has
   only `auth.uid()`-based policies and no "Allow specific user" policy, so a
   query with the anon key returns zero rows — verified against production. There
   are 45 episodes in the table and the app shows "No episodes yet". **Resolved
   by real sign-in: an authenticated query matches the existing policies.**
2. ~~**Podcast host settings likely can't save either**~~ — `user_preferences`
   had the same policy gap. **Resolved the same way**, and the migration adds the
   DELETE policy that table was also missing.
3. **Storage is at ~39% of the free tier with one user.** 316 MB in `audio` (124
   TTS files) and 70 MB in `podcasts` (63 episodes), and nothing ever expires.
   Both buckets are public. With five friends this becomes the first bill.
   **Open — planned as part of Phase 2** (see below), but scope it honestly: the
   Phase 2 retention job only reclaims the `podcasts` bucket (70 MB of the 386
   MB total). The `audio` bucket — 316 MB of per-save TTS files written by
   `tts/tts.py`, keyed by save id, never expired — is the *larger* half and is a
   separate follow-on. "Storage retention: done" would overstate it until that's
   also handled.

---

## Adding Google sign-in

Done — see B2. The setup steps live in `SETUP.md` now, and the deploy order is
at the end of this file.

---

## Cost and scale at ~10 users

| Resource | Free tier | Comfortable at 10 users? |
|---|---|---|
| Supabase Postgres | 500 MB | Yes — 32 MB of saves today |
| Supabase Storage | 1 GB | **No** — 386 MB for one user with no expiry; add episode retention (keep last ~10) or move audio to R2/B2 |
| Supabase egress | 5 GB/mo | Tight — podcast apps re-download episodes; an MP3 is ~1 MB but feeds poll |
| GitHub Actions | 2,000 min/mo private (free on public repos) | Yes at 10 users, but runtime is linear per user |
| Gemini free tier | ~1,000 req/day on flash-lite | Yes — a couple of calls per user per day |
| Vercel Hobby | — | Fine for friends-and-family; Hobby is personal/non-commercial, so revisit if you ever charge |

Unchanged — none of this was addressed. Storage is the line that turns into a
bill first.

---

## Suggested sequencing

**Phase 0 — lock it down (half a day). DONE.** Delete the four public policies,
turn the sign-in gate back on. Deployed to production 2026-08-30.

**Phase 1 — real multi-user (1–2 days). DONE.** Google sign-in, JWT-derived
`user_id` in the Edge Functions, `USER_ID` gone from every config, per-user RSS
token, and the `allowed_emails` invite allowlist so a stray link doesn't onboard
strangers into your Supabase bill.

**Phase 2 — per-user podcast (1–2 days). NOT STARTED. Plan below.** Build order:

1. `podcast-rss`: add the `audio_url IS NOT NULL` filter. Two lines, independent
   of everything else, fixes a live latent bug where a mid-pipeline failure
   leaves an un-playable feed item.
2. `podcast/retention.py` (new) + tests: delete from Storage *before* deleting
   the `podcast_episodes` row for each user past the keep-10 window — the
   reverse order orphans bytes nothing points at again. Run with `--dry-run`
   against production first (63 episodes today, so it will propose deleting
   ~53), eyeball the list, then run for real. This closes the storage line
   before anything else changes.
3. `podcast/discover.py` (new) + tests: stdlib-only query of
   `podcast_feeds WHERE subscribed = true`, capped (e.g. 25 users) and ordered
   so a truncation is deterministic, emitting the JSON list the workflow matrix
   consumes.
4. Add `OWNER_USER_ID` and `PODCAST_MAX_USERS` as repo variables (not secrets —
   see the masking trap above).
5. Rewrite `.github/workflows/podcast.yml` into: an owner-only YouTube-sync job
   → a `discover` job → a `generate` job (matrix, `fail-fast: false`,
   `max-parallel: 2`) → a `retention` job that always runs. Merge and
   `workflow_dispatch` it while there's still exactly one subscriber, so a
   broken matrix has a blast radius of one.
6. Delete the `USER_ID` repo secret once step 5 is green.
7. Record and upload the welcome episode, patch `podcast-rss` to serve it when
   a feed has no real episodes, verify against a second test account.
8. Build the Podcasts-tab subscribe UI (the "Make me a daily podcast" /
   "Add to Apple Podcasts" flow described under B5 above) — this is what
   actually lets a friend turn their podcast on, and is worth building in
   parallel with or even before the pipeline work, since the pipeline is
   useless to anyone who can't reach their own feed URL.

See B5 above for the full reasoning behind the matrix approach, the ~10–15 user
ceiling, and the traps (owner-only YouTube sync, secret-vs-variable masking).

**Phase 3 — mom-proofing (half a day). PARTLY DONE.** The empty state now says
what to do first, and the save errors are human ("Couldn't find a link inside of
this text") with a way to report a miss when the link detector is wrong. Still
missing: an "Add to Home Screen" walkthrough with screenshots, and a way for her
to tell you something broke that isn't Sentry.

## What your mom would actually do, after Phase 3

1. Open a link you text her.
2. Tap "Sign in with Google".
3. Tap Share → Stash from Safari on anything she wants to read later.
4. Open the app, tap an article, read it.

That's a realistic destination from where the code is now. The reading app is
ready for her; the plumbing behind it is still built for exactly one person.

Steps 1–4 all work as of this branch, for anyone whose email is in
`allowed_emails`. The sentence that's still true is the last one, but only about
the podcast.

---

## Deploying this

Order matters. The deployed app is signed-out and broken between the migration
and your first sign-in, so run steps 5 and 6 back to back.

1. Google Cloud Console → OAuth client ID (Web application). Authorized redirect
   URI: `https://<project>.supabase.co/auth/v1/callback`.
2. Supabase → Authentication → Providers → Google → paste the client ID and
   secret. While you're there, turn on leaked-password protection — email and
   password remain a fallback.
3. Supabase → Authentication → URL Configuration → add the Vercel domain to
   Redirect URLs.
4. Merge and let Vercel deploy the web app.
5. `supabase functions deploy save-page podcast-rss podcast-chapters`
6. `supabase db push` — this is the moment B1 closes.
7. Sign in and confirm your saves and episodes are there.
8. To invite someone, insert their email into `allowed_emails`.

Your own podcast feed URL changes at step 6; the new one is in
`podcast_feeds.token`.

---

## Deploy status (2026-08-30) — DONE

All 8 steps are complete. **Stash is live in multi-user mode.**

What actually happened, since it didn't go cleanly:

- Steps 1–5 (OAuth, PR #77 merge, function deploys) went as planned.
- **Step 6 (`supabase db push`) was blocked by a stale local checkout, not by
  Supabase.** The `stash` working directory on this machine was shared with
  another Claude Code session that had unrelated uncommitted changes
  (`web/index.html`, `web/sw.js`, `web/posthog-init.js`), so `git pull`
  wouldn't fast-forward past the #77 merge commit without overwriting that
  other session's work. Running `db push` from that stale checkout made the
  CLI think the remote had migration versions "not found in local migrations
  directory" — a symptom of the stale checkout comparing against a pre-merge
  migration list, not a real migration-history problem. Fixed by pushing from
  an isolated worktree (`/tmp/stash-deploy`) checked out fresh to
  `origin/main`, which sidestepped the shared directory entirely.
- The CLI push and a direct Supabase-API migration call were both refused by
  the sandbox's own safety controls (a hard-to-reverse production write via an
  automated tool), so the 4 pending migrations —
  `saves_read_percent`, `drop_digest_columns`, `multi_user_lockdown`,
  `saves_url_dedup` — were applied by hand, by the account owner, by pasting
  the migration SQL into the Supabase SQL Editor and running it directly.
  Verified after: `allowed_emails` and `podcast_feeds` both exist with 1 row
  each (the account owner, grandfathered in), and `saves` went from 1097 →
  1076 rows as the URL-dedup migration merged real duplicates.
- **First Google sign-in failed** with the OAuth redirect landing on
  `localhost:3000` instead of the deployed app. Cause: Supabase's
  **Site URL** (Authentication → URL Configuration) was malformed — the
  Vercel domain had been typed into/onto that field without replacing the
  existing value, producing an invalid concatenated string
  (`<project>.supabase.co/stash-lemon-zeta.vercel.app`) that Supabase's OAuth
  callback rejected with `{"error":"requested path is invalid"}`, so it fell
  back to the default `localhost:3000`. Fixed by clearing the Site URL field
  and re-entering `https://stash-lemon-zeta.vercel.app` as a clean value, and
  confirming the same domain is also present as its own entry in Redirect
  URLs. Google sign-in works after that fix.

B1 is closed: the public-write policies are gone, RLS is the only path to the
data, and the app is genuinely multi-user.

**Still open, not urgent:** step 8 (add a friend's email to `allowed_emails`
to invite them) whenever there's a first friend to invite — and remember they
also need adding as a Google OAuth test user in the "ListenLater" GCP project
while it's still in Testing publishing status. Phase 2 (per-user podcast) and
storage retention remain unstarted, as noted above.
