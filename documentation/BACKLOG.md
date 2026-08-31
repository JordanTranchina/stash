# Project Backlog

## Core PWA & Offline Experience

- [x] **Offline Data Storage**: Implement IndexedDB layer (e.g., `idb-keyval`) to store articles for offline reading. (Ref: PWA Spec 3.C)
- [x] **Offline Fallback**: Configure Service Worker to serve cached `index.html` or a specific fallback for `/save.html` when offline. (Ref: PWA Spec 3.B)
- [x] **Offline Share Handling**: Update `save.html` to queue shared links in IndexedDB when offline ("Pending Sync"). (Ref: PWA Spec 4.A)
- [ ] **Pending Queue Auto-Sync**: Implement logic to sync pending items to Supabase when the app opens or connectivity returns. (Ref: PWA Spec 6)
- [ ] **Background Sync**: Use Service Worker `sync` event for robust retries of failed saves. (Ref: PWA Spec 6)

## Listen Later (AI Podcast)

- [ ] **Podcast Data Extraction**: Implement Supabase query to fetch recent, unarchived articles for the podcast. (Ref: Product Spec 3.1)
- [ ] **AI Scriptwriting ("Vibe Engine")**: detailed prompt engineering and LLM integration (Gemini/GPT) to generate a conversational script. (Ref: Product Spec 3.2)
- [ ] **Audio Generation (TTS)**: Integrate OpenAI TTS or Qwen3-TTS to convert script lines to audio. (Ref: Product Spec 3.3)
- [ ] **Audio Assembly**: Stitch audio segments into a single MP3 and add ID3 tags. (Ref: Product Spec 3.3)
- [ ] **RSS Feed Generation**: Generate valid `rss.xml` for the podcast and serve it via Vercel/Node. (Ref: Product Spec 3.4)

## Future / Enhancements

- [ ] **Morning Brief**: Configure daily cron trigger for podcast generation. (Ref: Product Spec 6)
- [ ] **On-Demand Podcast**: Add UI button to trigger podcast generation immediately. (Ref: Product Spec 6)
- [ ] **Custom Host Personalities**: Settings to configure host "vibes". (Ref: Product Spec 6)
- [ ] **Interactive RSS Chapters**: Add chapter markers to MP3s. (Ref: Product Spec 6)
- [x] **YouTube Transcript Ingestion**: Resolve saved YouTube URLs (e.g. from Watch Later) to transcripts and feed them into Listen Later like articles. (`podcast/youtube.py`, `podcast/extract.py`)
- [x] **YouTube Playlist Auto-Sync**: Poll a dedicated (Unlisted) YouTube playlist via the official Data API and insert new videos as saves, so a phone-populated playlist flows into Listen Later with no desktop. Literal Watch Later is intentionally out of scope (not API-accessible; scraping it risks a Google account ban). (`podcast/youtube_sync.py`, `.github/workflows/podcast.yml`)
- [x] **Discussed Dedup**: Stamp each save with `podcast_episode_id`/`podcast_discussed_at` once discussed so it's never re-covered by a later episode, without relying on a recency cutoff that could drop saves. (`podcast/extract.py`, `podcast/script.py`, `supabase/migrations/20260726_saves_podcast_discussed.sql`)
- [x] **Newest-First Selection**: Select saves most-recently-saved first (reverted from an oldest-first FIFO experiment that let a backlog of very old saves dominate every episode ahead of anything recent). (`podcast/extract.py`)
- [ ] **Extension E2E Tests**: Set up Playwright for extension testing. (Ref: Product Spec 6)
- [ ] **Documentation Screenshots**: Add screenshots to `README.md`. (Ref: README)
- [ ] **Publish Extension to Web Stores**: Apply for Chrome Web Store ($5 one-time, `<all_urls>` justification, likely manual review) and Firefox Add-ons (AMO) listings so non-technical users don't have to sideload unpacked, and extension fixes ship without a per-machine reload. Unlisted vs public TBD. ([#96](https://github.com/JordanTranchina/stash/issues/96); see `documentation/DISTRIBUTION_READINESS.md` B6)
