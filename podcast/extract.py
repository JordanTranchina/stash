import os
import requests
from dotenv import load_dotenv

from youtube import is_youtube_url, fetch_transcript_for_url

# Load environment variables
load_dotenv()

# Saved YouTube videos whose stored content is shorter than this are treated as
# missing a real transcript, so we attempt to fetch one. Longer content is
# assumed to already be a cached transcript (or a real article) and reused.
YOUTUBE_CONTENT_MIN_CHARS = 500

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") # Use service role key for backend extraction
USER_ID = os.getenv("USER_ID")

def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

def clean_text(text):
    """Basic cleaning of article content."""
    import re
    if not text:
        return ""
    # Strip inline image markdown (![alt](url)) so image URLs don't leak into
    # the transcript the hosts discuss; the podcast is audio-only.
    text = re.sub(r'!\[[^\]]*\]\([^)]+\)', '', text)
    # Remove excessive newlines
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Remove common artifacts if any (can be expanded)
    return text.strip()

def fetch_recent_articles(limit=5):
    """Fetch unarchived, not-yet-discussed articles, oldest first.

    Oldest-first (FIFO) so a save can't be pushed out of a recency window and
    dropped forever just because newer saves keep arriving. Excluding saves
    where podcast_discussed_at is already set (rather than relying solely on
    is_archived) prevents the same article from being re-discussed in a later
    episode.
    """
    url = f"{SUPABASE_URL}/rest/v1/saves"
    params = {
        "select": "id,url,title,content,excerpt,site_name,created_at",
        "user_id": f"eq.{USER_ID}",
        "is_archived": "eq.false",
        "podcast_discussed_at": "is.null",
        "order": "created_at.asc",
        "limit": limit
    }

    response = requests.get(url, headers=get_headers(), params=params)

    if response.status_code != 200:
        print(f"Error fetching articles: {response.status_code} - {response.text}")
        return []

    articles = response.json()
    formatted_articles = []

    for article in articles:
        content = article.get("content") or article.get("excerpt") or ""
        site_name = article.get("site_name") or "Unknown"
        save_url = article.get("url")

        # YouTube videos are ingested just like articles: fetch the spoken
        # transcript and use it as the content the hosts discuss (issue: treat
        # saved Watch Later videos as podcast inputs).
        if save_url and is_youtube_url(save_url) and len(content) < YOUTUBE_CONTENT_MIN_CHARS:
            transcript = fetch_transcript_for_url(save_url)
            if transcript:
                content = transcript
                if not article.get("site_name"):
                    site_name = "YouTube"
                # Cache the transcript back onto the save so future runs and the
                # reading view reuse it instead of re-scraping YouTube.
                persist_transcript(article["id"], transcript)

        formatted_articles.append({
            "id": article["id"],
            "title": article["title"],
            "url": save_url,
            "site_name": site_name,
            "content": clean_text(content[:5000]), # Limit to 5k chars per article for context window
            "created_at": article["created_at"]
        })

    return formatted_articles


def persist_transcript(save_id, transcript):
    """Best-effort write of a fetched YouTube transcript back to the save.

    Storing it means the podcast pipeline (and the web reading view) reuse the
    transcript on subsequent runs instead of re-scraping YouTube. Failures are
    non-fatal — the transcript is still used for the current episode.
    """
    if not all([SUPABASE_URL, SUPABASE_KEY, USER_ID]):
        return

    try:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/saves",
            headers=get_headers(),
            params={"id": f"eq.{save_id}", "user_id": f"eq.{USER_ID}"},
            json={"content": transcript},
            timeout=30,
        )
    except Exception as e:
        print(f"Warning: could not cache transcript for {save_id}: {e}")

if __name__ == "__main__":
    if not all([SUPABASE_URL, SUPABASE_KEY, USER_ID]):
        print("Error: Missing environment variables. Please check podcast/.env")
        exit(1)
        
    articles = fetch_recent_articles()
    print(f"Found {len(articles)} articles:")
    for i, article in enumerate(articles, 1):
        print(f"{i}. {article['title']} ({article['site_name']})")
        # print(f"   Content preview: {article['content'][:100]}...")
