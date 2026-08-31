#!/usr/bin/env python3
"""Multi-user isolation E2E test.

Run only against an ephemeral local Supabase stack (see
.github/workflows/multi-user-e2e.yml, which starts one via `supabase
start` and tears it down when the job ends) — never against production.
This creates real auth users, real saves, and real podcast_episodes rows.

Exercises the two guarantees the auth lockdown and per-user podcast feed
migrations exist to provide:

  1. Article storage (saves RLS): one signed-in user can never list,
     read-by-id, update, or delete another user's save.
  2. Podcast feeds (podcast_feeds + podcast-rss): the RSS feed serves only
     the token-owning user's episodes, and an unknown token 404s rather
     than erroring or leaking anything.

Prints PASS/FAIL for every check and exits non-zero if any failed, so a
broken policy or a broken podcast-rss deploy turns the CI job red.
"""

import os
import sys
import uuid

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

REST_URL = f"{SUPABASE_URL}/rest/v1"
AUTH_URL = f"{SUPABASE_URL}/auth/v1"
FUNCTIONS_URL = f"{SUPABASE_URL}/functions/v1"

TIMEOUT = 30

results = []  # [(passed: bool, description: str), ...]


def check(condition, description):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {description}")
    results.append((bool(condition), description))


def service_headers():
    return {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def user_headers(access_token):
    # Mirrors what supabase-js sends for a signed-in user: the anon key as
    # apikey (so PostgREST/Kong accept the request at all) plus the user's
    # own session JWT as the bearer, which is what auth.uid() resolves from.
    return {
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }


def allow_email(email):
    """Insert into allowed_emails so the sign-up trigger doesn't reject it."""
    resp = requests.post(
        f"{REST_URL}/allowed_emails",
        headers={**service_headers(), "Prefer": "resolution=ignore-duplicates"},
        json={"email": email, "note": "multi-user-e2e"},
        timeout=TIMEOUT,
    )
    if resp.status_code not in (200, 201, 204):
        sys.exit(f"FATAL: could not allowlist {email}: {resp.status_code} {resp.text}")


def create_user(email, password):
    """Admin-create a pre-confirmed user (skips the email-confirmation step)."""
    resp = requests.post(
        f"{AUTH_URL}/admin/users",
        headers=service_headers(),
        json={"email": email, "password": password, "email_confirm": True},
        timeout=TIMEOUT,
    )
    if resp.status_code not in (200, 201):
        sys.exit(f"FATAL: could not create user {email}: {resp.status_code} {resp.text}")
    return resp.json()["id"]


def sign_in(email, password):
    resp = requests.post(
        f"{AUTH_URL}/token?grant_type=password",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    if resp.status_code != 200:
        sys.exit(f"FATAL: could not sign in as {email}: {resp.status_code} {resp.text}")
    return resp.json()["access_token"]


def create_episode(user_id, title):
    """Seed a podcast_episodes row directly, same as script.py's
    save_to_supabase + upload_audio_to_supabase (service role, bypasses RLS)."""
    resp = requests.post(
        f"{REST_URL}/podcast_episodes",
        headers={**service_headers(), "Prefer": "return=representation"},
        json={
            "user_id": user_id,
            "title": title,
            "description": "test episode",
            "audio_url": "https://example.com/ep.mp3",
        },
        timeout=TIMEOUT,
    )
    if resp.status_code != 201:
        sys.exit(f"FATAL: could not create episode for {user_id}: {resp.status_code} {resp.text}")
    return resp.json()[0]["id"]


def test_article_storage_isolation(token_a, token_b):
    print("\n--- Article storage isolation (saves RLS) ---")

    resp = requests.post(
        f"{REST_URL}/saves",
        headers={**user_headers(token_a), "Prefer": "return=representation"},
        json={"url": "https://example.com/a", "title": "User A's private article"},
        timeout=TIMEOUT,
    )
    check(resp.status_code == 201, "user A can create their own save")
    save_a_id = resp.json()[0]["id"] if resp.status_code == 201 else None
    if not save_a_id:
        sys.exit("FATAL: could not create user A's save; cannot continue this section.")

    # B must not see A's save in a list at all.
    resp = requests.get(
        f"{REST_URL}/saves", headers=user_headers(token_b),
        params={"select": "id,title"}, timeout=TIMEOUT,
    )
    titles_visible_to_b = [row["title"] for row in resp.json()] if resp.status_code == 200 else ["<request failed>"]
    check(
        "User A's private article" not in titles_visible_to_b,
        "user B cannot list user A's save",
    )

    # B must not be able to fetch it directly by id either — RLS silently
    # filters it out, it isn't a 403.
    resp = requests.get(
        f"{REST_URL}/saves", headers=user_headers(token_b),
        params={"id": f"eq.{save_a_id}"}, timeout=TIMEOUT,
    )
    check(
        resp.status_code == 200 and resp.json() == [],
        "user B's direct-id fetch of user A's save returns nothing",
    )

    # B's update must affect 0 rows — A's row stays unchanged.
    requests.patch(
        f"{REST_URL}/saves", headers=user_headers(token_b),
        params={"id": f"eq.{save_a_id}"}, json={"title": "hijacked by B"}, timeout=TIMEOUT,
    )
    resp = requests.get(
        f"{REST_URL}/saves", headers=user_headers(token_a),
        params={"id": f"eq.{save_a_id}", "select": "title"}, timeout=TIMEOUT,
    )
    title_after = resp.json()[0]["title"] if resp.status_code == 200 and resp.json() else None
    check(
        title_after == "User A's private article",
        "user B's update of user A's save has no effect",
    )

    # B's delete must affect 0 rows — the save still exists for A.
    requests.delete(
        f"{REST_URL}/saves", headers=user_headers(token_b),
        params={"id": f"eq.{save_a_id}"}, timeout=TIMEOUT,
    )
    resp = requests.get(
        f"{REST_URL}/saves", headers=user_headers(token_a),
        params={"id": f"eq.{save_a_id}"}, timeout=TIMEOUT,
    )
    check(
        resp.status_code == 200 and len(resp.json()) == 1,
        "user B's delete of user A's save has no effect",
    )

    # A can still read their own save throughout.
    check(resp.status_code == 200 and len(resp.json()) == 1, "user A still sees their own save")


def test_podcast_feed_isolation(user_a_id, user_b_id, token_a, token_b):
    print("\n--- Podcast feed isolation (podcast_feeds + podcast-rss) ---")

    # Every new user gets exactly one podcast_feeds row via the trigger on
    # auth.users, and RLS means each only ever sees their own.
    resp = requests.get(
        f"{REST_URL}/podcast_feeds", headers=user_headers(token_a),
        params={"select": "token,subscribed"}, timeout=TIMEOUT,
    )
    check(
        resp.status_code == 200 and len(resp.json()) == 1,
        "user A has exactly one podcast_feeds row (auto-created at sign-up)",
    )
    token_feed_a = resp.json()[0]["token"] if resp.status_code == 200 and resp.json() else None

    resp = requests.get(
        f"{REST_URL}/podcast_feeds", headers=user_headers(token_b),
        params={"select": "token"}, timeout=TIMEOUT,
    )
    token_feed_b = resp.json()[0]["token"] if resp.status_code == 200 and resp.json() else None

    check(
        bool(token_feed_a) and bool(token_feed_b) and token_feed_a != token_feed_b,
        "user A and user B have distinct, non-empty feed tokens",
    )
    if not (token_feed_a and token_feed_b):
        sys.exit("FATAL: could not obtain both feed tokens; cannot continue this section.")

    create_episode(user_a_id, "User A's private episode")
    create_episode(user_b_id, "User B's private episode")

    def fetch_feed(token):
        return requests.get(f"{FUNCTIONS_URL}/podcast-rss", params={"token": token}, timeout=TIMEOUT)

    resp_a = fetch_feed(token_feed_a)
    check(resp_a.status_code == 200, "user A's feed returns 200")
    check("User A's private episode" in resp_a.text, "user A's feed contains their own episode")
    check("User B's private episode" not in resp_a.text, "user A's feed does not contain user B's episode")

    resp_b = fetch_feed(token_feed_b)
    check(resp_b.status_code == 200, "user B's feed returns 200")
    check("User B's private episode" in resp_b.text, "user B's feed contains their own episode")
    check("User A's private episode" not in resp_b.text, "user B's feed does not contain user A's episode")

    resp_unknown = fetch_feed("not-a-real-token-" + uuid.uuid4().hex)
    check(
        resp_unknown.status_code == 404,
        "an unknown feed token returns 404, not an error page or someone's feed",
    )


def main():
    suffix = uuid.uuid4().hex[:10]
    email_a = f"multiuser-a-{suffix}@example.test"
    email_b = f"multiuser-b-{suffix}@example.test"
    password = "Correct-Horse-Battery-Staple-1"

    print(f"Creating test users {email_a} and {email_b}...")
    allow_email(email_a)
    allow_email(email_b)
    user_a_id = create_user(email_a, password)
    user_b_id = create_user(email_b, password)
    token_a = sign_in(email_a, password)
    token_b = sign_in(email_b, password)

    test_article_storage_isolation(token_a, token_b)
    test_podcast_feed_isolation(user_a_id, user_b_id, token_a, token_b)

    failed = [desc for passed, desc in results if not passed]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed.")
    if failed:
        print("\nFAILED:")
        for desc in failed:
            print(f"  - {desc}")
        sys.exit(1)

    print("All multi-user isolation checks passed.")


if __name__ == "__main__":
    main()
