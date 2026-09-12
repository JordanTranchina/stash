# **Product Specification: Stash & Listen Later**

> [!NOTE]
> This document specifies the core architecture, key user flows, and multi-user isolation requirements for **Stash** (a self-hosted/cloud read-it-later service) and its companion **Listen Later** daily AI podcast pipeline.

---

## **1. Product Overview**

**Stash** is a modern, distraction-free "read-it-later" platform and Pocket/Instapaper alternative designed for reading, archiving, and audio consumption. Users capture articles and web content from browser extensions, mobile share sheets, or in-app manual submission. Saved content is cleaned (via Mozilla Readability), synchronized to Supabase, cached for offline reading via PWA/IndexedDB, and transformed into personal daily conversational podcasts via **Listen Later**.

In a multi-user deployment, Stash guarantees complete data isolation across all accounts using Supabase Auth and Postgres Row Level Security (RLS). One user can never view, update, delete, or listen to another user's saves, reading progress, or podcast episodes.

---

## **2. Core Product Key Flows (Multi-User)**

The system is defined by six primary user flows. Every flow is architected to enforce strict multi-user data isolation.

```mermaid
graph TD
    subgraph Flow1["1. Log In"]
        U1[User Credentials] --> SupaAuth[Supabase Auth / JWT]
        SupaAuth --> SessionState[Isolated Client Session & RLS Context]
    end

    subgraph Flow2["2. Share Sheet Ingestion"]
        MobileShare[Mobile Share Sheet / save.html] --> SavePageEdge["/functions/v1/save-page (Bearer JWT)"]
        SavePageEdge --> ScrapedArticle[Readability Extraction & user_id = auth.uid()]
        ScrapedArticle --> UserSaves1[saves Table]
    end

    subgraph Flow3["3. In-App + Button Ingestion"]
        PlusBtn["+ Button Modal (#add-url-modal)"] --> ManualSave["save-page (source: manual)"]
        ManualSave --> UserSaves2[saves Table]
    end

    subgraph Flow4["4. Reading Article"]
        UserSaves2 --> ReadingPane["Reading Pane (#reading-pane)"]
        ReadingPane --> ReadPercent["read_percent Progress Tracking"]
    end

    subgraph Flow5["5. Archiving Article"]
        ReadingPane --> ToggleArchive["Archive Action (is_archived = true)"]
        ToggleArchive --> ActiveList["Filtered Active Library (is_archived = false)"]
    end

    subgraph Flow6["6. Daily Podcast Generation"]
        CronTrigger["Daily GitHub Actions Cron (8 AM UTC)"] --> Discover["podcast/discover.py"]
        Discover --> UserMatrix["Matrix Job per Subscribed User"]
        UserMatrix --> Extract["podcast/extract.py (user_id & is_archived = false)"]
        Extract --> ScriptSynth["script.py + edge-tts + ffmpeg"]
        ScriptSynth --> PrivateRSS["podcast-rss Edge Function (?token=user_token)"]
    end
```

### **Key Flow 1: Log In**
- **Description:** A user signs in to Stash on the web app, browser extension, or mobile PWA to access their private library.
- **User Journey:**
  1. User enters their email and password on `#auth-screen` and clicks `#signin-btn`.
  2. Supabase Auth validates credentials against `auth.users` and verifies the email against `allowed_emails` (if invite-only mode is active).
  3. The client receives a JWT access token containing the user's UUID in the `sub` claim.
  4. The UI transitions from `#auth-screen` to `#main-screen`, querying PostgREST for the user's private saves.
- **Multi-User Guarantees:**
  - Multiple concurrent users can be logged in across different browsers/devices without session cross-contamination.
  - Invalid credentials return explicit errors (`400 Bad Request`) and never authenticate or leak another user's session.
  - All PostgREST calls attach `Authorization: Bearer <JWT>`, mapping directly to Postgres `auth.uid()`.

### **Key Flow 2: Adding an Article via the Share Sheet**
- **Description:** A user shares a webpage or link from iOS Safari, Android Chrome, or any native mobile app into Stash.
- **User Journey:**
  1. The OS share sheet invokes the Stash PWA share target (`web/save.html?url=...&title=...&text=...`).
  2. `save.html` resolves the active user session token via `window.StashSave`.
  3. A POST request is dispatched to `/functions/v1/save-page` with the user's Bearer JWT.
  4. The Edge Function runs server-side Mozilla Readability (via `linkedom`) to extract clean title, author, lead image, excerpt, and article body.
  5. The article is saved to the `saves` table with `user_id` derived exclusively from `auth.uid()`.
- **Multi-User Guarantees:**
  - The client cannot spoof `user_id`; the Edge Function derives ownership strictly from the verified JWT.
  - **Per-User URL Deduplication:** Re-saving an existing URL updates the save date for that user (`duplicate: true`) without duplicating. If User B saves the same URL as User A, User B gets their own independent save row with no collision.
  - User B cannot see, query, or receive notifications for User A's share-sheet save.

### **Key Flow 3: Adding an Article via the `+` Button in the App**
- **Description:** A user manually pastes or types an article URL into the Stash web application.
- **User Journey:**
  1. User clicks the `+` button in the app header (`#header-add-btn`), opening `#add-url-modal`.
  2. User pastes a URL into `#add-url-url` (or clicks `#add-url-paste-btn`) and clicks `#add-url-save-btn`.
  3. `app.js` invokes `window.StashSave.saveViaScrapeDetailed()` with `source: 'manual'`.
  4. Upon successful response, the modal indicates success and closes, immediately refreshing the user's library (`#saves-list`).
- **Multi-User Guarantees:**
  - Saves are inserted with the active user's credentials.
  - User A's manual additions appear immediately in User A's active list, while User B's active list remains completely untouched.

### **Key Flow 4: Reading an Article**
- **Description:** A user opens and reads an article in the clean, typography-focused reading pane.
- **User Journey:**
  1. User clicks an article card in `#saves-list`.
  2. `openReadingPane(save)` opens `#reading-pane`, displaying title, publication date, author, domain, and full readable content.
  3. If full content was deferred for fast list loading, the app fetches `content` by ID from Supabase.
  4. As the user reads and scrolls, `updateReadingProgress()` updates `read_percent` (from 0 to 100%) and stamps read dwell time.
- **Multi-User Guarantees:**
  - RLS strictly prevents User B from reading User A's full article content, even with a known save ID.
  - User B cannot modify or overwrite User A's `read_percent` (PATCH queries by User B on User A's row affect 0 rows).
  - Reading progress is completely isolated per user account.

### **Key Flow 5: Archiving an Article**
- **Description:** A user archives an article after finishing it to declutter their active reading queue.
- **User Journey:**
  1. User clicks the Archive button in the reading pane (`#reading-archive-btn`) or swipes the article card in the list view.
  2. `toggleArchive()` sends a PATCH request updating `is_archived: true` for the save.
  3. The reading pane closes, and the article is removed from the Active view (`is_archived = false`).
  4. User can switch to the Archive view (`#archive-view` / `is_archived = true`) to browse or unarchive past reads.
- **Multi-User Guarantees:**
  - Archiving an article only updates the owning user's row.
  - User A archiving an article has zero impact on User B's active or archived queues.
  - User B cannot archive or unarchive User A's saves.

### **Key Flow 6: Automatically Creating a Podcast Each Day**
- **Description:** A daily automated pipeline converts each subscribed user's recent, unarchived saves into a customized, two-host conversational podcast episode ("Listen Later").
- **User Journey:**
  1. At 8:00 AM UTC daily, GitHub Actions triggers `.github/workflows/podcast.yml`.
  2. **Subscriber Discovery (`podcast/discover.py`):** Queries `podcast_feeds` table where `subscribed = true`. Generates a dynamic GitHub Actions execution matrix with one job per subscribed user.
  3. **Isolated Extraction (`podcast/extract.py`):** For each user job (`USER_ID = matrix.user_id`), the pipeline queries `saves` matching `user_id = eq.{USER_ID}`, `is_archived = eq.false`, `podcast_discussed_at = is.null`, and `created_at >= cutoff`.
  4. **Archived Exclusion:** Articles archived in Key Flow 5 are strictly excluded from the podcast.
  5. **Dialogue Synthesis & Audio Assembly:** Gemini generates two-host dialogue using the user's custom personality preferences (`user_preferences.podcast_hosts`). `edge-tts` renders voice clips, and `ffmpeg` stitches the audio with chapter markers.
  6. **Upload & Discussed Stamping:** The MP3 is uploaded to Supabase Storage, a row is inserted in `podcast_episodes`, and extracted saves are stamped with `podcast_discussed_at` so they are not repeated in future episodes.
  7. **RSS Distribution:** User's podcast app (e.g. Pocket Casts, Apple Podcasts) polls `/functions/v1/podcast-rss?token=<user_token>` and receives their new personalized episode.
- **Multi-User Guarantees:**
  - Each subscribed user receives a separate matrix job process boundary.
  - An individual user's generation failure does not cancel or block other users' episodes (`fail-fast: false`).
  - Temporary audio clips are isolated per run to prevent audio cross-contamination.
  - User A's RSS feed contains only User A's episodes; User B's RSS feed contains only User B's episodes.
  - Accessing the feed with an invalid or unknown token returns `404 Not Found`.

---

## **3. Technical Architecture & Stack**

- **Database & Auth:** Supabase (PostgreSQL 15, PostgREST, Supabase Auth with RLS).
- **Web Client & PWA:** Vanilla HTML5, CSS3, JavaScript (no framework, no bundler), Service Worker (`sw.js`), IndexedDB (`db.js`).
- **Edge Functions:** Deno / TypeScript deployed to Supabase Functions:
  - `save-page`: Readability scraper, redirect resolver, X/Twitter embed parser, multi-user attribution.
  - `podcast-rss`: Public RSS 2.0 feed generator keyed on user private token.
  - `podcast-chapters`: JSON chapter markers for podcast players.
- **Podcast Pipeline:** Python 3.10 CLI running via GitHub Actions:
  - `discover.py`: Stdlib-only subscriber discovery.
  - `extract.py`: Per-user article query and YouTube transcript extraction.
  - `script.py`: Dialogue synthesis via Gemini 2.5 Flash-Lite / GPT-4o-mini.
  - `assembly.py`: Audio concatenation and ID3 metadata tagging via ffmpeg.
  - `retention.py`: Pruning historical episodes beyond user-configured retention limit.

---

## **4. Data Model & RLS Security Contracts**

All database access is constrained by Row Level Security (RLS) policies defined in `supabase/schema.sql` and migrations:

| Table | Primary RLS Policy | Multi-User Guarantee |
| :--- | :--- | :--- |
| `saves` | `auth.uid() = user_id` | Users can only SELECT, INSERT, UPDATE, or DELETE their own saves. |
| `folders` | `auth.uid() = user_id` | Folder management is strictly per-user. |
| `tags` | `auth.uid() = user_id` | Tag taxonomies are strictly isolated. |
| `save_tags` | `EXISTS (SELECT 1 FROM saves WHERE saves.id = save_tags.save_id AND saves.user_id = auth.uid())` | Tag associations cannot cross user boundaries. |
| `user_preferences`| `auth.uid() = user_id` | Custom host names, voice personas, and theme settings are private. |
| `podcast_feeds` | `auth.uid() = user_id` | Auto-generated feed tokens are private; only the owner can query their token. |
| `podcast_episodes`| `auth.uid() = user_id` | Users can only query their own podcast episodes via client SDK. |

---

## **5. Acceptance Criteria & Automated Verification**

| Flow | Acceptance Criteria | Automated Test Suite |
| :--- | :--- | :--- |
| **1. Log In** | Multi-user concurrent sign-ins generate unique valid JWTs; invalid passwords reject with 400. | `.github/scripts/multi_user_e2e.py`<br>`tests/e2e/web.e2e.test.js` |
| **2. Share Sheet** | Ingestion via `save-page` derives `user_id` from token; URL dedup is scoped per-user; User B cannot read User A's share. | `.github/scripts/multi_user_e2e.py` |
| **3. + Button** | Manual URL entry saves to active library; appears only in submitter's library. | `.github/scripts/multi_user_e2e.py`<br>`tests/e2e/web.e2e.test.js` |
| **4. Reading Article** | Full content accessible to owner only; `read_percent` updates independently per user without crosstalk. | `.github/scripts/multi_user_e2e.py`<br>`tests/e2e/web.e2e.test.js` |
| **5. Archiving** | `is_archived = true` removes save from active view and includes in archive view; other users unaffected. | `.github/scripts/multi_user_e2e.py`<br>`tests/e2e/web.e2e.test.js` |
| **6. Daily Podcast** | `discover.py` finds subscribed users only; `extract.py` isolates unarchived saves per user; feed serves private RSS. | `.github/scripts/multi_user_e2e.py`<br>`.github/workflows/podcast.yml` |

