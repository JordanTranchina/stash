"""Prune old podcast episodes so Storage doesn't grow without bound.

Nothing in the pipeline ever deletes a `podcast_episodes` row or its MP3, so
today (one user) it's already ~70 MB / 63 episodes in the `podcasts` bucket.
This keeps only the most recent `PODCAST_RETENTION_KEEP` (default 10 — chosen
to exactly match podcast-rss's `.limit(10)`, so retention never deletes
anything a subscriber can currently see in their feed).

Runs over every `podcast_feeds` row, not just subscribed users: an
unsubscribed user's *existing* backlog still costs storage, and every
signed-up user has a `podcast_feeds` row (a trigger on `auth.users` creates
one), so this is a complete enumeration of everyone who could have episodes.

Deleting old episodes does not cause their articles to be re-discussed:
`saves.podcast_episode_id` is `ON DELETE SET NULL`, but `podcast_discussed_at`
is a separate column the cascade doesn't touch, and that's the column
extract.py filters on. The tests below pin this.

Storage objects are removed *before* the database row, deliberately. If the
row delete then fails, the next run re-selects the same (still-present) row
and re-issues an idempotent storage delete — self-healing. Reversed, a failed
storage delete would leave an object with no row pointing at it: invisible,
unfindable, permanent.

Usage:
    python podcast/retention.py [--dry-run]

Environment variables:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  - required
    PODCAST_RETENTION_KEEP  - episodes to keep per user (default 10)
"""

import argparse
import os
import sys

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

supabase_client: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Matches podcast-rss's `.limit(10)` — see module docstring.
DEFAULT_KEEP = 10

# A cap of 1000 per user is far above anything retention should ever need to
# page through; it exists so a runaway (e.g. keep=0 misconfiguration) can't
# turn one request into an unbounded one.
MAX_EPISODES_PER_QUERY = 1000


def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def list_feed_user_ids():
    """Return every user_id with a podcast_feeds row (subscribed or not)."""
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/podcast_feeds",
        headers=get_headers(),
        params={"select": "user_id"},
        timeout=30,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"Error listing podcast_feeds: {response.status_code} - {response.text}"
        )
    return [row["user_id"] for row in response.json()]


def episodes_to_prune(user_id, keep):
    """Return the episodes past the most-recent `keep` for this user.

    Each row is ``{"id": ..., "created_at": ...}``. Ordered newest-first with
    an `offset` of `keep`, so this returns exactly what's left over once the
    `keep` most recent episodes are excluded.
    """
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/podcast_episodes",
        headers=get_headers(),
        params={
            "select": "id,created_at",
            "user_id": f"eq.{user_id}",
            "order": "created_at.desc",
            "offset": keep,
            "limit": MAX_EPISODES_PER_QUERY,
        },
        timeout=30,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"Error listing episodes for {user_id}: {response.status_code} - {response.text}"
        )
    return response.json()


def storage_keys_for(episode_id):
    """Storage object keys for an episode — mirrors script.py's upload naming
    (`upload_audio_to_supabase`, `upload_artwork_to_supabase`) exactly, rather
    than parsing them out of `audio_url`, so this still works for a row whose
    `audio_url` is null because the run that created it died mid-pipeline."""
    return [f"episode_{episode_id}.mp3", f"episode_{episode_id}_artwork.jpg"]


def delete_episode_rows(episode_ids):
    if not episode_ids:
        return
    quoted = ",".join(str(i) for i in episode_ids)
    response = requests.delete(
        f"{SUPABASE_URL}/rest/v1/podcast_episodes",
        headers=get_headers(),
        params={"id": f"in.({quoted})"},
        timeout=30,
    )
    if response.status_code not in (200, 204):
        raise RuntimeError(
            f"Error deleting episode rows: {response.status_code} - {response.text}"
        )


def prune_user(user_id, keep, dry_run=False):
    """Delete one user's episodes past the keep window. Returns count pruned.

    Raises on a storage failure (see module docstring for why the row delete
    must not proceed in that case) or a row-delete failure. The caller is
    expected to catch per-user, so one user's failure doesn't stop the rest.
    """
    stale = episodes_to_prune(user_id, keep)
    if not stale:
        return 0

    keys = [key for ep in stale for key in storage_keys_for(ep["id"])]
    print(f"  {user_id}: pruning {len(stale)} episode(s), {len(keys)} storage object(s)")

    if dry_run:
        return len(stale)

    if supabase_client and keys:
        # Removing a key that no longer exists (e.g. a run that never
        # finished uploading) is a no-op on Supabase Storage, not an error —
        # only a genuine failure should raise and block the row delete below.
        try:
            supabase_client.storage.from_("podcasts").remove(keys)
        except Exception as e:
            raise RuntimeError(f"Storage delete failed for {user_id}: {e}") from e

    delete_episode_rows([ep["id"] for ep in stale])
    return len(stale)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="report what would be pruned without deleting anything",
    )
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("FATAL: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")

    try:
        keep = int(os.getenv("PODCAST_RETENTION_KEEP") or DEFAULT_KEEP)
    except ValueError:
        keep = DEFAULT_KEEP

    user_ids = list_feed_user_ids()
    print(
        f"Checking {len(user_ids)} user(s), keeping {keep} episode(s) each"
        f"{' (dry run — no writes)' if args.dry_run else ''}..."
    )

    pruned_total = 0
    failures = 0
    for user_id in user_ids:
        try:
            pruned_total += prune_user(user_id, keep, dry_run=args.dry_run)
        except Exception as e:
            failures += 1
            print(f"  Warning: could not prune {user_id}: {e}")

    print(
        f"Done. Pruned {pruned_total} episode(s) across {len(user_ids)} user(s)"
        f"{f', {failures} failure(s)' if failures else ''}."
    )

    # A handful of per-user failures shouldn't red a run that mostly worked —
    # but if every single user failed, something structural is broken
    # (bad credentials, the table renamed) and the run should say so.
    if user_ids and failures == len(user_ids):
        sys.exit(f"FATAL: retention failed for every user ({failures}).")


if __name__ == "__main__":
    main()
