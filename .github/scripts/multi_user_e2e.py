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
  3. Friend invites (invite_friend / my_invites): a user can put 3 friends
     on the sign-up allowlist and no more, the row records who invited
     whom, the invited friend can then sign up, and nobody can go around
     the functions to write allowed_emails directly.

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


def test_article_storage_isolation(user_a_id, token_a, token_b):
    print("\n--- Article storage isolation (saves RLS) ---")

    # user_id must be set explicitly — the insert RLS policy checks the
    # *provided* value against auth.uid(), it doesn't fill it in, and the
    # column is NOT NULL, so omitting it fails before RLS is even relevant.
    resp = requests.post(
        f"{REST_URL}/saves",
        headers={**user_headers(token_a), "Prefer": "return=representation"},
        json={"user_id": user_a_id, "url": "https://example.com/a", "title": "User A's private article"},
        timeout=TIMEOUT,
    )
    check(resp.status_code == 201, "user A can create their own save")
    save_a_id = resp.json()[0]["id"] if resp.status_code == 201 else None
    if not save_a_id:
        sys.exit(f"FATAL: could not create user A's save: {resp.status_code} {resp.text}")

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

    # No apostrophes in these titles — podcast-rss XML-escapes them (' ->
    # &apos;), which would otherwise break a plain substring check below.
    create_episode(user_a_id, "User A private episode")
    create_episode(user_b_id, "User B private episode")

    def fetch_feed(token):
        return requests.get(f"{FUNCTIONS_URL}/podcast-rss", params={"token": token}, timeout=TIMEOUT)

    resp_a = fetch_feed(token_feed_a)
    check(resp_a.status_code == 200, "user A's feed returns 200")
    check("User A private episode" in resp_a.text, "user A's feed contains their own episode")
    check("User B private episode" not in resp_a.text, "user A's feed does not contain user B's episode")

    resp_b = fetch_feed(token_feed_b)
    check(resp_b.status_code == 200, "user B's feed returns 200")
    check("User B private episode" in resp_b.text, "user B's feed contains their own episode")
    check("User A private episode" not in resp_b.text, "user B's feed does not contain user A's episode")

    resp_unknown = fetch_feed("not-a-real-token-" + uuid.uuid4().hex)
    check(
        resp_unknown.status_code == 404,
        "an unknown feed token returns 404, not an error page or someone's feed",
    )


def rpc(fn, token, body=None, key=None):
    """Call a Postgres function through PostgREST, as supabase.rpc() does."""
    headers = user_headers(token) if token else {"apikey": key or ANON_KEY, "Content-Type": "application/json"}
    return requests.post(f"{REST_URL}/rpc/{fn}", headers=headers, json=body or {}, timeout=TIMEOUT)


def allowlist_row(email):
    resp = requests.get(
        f"{REST_URL}/allowed_emails", headers=service_headers(),
        params={"email": f"eq.{email}", "select": "email,invited_by,note"}, timeout=TIMEOUT,
    )
    return resp.json()[0] if resp.status_code == 200 and resp.json() else None


def sign_up(email, password):
    """Public sign-up, the same GoTrue endpoint the web app's sign-up uses. It
    runs the enforce_email_allowlist trigger, unlike the admin create above."""
    return requests.post(
        f"{AUTH_URL}/signup",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )


def signed_up_user_id(resp):
    if resp.status_code != 200:
        return None
    body = resp.json()
    # With email confirmation off GoTrue returns a session ({"user": {...}});
    # with it on it returns the bare user.
    return (body.get("user") or body).get("id")


def test_friend_invites(user_a_id, token_a, token_b, suffix, password):
    print("\n--- Friend invites (invite_friend / my_invites) ---")

    resp = rpc("my_invites", token_a)
    data = resp.json() if resp.status_code == 200 else {}
    check(
        data.get("limit") == 3 and data.get("remaining") == 3 and data.get("invites") == [],
        "a new user starts with 3 of 3 invites left",
    )

    friends = [f"friend{i}-{suffix}@example.test" for i in range(1, 5)]

    # Mixed case and spaces, as someone might type it; stored lowercased.
    resp = rpc("invite_friend", token_a, {"p_email": f"  {friends[0].upper()} "})
    data = resp.json() if resp.status_code == 200 else {}
    check(resp.status_code == 200 and data.get("remaining") == 2, "user A can invite a friend (2 left)")

    row = allowlist_row(friends[0])
    check(row is not None, "the invited email is on the allowlist, lowercased")
    check(row is not None and row["invited_by"] == user_a_id, "the allowlist row records user A as the inviter")

    resp = rpc("invite_friend", token_a, {"p_email": friends[0]})
    check(
        resp.status_code != 200 and resp.json().get("code") == "23505",
        "inviting the same email again is refused",
    )
    resp = rpc("invite_friend", token_b, {"p_email": friends[0]})
    check(
        resp.status_code != 200 and resp.json().get("code") == "23505",
        "another user cannot re-invite an email that is already listed",
    )
    resp = rpc("my_invites", token_a)
    check(
        resp.status_code == 200 and resp.json().get("remaining") == 2,
        "a refused duplicate does not use up an invite",
    )

    resp = rpc("invite_friend", token_a, {"p_email": "not-an-email"})
    check(
        resp.status_code != 200 and resp.json().get("code") == "22023",
        "an invalid email is refused",
    )

    for friend in friends[1:3]:
        rpc("invite_friend", token_a, {"p_email": friend})
    resp = rpc("my_invites", token_a)
    data = resp.json() if resp.status_code == 200 else {}
    check(
        data.get("remaining") == 0 and len(data.get("invites", [])) == 3,
        "after 3 invites user A has 0 left and sees all 3",
    )

    resp = rpc("invite_friend", token_a, {"p_email": friends[3]})
    check(
        resp.status_code != 200 and resp.json().get("code") == "54000",
        "a 4th invite is refused",
    )
    check(allowlist_row(friends[3]) is None, "the refused 4th email is not on the allowlist")

    # Going around the functions must not work.
    resp = requests.post(
        f"{REST_URL}/allowed_emails", headers=user_headers(token_b),
        json={"email": f"sneaky-{suffix}@example.test"}, timeout=TIMEOUT,
    )
    check(resp.status_code not in (200, 201, 204), "a signed-in user cannot insert into allowed_emails directly")
    resp = requests.get(f"{REST_URL}/allowed_emails", headers=user_headers(token_b), timeout=TIMEOUT)
    check(resp.status_code != 200 or resp.json() == [], "a signed-in user cannot read allowed_emails")
    resp = rpc("invite_friend", None, {"p_email": f"anon-{suffix}@example.test"})
    check(
        resp.status_code != 200 and allowlist_row(f"anon-{suffix}@example.test") is None,
        "a signed-out caller cannot invite anyone",
    )

    # The point of an invite: the friend can now sign up, and a stranger can't.
    resp = sign_up(friends[0], password)
    check(signed_up_user_id(resp) is not None, "the invited friend can sign up")
    resp = rpc("my_invites", token_a)
    joined = {i["email"]: i["joined"] for i in resp.json().get("invites", [])} if resp.status_code == 200 else {}
    check(joined.get(friends[0]) is True, "user A sees the invited friend as joined")

    resp = sign_up(friends[3], password)
    check(signed_up_user_id(resp) is None, "an email that was not invited cannot sign up")


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

    test_article_storage_isolation(user_a_id, token_a, token_b)
    test_podcast_feed_isolation(user_a_id, user_b_id, token_a, token_b)
    test_friend_invites(user_a_id, token_a, token_b, suffix, password)

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
