"""
Tests for podcast/youtube.py

Covers YouTube URL detection / video-id parsing, transcript cleaning, and the
transcript-fetch wrapper (with the youtube-transcript-api dependency mocked so
no real network calls are made).
"""

import sys
import os
from unittest.mock import patch, MagicMock

# Ensure the podcast directory is on the path so we can import modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import youtube


# ---------------------------------------------------------------------------
# extract_video_id / is_youtube_url
# ---------------------------------------------------------------------------

class TestExtractVideoId:
    def test_standard_watch_url(self):
        assert youtube.extract_video_id(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ) == "dQw4w9WgXcQ"

    def test_short_youtu_be_url(self):
        assert youtube.extract_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"

    def test_shorts_url(self):
        assert youtube.extract_video_id(
            "https://www.youtube.com/shorts/dQw4w9WgXcQ"
        ) == "dQw4w9WgXcQ"

    def test_embed_url(self):
        assert youtube.extract_video_id(
            "https://www.youtube.com/embed/dQw4w9WgXcQ"
        ) == "dQw4w9WgXcQ"

    def test_live_url(self):
        assert youtube.extract_video_id(
            "https://www.youtube.com/live/dQw4w9WgXcQ"
        ) == "dQw4w9WgXcQ"

    def test_watch_url_with_extra_params(self):
        # Watch Later links often carry a list= and index= param.
        assert youtube.extract_video_id(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=WL&index=3&t=42s"
        ) == "dQw4w9WgXcQ"

    def test_youtu_be_with_timestamp(self):
        assert youtube.extract_video_id(
            "https://youtu.be/dQw4w9WgXcQ?t=42"
        ) == "dQw4w9WgXcQ"

    def test_mobile_host(self):
        assert youtube.extract_video_id(
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ"
        ) == "dQw4w9WgXcQ"

    def test_non_youtube_url_returns_none(self):
        assert youtube.extract_video_id("https://example.com/watch?v=dQw4w9WgXcQ") is None

    def test_youtube_non_video_page_returns_none(self):
        assert youtube.extract_video_id("https://www.youtube.com/feed/subscriptions") is None

    def test_lookalike_host_returns_none(self):
        # notyoutube.com must not be treated as YouTube.
        assert youtube.extract_video_id("https://notyoutube.com/watch?v=dQw4w9WgXcQ") is None

    def test_none_input_returns_none(self):
        assert youtube.extract_video_id(None) is None

    def test_empty_string_returns_none(self):
        assert youtube.extract_video_id("") is None

    def test_malformed_id_returns_none(self):
        assert youtube.extract_video_id("https://youtu.be/short") is None


class TestIsYoutubeUrl:
    def test_true_for_youtube(self):
        assert youtube.is_youtube_url("https://youtu.be/dQw4w9WgXcQ") is True

    def test_false_for_article(self):
        assert youtube.is_youtube_url("https://blog.example.com/post") is False

    def test_false_for_none(self):
        assert youtube.is_youtube_url(None) is False


# ---------------------------------------------------------------------------
# clean_transcript
# ---------------------------------------------------------------------------

class TestCleanTranscript:
    def test_empty_returns_empty(self):
        assert youtube.clean_transcript("") == ""
        assert youtube.clean_transcript(None) == ""

    def test_collapses_whitespace_and_newlines(self):
        assert youtube.clean_transcript("hello\nthere    world") == "hello there world"

    def test_strips_sound_cues(self):
        result = youtube.clean_transcript("welcome [Music] to the show [Applause]")
        assert "[Music]" not in result
        assert "[Applause]" not in result
        assert "welcome" in result and "to the show" in result

    def test_trims_edges(self):
        assert youtube.clean_transcript("   padded   ") == "padded"


# ---------------------------------------------------------------------------
# fetch_transcript
# ---------------------------------------------------------------------------

class TestFetchTranscript:
    def test_returns_none_when_dependency_unavailable(self):
        with patch.object(youtube, "_YT_AVAILABLE", False):
            assert youtube.fetch_transcript("dQw4w9WgXcQ") is None

    def test_returns_none_for_empty_video_id(self):
        with patch.object(youtube, "_YT_AVAILABLE", True):
            assert youtube.fetch_transcript(None) is None

    def test_legacy_get_transcript_dicts(self):
        fake_api = MagicMock()
        fake_api.get_transcript.return_value = [
            {"text": "hello", "start": 0.0, "duration": 1.0},
            {"text": "[Music]", "start": 1.0, "duration": 1.0},
            {"text": "world", "start": 2.0, "duration": 1.0},
        ]
        with patch.object(youtube, "_YT_AVAILABLE", True), \
             patch.object(youtube, "YouTubeTranscriptApi", fake_api):
            result = youtube.fetch_transcript("dQw4w9WgXcQ")

        assert result == "hello world"
        fake_api.get_transcript.assert_called_once()

    def test_new_fetch_api_objects(self):
        # Simulate the >= 1.0 instance API with snippet objects (no
        # get_transcript attribute present).
        snippet_a = MagicMock()
        snippet_a.text = "first"
        snippet_b = MagicMock()
        snippet_b.text = "second"

        fake_instance = MagicMock()
        fake_instance.fetch.return_value = [snippet_a, snippet_b]

        fake_api = MagicMock(return_value=fake_instance)
        # Ensure the legacy branch is not taken.
        del fake_api.get_transcript

        with patch.object(youtube, "_YT_AVAILABLE", True), \
             patch.object(youtube, "YouTubeTranscriptApi", fake_api):
            result = youtube.fetch_transcript("dQw4w9WgXcQ")

        assert result == "first second"

    def test_returns_none_on_exception(self):
        fake_api = MagicMock()
        fake_api.get_transcript.side_effect = Exception("Transcripts disabled")
        with patch.object(youtube, "_YT_AVAILABLE", True), \
             patch.object(youtube, "YouTubeTranscriptApi", fake_api):
            assert youtube.fetch_transcript("dQw4w9WgXcQ") is None

    def test_returns_none_when_transcript_empty(self):
        fake_api = MagicMock()
        fake_api.get_transcript.return_value = [{"text": "[Music]"}]
        with patch.object(youtube, "_YT_AVAILABLE", True), \
             patch.object(youtube, "YouTubeTranscriptApi", fake_api):
            assert youtube.fetch_transcript("dQw4w9WgXcQ") is None


class TestFetchTranscriptForUrl:
    def test_resolves_url_then_fetches(self):
        with patch.object(youtube, "fetch_transcript", return_value="the words") as m:
            result = youtube.fetch_transcript_for_url(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            )
        assert result == "the words"
        # Called with the parsed video id.
        assert m.call_args[0][0] == "dQw4w9WgXcQ"

    def test_non_youtube_url_yields_none_id(self):
        with patch.object(youtube, "fetch_transcript", return_value=None) as m:
            youtube.fetch_transcript_for_url("https://example.com/post")
        assert m.call_args[0][0] is None
