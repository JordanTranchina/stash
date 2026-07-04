"""YouTube transcript ingestion for the Listen Later podcast pipeline.

When the user saves a YouTube video to Stash (e.g. from their Watch Later
queue) it lands in the ``saves`` table just like an article, but the stored
``content`` is whatever the page scraper managed to grab — usually not the
actual spoken words. This module turns a YouTube URL into a clean transcript
so the video can be discussed by the podcast hosts exactly like a written
article.

Note on "Watch Later": YouTube no longer exposes the Watch Later playlist
through its Data API, so there is no way to read that playlist directly.
Instead, videos flow in through the normal Stash save path (extension /
bookmarklet / iOS share sheet); this module just resolves the transcript for
any saved YouTube URL.
"""

import re

# youtube-transcript-api is an optional dependency. Import defensively so the
# rest of the pipeline keeps working (articles only) if it is not installed.
try:
    from youtube_transcript_api import YouTubeTranscriptApi
    _YT_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only when dep is missing
    YouTubeTranscriptApi = None
    _YT_AVAILABLE = False


# Matches the video id in the common YouTube URL shapes:
#   https://www.youtube.com/watch?v=VIDEOID
#   https://youtu.be/VIDEOID
#   https://www.youtube.com/shorts/VIDEOID
#   https://www.youtube.com/embed/VIDEOID
#   https://www.youtube.com/live/VIDEOID
_YOUTUBE_HOST_RE = re.compile(r"(?:^|\.)(youtube\.com|youtu\.be)$", re.IGNORECASE)
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# Sound cues that transcripts sprinkle in ([Music], [Applause], etc.).
_SOUND_CUE_RE = re.compile(r"\[[^\]]{1,40}\]")


def is_youtube_url(url):
    """Return True if ``url`` points at a YouTube video."""
    return extract_video_id(url) is not None


def extract_video_id(url):
    """Extract the 11-character video id from a YouTube URL, or None.

    Handles watch?v=, youtu.be/, /shorts/, /embed/ and /live/ forms as well
    as extra query params (e.g. playlist / timestamp links from Watch Later).
    """
    if not url or not isinstance(url, str):
        return None

    # Avoid importing urllib at module import time for such a small parse.
    from urllib.parse import urlparse, parse_qs

    try:
        parsed = urlparse(url.strip())
    except (ValueError, TypeError):
        return None

    host = (parsed.hostname or "").lower()
    if not _YOUTUBE_HOST_RE.search(host):
        return None

    # youtu.be/VIDEOID
    if host.endswith("youtu.be"):
        candidate = parsed.path.lstrip("/").split("/")[0]
        return candidate if _VIDEO_ID_RE.match(candidate) else None

    # youtube.com/watch?v=VIDEOID
    if parsed.path == "/watch":
        vid = parse_qs(parsed.query).get("v", [None])[0]
        return vid if vid and _VIDEO_ID_RE.match(vid) else None

    # youtube.com/{shorts,embed,live,v}/VIDEOID
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
        return parts[1] if _VIDEO_ID_RE.match(parts[1]) else None

    return None


def clean_transcript(text):
    """Tidy raw transcript text for scriptwriting.

    Removes bracketed sound cues, collapses whitespace/newlines introduced by
    per-caption line breaks, and trims the result.
    """
    if not text:
        return ""
    text = _SOUND_CUE_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _snippets_to_text(snippets):
    """Join transcript snippets (dicts or objects) into one string."""
    parts = []
    for snippet in snippets:
        # New API yields objects with a .text attribute; the legacy API yields
        # dicts with a "text" key.
        piece = getattr(snippet, "text", None)
        if piece is None and isinstance(snippet, dict):
            piece = snippet.get("text")
        if piece:
            parts.append(piece.strip())
    return " ".join(parts)


def fetch_transcript(video_id, languages=("en", "en-US", "en-GB")):
    """Fetch and clean the transcript for a YouTube video id.

    Returns the cleaned transcript string, or None if no transcript is
    available (captions disabled, video unavailable, or the dependency is not
    installed). Never raises — the caller can safely fall back to the stored
    content.
    """
    if not _YT_AVAILABLE or not video_id:
        return None

    langs = list(languages)

    try:
        raw = None

        # Legacy (< 1.0) exposes a static ``get_transcript``; newer releases
        # (>= 1.0) use an instance ``.fetch()`` method instead.
        if hasattr(YouTubeTranscriptApi, "get_transcript"):
            snippets = YouTubeTranscriptApi.get_transcript(video_id, languages=langs)
            raw = _snippets_to_text(snippets)
        else:
            fetched = YouTubeTranscriptApi().fetch(video_id, languages=langs)
            # FetchedTranscript is iterable of snippet objects.
            raw = _snippets_to_text(fetched)

        cleaned = clean_transcript(raw)
        return cleaned or None
    except Exception as e:
        # Captions disabled, no transcript in the requested languages, video
        # unavailable, network hiccup, etc. Degrade gracefully.
        print(f"Warning: could not fetch YouTube transcript for {video_id}: {e}")
        return None


def fetch_transcript_for_url(url, languages=("en", "en-US", "en-GB")):
    """Convenience wrapper: resolve a YouTube URL straight to a transcript."""
    return fetch_transcript(extract_video_id(url), languages=languages)
