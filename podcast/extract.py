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

# A save needs this much real body text before it's worth a podcast segment.
# Below it there is nothing for the hosts to discuss and they hallucinate to
# fill the gap: X/Twitter posts save no body at all, paywalled pages save only
# the teaser paragraph before the wall, and link-only saves (bot-blocked
# fetches) save nothing but a title. ~250 characters is roughly 40 words.
MIN_ARTICLE_CHARS = 250

# Paywall/consent interstitials leave a short stub of text that *looks* like an
# article. These phrases only disqualify a save when its body is also short
# (see PAYWALL_MAX_CHARS), so a full-length article that merely talks about
# paywalls isn't dropped.
PAYWALL_MARKERS = (
    "subscribe to continue",
    "subscribe to read",
    "continue reading",
    "already a subscriber",
    "become a subscriber",
    "subscribers only",
    "for subscribers",
    "this article is for",
    "create an account to read",
    "sign in to read",
    "sign up to read",
    "register to continue",
    "to continue reading",
    "you have reached your",
    "free articles remaining",
    "enable javascript",
    "javascript is disabled",
    "accept cookies",
    "verify you are a human",
    "are you a robot",
    "access denied",
)
PAYWALL_MAX_CHARS = 2500

# How many candidate saves to pull per requested article. Ineligible saves are
# filtered out client-side, so fetching exactly `limit` rows would produce
# half-empty (or empty) episodes whenever the newest saves happen to be X posts
# or paywalled pages.
CANDIDATE_MULTIPLIER = 6
MIN_CANDIDATE_POOL = 20

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

def is_paywalled(content):
    """True when a short body looks like a paywall / bot-check interstitial.

    Only short bodies are tested (PAYWALL_MAX_CHARS) so a full-length article
    that happens to mention subscriptions isn't mistaken for a wall.
    """
    if not content:
        return False
    if len(content) > PAYWALL_MAX_CHARS:
        return False
    lowered = content.lower()
    return any(marker in lowered for marker in PAYWALL_MARKERS)


def podcast_skip_reason(content):
    """Return why this body can't carry a podcast segment, or None if it can.

    The hosts only ever see `content`, so a save with no real body (an X/Twitter
    post, a bot-blocked or paywalled page, a bare link) gives them nothing to
    work from and they invent the article instead. Better to leave those out of
    the episode entirely.
    """
    text = (content or "").strip()
    if not text:
        return "no body text was saved"
    if len(text) < MIN_ARTICLE_CHARS:
        return f"only {len(text)} chars of body text (minimum {MIN_ARTICLE_CHARS})"
    if is_paywalled(text):
        return "body text looks like a paywall or bot-check interstitial"
    return None


def format_article(article):
    """Shape a raw `saves` row into the dict the script generator consumes.

    Resolves a YouTube save to its transcript (caching it back onto the save)
    so videos are ingested like articles.
    """
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

    return {
        "id": article["id"],
        "title": article["title"],
        "url": save_url,
        "site_name": site_name,
        "content": clean_text(content[:5000]), # Limit to 5k chars per article for context window
        "created_at": article["created_at"],
        "published_at": article.get("published_at"),
        "image_url": article.get("image_url")
    }


def fetch_recent_articles(limit=5):
    """Fetch unarchived, not-yet-discussed articles, most recently saved first.

    Newest-first so episodes stay current instead of working through however
    much of a backlog has piled up. Excluding saves where podcast_discussed_at
    is already set (rather than relying solely on is_archived) prevents the
    same article from being re-discussed in a later episode, and there's no
    recency cutoff, so an old undiscussed save is never silently dropped —
    it just gets picked up once the newer queue thins out.

    Saves without enough real body text to discuss (X posts, paywalled pages,
    link-only saves) are skipped — see :func:`podcast_skip_reason`. Because
    that filtering happens after the query, we ask for a larger candidate pool
    than `limit` and stop once `limit` usable articles have been collected.
    """
    url = f"{SUPABASE_URL}/rest/v1/saves"
    candidate_limit = max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATE_POOL)
    params = {
        "select": "id,url,title,content,excerpt,site_name,created_at,published_at,image_url",
        "user_id": f"eq.{USER_ID}",
        "is_archived": "eq.false",
        "podcast_discussed_at": "is.null",
        "order": "created_at.desc",
        "limit": candidate_limit
    }

    response = requests.get(url, headers=get_headers(), params=params)

    if response.status_code != 200:
        # A failed query (e.g. schema drift, auth issue) is not the same as
        # "no articles found" — treating it as empty silently masks real
        # breakage behind a green scheduled run. Let it fail loudly instead.
        raise RuntimeError(f"Error fetching articles: {response.status_code} - {response.text}")

    articles = response.json()
    formatted_articles = []

    for article in articles:
        if len(formatted_articles) >= limit:
            break

        formatted = format_article(article)

        skip_reason = podcast_skip_reason(formatted["content"])
        if skip_reason:
            print(f"Skipping '{formatted['title']}' — {skip_reason}.")
            continue

        formatted_articles.append(formatted)

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
