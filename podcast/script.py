import os
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

# System prompt for Alex and Taylor
SYSTEM_PROMPT = """
You are the witty, insightful, and casual producers and hosts of "Listen Later," a personalized daily podcast. 
Your goal is to summarize a set of articles stashed by the user.

PERSONAS:
- ALEX: Confident, tech-savvy, fast-talking, slightly cynical but enthusiastic about good ideas. 
- TAYLOR: Curious, witty, plays the "straight man" to Alex's intensity, focuses on the "why this matters" and human impact.

TONE:
- "Hard Fork-esque" (smart, accessible, conversational).
- Don't just read summaries; analyze why the user might have saved these and how they relate to each other.
- Use natural transitions between articles.
- Avoid sounding like a dry news report. Use "Alex:" and "Taylor:" prefixes for dialogue.

OUTPUT FORMAT:
Return a JSON array of objects. Each object must have:
- "speaker": "Alex" or "Taylor"
- "text": their dialogue line
- "article_index": the 0-based index (into the provided articles list) of the article this line is primarily about, or null for the intro, outro, and cross-article transitions.
Group the lines so all discussion of one article is contiguous, and move through the articles in order.
Example:
[
  { "speaker": "Alex", "text": "Welcome back to Listen Later!", "article_index": null },
  { "speaker": "Alex", "text": "Taylor, did you see this piece on local-first software?", "article_index": 0 },
  { "speaker": "Taylor", "text": "I did! It's such a shift from the last decade of cloud-only thinking.", "article_index": 0 }
]

Do not include any other text, markdown, or explanations. Only return the raw JSON array.
"""

def generate_script(articles):
    """Generate a conversational script based on the provided articles."""
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if not gemini_api_key:
        print("Error: GEMINI_API_KEY not found. Please set it in your environment.")
        return None

    if not articles:
        print("No articles to summarize.")
        return None

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
            model="gemini-2.0-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
            ),
        )
        
        # Clean up the response text in case Gemini adds markdown code blocks
        content = response.text.strip()
        if content.startswith("```json"):
            content = content[7:]
        if content.endswith("```"):
            content = content[:-3]
        
        script = json.loads(content)
        return script
    except Exception as e:
        print(f"Error generating script: {e}")
        return None

async def generate_audio(script, output_dir="podcast/temp_audio"):
    """Generate audio files for each line of the script using edge-tts."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    audio_files = []
    
    print(f"Generating audio for {len(script)} lines...")
    
    for i, line in enumerate(script):
        speaker = line.get("speaker", "Alex")
        text = line.get("text", "")
        
        # Select voice based on speaker
        # Alex: Andrew (Male), Taylor: Ava (Female)
        voice = "en-US-AndrewNeural" if speaker == "Alex" else "en-US-AvaNeural"
        
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


def build_chapters(script, durations, articles):
    """Build chapter markers (#14) mapping playback time to the article discussed.

    Each script line carries an optional 0-based ``article_index``. The first line
    of each article opens a chapter at that line's cumulative start time, titled
    with the article title. A leading "Intro" chapter is added when the episode
    opens with non-article lines. Returns [] when no article lines are tagged.
    """
    chapters = []
    seen = set()
    cumulative = 0.0

    for i, line in enumerate(script):
        idx = line.get("article_index")
        if isinstance(idx, str) and idx.strip().isdigit():
            idx = int(idx)

        if isinstance(idx, int) and 0 <= idx < len(articles) and idx not in seen:
            title = articles[idx].get("title") or f"Article {idx + 1}"
            chapters.append({"startTime": round(cumulative, 3), "title": title})
            seen.add(idx)

        cumulative += durations[i] if i < len(durations) else 0.0

    if not chapters:
        return []

    # Ensure the first chapter starts at 0 (add an Intro if the episode opens
    # with untagged lines before the first article).
    if chapters[0]["startTime"] > 0.5:
        chapters.insert(0, {"startTime": 0.0, "title": "Intro"})

    return chapters


def save_to_supabase(script, articles):
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
    date_str = datetime.now().strftime("%B %d, %Y")
    title = f"Listen Later: {date_str}"
    
    # Simple description based on article titles
    description = "Discussing: " + ", ".join([art["title"] for art in articles])

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
                             chapters=None):
    """Updates the database record with the audio URL, duration, size, and chapters."""
    if not supabase_client:
        return False

    update_data = {"audio_url": audio_url}
    if duration_seconds is not None:
        update_data["duration_seconds"] = duration_seconds
    if size_bytes is not None:
        update_data["size_bytes"] = size_bytes
    if chapters is not None:
        update_data["chapters"] = chapters

    try:
        supabase_client.table("podcast_episodes").update(
            update_data
        ).eq("id", episode_id).execute()
        print(f"Updated episode {episode_id}: audio_url, duration={duration_seconds}s, size={size_bytes}B")
        return True
    except Exception as e:
        print(f"Error updating database with audio URL: {e}")
        return False

def save_script_locally(script, filename="podcast/script.json"):
    """Save the generated script to a local file."""
    with open(filename, "w") as f:
        json.dump(script, f, indent=2)
    print(f"Script saved locally to {filename}")

    print(f"Script saved locally to {filename}")

async def main():
    # Integration test: Fetch articles and generate script
    print("Fetching articles...")
    articles = fetch_recent_articles(limit=3) # Limit to 3 for testing
    
    if articles:
        print(f"Generating script for {len(articles)} articles...")
        script = generate_script(articles)
        
        if script:
            save_script_locally(script)
            episode_id = save_to_supabase(script, articles)
            
            print("\nPreview of first 3 lines:")
            for line in script[:3]:
                print(f"{line['speaker']}: {line['text']}")
                
            # Generate Audio
            audio_files = await generate_audio(script)

            # Build chapters (#14) from per-line durations and article tags
            line_durations = compute_line_durations(audio_files)
            chapters = build_chapters(script, line_durations, articles)
            total_duration = sum(line_durations)
            if chapters:
                print(f"Built {len(chapters)} chapters.")

            # Assemble Episode
            print("Assembling episode...")
            metadata = {
                "title": f"Listen Later: {datetime.now().strftime('%B %d, %Y')}",
                "artist": "Listen Later",
                "album": "Stash Podcast",
                "description": "Discussing: " + ", ".join([art["title"] for art in articles])
            }
            final_audio = assemble_episode(
                "podcast/temp_audio", "podcast/output/episode.mp3", metadata,
                chapters=chapters, total_duration=total_duration,
            )

            if final_audio:
                print(f"Podcast generated successfully: {final_audio}")
                if episode_id:
                    print("Uploading audio to Supabase...")
                    audio_url = upload_audio_to_supabase("podcast/output/episode.mp3", episode_id)
                    if audio_url:
                        duration_seconds, size_bytes = get_audio_metadata("podcast/output/episode.mp3")
                        update_episode_audio_url(
                            episode_id, audio_url, duration_seconds, size_bytes,
                            chapters=chapters or None,
                        )
            else:
                print("Failed to assemble episode.")
            
        else:
            print("Failed to generate script.")
    else:
        print("No recent articles found to process.")

if __name__ == "__main__":
    asyncio.run(main())
