# Analytics Plan — Corrections

Corrections to *"Does Every Stash Feature Earn Its Keep?"* (Stash Analytics Plan,
Aug 2026), checked against the instrumentation shipped in #79 / #81. The plan's
structure — North Star, save→read funnel, read-it-never rate, feature scorecard —
is sound. These are the fixes needed before the numbers can be trusted.

Code changes in this branch implement items 1–3. Items 4–6 are
dashboard/interpretation notes with no code change.

---

## 1. `save_created` now carries `save_id` — the funnel can join

**Was:** `save_created` emitted only `source` / `duplicate` / `type`. Every
downstream event (`article_opened`, `article_read_progress`, `audio_played`)
carries `save_id`, but the save event did not, so a strict per-article
save→open→read funnel had no shared key. The plan correctly flagged this as the
one blocking fix.

**Now:** every save path attaches `save_id` (the `saves` row id):

| Path | File | Notes |
|---|---|---|
| Extension — full page | `extension/background.js` `savePage` | `result[0].id`; absent on a duplicate (no row inserted) |
| Extension — highlight | `extension/background.js` `saveHighlight` | `result[0].id` |
| Manual URL (web) | `web/app.js` `saveUrlManually` → `saveViaScrapeDetailed` | via `body.save.id` |
| Share target / mobile-web / offline-queue drain | `web/save-lib.js` `saveViaScrapeDetailed` | via `body.save.id` (the `save-page` function already returns the row) |

`extension-firefox/` regenerated via `npm run sync:firefox-extension`.

**Unlocks:** true per-article funnel; exact read-it-never via HogQL (`save_created`
rows whose `save_id` has no `article_read_progress[percent >= 75]` within 14
days); time-to-read (gap between a save and its first `article_opened`).

**Still approximate — `import`:** `import_completed` fires once with
`total` / `imported` / `failed` counts; it does not emit a `save_created` per
imported row, so imported saves have no `save_id` and can't be attributed
individually. Import read-through stays a cohort approximation (imported-in-window
vs. reads-in-later-window) until per-row save events exist. Reflected in the
`save_created` row of `SETUP.md` ("absent … on `import`").

---

## 2. `article_read_progress` is scroll-position only — dwell time added

**The real flaw (the plan's "short article" concern, corrected):**
`updateReadingProgress` is wired to the `reading-content` **scroll** event only,
so an article that fits with no scrollbar fires *nothing* — it does not
auto-complete as the plan feared. The actual over-count is the **flick**: for any
article only modestly taller than the viewport, `scrollTop / scrollHeight` jumps
to a high percentage from one trackpad flick or momentum scroll, firing
25/50/75/100 in a single tick. Milestones are driven purely by scroll position —
there is **no reading-time gate at all**. A 4,000-word essay scrolled to the
bottom in two seconds counts identically to one actually read.

**Now:** milestones are still emitted (suppressing them would irreversibly lose
genuine reads during the baseline period), but each `article_read_progress` event
carries:

- `dwell_seconds` — wall-clock since the reading pane opened for this session
  (`readingPaneOpenedAt` stamped in `openReadingPane`)
- `word_count` — words in the extracted body (`wordCount()`, also now the basis
  for `readingTime()`)

`article_opened` also gains `word_count`, so open→read analysis by article length
needs no `save_id` join back to the row.

**Dashboard rule:** the North Star tile ("weekly read-throughs") must filter
`article_read_progress` to `percent = 75 AND dwell_seconds >= word_count / 10`
(≈10 words/sec is a generous skim ceiling), or a flat floor such as
`dwell_seconds >= 20`. An unfiltered count is a scroll-velocity metric, not a
reading metric. Same filter on the funnel's read step so funnel and North Star
agree.

---

## 3. `search_performed` fires mid-typing — `query_length` added

**Was:** search runs on a 300ms debounce on every `input` event, so typing
"reading" emits events for "re", "rea", "readi", … — the early ones usually
`result_count = 0` through no fault of search quality. The plan's zero-result
rate (`count(result_count = 0) / count(all)`) is inflated by half-typed stubs.

**Also:** `SETUP.md` described `search_performed` as firing *"when a search
returns results"*. The code (`web/app.js` `search()`) has always fired it
unconditionally with `result_count: this.saves.length`, so `result_count = 0`
**does** land. The doc was wrong, not the instrumentation — no verification step
needed. Fixed in `SETUP.md`.

**Now:** `search_performed` carries `query_length` (trimmed). Build the
zero-result rate over `query_length >= 3` (or whatever floor matches how you
actually search) so the metric reflects real queries. If the noise is still bad,
the follow-up is to capture only on submit/Enter rather than per debounce — a UX
change, deliberately not made here.

---

## 4. The funnel is web-app-only — read the `source` breakdown accordingly

Only `save_created` fires from the extension. `article_opened`,
`article_read_progress`, `search_performed`, `sort_changed`, `save_archived`,
`audio_played` are all web-app events. That's expected (reading only happens in
the web app), but it means the funnel's step-1 `source` breakdown answers *"whose
saves later get opened **in the web app**"*, not *"where reading happens"*. Don't
read a low extension→read conversion as an extension problem; it may just be that
extension-saved articles pile up until a web session.

---

## 5. `distinct_id` is the configured `USER_ID`, not literally `stash-user`

`analytics.js` defaults `distinctId` to `'stash-user'` but `init()` overrides it
with `CONFIG.USER_ID` (a UUID) whenever one is set, which single-user mode always
does. The plan's operative point still holds: it's one identity, so
"unique users" is always 1 — count events and distinct `save_id`s. Just don't go
looking for a literal `stash-user` in PostHog; filter on the UUID.

---

## 6. Re-reads re-fire milestones — dedupe in HogQL if it matters

`readMilestonesFired` is a per-pane-session `Set`, so re-opening an article days
later re-emits its 25/50/75/100 events. The plan acknowledges this. At
single-user scale it's a minor over-count. If the North Star drifts because of
it, dedupe in HogQL by taking `min(timestamp)` per `(save_id, percent)` before
counting.

---

## Net effect on the plan's tiles

| Tile | Change |
|---|---|
| 1 · North Star: weekly read-throughs | add `dwell_seconds >= word_count / 10` filter to `percent = 75` |
| 2 · Save→read funnel | now a real per-`save_id` join; same dwell filter on the read step; `source` caveat (§4) |
| 3 · Read-it-never rate | exact HogQL version now possible (`save_id` with no qualifying read in 14d) |
| 4 · Reading-depth distribution | filter to dwell-qualified events or it's a scroll-depth chart |
| 8 · Search health | zero-result rate over `query_length >= 3` |
| — · Import health | stays a cohort approximation; no per-item `save_id` |
