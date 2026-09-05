# Read Later ↔ Listen Later: Integration Ideas

Notes from a review of how the reading app (`web/`, `saves` table) and the
podcast pipeline (`podcast/`, `podcast_episodes` table) connect today, and
where the connection could go further. Grounded in the actual code, not
aspirational — each idea below says what it builds on.

## Done

- **FIFO selection + discussed dedup** (#68, merged): `podcast/extract.py`
  now selects saves oldest-first with no recency cutoff instead of
  newest-first within a 7-day window, so a save can no longer silently age
  out and never be discussed. `podcast/script.py` stamps every discussed
  save with `podcast_episode_id` / `podcast_discussed_at`
  (`supabase/migrations/20260730115730_saves_podcast_discussed.sql`), so nothing
  is re-discussed in a later episode.

## Ideas

Roughly in order of effort.

### 1. Close the loop with one button
`podcast_episodes.related_article_ids` already stores which saves an
episode covered. Add a "Mark these as read" button on each episode card in
the Podcasts tab (`web/app.js`, the `podcasts-view` renderer) that archives
every save in that list. Cheap — no new data needed, just a button and an
`is_archived` bulk update.

### 2. Deep-link episode → article
Show notes currently link each discussed article to its **original**
source URL (`build_description` in `podcast/script.py`). Point them at
Stash's own reading view instead (e.g. `https://stash.app/read/<save_id>`),
so tapping a timestamp in a podcast app opens the cleaned/extracted version
Stash already has, not a live (possibly paywalled) page.

### 3. Deep-link article → episode
`compute_article_start_times` already computes the exact playback second
each article is discussed. Add a "🎧 Jump to this in the podcast" button on
the reading pane (`web/app.js`) that opens the relevant episode's audio at
that chapter's timestamp — the data already exists, this is just surfacing
it in the reading UI.

### 4. Per-save curation
Selection today is pure FIFO: oldest unarchived, undiscussed save wins, no
say in the matter. Add an explicit toggle on each save ("skip for podcast" /
"prioritize") so `extract.py`'s query can respect curation instead of only
recency — and optionally weight `is_favorite` or specific tags higher.

### 5. On-demand single-article episode
The Podcasts tab already links out to the GitHub Actions "Run workflow"
page for on-demand generation of the whole queue. Scope it down: an
"add to next episode" or "make a solo episode from just this" action on a
single save's reading view, rather than only the full recent-saves queue.

### 6. Merge the two TTS paths
`tts/tts.py` is a separate always-on daemon doing raw single-article
narration (`en-US-AriaNeural`) that writes straight to `saves.audio_url`,
running alongside the two-host podcast pipeline (`podcast/script.py`,
`en-US-AndrewNeural` / `en-US-AvaNeural`). Folding single-article narration
into the podcast pipeline's chaptering/assembly code would mean one voice
system instead of two, and "listen to just this article" could reuse
episode infrastructure instead of a parallel one.

Also: `tts/tts.py` has the Supabase URL, publishable key, and user ID
hardcoded in plaintext at the top of the file (already committed). Worth
moving to environment variables regardless of the merge above.

### 7. Surface "listen available" in the main list
A card in the main saves list currently only shows read/archive/favorite
state. Add a headphone icon for any save that has an `audio_url` or shows
up in some episode's `related_article_ids`, so read-vs-listen becomes a
visible per-item choice instead of two disconnected tabs.
