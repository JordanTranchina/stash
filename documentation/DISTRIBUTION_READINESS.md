# Distribution Readiness

_Assessment date: 2026-08-24. Target: hand Stash to a handful of friends (and your
mom) as a hosted product — no self-hosting, no config files, no GitHub._

## Verdict

**Not ready to send today, but the gap is narrower than it looks — roughly 3–5
focused days.** Almost none of the missing work is in the reading experience,
which is genuinely good. It's all in the identity layer: right now Stash has no
login at all, and the database is deliberately wired so that *anyone holding a
key that ships in this public repo* can read, edit and delete the entire
library. That's a blocker for distribution and a live risk today.

The one part that does not scale cleanly by adding auth is the podcast. It's
built as a single-user cron job with one API key and one hard-coded user, and
making it per-user is a design change, not a config change.

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

### B1 — The database is publicly writable (fix this regardless of distribution)

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

### B2 — There is no sign-in path in the web app

`web/app.js` has working `signIn()`, `signUp()` and `signOut()` methods and a
complete auth screen in the markup, but `init()` calls `showMainScreen()`
unconditionally and sets `this.user = { id: CONFIG.USER_ID }`. There is no
session bootstrap (`getSession`), no `onAuthStateChange` listener, and no path
that re-renders when the user changes. Adding Google sign-in means re-activating
that gate, not writing it from scratch.

### B3 — Edge Functions trust the `user_id` in the request body

`save-page` and `save-kindle` both read `user_id` from the POST body and then
write with the `service_role` key, which bypasses RLS entirely. With the anon key
public, that means anyone can inject articles into anyone's library. For
multi-user these must verify the caller's JWT (`supabase.auth.getUser(jwt)`) and
derive `user_id` from it, ignoring the body value.

### B4 — The podcast feed is global, not per-user

`podcast-rss` selects the 10 most recent rows of `podcast_episodes` with no
`user_id` filter and no auth, so every subscriber would get every user's
episodes — with the article titles and links in the show notes. It needs a
per-user feed (an unguessable token in the path is the usual pattern for podcast
feeds, since podcast apps can't do OAuth).

### B5 — The podcast pipeline is single-tenant by construction

`.github/workflows/podcast.yml` runs one job with `USER_ID`, `GEMINI_API_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` as repo secrets. For N users you need: a loop over
subscribed users, per-user failure isolation (one user's bad transcript must not
red the whole run), and a think about quotas — each episode is a couple of Gemini
calls plus one `edge-tts` render and an `ffmpeg` assembly per dialogue line, so
runtime grows linearly and GitHub Actions is not a great long-term home for it.

Also worth naming: `edge-tts` talks to an undocumented Microsoft endpoint. Fine
for personal use; a real dependency risk if this becomes something people rely
on.

### B6 — The clients are per-user build artifacts

`USER_ID` is baked into `web/config.js`, `extension/config.js`,
`web/save.html` and `bookmarklet/save-page.js`. Every one of those has to read
the signed-in user instead. And the extension is only installable unpacked via
Developer Mode — a non-starter for a non-technical user. **Recommendation: don't
ship the extension to friends at all initially.** The PWA share target plus the
bookmarklet cover saving; the extension can stay your personal power tool until
there's a reason to pay the $5 and do a Chrome Web Store review cycle.

---

## Live bugs found while assessing

1. **The Podcasts tab is empty for you right now.** `podcast_episodes` has only
   `auth.uid()`-based policies and no "Allow specific user" policy, so a query
   with the anon key returns zero rows — verified against production. There are
   45 episodes in the table and the app shows "No episodes yet". The RSS feed
   works because it uses the service role. Fixing B1/B2 properly (real sign-in)
   fixes this too.
2. **Podcast host settings likely can't save either** — `user_preferences` has
   the same policy gap, so the podcast settings modal is writing into a table the
   anon key can't touch.
3. **Storage is at ~39% of the free tier with one user.** 316 MB in `audio` (124
   TTS files) and 70 MB in `podcasts` (63 episodes), and nothing ever expires.
   Both buckets are public. With five friends this becomes the first bill.

---

## Adding Google sign-in

The provider itself is the easy half.

**Supabase / Google Cloud (about 30 minutes, no code)**
1. Google Cloud Console → OAuth consent screen (External), then Credentials →
   OAuth client ID → Web application.
2. Authorized redirect URI: `https://<project>.supabase.co/auth/v1/callback`.
3. Supabase → Authentication → Providers → Google → paste client ID and secret.
4. Add your Vercel domain to Authentication → URL Configuration → Redirect URLs.
5. While you're there: turn on leaked-password protection (currently off) if you
   keep email/password as a fallback.

**Code (the real work)**
- `web/app.js`: a `signInWithOAuth({ provider: 'google' })` button; replace the
  hard-coded `this.user` with `getSession()` plus an `onAuthStateChange`
  listener; gate `showMainScreen()` on a session; make `signOut()` return to the
  auth screen. Everything downstream already uses `this.user.id`.
- `web/save.html` and `web/sw.js`: take `user_id` from the stored session rather
  than `CONFIG.USER_ID` (the service worker reads the persisted session from
  IndexedDB/localStorage).
- `supabase/functions/*`: derive `user_id` from the `Authorization` JWT.
- Drop the four "Allow specific user" policies.
- Extension (only if you ship it): `chrome.identity.launchWebAuthFlow` against
  the Supabase OAuth endpoint, storing the session the way `supabase.js`
  already stores password sessions.

Roughly a day of work plus testing, most of it in `app.js`.

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

---

## Suggested sequencing

**Phase 0 — lock it down (half a day).** Delete the four public policies, turn
the sign-in gate back on for yourself with email/password, verify every client
still saves. Nothing else can be tested honestly until this is done.

**Phase 1 — real multi-user (1–2 days).** Google sign-in, JWT-derived `user_id`
in the Edge Functions, remove `USER_ID` from every config, per-user RSS token.
Invite by allowlist (a `allowed_emails` table checked at sign-up) so a stray link
doesn't onboard strangers into your Supabase bill.

**Phase 2 — per-user podcast (1–2 days).** Loop the pipeline over opted-in users,
isolate failures, add episode retention. Consider whether the podcast should be
opt-in per user rather than automatic.

**Phase 3 — mom-proofing (half a day).** An empty state that explains what to do
first, an "Add to Home Screen" walkthrough with screenshots, human error messages
instead of `Server rejected the save`, and a way for her to tell you something
broke that isn't Sentry.

## What your mom would actually do, after Phase 3

1. Open a link you text her.
2. Tap "Sign in with Google".
3. Tap Share → Stash from Safari on anything she wants to read later.
4. Open the app, tap an article, read it.

That's a realistic destination from where the code is now. The reading app is
ready for her; the plumbing behind it is still built for exactly one person.
