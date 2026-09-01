"""One-off: record and upload the shared "welcome" episode.

Never run in CI — this is not part of the daily pipeline. It produces the
single `podcasts/welcome.mp3` object that `podcast-rss` serves to any feed
with zero real episodes (see supabase/functions/podcast-rss/index.ts).

Reuses the real pipeline's voices and assembly (generate_audio /
assemble_episode) rather than a one-off TTS call, so the welcome message
actually sounds like the show — same two hosts, same rhythm — which is the
entire point of a first impression.

Run locally once, from the repo root (its paths are relative to it, same as
script.py's):
    python podcast/welcome_audio.py

Then, if it needs re-recording later, bump WELCOME_GUID in
supabase/functions/podcast-rss/index.ts (and the mirrored test) to
"stash-welcome-v2" etc. — the guid is what tells a podcast app this is a new
item rather than a cached one under the same id, and it's part of the source
file, not this script.
"""

import asyncio
import sys

from script import generate_audio, supabase_client
from assembly import assemble_episode

WELCOME_SCRIPT = [
    {"speaker": "Alex", "text": "Hey — welcome to your Stash podcast."},
    {"speaker": "Taylor", "text": "This feed is just for you. Nobody else's articles show up here, and nothing of yours shows up in anyone else's."},
    {"speaker": "Alex", "text": "Once you save a few things to read later in Stash, we'll turn them into an episode like this one — every morning, automatically."},
    {"speaker": "Taylor", "text": "If you're not seeing episodes after a day or two, double check that Podcasts is turned on in Stash — it's one tap, in the Podcasts tab."},
    {"speaker": "Alex", "text": "That's it. Go save something you want to read later, and we'll take it from here."},
]

OUTPUT_DIR = "podcast/temp_welcome_audio"
OUTPUT_FILE = "podcast/output/welcome.mp3"


async def main():
    print("Generating welcome audio...")
    audio_files = await generate_audio(WELCOME_SCRIPT, output_dir=OUTPUT_DIR, host_a_name="Alex")
    if not audio_files:
        sys.exit("FATAL: no audio clips were generated (edge-tts failure?).")

    metadata = {
        "title": "Welcome to your Stash podcast",
        "artist": "Listen Later",
        "album": "Stash Podcast",
    }
    final_audio = assemble_episode(OUTPUT_DIR, OUTPUT_FILE, metadata)
    if not final_audio:
        sys.exit("FATAL: ffmpeg failed to assemble the welcome episode.")

    print(f"Assembled: {final_audio}")
    print("Uploading to Supabase Storage as podcasts/welcome.mp3...")

    # A fixed, never-changing key — NOT upload_audio_to_supabase's
    # episode_{id}.mp3 naming, since this isn't a podcast_episodes row.
    # podcast-rss hardcodes this exact path.
    if not supabase_client:
        sys.exit("FATAL: Supabase client not initialized — check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")

    try:
        with open(OUTPUT_FILE, "rb") as f:
            supabase_client.storage.from_("podcasts").upload(
                path="welcome.mp3",
                file=f,
                file_options={"content-type": "audio/mpeg", "upsert": "true"},
            )
    except Exception as e:
        sys.exit(f"FATAL: upload to Supabase Storage failed: {e}")

    url = supabase_client.storage.from_("podcasts").get_public_url("welcome.mp3")
    print(f"Uploaded: {url}")
    print(
        "\nNext: get this file's exact duration and size, and update "
        "WELCOME_DURATION_SECONDS / WELCOME_SIZE_BYTES in "
        "supabase/functions/podcast-rss/index.ts (and the mirrored test) to "
        "match — run `ffprobe podcast/output/welcome.mp3` and `ls -l` on it."
    )


if __name__ == "__main__":
    asyncio.run(main())
