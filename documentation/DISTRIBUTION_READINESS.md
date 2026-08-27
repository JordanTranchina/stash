# Distribution Readiness

_Assessment date: 2026-08-24. Updated 2026-08-25 on the `launch-readiness`
branch, which implements Phases 0 and 1 below. Target: hand Stash to a handful
of friends (and your mom) as a hosted product — no self-hosting, no config
files, no GitHub._

## Status at a glance

| | |
|---|---|
| **B1** Database publicly writable | Fixed in code — migration written, **not yet applied to production** |
| **B2** No sign-in path in the web app | Fixed |
| **B3** Edge Functions trust the body's `user_id` | Fixed |
| **B4** Podcast feed is global | Fixed |
| **B5** Podcast pipeline is single-tenant | **Open** |
| **B6** Clients are per-user build artifacts | Fixed |
| Storage has no retention | **Open** |

The remaining work is Phase 2 (per-user podcast) and the storage bill. Until
the migration is applied to production, B1 is still live — see "Deploying" at
the end.

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

### B1 — The database is publicly writable — FIXED IN CODE, NOT YET DEPLOYED

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
accounts grandfathered in), and the `podcast_feeds` table B4 needs. **This is
still live in production until the migration is applied** — it is deliberately
sequenced to run immediately before the first sign-in, since the deployed app is
signed-out and broken in between.

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

### B5 — The podcast pipeline is single-tenant by construction — STILL OPEN

`.github/workflows/podcast.yml` runs one job with `USER_ID`, `GEMINI_API_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` as repo secrets. For N users you need: a loop over
subscribed users, per-user failure isolation (one user's bad transcript must not
red the whole run), and a think about quotas — each episode is a couple of Gemini
calls plus one `edge-tts` render and an `ffmpeg` assembly per dialogue line, so
runtime grows linearly and GitHub Actions is not a great long-term home for it.

Also worth naming: `edge-tts` talks to an undocumented Microsoft endpoint. Fine
for personal use; a real dependency risk if this becomes something people rely
on.

**Unchanged.** `podcast/` still reads one `USER_ID` env var, so friends won't get
episodes. The schema half is in place — `podcast_feeds.subscribed` is an opt-in
flag, so the pipeline has something to loop over when it's written, and a friend
who only wants to read costs no Gemini quota. The Podcasts tab also has no UI yet
for showing someone their own feed URL.

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
   **Still open** — no retention policy has been added.

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

**Phase 0 — lock it down (half a day). DONE in code.** Delete the four public
policies, turn the sign-in gate back on. The migration is written; applying it is
the deploy step below.

**Phase 1 — real multi-user (1–2 days). DONE.** Google sign-in, JWT-derived
`user_id` in the Edge Functions, `USER_ID` gone from every config, per-user RSS
token, and the `allowed_emails` invite allowlist so a stray link doesn't onboard
strangers into your Supabase bill.

**Phase 2 — per-user podcast (1–2 days). NOT STARTED.** Loop the pipeline over
opted-in users (`podcast_feeds.subscribed`), isolate failures, add episode
retention. Retention is also the fix for the storage line above, so these are one
piece of work.

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
