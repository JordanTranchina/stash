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
- [ ] **Extension E2E Tests**: Set up Playwright for extension testing. (Ref: Product Spec 6)
- [ ] **Documentation Screenshots**: Add screenshots to `README.md`. (Ref: README)
