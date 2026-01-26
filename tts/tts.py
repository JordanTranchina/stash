#!/usr/bin/env python3
"""
Stash Text-to-Speech Generator
Generates audio versions of saved articles using Edge TTS (Microsoft neural voices).
Free, no API key required.

Usage:
  pip install edge-tts requests
  python tts.py           # Run as daemon (checks every 2 min)
  python tts.py --once    # Run once and exit
"""

import os
import sys
import asyncio
import time
import tempfile
import re
from pathlib import Path

import requests

# Try to import edge_tts
try:
    import edge_tts
except ImportError:
    print("Error: edge-tts not installed. Run: pip install edge-tts")
    sys.exit(1)

# Configuration - UPDATE THESE VALUES
SUPABASE_URL = "https://jntnmvxkirrosxjquuoy.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpudG5tdnhraXJyb3N4anF1dW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzNjQ1MDgsImV4cCI6MjA4NDk0MDUwOH0.NnWNtHivG1aOKtVgZ9YeL2dW7SL4DCwIQaQu_ktqN6U"
USER_ID = "6c7a3a96-16cd-4702-ac7b-0c7a4a81346d"
CHECK_INTERVAL = 120  # seconds between checks
LOG_FILE = Path(__file__).parent / "tts.log"

# TTS Settings
VOICE = "en-US-AriaNeural"  # Options: en-US-AriaNeural, en-US-GuyNeural, en-GB-SoniaNeural
RATE = "+0%"  # Speed adjustment: -50% to +100%
VOLUME = "+0%"  # Volume adjustment

# Storage bucket name (create this in Supabase dashboard)
STORAGE_BUCKET = "audio"

def log(msg):
    """Log message to file and stdout."""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def get_headers():
    """Get Supabase API headers."""
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

def get_pending_saves():
    """Get saves that need TTS audio generation."""
    url = f"{SUPABASE_URL}/rest/v1/saves"
    params = {
        "select": "id,title,content,highlight,site_name",
        "user_id": f"eq.{USER_ID}",
        "audio_url": "is.null",  # Only saves without audio
        "is_archived": "eq.false",
        "order": "created_at.desc",
        "limit": "5"  # Process 5 at a time
    }

    response = requests.get(url, headers=get_headers(), params=params)

    if response.status_code != 200:
        log(f"Error fetching saves: {response.text}")
        return []

    saves = response.json()

    # Filter to articles with actual content (skip highlights, skip empty)
    pending = []
    for save in saves:
        content = save.get("content") or save.get("highlight") or ""
        # Skip very short content
        if len(content) < 100:
            continue
        pending.append(save)

    return pending

def extract_text_for_tts(save):
    """Extract clean text from a save for TTS."""
    content = save.get("content") or save.get("highlight") or ""
    title = save.get("title") or "Article"

    # Remove markdown formatting
    text = content

    # Remove markdown headers (keep the text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)

    # Remove markdown links, keep text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)

    # Remove markdown bold/italic
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    text = re.sub(r'_([^_]+)_', r'\1', text)

    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'`[^`]+`', '', text)

    # Remove horizontal rules
    text = re.sub(r'^---+$', '', text, flags=re.MULTILINE)

    # Remove image markdown
    text = re.sub(r'!\[[^\]]*\]\([^)]+\)', '', text)

    # Remove HTML tags
    text = re.sub(r'<[^>]+>', '', text)

    # Clean up whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()

    # Prepend title
    full_text = f"{title}.\n\n{text}"

    # Limit length (Edge TTS has limits, and long articles = huge files)
    # ~150 words per minute speaking, limit to ~30 min = 4500 words
    words = full_text.split()
    if len(words) > 4500:
        full_text = ' '.join(words[:4500]) + "... End of article preview."
        log(f"  Truncated from {len(words)} to 4500 words")

    return full_text

async def generate_audio(text, output_path):
    """Generate audio using Edge TTS."""
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, volume=VOLUME)
    await communicate.save(output_path)
    return output_path

def upload_to_supabase_storage(file_path, save_id):
    """Upload audio file to Supabase Storage."""
    # Generate a unique filename
    filename = f"{save_id}.mp3"

    # Read file
    with open(file_path, "rb") as f:
        file_data = f.read()

    # Upload to Supabase Storage
    url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{filename}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "audio/mpeg",
        "x-upsert": "true"  # Overwrite if exists
    }

    response = requests.post(url, headers=headers, data=file_data)

    if response.status_code not in [200, 201]:
        raise Exception(f"Storage upload failed: {response.status_code} - {response.text}")

    # Return the public URL
    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{filename}"
    return public_url

def update_save_audio_url(save_id, audio_url):
    """Update the save with the audio URL."""
    url = f"{SUPABASE_URL}/rest/v1/saves?id=eq.{save_id}"
    headers = get_headers()
    headers["Prefer"] = "return=representation"

    response = requests.patch(url, headers=headers, json={"audio_url": audio_url})

    if response.status_code not in [200, 204]:
        raise Exception(f"Error updating save: {response.text}")

def process_save(save):
    """Process a single save: extract text, generate audio, upload."""
    save_id = save["id"]
    title = save.get("title", "Untitled")[:50]

    log(f"Processing: {title}")

    # Extract text
    text = extract_text_for_tts(save)
    word_count = len(text.split())
    log(f"  Text: {word_count} words")

    if word_count < 20:
        log(f"  Skipping - too short")
        return False

    with tempfile.TemporaryDirectory() as tmpdir:
        audio_path = os.path.join(tmpdir, f"{save_id}.mp3")

        try:
            # Generate audio
            log(f"  Generating audio with {VOICE}...")
            asyncio.run(generate_audio(text, audio_path))

            # Check file size
            file_size = os.path.getsize(audio_path)
            log(f"  Audio file: {file_size / 1024 / 1024:.1f} MB")

            # Upload to storage
            log(f"  Uploading to Supabase Storage...")
            audio_url = upload_to_supabase_storage(audio_path, save_id)

            # Update save
            log(f"  Updating save record...")
            update_save_audio_url(save_id, audio_url)

            log(f"  Done! {audio_url}")
            return True

        except Exception as e:
            log(f"  Error: {e}")
            return False

def main():
    """Main loop."""
    log("=" * 50)
    log("Stash TTS Generator started")
    log(f"Voice: {VOICE}")
    log(f"Check interval: {CHECK_INTERVAL}s")
    log("=" * 50)

    while True:
        try:
            pending = get_pending_saves()

            if pending:
                log(f"Found {len(pending)} saves to process")
                for save in pending:
                    process_save(save)
                    time.sleep(2)  # Small delay between saves
            else:
                log("No saves pending audio generation")

        except Exception as e:
            log(f"Error in main loop: {e}")

        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    # Check for single-run mode
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        log("Running once...")
        pending = get_pending_saves()
        if pending:
            log(f"Found {len(pending)} saves to process")
            for save in pending:
                process_save(save)
        else:
            log("No saves pending")
        sys.exit(0)

    # Normal daemon mode
    try:
        main()
    except KeyboardInterrupt:
        log("TTS Generator stopped")
        sys.exit(0)
