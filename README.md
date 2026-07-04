# Stash

A simple, self-hosted read-it-later app. Save articles, highlights, and Kindle notes to your own database.

**Your data. Your server. No subscription.**

## Features

- **Chrome Extension** - Save pages and highlights with one click
- **Web App** - Access your saves from any device
- **Kindle Sync** - Import highlights from your Kindle library
- **Full-Text Search** - Find anything you've saved
- **Text-to-Speech** - Basic audio generation (Edge TTS)
- **Listen Later** - Turn your saved articles into a conversational AI podcast with an RSS feed
- **iOS Shortcut** - Save from Safari on iPhone/iPad
- **Bookmarklet** - Works in any browser

## Why Stash?

- **Free forever** - Runs on Supabase free tier (500MB, unlimited API calls)
- **You own your data** - Everything stored in your own database
- **No account needed** - Single-user mode, no sign-up friction
- **Works offline** - PWA support for mobile
- **Open source** - Fork it, modify it, make it yours

## Quick Start

1. **Create a Supabase project** (free) at [supabase.com](https://supabase.com)
2. **Run the schema** from `supabase/schema.sql`
3. **Add your credentials** to `extension/config.js` and `web/config.js`
4. **Load the extension** in Chrome (`chrome://extensions` > Load unpacked)
5. **Deploy the web app** to Vercel/Netlify (free)

See [SETUP.md](SETUP.md) for detailed instructions.

## Project Structure

```
stash/
├── extension/       # Chrome extension
├── web/            # Web app (PWA)
├── tts/            # Text-to-speech generator
├── bookmarklet/    # Universal save bookmarklet
├── ios-shortcut/   # iOS Shortcut for Safari
└── supabase/       # Database schema & Edge Functions
```

## Tech Stack

- **Frontend**: Vanilla JS, HTML, CSS (no framework bloat)
- **Backend**: Supabase (PostgreSQL + REST API)
- **Hosting**: Any static host (Vercel, Netlify, GitHub Pages)

## Listen Later (AI Podcast)

**Listen Later** turns your saved articles into a two-host conversational podcast, distributed as a standard RSS feed you can subscribe to in any podcast app. A daily GitHub Action extracts recent unarchived articles, an LLM writes the script, Edge TTS voices the hosts, and the stitched MP3 (with per-article chapters) is published to Supabase Storage. You can also customize the host personalities or generate an episode on demand from the app. See [Product Spec.md](documentation/Product%20Spec.md) for details.

## Screenshots

### Your saves
![All saves](documentation/screenshots/01-all-saves.png)

### Reading view with text-to-speech
![Reading pane](documentation/screenshots/02-reading-pane.png)

### Listen Later podcast feed
![Podcasts view](documentation/screenshots/03-podcasts.png)

### Custom host personalities
![Podcast settings](documentation/screenshots/04-podcast-settings.png)

## License

MIT
