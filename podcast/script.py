import os
import sys
import json
import subprocess
import requests
from google import genai
from google.genai import types
import asyncio
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv
import edge_tts
from extract import fetch_recent_articles
from assembly import assemble_episode
from artwork import build_episode_collage
from supabase import create_client, Client

# Load environment variables
load_dotenv()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
USER_ID = os.getenv("USER_ID")

supabase_client: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Gemini model for scriptwriting. Default to 2.5 Flash-Lite: as of 2026 it's the
# most generous free tier (15 RPM / 1,000 requests per day). gemini-2.0-flash had
# its free tier zeroed out. Override with the GEMINI_MODEL env var if needed.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")

# Default host personalities (used when the user has not customized them, issue #13).
DEFAULT_PODCAST_PREFS = {
    "host_a_name": "Alex",
    "host_a_persona": "Confident, tech-savvy, fast-talking, slightly cynical but enthusiastic about good ideas.",
    "host_b_name": "Taylor",
    "host_b_persona": "Curious, witty, plays the \"straight man\" to the other host's intensity, focuses on the \"why this matters\" and human impact.",
    "tone": "\"Hard Fork-esque\" — smart, accessible, and conversational.",
}


def fetch_podcast_preferences():
    """Load the user's custom host personalities from user_preferences.

    Returns a dict with host_a_name/persona, host_b_name/persona and tone,
    falling back to DEFAULT_PODCAST_PREFS for any value that is unset.
    """
    prefs = dict(DEFAULT_PODCAST_PREFS)

    if not supabase_client or not USER_ID:
        return prefs

    try:
        res = (
            supabase_client.table("user_preferences")
            .select(
                "podcast_host_a_name, podcast_host_a_persona, "
                "podcast_host_b_name, podcast_host_b_persona, podcast_tone"
            )
            .eq("user_id", USER_ID)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        if rows:
            row = rows[0]
            mapping = {
                "host_a_name": row.get("podcast_host_a_name"),
                "host_a_persona": row.get("podcast_host_a_persona"),
                "host_b_name": row.get("podcast_host_b_name"),
                "host_b_persona": row.get("podcast_host_b_persona"),
                "tone": row.get("podcast_tone"),
            }
            # Only override defaults with non-empty values.
            for key, value in mapping.items():
                if value:
                    prefs[key] = value
    except Exception as e:
        print(f"Warning: could not load podcast preferences, using defaults: {e}")

    return prefs


def build_system_prompt(prefs):
    """Construct the Gemini system prompt from the given host preferences."""
    host_a = prefs["host_a_name"]
    host_b = prefs["host_b_name"]
    return f"""
You are the witty, insightful, and casual producers and hosts of "Listen Later," a personalized daily podcast.
Your goal is to summarize a set of articles stashed by the user.

PERSONAS:
- {host_a.upper()}: {prefs["host_a_persona"]}
- {host_b.upper()}: {prefs["host_b_persona"]}

TONE:
- {prefs["tone"]}
- Don't just read summaries; analyze why the user might have saved these and how they relate to each other.
- Use natural transitions between articles.
- Avoid sounding like a dry news report. Use "{host_a}:" and "{host_b}:" prefixes for dialogue.

OUTPUT FORMAT:
Return a JSON array of objects. Each object must have:
- "speaker": exactly "{host_a}" or "{host_b}"
- "text": their dialogue line
- "article_index": the 0-based index (into the provided articles list) of the article this line is primarily about, or null for the intro, outro, and cross-article transitions.
Group the lines so all discussion of one article is contiguous, and move through the articles in order.
Example:
[
  {{ "speaker": "{host_a}", "text": "Welcome back to Listen Later!", "article_index": null }},
  {{ "speaker": "{host_a}", "text": "{host_b}, did you see this piece on local-first software?", "article_index": 0 }},
  {{ "speaker": "{host_b}", "text": "I did! It's such a shift from the last decade of cloud-only thinking.", "article_index": 0 }}
]

Do not include any other text, markdown, or explanations. Only return the raw JSON array.
"""


# Backwards-compatible default prompt (Alex/Taylor) for callers/tests that import it.
SYSTEM_PROMPT = build_system_prompt(DEFAULT_PODCAST_PREFS)

# The show always runs to this length, no matter how many articles were saved
# that day (override with PODCAST_TARGET_MINUTES). One article gets the full
# runtime to itself; ten articles split the same runtime ten ways.
TARGET_EPISODE_MINUTES = float(os.getenv("PODCAST_TARGET_MINUTES", "5"))

# Rough conversational speaking pace, used to translate the target runtime
# into a word-count budget Gemini can actually aim for.
SPEAKING_RATE_WPM = float(os.getenv("PODCAST_SPEAKING_RATE_WPM", "150"))

# Fraction of the total runtime reserved for the intro/outro/transitions
# rather than article discussion.
INTRO_OUTRO_FRACTION = 0.1


def build_length_instructions(num_articles, target_minutes=None, wpm=None):
    """Instructions telling Gemini how to divide the fixed episode runtime.

    The episode is always ``target_minutes`` long in total; each article gets
    an equal share of that time (so one article fills the whole runtime and N
    articles split it N ways) with a small reserve for the intro/outro.
    Returns "" when there are no articles to budget for.
    """
    if num_articles <= 0:
        return ""

    target_minutes = TARGET_EPISODE_MINUTES if target_minutes is None else target_minutes
    wpm = SPEAKING_RATE_WPM if wpm is None else wpm

    total_words = target_minutes * wpm
    article_words = total_words * (1 - INTRO_OUTRO_FRACTION)
    words_per_article = round(article_words / num_articles)
    seconds_per_article = round((target_minutes * 60 * (1 - INTRO_OUTRO_FRACTION)) / num_articles)

    return f"""
EPISODE LENGTH:
- The whole episode must run about {target_minutes:g} minutes when spoken aloud, total — this is fixed regardless of how many articles there are.
- There {"is 1 article" if num_articles == 1 else f"are {num_articles} articles"} today, so give each one roughly equal airtime: about {words_per_article} words of dialogue (~{seconds_per_article} seconds) per article.
- Keep the intro and outro short (a couple of lines each) so nearly all the runtime goes to the articles.
"""


def generate_script(articles, prefs=None):
    """Generate a conversational script based on the provided articles.

    If ``prefs`` is None the user's custom host personalities are loaded from
    Supabase (falling back to the Alex/Taylor defaults).
    """
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if not gemini_api_key:
        print("Error: GEMINI_API_KEY not found. Please set it in your environment.")
        return None

    if not articles:
        print("No articles to summarize.")
        return None

    if prefs is None:
        prefs = fetch_podcast_preferences()
    system_prompt = build_system_prompt(prefs) + build_length_instructions(len(articles))

    client = genai.Client(api_key=gemini_api_key)

    # Prepare article content for the prompt (index lets the model tag lines for chapters)
    articles_payload = []
    for i, art in enumerate(articles):
        articles_payload.append({
            "index": i,
            "title": art["title"],
            "site": art["site_name"],
            "content": art["content"]
        })

    prompt = f"Here are the articles to discuss today:\n\n{json.dumps(articles_payload, indent=2)}"

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
            ),
        )

        # Clean up the response text in case Gemini adds markdown code blocks
        content = response.text.strip()
        if content.startswith("```json"):
            content = content[7:]
        if content.endswith("```"):
            content = content[:-3]

        return json.loads(content)
    except Exception as e:
        # Surface the real reason (quota/rate-limit, bad key, bad JSON, …) instead
        # of silently returning None so the pipeline can fail loudly.
        raise RuntimeError(f"Gemini script generation failed ({GEMINI_MODEL}): {e}") from e


FALLBACK_EPISODE_TITLE = "Listen Later"


def generate_episode_title(articles, prefs=None):
    """Ask Gemini for a short, punchy episode title summarizing the articles covered.

    Falls back to FALLBACK_EPISODE_TITLE if GEMINI_API_KEY is missing, there
    are no articles, or generation fails for any reason — the title is
    cosmetic, so this never raises.
    """
    if not articles:
        return FALLBACK_EPISODE_TITLE

    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if not gemini_api_key:
        return FALLBACK_EPISODE_TITLE

    titles = [art["title"] for art in articles if art.get("title")]
    if not titles:
        return FALLBACK_EPISODE_TITLE

    prompt = (
        "Write a short, catchy podcast episode title (under 70 characters, "
        "no surrounding quotes, no date) that captures what this episode "
        "covers, based on the following articles:\n"
        + "\n".join(f"- {t}" for t in titles)
    )

    try:
        client = genai.Client(api_key=gemini_api_key)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        title = response.text.strip().strip('"').strip()
        return title or FALLBACK_EPISODE_TITLE
    except Exception as e:
        print(f"Warning: could not generate episode title, using fallback: {e}")
        return FALLBACK_EPISODE_TITLE


# Voices assigned to host slot A and slot B respectively.
VOICE_A = "en-US-AndrewNeural"  # Confident, male
VOICE_B = "en-US-AvaNeural"     # Friendly, female


async def generate_audio(script, output_dir="podcast/temp_audio", host_a_name="Alex"):
    """Generate audio files for each line of the script using edge-tts.

    ``host_a_name`` is the speaker mapped to VOICE_A; every other speaker gets VOICE_B.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    audio_files = []

    print(f"Generating audio for {len(script)} lines...")

    for i, line in enumerate(script):
        speaker = line.get("speaker", host_a_name)
        text = line.get("text", "")

        # Select voice by host slot: host A -> VOICE_A, everyone else -> VOICE_B
        voice = VOICE_A if speaker == host_a_name else VOICE_B
        
        filename = output_path / f"line_{i:03d}.mp3"
        communicate = edge_tts.Communicate(text, voice)
        
        try:
            await communicate.save(str(filename))
            audio_files.append(str(filename))
        except Exception as e:
            print(f"Error generating audio for line {i}: {e}")
    
    print(f"Generated {len(audio_files)} audio clips in {output_dir}")
    return audio_files

def compute_line_durations(audio_files):
    """Probe each per-line audio clip and return its duration in seconds."""
    durations = []
    for path in audio_files:
        try:
            result = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    path,
                ],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
            )
            durations.append(float(result.stdout.decode().strip()))
        except Exception as e:
            print(f"Warning: could not probe duration for {path}: {e}")
            durations.append(0.0)
    return durations


def compute_article_start_times(script, durations, articles):
    """Map each tagged article's 0-based index to the playback time (seconds) at
    which it is first discussed.

    Each script line carries an optional 0-based ``article_index``. Walking the
    script and accumulating per-line durations, the first line tagged with an
    article records that article's start offset. Out-of-range and duplicate
    indices are ignored. Returns ``{index: startTime}``.
    """
    starts = {}
    cumulative = 0.0

    for i, line in enumerate(script):
        idx = line.get("article_index")
        if isinstance(idx, str) and idx.strip().isdigit():
            idx = int(idx)

        if isinstance(idx, int) and 0 <= idx < len(articles) and idx not in starts:
            starts[idx] = round(cumulative, 3)

        cumulative += durations[i] if i < len(durations) else 0.0

    return starts


def build_chapters(script, durations, articles):
    """Build chapter markers (#14) mapping playback time to the article discussed.

    The first line of each article opens a chapter at that line's cumulative
    start time, titled with the article title. A leading "Intro" chapter is
    added when the episode opens with non-article lines. Returns [] when no
    article lines are tagged.
    """
    starts = compute_article_start_times(script, durations, articles)
    if not starts:
        return []

    chapters = [
        {
            "startTime": starts[idx],
            "title": articles[idx].get("title") or f"Article {idx + 1}",
        }
        for idx in sorted(starts, key=lambda k: starts[k])
    ]

    # Ensure the first chapter starts at 0 (add an Intro if the episode opens
    # with untagged lines before the first article).
    if chapters[0]["startTime"] > 0.5:
        chapters.insert(0, {"startTime": 0.0, "title": "Intro"})

    return chapters


def format_timestamp(seconds):
    """Format a playback offset in seconds as ``M:SS`` (or ``H:MM:SS`` past an hour)."""
    seconds = int(round(float(seconds)))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_date(value):
    """Render an ISO timestamp (or date) as e.g. "Aug 12, 2026".

    Returns "" for anything missing or unparseable so a malformed
    published_at just drops the date rather than breaking the description.
    """
    if not value:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    # Postgres/PostgREST hands back "…Z" or "…+00:00"; fromisoformat only
    # learned to parse the "Z" suffix in Python 3.11.
    normalized = text.replace("Z", "+00:00")
    for candidate in (normalized, normalized[:10]):
        try:
            parsed = datetime.fromisoformat(candidate)
        except (ValueError, TypeError):
            continue
        # Built by hand rather than with "%b %-d, %Y": the no-pad directive
        # isn't portable across platforms.
        return f"{parsed.strftime('%b')} {parsed.day}, {parsed.year}"
    return ""


def build_article_dates(article):
    """One-line "Published … · Saved …" summary for an article.

    The saved date always shows (every save has a created_at); the published
    date only when the source page exposed one. Returns "" if neither is
    available.
    """
    published = format_date(article.get("published_at"))
    saved = format_date(article.get("created_at"))

    parts = []
    if published:
        parts.append(f"Published {published}")
    if saved:
        parts.append(f"Saved {saved}")
    return " · ".join(parts)


def build_description(articles, start_times=None, html=True):
    """Build an episode description listing each article with a link and timestamp.

    Args:
        articles (list): the article dicts (``title``, ``url``, ``published_at``
            and ``created_at``) in the order
            passed to :func:`generate_script`, so their positions line up with
            the ``article_index`` used for ``start_times``.
        start_times (dict): optional ``{index: seconds}`` (see
            :func:`compute_article_start_times`). When present, the timestamp at
            which each article is discussed is appended. Omit before audio has
            been generated to produce a link-only description.
        html (bool): when True, produce an HTML list with anchor links (used for
            the RSS/web description). When False, produce a plain-text version
            (used for the MP3 ``comment`` tag).

    Returns:
        str: the formatted description.
    """
    from html import escape

    start_times = start_times or {}

    if html:
        items = []
        for i, art in enumerate(articles):
            title = escape(art.get("title") or f"Article {i + 1}")
            url = art.get("url")
            if url:
                href = escape(str(url), quote=True)
                label = f'<a href="{href}" target="_blank" rel="noopener">{title}</a>'
            else:
                label = title
            if i in start_times:
                label += f" ({format_timestamp(start_times[i])})"
            dates = build_article_dates(art)
            if dates:
                label += f" — <em>{escape(dates)}</em>"
            items.append(f"<li>{label}</li>")
        return "Discussing:<ul>" + "".join(items) + "</ul>"

    lines = ["Discussing:"]
    for i, art in enumerate(articles):
        title = art.get("title") or f"Article {i + 1}"
        stamp = f" [{format_timestamp(start_times[i])}]" if i in start_times else ""
        url = art.get("url")
        suffix = f" — {url}" if url else ""
        lines.append(f"• {title}{stamp}{suffix}")
        dates = build_article_dates(art)
        if dates:
            lines.append(f"  {dates}")
    return "\n".join(lines)


def save_to_supabase(script, articles, title=None):
    """Save the generated script and metadata to Supabase."""
    if not all([SUPABASE_URL, SUPABASE_KEY, USER_ID]):
        print("Error: Missing Supabase credentials. Skipping Supabase save.")
        return None

    url = f"{SUPABASE_URL}/rest/v1/podcast_episodes"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

    # Generate metadata
    article_ids = [art["id"] for art in articles]
    title = title or FALLBACK_EPISODE_TITLE

    # Description with a hyperlink to each article. Timestamps are added later,
    # once audio has been generated (see update_episode_audio_url in main()).
    description = build_description(articles)

    payload = {
        "user_id": USER_ID,
        "title": title,
        "description": description,
        "related_article_ids": article_ids,
        "script_json": script
    }

    try:
        response = requests.post(url, headers=headers, json=payload)
        if response.status_code in [201, 200]:
            created_episode = response.json()[0]
            print(f"Episode saved to Supabase (ID: {created_episode['id']})")
            return created_episode["id"]
        else:
            print(f"Error saving to Supabase: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"Error saving to Supabase: {e}")
        return None

def upload_audio_to_supabase(file_path, episode_id):
    """Uploads the podcast MP3 to Supabase Storage and returns the public URL."""
    if not supabase_client:
        print("Error: Supabase client not initialized. Cannot upload audio.")
        return None

    filename = f"episode_{episode_id}.mp3"
    
    try:
        with open(file_path, 'rb') as f:
            supabase_client.storage.from_("podcasts").upload(
                path=filename,
                file=f,
                file_options={"content-type": "audio/mpeg"}
            )
        print(f"Uploaded audio to Supabase Storage: {filename}")
        
        # Get public URL
        res = supabase_client.storage.from_("podcasts").get_public_url(filename)
        return res
    except Exception as e:
        print(f"Error uploading audio to Supabase: {e}")
        return None

def upload_artwork_to_supabase(file_path, episode_id):
    """Uploads the episode's collage artwork JPEG to Supabase Storage and returns the public URL."""
    if not supabase_client:
        print("Error: Supabase client not initialized. Cannot upload artwork.")
        return None

    filename = f"episode_{episode_id}_artwork.jpg"

    try:
        with open(file_path, 'rb') as f:
            supabase_client.storage.from_("podcasts").upload(
                path=filename,
                file=f,
                file_options={"content-type": "image/jpeg"}
            )
        print(f"Uploaded artwork to Supabase Storage: {filename}")

        res = supabase_client.storage.from_("podcasts").get_public_url(filename)
        return res
    except Exception as e:
        print(f"Error uploading artwork to Supabase: {e}")
        return None

def get_audio_metadata(file_path):
    """Returns (duration_seconds, size_bytes) for an MP3 using ffprobe + os.path."""
    size_bytes = os.path.getsize(file_path)
    duration_seconds = None
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        duration_seconds = int(float(result.stdout.decode().strip()))
    except Exception as e:
        print(f"Warning: could not probe audio duration: {e}")
    return duration_seconds, size_bytes


def update_episode_audio_url(episode_id, audio_url, duration_seconds=None, size_bytes=None,
                             chapters=None, description=None, artwork_url=None):
    """Updates the database record with the audio URL, duration, size, chapters,
    and (optionally) a refreshed description carrying per-article timestamps
    and/or the episode's collage artwork URL."""
    if not supabase_client:
        return False

    update_data = {"audio_url": audio_url}
    if duration_seconds is not None:
        update_data["duration_seconds"] = duration_seconds
    if size_bytes is not None:
        update_data["size_bytes"] = size_bytes
    if chapters is not None:
        update_data["chapters"] = chapters
    if description is not None:
        update_data["description"] = description
    if artwork_url is not None:
        update_data["artwork_url"] = artwork_url

    try:
        supabase_client.table("podcast_episodes").update(
            update_data
        ).eq("id", episode_id).execute()
        print(f"Updated episode {episode_id}: audio_url, duration={duration_seconds}s, size={size_bytes}B")
        return True
    except Exception as e:
        print(f"Error updating database with audio URL: {e}")
        return False

def mark_articles_discussed(article_ids, episode_id):
    """Flag saves as covered by this episode (dedup, see extract.py).

    Excluding these going forward, independent of is_archived, keeps a save
    from being re-discussed in a future episode.
    """
    if not supabase_client or not article_ids:
        return False

    try:
        supabase_client.table("saves").update({
            "podcast_episode_id": episode_id,
            "podcast_discussed_at": datetime.utcnow().isoformat(),
        }).in_("id", article_ids).execute()
        print(f"Marked {len(article_ids)} article(s) as discussed (episode {episode_id})")
        return True
    except Exception as e:
        print(f"Warning: could not mark articles as discussed: {e}")
        return False


def save_script_locally(script, filename="podcast/script.json"):
    """Save the generated script to a local file."""
    with open(filename, "w") as f:
        json.dump(script, f, indent=2)
    print(f"Script saved locally to {filename}")

    print(f"Script saved locally to {filename}")

def fail(reason):
    """Exit non-zero with a clear reason so the GitHub Action turns red."""
    sys.exit(f"FATAL: {reason}")


async def main():
    print("Fetching articles...")
    try:
        articles = fetch_recent_articles(limit=3)
    except Exception as e:
        fail(str(e))

    # Not a failure: nothing was saved recently enough to discuss (see
    # fetch_recent_articles' recency window). Exit 0 so the scheduled run stays
    # green on quiet days.
    if not articles:
        print("No recent unarchived, undiscussed articles found — nothing to "
              "generate. Exiting cleanly (this is not an error).")
        return

    # Load custom host personalities once and reuse for script + audio (#13)
    prefs = fetch_podcast_preferences()
    print(f"Generating script for {len(articles)} articles "
          f"(hosts: {prefs['host_a_name']} & {prefs['host_b_name']})...")

    try:
        script = generate_script(articles, prefs=prefs)
    except Exception as e:
        fail(str(e))

    if not script:
        fail("script generation returned no content — is GEMINI_API_KEY set and valid?")

    save_script_locally(script)

    title = generate_episode_title(articles, prefs=prefs)

    episode_id = save_to_supabase(script, articles, title)
    if not episode_id:
        fail("could not save the episode record to Supabase — check "
             "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / USER_ID.")

    mark_articles_discussed([art["id"] for art in articles], episode_id)

    # Best-effort collage artwork from the covered articles' images. Never
    # fatal — an episode with no artwork is fine, this is enrichment only.
    artwork_url = None
    image_urls = [art["image_url"] for art in articles if art.get("image_url")]
    if image_urls:
        collage_path = build_episode_collage(image_urls, "podcast/output/artwork.jpg")
        if collage_path:
            artwork_url = upload_artwork_to_supabase(collage_path, episode_id)
            if not artwork_url:
                print("Warning: failed to upload episode artwork; continuing without it.")
        else:
            print("Warning: could not build episode artwork from article images; continuing without it.")

    print("\nPreview of first 3 lines:")
    for line in script[:3]:
        print(f"{line['speaker']}: {line['text']}")

    # Generate Audio (voice mapped to the configured host A name, #13)
    audio_files = await generate_audio(script, host_a_name=prefs["host_a_name"])
    if not audio_files:
        fail("no audio clips were generated (edge-tts failure?).")

    # Build chapters (#14) from per-line durations and article tags
    line_durations = compute_line_durations(audio_files)
    article_start_times = compute_article_start_times(script, line_durations, articles)
    chapters = build_chapters(script, line_durations, articles)
    total_duration = sum(line_durations)
    if chapters:
        print(f"Built {len(chapters)} chapters.")

    # Descriptions with a hyperlink + timestamp per article (HTML for the RSS/web
    # feed, plain text for the MP3 comment tag).
    html_description = build_description(articles, article_start_times, html=True)
    text_description = build_description(articles, article_start_times, html=False)

    # Assemble Episode
    print("Assembling episode...")
    metadata = {
        "title": title,
        "artist": "Listen Later",
        "album": "Stash Podcast",
        "description": text_description,
    }
    final_audio = assemble_episode(
        "podcast/temp_audio", "podcast/output/episode.mp3", metadata,
        chapters=chapters, total_duration=total_duration,
    )
    if not final_audio:
        fail("ffmpeg failed to assemble the episode MP3 (see error above).")

    print(f"Podcast generated successfully: {final_audio}")

    print("Uploading audio to Supabase...")
    audio_url = upload_audio_to_supabase("podcast/output/episode.mp3", episode_id)
    if not audio_url:
        fail("failed to upload the episode MP3 to Supabase Storage.")

    duration_seconds, size_bytes = get_audio_metadata("podcast/output/episode.mp3")
    if not update_episode_audio_url(
        episode_id, audio_url, duration_seconds, size_bytes, chapters=chapters or None,
        description=html_description, artwork_url=artwork_url,
    ):
        fail("uploaded the MP3 but failed to update the episode row with its audio URL.")

    print(f"✅ Episode published: {metadata['title']} "
          f"({duration_seconds}s, {len(chapters)} chapters)")


if __name__ == "__main__":
    asyncio.run(main())
