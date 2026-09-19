#!/usr/bin/env python3
"""Multi-user E2E test suite for Stash & Listen Later key flows.

Run only against an ephemeral local Supabase stack (see
.github/workflows/multi-user-e2e.yml, which starts one via `supabase
start` and tears it down when the job ends) — never against production.
This tests real auth users, real saves, edge functions, and podcast pipelines.

Validates the 6 Key Flows defined in the Product Spec:
  1. Log in: Multi-user concurrent sessions, JWT validation, credential rejection.
  2. Adding an article via the share sheet: Edge Function ingestion (`save-page`),
     user attribution from JWT, per-user URL deduplication, cross-user isolation.
  3. Adding an article via the + button in the app: Manual ingestion (`source: manual`),
     isolated active library updates.
  4. Reading an article: Full content retrieval by ID, isolated reading progress
     updates (`read_percent`), cross-user read/write protection.
  5. Archiving an article: State toggle (`is_archived`), active vs archive view
     filtering per user, protection against cross-user archive mutations.
  6. Automatically creating a podcast each day: Subscriber discovery (`discover.py`),
     isolated article extraction per user (`extract.py`), exclusion of archived articles,
     idempotent discussed tracking (`podcast_discussed_at`), and private RSS feed serving.

Prints PASS/FAIL for every check and exits non-zero if any failed.
"""

import os
import sys
import uuid
from datetime import datetime, timezone

import requests

# Add podcast/ directory to Python path so we can import discover & extract directly
PODCAST_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "podcast"))
if PODCAST_DIR not in sys.path:
    sys.path.insert(0, PODCAST_DIR)

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
    return resp


def create_episode(user_id, title):
    """Seed a podcast_episodes row directly for RSS testing."""
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


# ---------------------------------------------------------------------------
# Key Flow 1: Log in
# ---------------------------------------------------------------------------
def test_flow_1_login(email_a, email_b, password):
    print("\n--- Key Flow 1: Log in (Multi-User Authentication) ---")

    # Valid sign-in User A
    resp_a = sign_in(email_a, password)
    check(resp_a.status_code == 200, "User A logs in successfully with valid credentials")
    token_a = resp_a.json().get("access_token")

    # Valid sign-in User B
    resp_b = sign_in(email_b, password)
    check(resp_b.status_code == 200, "User B logs in successfully with valid credentials")
    token_b = resp_b.json().get("access_token")

    check(bool(token_a and token_b and token_a != token_b), "User A and User B receive distinct access tokens")

    # Validate User A JWT resolves to User A UUID
    user_info_a = requests.get(f"{AUTH_URL}/user", headers=user_headers(token_a), timeout=TIMEOUT)
    check(
        user_info_a.status_code == 200 and user_info_a.json().get("email") == email_a,
        "User A access token resolves correctly to User A identity",
    )

    # Validate User B JWT resolves to User B UUID
    user_info_b = requests.get(f"{AUTH_URL}/user", headers=user_headers(token_b), timeout=TIMEOUT)
    check(
        user_info_b.status_code == 200 and user_info_b.json().get("email") == email_b,
        "User B access token resolves correctly to User B identity",
    )

    # Invalid password attempt
    bad_resp = sign_in(email_a, "Wrong-Password-123!")
    check(
        bad_resp.status_code == 400,
        "Invalid password fails authentication with 400 Bad Request",
    )

    # Unauthenticated request to private saves
    unauth_resp = requests.get(
        f"{REST_URL}/saves",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        timeout=TIMEOUT,
    )
    check(
        unauth_resp.status_code == 200 and unauth_resp.json() == [],
        "Unauthenticated request returns empty list (RLS hides all saves)",
    )

    return token_a, token_b


# ---------------------------------------------------------------------------
# Key Flow 2: Adding an article via the share sheet
# ---------------------------------------------------------------------------
def test_flow_2_share_sheet(user_a_id, user_b_id, token_a, token_b):
    print("\n--- Key Flow 2: Adding an article via the share sheet ---")

    share_url_a = "https://example.test/articles/shared-by-a"
    long_content = "This is a detailed article body saved through the share sheet. " * 15

    # User A shares an article via save-page Edge Function
    share_payload_a = {
        "url": share_url_a,
        "source": "share-target",
        "prefetched": {
            "title": "User A Share Sheet Article",
            "content": long_content,
            "excerpt": "Excerpt of article shared by User A",
            "site_name": "Example Tech",
            "author": "Alice",
        },
    }
    resp_a = requests.post(
        f"{FUNCTIONS_URL}/save-page",
        headers=user_headers(token_a),
        json=share_payload_a,
        timeout=TIMEOUT,
    )
    check(resp_a.status_code == 200, "User A saves an article via share-sheet ingestion (save-page)")
    save_a_data = resp_a.json().get("save", {})
    save_a_id = save_a_data.get("id")
    check(
        save_a_data.get("user_id") == user_a_id and save_a_data.get("title") == "User A Share Sheet Article",
        "Edge Function attributes share-sheet save strictly to User A",
    )

    # User B must not see User A's share-sheet save
    resp_b_list = requests.get(f"{REST_URL}/saves", headers=user_headers(token_b), timeout=TIMEOUT)
    visible_titles_b = [row["title"] for row in resp_b_list.json()] if resp_b_list.status_code == 200 else []
    check(
        "User A Share Sheet Article" not in visible_titles_b,
        "User B cannot see User A's share-sheet save in library list",
    )

    # User B shares their own article
    share_url_b = "https://example.test/articles/shared-by-b"
    share_payload_b = {
        "url": share_url_b,
        "source": "share-target",
        "prefetched": {
            "title": "User B Share Sheet Article",
            "content": "Body text for User B article. " * 15,
            "excerpt": "Excerpt for B",
            "site_name": "Tech Daily",
            "author": "Bob",
        },
    }
    resp_b = requests.post(
        f"{FUNCTIONS_URL}/save-page",
        headers=user_headers(token_b),
        json=share_payload_b,
        timeout=TIMEOUT,
    )
    check(resp_b.status_code == 200, "User B saves an article via share-sheet ingestion (save-page)")
    save_b_data = resp_b.json().get("save", {})
    save_b_id = save_b_data.get("id")
    check(
        save_b_data.get("user_id") == user_b_id,
        "Edge Function attributes share-sheet save strictly to User B",
    )

    # Per-user URL deduplication test: User A shares the same URL again
    resp_a_dup = requests.post(
        f"{FUNCTIONS_URL}/save-page",
        headers=user_headers(token_a),
        json=share_payload_a,
        timeout=TIMEOUT,
    )
    check(
        resp_a_dup.status_code == 200 and resp_a_dup.json().get("duplicate") is True,
        "Re-sharing the same URL recognizes duplicate for User A and updates timestamp",
    )

    # User B shares the same URL that User A already saved -> should create independently for User B
    share_payload_b_same_url = {
        "url": share_url_a,
        "source": "share-target",
        "prefetched": {
            "title": "User B copy of same URL",
            "content": long_content,
        },
    }
    resp_b_same = requests.post(
        f"{FUNCTIONS_URL}/save-page",
        headers=user_headers(token_b),
        json=share_payload_b_same_url,
        timeout=TIMEOUT,
    )
    check(
        resp_b_same.status_code == 200 and resp_b_same.json().get("duplicate") is False,
        "User B saving the same URL creates a fresh, separate save for User B without colliding with User A",
    )

    # Unauthenticated save attempt to save-page
    unauth_save = requests.post(
        f"{FUNCTIONS_URL}/save-page",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"url": "https://example.test/unauth"},
        timeout=TIMEOUT,
    )
    check(
        unauth_save.status_code in (401, 403),
        "Unauthenticated call to save-page is rejected (401/403 Unauthorized)",
    )

    return save_a_id, save_b_id


# ---------------------------------------------------------------------------
# Key Flow 3: Adding an article via the + button in the app
# ---------------------------------------------------------------------------
def test_flow_3_add_button(user_a_id, user_b_id, token_a, token_b):
    print("\n--- Key Flow 3: Adding an article via the + button in the app ---")

    manual_url_a = "https://example.test/articles/manual-button-a"
    payload_a = {
        "url": manual_url_a,
        "source": "manual",
        "prefetched": {
            "title": "User A Manual + Button Article",
            "content": "Article manually added via the in-app + button by User A. " * 12,
            "excerpt": "Manual excerpt A",
            "site_name": "Productivity Hub",
        },
    }
    resp_a = requests.post(
        f"{FUNCTIONS_URL}/save-page",
        headers=user_headers(token_a),
        json=payload_a,
        timeout=TIMEOUT,
    )
    check(resp_a.status_code == 200, "User A adds an article via in-app + button modal")
    save_a_manual = resp_a.json().get("save", {})
    save_a_manual_id = save_a_manual.get("id")

    # Verify User A's active library contains the newly added article
    active_a = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"is_archived": "eq.false", "select": "id,title"},
        timeout=TIMEOUT,
    )
    active_titles_a = [s["title"] for s in active_a.json()] if active_a.status_code == 200 else []
    check(
        "User A Manual + Button Article" in active_titles_a,
        "User A's active library reflects the + button save immediately",
    )

    # Verify User B's active library does NOT contain User A's manual save
    active_b = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"is_archived": "eq.false", "select": "id,title"},
        timeout=TIMEOUT,
    )
    active_titles_b = [s["title"] for s in active_b.json()] if active_b.status_code == 200 else []
    check(
        "User A Manual + Button Article" not in active_titles_b,
        "User B's active library contains zero articles from User A's manual addition",
    )

    return save_a_manual_id


# ---------------------------------------------------------------------------
# Key Flow 4: Reading an article
# ---------------------------------------------------------------------------
def test_flow_4_read_article(save_a_id, save_b_id, token_a, token_b):
    print("\n--- Key Flow 4: Reading an article ---")

    # User A opens reading pane: fetches full content by ID
    resp_read_a = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"id": f"eq.{save_a_id}", "select": "id,title,content,read_percent"},
        timeout=TIMEOUT,
    )
    check(
        resp_read_a.status_code == 200 and len(resp_read_a.json()) == 1 and bool(resp_read_a.json()[0]["content"]),
        "User A can open reading pane and retrieve full article content",
    )

    # User B attempts to read User A's article content by ID
    resp_read_b_forbidden = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"id": f"eq.{save_a_id}", "select": "id,content"},
        timeout=TIMEOUT,
    )
    check(
        resp_read_b_forbidden.status_code == 200 and resp_read_b_forbidden.json() == [],
        "User B cannot read User A's full article content (RLS returns empty)",
    )

    # User A updates reading progress (e.g. scrolled 75%)
    patch_prog_a = requests.patch(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"id": f"eq.{save_a_id}"},
        json={"read_percent": 75},
        timeout=TIMEOUT,
    )
    check(patch_prog_a.status_code in (200, 204), "User A updates reading progress to 75%")

    # User B attempts to overwrite User A's read_percent
    requests.patch(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"id": f"eq.{save_a_id}"},
        json={"read_percent": 100},
        timeout=TIMEOUT,
    )

    # Verify User A's read_percent is intact at 75
    verify_a = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"id": f"eq.{save_a_id}", "select": "read_percent"},
        timeout=TIMEOUT,
    )
    current_read_a = verify_a.json()[0]["read_percent"] if verify_a.status_code == 200 and verify_a.json() else None
    check(current_read_a == 75, "User B's attempt to overwrite User A's read_percent has zero effect")

    # User B reads own article and updates progress to 50%
    requests.patch(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"id": f"eq.{save_b_id}"},
        json={"read_percent": 50},
        timeout=TIMEOUT,
    )
    verify_b = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"id": f"eq.{save_b_id}", "select": "read_percent"},
        timeout=TIMEOUT,
    )
    current_read_b = verify_b.json()[0]["read_percent"] if verify_b.status_code == 200 and verify_b.json() else None
    check(current_read_b == 50, "User B updates own reading progress to 50% independently")


# ---------------------------------------------------------------------------
# Key Flow 5: Archiving an article
# ---------------------------------------------------------------------------
def test_flow_5_archive_article(save_a1_id, save_a2_id, token_a, token_b):
    print("\n--- Key Flow 5: Archiving an article ---")

    # User A archives save_a1
    archive_resp = requests.patch(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"id": f"eq.{save_a1_id}"},
        json={"is_archived": True},
        timeout=TIMEOUT,
    )
    check(archive_resp.status_code in (200, 204), "User A archives an article (is_archived = true)")

    # Active view for User A excludes save_a1 and includes save_a2
    active_a = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"is_archived": "eq.false", "select": "id"},
        timeout=TIMEOUT,
    )
    active_ids_a = [s["id"] for s in active_a.json()] if active_a.status_code == 200 else []
    check(
        save_a1_id not in active_ids_a and save_a2_id in active_ids_a,
        "User A's active view correctly excludes the archived article",
    )

    # Archive view for User A includes save_a1
    archived_a = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"is_archived": "eq.true", "select": "id"},
        timeout=TIMEOUT,
    )
    archived_ids_a = [s["id"] for s in archived_a.json()] if archived_a.status_code == 200 else []
    check(
        save_a1_id in archived_ids_a,
        "User A's archive view correctly displays the archived article",
    )

    # User B's active view is completely unaffected
    active_b = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"is_archived": "eq.false", "select": "id"},
        timeout=TIMEOUT,
    )
    active_ids_b = [s["id"] for s in active_b.json()] if active_b.status_code == 200 else []
    check(save_a1_id not in active_ids_b and save_a2_id not in active_ids_b, "User B's active view is completely unaffected")

    # User B cannot unarchive User A's save
    requests.patch(
        f"{REST_URL}/saves",
        headers=user_headers(token_b),
        params={"id": f"eq.{save_a1_id}"},
        json={"is_archived": False},
        timeout=TIMEOUT,
    )
    check_still_archived = requests.get(
        f"{REST_URL}/saves",
        headers=user_headers(token_a),
        params={"id": f"eq.{save_a1_id}", "select": "is_archived"},
        timeout=TIMEOUT,
    )
    is_arch = check_still_archived.json()[0]["is_archived"] if check_still_archived.status_code == 200 and check_still_archived.json() else None
    check(is_arch is True, "User B's attempt to unarchive User A's save is rejected by RLS (remains archived)")


# ---------------------------------------------------------------------------
# Key Flow 6: Automatically creating a podcast each day
# ---------------------------------------------------------------------------
def test_flow_6_daily_podcast_creation(user_a_id, user_b_id, user_c_id, token_a, token_b):
    print("\n--- Key Flow 6: Automatically creating a podcast each day ---")

    # 1. Subscriber Discovery via podcast/discover.py
    import discover
    discover.SUPABASE_URL = SUPABASE_URL
    discover.SUPABASE_KEY = SERVICE_ROLE_KEY

    # podcast_feeds.subscribed defaults to false at sign-up (opting into the
    # podcast is a deliberate Settings action, not automatic) — so User A and
    # User B must explicitly subscribe here, the same PATCH the app's podcast
    # settings toggle sends, before discover.py has anyone to find.
    for uid in (user_a_id, user_b_id):
        requests.patch(
            f"{REST_URL}/podcast_feeds",
            headers=service_headers(),
            params={"user_id": f"eq.{uid}"},
            json={"subscribed": True},
            timeout=TIMEOUT,
        )

    # User C stays on the sign-up default (subscribed = false) — no action
    # needed, but PATCH it explicitly so this test doesn't silently pass if
    # that default ever flips.
    requests.patch(
        f"{REST_URL}/podcast_feeds",
        headers=service_headers(),
        params={"user_id": f"eq.{user_c_id}"},
        json={"subscribed": False},
        timeout=TIMEOUT,
    )

    # Run discovery logic
    subscribed_ids = discover.fetch_subscribed_user_ids(cap=25)
    check(
        user_a_id in subscribed_ids and user_b_id in subscribed_ids,
        "discover.py discovers subscribed User A and User B for daily matrix run",
    )
    check(
        user_c_id not in subscribed_ids,
        "discover.py strictly excludes unsubscribed User C from podcast generation matrix",
    )

    # 2. Isolated Extraction & Archived Exclusion via podcast/extract.py
    import extract
    extract.SUPABASE_URL = SUPABASE_URL
    extract.SUPABASE_KEY = SERVICE_ROLE_KEY

    # Extract for User A
    extract.USER_ID = user_a_id
    articles_a = extract.fetch_recent_articles(limit=10)
    titles_extracted_a = [a["title"] for a in articles_a]

    check(
        "User A Manual + Button Article" in titles_extracted_a,
        "extract.py extracts User A's eligible unarchived recent article for User A",
    )
    check(
        "User A Share Sheet Article" not in titles_extracted_a,
        "extract.py excludes User A's archived article from podcast generation",
    )
    check(
        not any("User B" in t for t in titles_extracted_a),
        "extract.py contains zero articles from User B when extracting for User A",
    )

    # Extract for User B
    extract.USER_ID = user_b_id
    articles_b = extract.fetch_recent_articles(limit=10)
    titles_extracted_b = [a["title"] for a in articles_b]

    check(
        any("User B" in t for t in titles_extracted_b),
        "extract.py extracts User B's eligible recent articles for User B",
    )
    check(
        not any("User A" in t for t in titles_extracted_b),
        "extract.py contains zero articles from User A when extracting for User B",
    )

    # 3. Idempotent Discussed Tracking
    # Simulate episode generation: stamp User A's extracted article with podcast_discussed_at
    if articles_a:
        extracted_id = articles_a[0]["id"]
        requests.patch(
            f"{REST_URL}/saves",
            headers=service_headers(),
            params={"id": f"eq.{extracted_id}"},
            json={"podcast_discussed_at": datetime.now(timezone.utc).isoformat()},
            timeout=TIMEOUT,
        )

    # Re-extract for User A -> should now be empty (no duplicate episode generation)
    extract.USER_ID = user_a_id
    re_extract_a = extract.fetch_recent_articles(limit=10)
    check(
        len(re_extract_a) == 0,
        "podcast_discussed_at stamp prevents discussed articles from repeating in tomorrow's run",
    )

    # Re-extract for User B -> User B's articles remain untouched and eligible
    extract.USER_ID = user_b_id
    re_extract_b = extract.fetch_recent_articles(limit=10)
    check(
        len(re_extract_b) > 0,
        "User B's un-discussed articles remain eligible for User B's episode run",
    )

    # 4. RSS Feed Serving Isolation via podcast-rss Edge Function
    resp_feed_a = requests.get(
        f"{REST_URL}/podcast_feeds",
        headers=user_headers(token_a),
        params={"select": "token"},
        timeout=TIMEOUT,
    )
    token_feed_a = resp_feed_a.json()[0]["token"] if resp_feed_a.status_code == 200 and resp_feed_a.json() else None

    resp_feed_b = requests.get(
        f"{REST_URL}/podcast_feeds",
        headers=user_headers(token_b),
        params={"select": "token"},
        timeout=TIMEOUT,
    )
    token_feed_b = resp_feed_b.json()[0]["token"] if resp_feed_b.status_code == 200 and resp_feed_b.json() else None

    check(
        bool(token_feed_a and token_feed_b and token_feed_a != token_feed_b),
        "User A and User B have distinct private podcast feed tokens",
    )

    create_episode(user_a_id, "User A Daily Digest Episode")
    create_episode(user_b_id, "User B Daily Digest Episode")

    def fetch_rss(token):
        return requests.get(f"{FUNCTIONS_URL}/podcast-rss", params={"token": token}, timeout=TIMEOUT)

    rss_a = fetch_rss(token_feed_a)
    check(rss_a.status_code == 200, "User A's podcast RSS feed returns 200")
    check("User A Daily Digest Episode" in rss_a.text, "User A's feed contains User A's episode")
    check("User B Daily Digest Episode" not in rss_a.text, "User A's feed does not contain User B's episode")

    rss_b = fetch_rss(token_feed_b)
    check(rss_b.status_code == 200, "User B's podcast RSS feed returns 200")
    check("User B Daily Digest Episode" in rss_b.text, "User B's feed contains User B's episode")
    check("User A Daily Digest Episode" not in rss_b.text, "User B's feed does not contain User A's episode")

    rss_unknown = fetch_rss("invalid-token-" + uuid.uuid4().hex)
    check(rss_unknown.status_code == 404, "Unknown podcast feed token returns 404 Not Found")


# ---------------------------------------------------------------------------
# Main Runner
# ---------------------------------------------------------------------------
def main():
    suffix = uuid.uuid4().hex[:8]
    email_a = f"flow-user-a-{suffix}@example.test"
    email_b = f"flow-user-b-{suffix}@example.test"
    email_c = f"flow-user-c-{suffix}@example.test"
    password = "Secure-Password-Flow-123!"

    print(f"Creating test users:\n  User A: {email_a}\n  User B: {email_b}\n  User C: {email_c}")
    allow_email(email_a)
    allow_email(email_b)
    allow_email(email_c)

    user_a_id = create_user(email_a, password)
    user_b_id = create_user(email_b, password)
    user_c_id = create_user(email_c, password)

    # Key Flow 1: Log in
    token_a, token_b = test_flow_1_login(email_a, email_b, password)

    # Key Flow 2: Adding an article via the share sheet
    save_a1_id, save_b_id = test_flow_2_share_sheet(user_a_id, user_b_id, token_a, token_b)

    # Key Flow 3: Adding an article via the + button in the app
    save_a2_id = test_flow_3_add_button(user_a_id, user_b_id, token_a, token_b)

    # Key Flow 4: Reading an article
    test_flow_4_read_article(save_a1_id, save_b_id, token_a, token_b)

    # Key Flow 5: Archiving an article
    test_flow_5_archive_article(save_a1_id, save_a2_id, token_a, token_b)

    # Key Flow 6: Automatically creating a podcast each day
    test_flow_6_daily_podcast_creation(user_a_id, user_b_id, user_c_id, token_a, token_b)

    failed = [desc for passed, desc in results if not passed]
    print(f"\n{'=' * 60}")
    print(f"Multi-user Key Flows E2E Summary: {len(results) - len(failed)}/{len(results)} checks passed.")
    print(f"{'=' * 60}")
    if failed:
        print("\nFAILED CHECKS:")
        for desc in failed:
            print(f"  ❌ {desc}")
        sys.exit(1)

    print("\n✅ All multi-user key flow checks PASSED successfully.")


if __name__ == "__main__":
    main()

