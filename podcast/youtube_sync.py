"""Sync a YouTube playlist into Stash so its videos become podcast inputs.

The Listen Later pipeline already turns any saved YouTube video into a podcast
segment (see ``youtube.py`` / ``extract.py``). The missing piece was getting
videos *into* Stash without an active device. This script closes that loop:
point it at an ordinary YouTube playlist you populate from your phone
("Save -> Listen Later" instead of the Watch Later default) and a scheduled job
reads that playlist via the **official YouTube Data API** and inserts any new
videos as ``saves`` rows.

Why a dedicated playlist and not literal "Watch Later": YouTube's Watch Later
playlist is system-managed and not readable through any official API, so the
only way to read it is to scrape it while logged in as you — which violates
YouTube's ToS and risks a permanent ban of your Google account. Reading your
own playlist through the Data API (API key only, no login) is fully sanctioned
and carries no account risk.

Required environment variables:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, USER_ID  (same as extract.py)
    YOUTUBE_API_KEY            - a YouTube Data API v3 key
    YOUTUBE_SYNC_PLAYLIST_ID   - the playlist id (the list=... value; an
                                 Unlisted playlist is readable with just a key)
"""

import os
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
USER_ID = os.getenv("USER_ID")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
PLAYLIST_ID = os.getenv("YOUTUBE_SYNC_PLAYLIST_ID")

YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/playlistItems"

# Titles YouTube gives placeholder items whose real content is unavailable.
UNAVAILABLE_TITLES = {"Private video", "Deleted video"}

# Keep descriptions short — extract.py replaces content with the transcript
# anyway; the excerpt is just a fallback shown before that happens.
EXCERPT_MAX_CHARS = 500


def get_headers():
    """PostgREST headers using the service-role key (mirrors extract.py)."""
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def _best_thumbnail(thumbnails):
    """Pick the highest-resolution thumbnail URL from a snippet, or None."""
    if not thumbnails:
        return None
    # Prefer larger renditions; fall back to whatever is present.
    for key in ("maxres", "standard", "high", "medium", "default"):
        thumb = thumbnails.get(key)
        if thumb and thumb.get("url"):
            return thumb["url"]
    return None


def fetch_playlist_items(playlist_id, api_key):
    """Return every video item in a playlist, following pagination.

    Each returned dict is a raw YouTube ``playlistItems`` resource. Raises on a
    non-200 response so the caller can fail loudly.
    """
    items = []
    page_token = None

    while True:
        params = {
            "part": "snippet,contentDetails",
            "playlistId": playlist_id,
            "maxResults": 50,
            "key": api_key,
        }
        if page_token:
            params["pageToken"] = page_token

        response = requests.get(YOUTUBE_API_URL, params=params, timeout=30)
        if response.status_code != 200:
            raise RuntimeError(
                f"YouTube API error: {response.status_code} - {response.text}"
            )

        data = response.json()
        items.extend(data.get("items", []))

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return items


def item_to_save(item):
    """Map a YouTube playlist item to a Stash ``saves`` payload, or None.

    Returns None for items we can't ingest (private/deleted videos, or items
    missing a video id).
    """
    snippet = item.get("snippet") or {}
    content_details = item.get("contentDetails") or {}

    video_id = content_details.get("videoId") or (
        snippet.get("resourceId") or {}
    ).get("videoId")
    if not video_id:
        return None

    title = snippet.get("title") or ""
    if title in UNAVAILABLE_TITLES:
        return None

    description = (snippet.get("description") or "").strip()
    channel = snippet.get("videoOwnerChannelTitle") or snippet.get("channelTitle")

    return {
        "user_id": USER_ID,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": title or "Untitled video",
        "excerpt": description[:EXCERPT_MAX_CHARS] or None,
        "site_name": channel or "YouTube",
        "image_url": _best_thumbnail(snippet.get("thumbnails")),
        "published_at": content_details.get("videoPublishedAt"),
        "source": "youtube-sync",
    }


def fetch_existing_urls(urls):
    """Return the subset of ``urls`` already saved for this user.

    Used for deduplication — there is no unique constraint on saves.url, so we
    check explicitly before inserting.
    """
    if not urls:
        return set()

    # PostgREST in.() list: quote each url to be safe with reserved characters.
    quoted = ",".join(f'"{u}"' for u in urls)
    params = {
        "select": "url",
        "user_id": f"eq.{USER_ID}",
        "url": f"in.({quoted})",
    }

    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/saves",
        headers=get_headers(),
        params=params,
        timeout=30,
    )
    if response.status_code != 200:
        print(f"Warning: could not check existing saves: {response.status_code} - {response.text}")
        # Fail safe: treat nothing as existing would risk duplicates, so instead
        # signal "all exist" to avoid inserting on an unreliable read.
        return set(urls)

    return {row["url"] for row in response.json() if row.get("url")}


def insert_saves(payloads):
    """Bulk-insert new save rows via PostgREST. Returns True on success."""
    if not payloads:
        return True

    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/saves",
        headers={**get_headers(), "Prefer": "return=minimal"},
        json=payloads,
        timeout=30,
    )
    if response.status_code not in (200, 201, 204):
        print(f"Error inserting saves: {response.status_code} - {response.text}")
        return False
    return True


def sync_playlist():
    """Fetch the playlist and insert any videos not already saved.

    Returns the number of new saves inserted.
    """
    items = fetch_playlist_items(PLAYLIST_ID, YOUTUBE_API_KEY)
    print(f"Playlist returned {len(items)} items.")

    # Map to payloads, dropping unusable items and de-duplicating within the
    # playlist itself (a video can appear twice).
    payloads_by_url = {}
    for item in items:
        payload = item_to_save(item)
        if payload:
            payloads_by_url.setdefault(payload["url"], payload)

    if not payloads_by_url:
        print("No ingestible videos in playlist.")
        return 0

    existing = fetch_existing_urls(list(payloads_by_url))
    new_payloads = [p for url, p in payloads_by_url.items() if url not in existing]

    if not new_payloads:
        print("All playlist videos are already saved. Nothing to do.")
        return 0

    if insert_saves(new_payloads):
        for p in new_payloads:
            print(f"  + {p['title']} ({p['site_name']})")
        print(f"Inserted {len(new_payloads)} new video(s) into Stash.")
        return len(new_payloads)

    return 0


if __name__ == "__main__":
    missing = [
        name
        for name, value in {
            "SUPABASE_URL": SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_KEY,
            "USER_ID": USER_ID,
            "YOUTUBE_API_KEY": YOUTUBE_API_KEY,
            "YOUTUBE_SYNC_PLAYLIST_ID": PLAYLIST_ID,
        }.items()
        if not value
    ]
    if missing:
        # Not a hard failure: the podcast can still run on articles + already
        # saved videos, so we skip cleanly when sync isn't configured.
        print(f"YouTube sync skipped — missing env: {', '.join(missing)}")
        raise SystemExit(0)

    sync_playlist()
