"""
Tests for podcast/extract.py

These tests validate the text cleaning logic and the article-fetching pipeline
without making real network calls to Supabase. All HTTP requests are mocked.
"""

import sys
import os
import pytest
from unittest.mock import patch, MagicMock

# Ensure the podcast directory is on the path so we can import modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import extract


# ---------------------------------------------------------------------------
# clean_text
# ---------------------------------------------------------------------------

class TestCleanText:
    def test_returns_empty_string_for_none(self):
        assert extract.clean_text(None) == ""

    def test_returns_empty_string_for_empty_input(self):
        assert extract.clean_text("") == ""

    def test_strips_leading_and_trailing_whitespace(self):
        assert extract.clean_text("  hello  ") == "hello"

    def test_collapses_excessive_newlines_to_double(self):
        text = "paragraph one\n\n\n\nparagraph two"
        result = extract.clean_text(text)
        assert "\n\n\n" not in result
        assert "paragraph one" in result
        assert "paragraph two" in result

    def test_preserves_double_newlines(self):
        text = "line one\n\nline two"
        result = extract.clean_text(text)
        assert result == "line one\n\nline two"

    def test_handles_regular_text_unchanged(self):
        text = "Hello, world! This is a normal sentence."
        assert extract.clean_text(text) == text


# ---------------------------------------------------------------------------
# fetch_recent_articles
# ---------------------------------------------------------------------------

# Long enough to clear MIN_ARTICLE_CHARS — a save with less body text than
# that is skipped as unusable for a podcast segment (see TestPodcastEligibility).
LONG_BODY = "This is the body content. " * 40
LONG_EXCERPT = "Excerpt text. " * 80

MOCK_ARTICLE = {
    "id": "abc-123",
    "title": "Test Article",
    "content": LONG_BODY,
    "excerpt": LONG_EXCERPT,
    "site_name": "Test Site",
    "created_at": "2026-02-20T10:00:00Z",
}


class TestFetchRecentArticles:
    def _patch_env(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fake-key")
        monkeypatch.setenv("USER_ID", "user-001")

    def test_returns_formatted_articles_on_success(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [MOCK_ARTICLE]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert len(articles) == 1
        article = articles[0]
        assert article["id"] == "abc-123"
        assert article["title"] == "Test Article"
        assert article["site_name"] == "Test Site"
        assert article["content"].startswith("This is the body content.")

    def test_content_falls_back_to_excerpt_when_content_is_none(self, monkeypatch):
        self._patch_env(monkeypatch)
        article_no_content = {**MOCK_ARTICLE, "content": None}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [article_no_content]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles[0]["content"] == LONG_EXCERPT.strip()

    def test_content_is_truncated_to_5000_chars(self, monkeypatch):
        self._patch_env(monkeypatch)
        long_content = "x" * 10_000
        article_long = {**MOCK_ARTICLE, "content": long_content}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [article_long]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert len(articles[0]["content"]) <= 5000

    def test_raises_on_api_error(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"

        with patch("extract.requests.get", return_value=mock_response):
            with pytest.raises(RuntimeError, match="500"):
                extract.fetch_recent_articles()

    def test_image_url_passed_through(self, monkeypatch):
        self._patch_env(monkeypatch)
        article_with_image = {**MOCK_ARTICLE, "image_url": "https://example.com/og.jpg"}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [article_with_image]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles[0]["image_url"] == "https://example.com/og.jpg"

    def test_image_url_defaults_to_none_when_missing(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [MOCK_ARTICLE]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles[0]["image_url"] is None

    def test_site_name_defaults_to_unknown(self, monkeypatch):
        self._patch_env(monkeypatch)
        article_no_site = {**MOCK_ARTICLE, "site_name": None}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [article_no_site]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles[0]["site_name"] == "Unknown"

    def test_queries_newest_first_excluding_already_discussed(self, monkeypatch):
        """Newest-first + dedup: most recently saved unarchived, undiscussed
        saves come first, and already-discussed saves are excluded regardless
        of age (#fifo-dedup)."""
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [MOCK_ARTICLE]

        with patch("extract.requests.get", return_value=mock_response) as mock_get:
            extract.fetch_recent_articles(limit=3)

        params = mock_get.call_args.kwargs["params"]
        assert params["order"] == "created_at.desc"
        assert params["podcast_discussed_at"] == "is.null"
        assert params["is_archived"] == "eq.false"
        # Ineligible saves are filtered after the query, so we ask for a pool of
        # candidates rather than exactly `limit` rows.
        assert params["limit"] > 3
        assert "created_at" not in params  # no recency-window cutoff anymore
        assert "published_at" in params["select"]

    def test_recently_saved_article_surfaces_before_ancient_one(self, monkeypatch):
        """Regression test: episodes were discussing years-old undiscussed
        saves before anything recently saved, because selection was
        oldest-first FIFO. Confirms both that newest-first is requested from
        the API and that extract.py doesn't reorder what comes back."""
        self._patch_env(monkeypatch)
        recent_save = {**MOCK_ARTICLE, "id": "recent-1", "title": "Just Saved", "created_at": "2026-07-31T09:00:00Z"}
        ancient_save = {**MOCK_ARTICLE, "id": "ancient-1", "title": "Saved Years Ago", "created_at": "2013-01-01T00:00:00Z"}
        mock_response = MagicMock()
        mock_response.status_code = 200
        # A real Supabase response for order=created_at.desc would put the
        # newer save first.
        mock_response.json.return_value = [recent_save, ancient_save]

        with patch("extract.requests.get", return_value=mock_response) as mock_get:
            articles = extract.fetch_recent_articles(limit=2)

        assert mock_get.call_args.kwargs["params"]["order"] == "created_at.desc"
        assert [a["id"] for a in articles] == ["recent-1", "ancient-1"]


# ---------------------------------------------------------------------------
# fetch_recent_articles – YouTube ingestion
# ---------------------------------------------------------------------------

MOCK_YOUTUBE_SAVE = {
    "id": "yt-1",
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "title": "A Great Talk",
    "content": "",  # page scraper couldn't grab the spoken words
    "excerpt": "",
    "site_name": None,
    "created_at": "2026-02-20T10:00:00Z",
}


class TestYouTubeIngestion:
    """Transcript resolution lives in format_article, which shapes one raw
    `saves` row; it runs before the podcast-eligibility filter, so these tests
    call it directly rather than going through fetch_recent_articles."""

    def _patch_env(self, monkeypatch):
        # extract.py reads these into module globals at import time, so set the
        # attributes directly (env vars alone wouldn't reach the already-loaded
        # module) to exercise the transcript cache write.
        monkeypatch.setattr(extract, "SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setattr(extract, "SUPABASE_KEY", "fake-key")
        monkeypatch.setattr(extract, "USER_ID", "user-001")

    def test_transcript_used_as_content_for_youtube_save(self, monkeypatch):
        self._patch_env(monkeypatch)

        with patch("extract.requests.patch") as mock_patch, \
             patch("extract.fetch_transcript_for_url", return_value="the spoken transcript"):
            article = extract.format_article(dict(MOCK_YOUTUBE_SAVE))

        assert article["content"] == "the spoken transcript"
        # site_name defaults to YouTube when the save has none.
        assert article["site_name"] == "YouTube"
        # Transcript is cached back to the save.
        mock_patch.assert_called_once()

    def test_stored_content_reused_when_long_enough(self, monkeypatch):
        # A YouTube save that already has a cached transcript is not re-fetched.
        self._patch_env(monkeypatch)
        cached = "x" * (extract.YOUTUBE_CONTENT_MIN_CHARS + 10)
        save = {**MOCK_YOUTUBE_SAVE, "content": cached}

        with patch("extract.fetch_transcript_for_url") as mock_fetch:
            article = extract.format_article(save)

        mock_fetch.assert_not_called()
        assert article["content"].startswith("x")

    def test_falls_back_to_stored_content_when_no_transcript(self, monkeypatch):
        self._patch_env(monkeypatch)
        save = {**MOCK_YOUTUBE_SAVE, "excerpt": "short description"}

        with patch("extract.requests.patch") as mock_patch, \
             patch("extract.fetch_transcript_for_url", return_value=None):
            article = extract.format_article(save)

        # No transcript -> use whatever the save already had, no cache write.
        assert article["content"] == "short description"
        mock_patch.assert_not_called()

    def test_non_youtube_save_never_fetches_transcript(self, monkeypatch):
        self._patch_env(monkeypatch)
        save = {**MOCK_ARTICLE, "url": "https://blog.example.com/post"}

        with patch("extract.fetch_transcript_for_url") as mock_fetch:
            article = extract.format_article(save)

        mock_fetch.assert_not_called()
        assert article["content"] == LONG_BODY.strip()


# ---------------------------------------------------------------------------
# Podcast eligibility — thin, empty and paywalled saves are not discussable
# ---------------------------------------------------------------------------

class TestPodcastSkipReason:
    def test_empty_content_is_skipped(self):
        assert extract.podcast_skip_reason("") == "no body text was saved"
        assert extract.podcast_skip_reason(None) == "no body text was saved"
        assert extract.podcast_skip_reason("   \n  ") == "no body text was saved"

    def test_short_content_is_skipped(self):
        # An X/Twitter save keeps the post text at most — nothing to discuss.
        reason = extract.podcast_skip_reason("Just posted a hot take about AI.")
        assert reason is not None
        assert "minimum" in reason

    def test_full_length_article_is_kept(self):
        assert extract.podcast_skip_reason("word " * 400) is None

    def test_paywall_stub_is_skipped(self):
        stub = (
            "The opening paragraph of the article runs for a little while and then "
            "stops abruptly. " * 10
            + "Subscribe to continue reading this article."
        )
        assert len(stub) > extract.MIN_ARTICLE_CHARS  # long enough to pass the length gate
        assert extract.podcast_skip_reason(stub) == (
            "body text looks like a paywall or bot-check interstitial"
        )

    def test_bot_check_stub_is_skipped(self):
        stub = "Please enable JavaScript to view this page. " * 20
        assert extract.podcast_skip_reason(stub) is not None

    def test_long_article_mentioning_subscriptions_is_kept(self):
        # A real article about the subscription economy must not be mistaken for
        # a paywall stub, hence the PAYWALL_MAX_CHARS guard.
        article = "Media companies keep asking readers to subscribe to continue. " * 60
        assert len(article) > extract.PAYWALL_MAX_CHARS
        assert extract.podcast_skip_reason(article) is None


class TestFetchRecentArticlesFiltering:
    def _patch_env(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fake-key")
        monkeypatch.setenv("USER_ID", "user-001")

    def _respond_with(self, rows):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = rows
        return mock_response

    def test_thin_saves_are_left_out_of_the_episode(self, monkeypatch):
        self._patch_env(monkeypatch)
        x_post = {**MOCK_ARTICLE, "id": "x-1", "title": "An X post",
                  "content": "", "excerpt": ""}
        paywalled = {**MOCK_ARTICLE, "id": "pw-1", "title": "Paywalled",
                     "content": "The first two paragraphs are free. " * 15
                                + "Already a subscriber? Sign in.", "excerpt": ""}
        good = {**MOCK_ARTICLE, "id": "ok-1", "title": "A real article"}

        with patch("extract.requests.get", return_value=self._respond_with([x_post, paywalled, good])):
            articles = extract.fetch_recent_articles(limit=3)

        assert [a["id"] for a in articles] == ["ok-1"]

    def test_fetches_a_larger_candidate_pool_than_limit(self, monkeypatch):
        """Filtering happens after the query, so asking for exactly `limit`
        rows would yield half-empty episodes whenever the newest saves are
        unusable."""
        self._patch_env(monkeypatch)

        with patch("extract.requests.get", return_value=self._respond_with([])) as mock_get:
            extract.fetch_recent_articles(limit=3)

        assert mock_get.call_args.kwargs["params"]["limit"] >= extract.MIN_CANDIDATE_POOL

    def test_stops_once_limit_usable_articles_are_collected(self, monkeypatch):
        self._patch_env(monkeypatch)
        rows = [{**MOCK_ARTICLE, "id": f"ok-{i}"} for i in range(10)]

        with patch("extract.requests.get", return_value=self._respond_with(rows)):
            articles = extract.fetch_recent_articles(limit=3)

        assert [a["id"] for a in articles] == ["ok-0", "ok-1", "ok-2"]

    def test_returns_empty_when_nothing_is_discussable(self, monkeypatch):
        self._patch_env(monkeypatch)
        rows = [{**MOCK_ARTICLE, "id": "x-1", "content": "", "excerpt": ""}]

        with patch("extract.requests.get", return_value=self._respond_with(rows)):
            articles = extract.fetch_recent_articles(limit=3)

        assert articles == []

    def test_published_at_is_passed_through(self, monkeypatch):
        self._patch_env(monkeypatch)
        rows = [{**MOCK_ARTICLE, "published_at": "2026-02-01T00:00:00Z"}]

        with patch("extract.requests.get", return_value=self._respond_with(rows)):
            articles = extract.fetch_recent_articles(limit=1)

        assert articles[0]["published_at"] == "2026-02-01T00:00:00Z"
        assert articles[0]["created_at"] == MOCK_ARTICLE["created_at"]

    def test_published_at_defaults_to_none(self, monkeypatch):
        self._patch_env(monkeypatch)

        with patch("extract.requests.get", return_value=self._respond_with([dict(MOCK_ARTICLE)])):
            articles = extract.fetch_recent_articles(limit=1)

        assert articles[0]["published_at"] is None
