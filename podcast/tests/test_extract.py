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

MOCK_ARTICLE = {
    "id": "abc-123",
    "title": "Test Article",
    "content": "This is the body content.",
    "excerpt": "Excerpt text.",
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

    def test_content_falls_back_to_excerpt_when_content_is_none(self, monkeypatch):
        self._patch_env(monkeypatch)
        article_no_content = {**MOCK_ARTICLE, "content": None}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [article_no_content]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles[0]["content"] == "Excerpt text."

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

    def test_returns_empty_list_on_api_error(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles == []

    def test_site_name_defaults_to_unknown(self, monkeypatch):
        self._patch_env(monkeypatch)
        article_no_site = {**MOCK_ARTICLE, "site_name": None}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [article_no_site]

        with patch("extract.requests.get", return_value=mock_response):
            articles = extract.fetch_recent_articles()

        assert articles[0]["site_name"] == "Unknown"

    def test_queries_oldest_first_excluding_already_discussed(self, monkeypatch):
        """FIFO + dedup: oldest unarchived, undiscussed saves come first, and
        already-discussed saves are excluded regardless of age (#fifo-dedup)."""
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [MOCK_ARTICLE]

        with patch("extract.requests.get", return_value=mock_response) as mock_get:
            extract.fetch_recent_articles(limit=3)

        params = mock_get.call_args.kwargs["params"]
        assert params["order"] == "created_at.asc"
        assert params["podcast_discussed_at"] == "is.null"
        assert params["is_archived"] == "eq.false"
        assert params["limit"] == 3
        assert "created_at" not in params  # no recency-window cutoff anymore


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
    def _patch_env(self, monkeypatch):
        # extract.py reads these into module globals at import time, so set the
        # attributes directly (env vars alone wouldn't reach the already-loaded
        # module) to exercise the transcript cache write.
        monkeypatch.setattr(extract, "SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setattr(extract, "SUPABASE_KEY", "fake-key")
        monkeypatch.setattr(extract, "USER_ID", "user-001")

    def test_transcript_used_as_content_for_youtube_save(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [dict(MOCK_YOUTUBE_SAVE)]

        with patch("extract.requests.get", return_value=mock_response), \
             patch("extract.requests.patch") as mock_patch, \
             patch("extract.fetch_transcript_for_url", return_value="the spoken transcript"):
            articles = extract.fetch_recent_articles()

        assert articles[0]["content"] == "the spoken transcript"
        # site_name defaults to YouTube when the save has none.
        assert articles[0]["site_name"] == "YouTube"
        # Transcript is cached back to the save.
        mock_patch.assert_called_once()

    def test_stored_content_reused_when_long_enough(self, monkeypatch):
        # A YouTube save that already has a cached transcript is not re-fetched.
        self._patch_env(monkeypatch)
        cached = "x" * (extract.YOUTUBE_CONTENT_MIN_CHARS + 10)
        save = {**MOCK_YOUTUBE_SAVE, "content": cached}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [save]

        with patch("extract.requests.get", return_value=mock_response), \
             patch("extract.fetch_transcript_for_url") as mock_fetch:
            articles = extract.fetch_recent_articles()

        mock_fetch.assert_not_called()
        assert articles[0]["content"].startswith("x")

    def test_falls_back_to_stored_content_when_no_transcript(self, monkeypatch):
        self._patch_env(monkeypatch)
        save = {**MOCK_YOUTUBE_SAVE, "excerpt": "short description"}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [save]

        with patch("extract.requests.get", return_value=mock_response), \
             patch("extract.requests.patch") as mock_patch, \
             patch("extract.fetch_transcript_for_url", return_value=None):
            articles = extract.fetch_recent_articles()

        # No transcript -> use whatever the save already had, no cache write.
        assert articles[0]["content"] == "short description"
        mock_patch.assert_not_called()

    def test_non_youtube_save_never_fetches_transcript(self, monkeypatch):
        self._patch_env(monkeypatch)
        save = {**MOCK_ARTICLE, "url": "https://blog.example.com/post"}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [save]

        with patch("extract.requests.get", return_value=mock_response), \
             patch("extract.fetch_transcript_for_url") as mock_fetch:
            articles = extract.fetch_recent_articles()

        mock_fetch.assert_not_called()
        assert articles[0]["content"] == "This is the body content."
