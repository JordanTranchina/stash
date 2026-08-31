"""Discover which users should get a podcast episode generated today.

Deliberately stdlib-only (``urllib``, not ``requests``) so no ``pip install``
step is needed to run this. Every downstream job in the daily workflow depends
on this one's output, so keeping it dependency-free means a broken wheel or a
slow index somewhere can't take down the whole run before it even starts.

Prints exactly two lines to stdout, meant to be appended straight to
``$GITHUB_OUTPUT``:

    users=[{"user_id":"...","label":"..."},...]
    count=<n>

``label`` is the first 8 characters of the user id, so a matrix job renders as
e.g. "Episode (6c7a3a96)" instead of the full 36-character uuid. Everything
else — the human-readable summary, warnings — goes to stderr, so it never ends
up appended to $GITHUB_OUTPUT by an overly broad shell redirect.

Environment variables:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  - required
    PODCAST_MAX_USERS  - cap on how many subscribers one run processes
                         (default 25; hard-clamped to GitHub's 256-entry
                         matrix limit regardless of this value)
    PODCAST_ONLY_USER  - if set, short-circuits the query entirely and
                         returns just this one user id (the
                         workflow_dispatch single-user escape hatch)
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

DEFAULT_MAX_USERS = 25

# GitHub's own hard ceiling on `strategy.matrix.include` entries. Enforced
# here too so a misconfigured PODCAST_MAX_USERS fails loudly and locally
# instead of as a cryptic workflow-syntax error later.
GITHUB_MATRIX_LIMIT = 256


def _get(url, params):
    """GET a PostgREST endpoint with the service-role key. Raises on non-200."""
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{url}?{query}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Supabase query failed: {e.code} - {e.read().decode(errors='replace')}"
        ) from e


def fetch_subscribed_user_ids(cap):
    """Return up to `cap` subscribed users' ids, oldest-subscribed-first.

    Oldest-first makes a truncation (when subscriber count exceeds the cap)
    deterministic: the same users are included every day rather than a random
    subset rotating in and out.

    A query failure raises rather than returning an empty list — a broken
    query (schema drift, a bad key) must not silently read as "nobody is
    subscribed today", which would make every subscriber's episode quietly
    stop appearing behind a green run.
    """
    try:
        rows = _get(
            f"{SUPABASE_URL}/rest/v1/podcast_feeds",
            {
                "select": "user_id",
                "subscribed": "eq.true",
                "order": "created_at.asc",
                "limit": cap,
            },
        )
    except Exception as e:
        raise RuntimeError(f"Could not list subscribed users: {e}") from e

    return [row["user_id"] for row in rows]


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        sys.exit("FATAL: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")

    only_user = (os.getenv("PODCAST_ONLY_USER") or "").strip()

    try:
        cap = int(os.getenv("PODCAST_MAX_USERS") or DEFAULT_MAX_USERS)
    except ValueError:
        cap = DEFAULT_MAX_USERS
    cap = max(0, min(cap, GITHUB_MATRIX_LIMIT))

    if only_user:
        user_ids = [only_user]
    else:
        user_ids = fetch_subscribed_user_ids(cap)
        if cap and len(user_ids) >= cap:
            print(
                f"Warning: subscriber count hit the cap ({cap}); some "
                "subscribers were not included in today's run.",
                file=sys.stderr,
            )

    # Belt and braces: the query above is already limited to `cap`, but this
    # protects against a future change to that query loosening the limit.
    if len(user_ids) > GITHUB_MATRIX_LIMIT:
        sys.exit(
            f"FATAL: {len(user_ids)} users exceeds GitHub's "
            f"{GITHUB_MATRIX_LIMIT}-entry matrix limit."
        )

    users = [{"user_id": uid, "label": uid[:8]} for uid in user_ids]

    print(f"users={json.dumps(users, separators=(',', ':'))}")
    print(f"count={len(users)}")

    print(f"Found {len(users)} user(s) to generate a podcast episode for.", file=sys.stderr)


if __name__ == "__main__":
    main()
