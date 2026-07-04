"""
Tests for podcast/script.py

Covers:
  - generate_script: validates Gemini API interaction, JSON parsing, and markdown fencing cleanup
  - save_to_supabase: validates request payload construction and error handling
  - upload_audio_to_supabase: validates Supabase storage client calls
  - update_episode_audio_url: validates database update logic
All external API/network calls are fully mocked.
"""

import sys
import os
import json
import pytest
from unittest.mock import patch, MagicMock, mock_open

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Patch out the Supabase client at import time so script.py doesn't try to
# connect during test collection (SUPABASE_URL / SUPABASE_KEY are unset)
with patch("script.create_client", return_value=None):
    import script


SAMPLE_SCRIPT = [
    {"speaker": "Alex", "text": "Taylor, did you see this piece on local-first software?"},
    {"speaker": "Taylor", "text": "I did! Fascinating shift."},
]

SAMPLE_ARTICLES = [
    {"id": "1", "title": "Article One", "site_name": "Site A", "content": "Content A"},
    {"id": "2", "title": "Article Two", "site_name": "Site B", "content": "Content B"},
]


# ---------------------------------------------------------------------------
# generate_script
# ---------------------------------------------------------------------------

class TestGenerateScript:
    def test_returns_none_when_no_api_key(self, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        result = script.generate_script(SAMPLE_ARTICLES)
        assert result is None

    def test_returns_none_when_no_articles(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        result = script.generate_script([])
        assert result is None

    def test_parses_clean_json_response(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value.text = json.dumps(SAMPLE_SCRIPT)

        with patch("script.genai.Client", return_value=mock_client):
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result == SAMPLE_SCRIPT

    def test_strips_markdown_fences_from_response(self, monkeypatch):
        """Gemini sometimes returns ```json ... ``` — we must strip that."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        fenced = f"```json\n{json.dumps(SAMPLE_SCRIPT)}\n```"
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value.text = fenced

        with patch("script.genai.Client", return_value=mock_client):
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result == SAMPLE_SCRIPT

    def test_returns_none_on_gemini_exception(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = Exception("API error")

        with patch("script.genai.Client", return_value=mock_client):
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result is None


# ---------------------------------------------------------------------------
# Chapters (#14)
# ---------------------------------------------------------------------------

class TestBuildChapters:
    ARTICLES = [
        {"id": "1", "title": "Local-First Software"},
        {"id": "2", "title": "The RSS Renaissance"},
    ]

    def test_maps_articles_to_start_times(self):
        script_lines = [
            {"speaker": "Alex", "text": "Welcome!", "article_index": None},   # 1.0s
            {"speaker": "Alex", "text": "Local first...", "article_index": 0},  # 2.0s
            {"speaker": "Taylor", "text": "Yes!", "article_index": 0},          # 3.0s
            {"speaker": "Alex", "text": "Now RSS...", "article_index": 1},      # 4.0s
        ]
        durations = [1.0, 2.0, 3.0, 4.0]
        chapters = script.build_chapters(script_lines, durations, self.ARTICLES)

        assert chapters == [
            {"startTime": 0.0, "title": "Intro"},        # leading untagged line
            {"startTime": 1.0, "title": "Local-First Software"},
            {"startTime": 6.0, "title": "The RSS Renaissance"},
        ]

    def test_no_intro_when_first_line_is_article(self):
        script_lines = [
            {"speaker": "Alex", "text": "Local first...", "article_index": 0},
            {"speaker": "Alex", "text": "Now RSS...", "article_index": 1},
        ]
        durations = [2.0, 2.0]
        chapters = script.build_chapters(script_lines, durations, self.ARTICLES)
        assert chapters[0] == {"startTime": 0.0, "title": "Local-First Software"}
        assert len(chapters) == 2

    def test_returns_empty_when_no_article_tags(self):
        script_lines = [
            {"speaker": "Alex", "text": "Hi", "article_index": None},
            {"speaker": "Taylor", "text": "Bye", "article_index": None},
        ]
        assert script.build_chapters(script_lines, [1.0, 1.0], self.ARTICLES) == []

    def test_ignores_out_of_range_and_duplicate_indices(self):
        script_lines = [
            {"speaker": "Alex", "text": "a", "article_index": 0},
            {"speaker": "Alex", "text": "b", "article_index": 5},   # out of range
            {"speaker": "Alex", "text": "c", "article_index": 0},   # duplicate
        ]
        chapters = script.build_chapters(script_lines, [1.0, 1.0, 1.0], self.ARTICLES)
        assert chapters == [{"startTime": 0.0, "title": "Local-First Software"}]


class TestComputeLineDurations:
    def test_probes_each_file(self):
        outputs = [b"1.5\n", b"2.5\n"]
        with patch("script.subprocess.run") as mock_run:
            mock_run.side_effect = [MagicMock(stdout=o) for o in outputs]
            durations = script.compute_line_durations(["a.mp3", "b.mp3"])
        assert durations == [1.5, 2.5]

    def test_defaults_to_zero_on_probe_error(self):
        with patch("script.subprocess.run", side_effect=Exception("boom")):
            durations = script.compute_line_durations(["a.mp3"])
        assert durations == [0.0]


# ---------------------------------------------------------------------------
# Custom host personalities (#13)
# ---------------------------------------------------------------------------

class TestPodcastPreferences:
    def test_defaults_when_no_supabase_client(self, monkeypatch):
        monkeypatch.setattr(script, "supabase_client", None)
        prefs = script.fetch_podcast_preferences()
        assert prefs == script.DEFAULT_PODCAST_PREFS

    def test_custom_personas_from_db(self, monkeypatch):
        mock_client = MagicMock()
        (mock_client.table.return_value.select.return_value
            .eq.return_value.limit.return_value.execute.return_value.data) = [{
                "podcast_host_a_name": "Sam",
                "podcast_host_a_persona": "Dry and precise.",
                "podcast_host_b_name": "Kai",
                "podcast_host_b_persona": "Warm and rambly.",
                "podcast_tone": "Late-night radio.",
            }]
        monkeypatch.setattr(script, "supabase_client", mock_client)
        monkeypatch.setattr(script, "USER_ID", "user-001")

        prefs = script.fetch_podcast_preferences()
        assert prefs["host_a_name"] == "Sam"
        assert prefs["host_b_name"] == "Kai"
        assert prefs["tone"] == "Late-night radio."

    def test_partial_override_falls_back_to_defaults(self, monkeypatch):
        mock_client = MagicMock()
        (mock_client.table.return_value.select.return_value
            .eq.return_value.limit.return_value.execute.return_value.data) = [{
                "podcast_host_a_name": "Sam",
                "podcast_host_a_persona": None,
                "podcast_host_b_name": None,
                "podcast_host_b_persona": None,
                "podcast_tone": None,
            }]
        monkeypatch.setattr(script, "supabase_client", mock_client)
        monkeypatch.setattr(script, "USER_ID", "user-001")

        prefs = script.fetch_podcast_preferences()
        assert prefs["host_a_name"] == "Sam"
        assert prefs["host_b_name"] == "Taylor"  # default retained
        assert prefs["host_a_persona"] == script.DEFAULT_PODCAST_PREFS["host_a_persona"]

    def test_build_system_prompt_uses_host_names(self):
        prefs = dict(script.DEFAULT_PODCAST_PREFS,
                     host_a_name="Sam", host_b_name="Kai")
        prompt = script.build_system_prompt(prefs)
        assert "SAM:" in prompt and "KAI:" in prompt
        assert 'exactly "Sam" or "Kai"' in prompt
        assert "article_index" in prompt

    def test_generate_script_uses_supplied_prefs(self, monkeypatch):
        """When prefs are passed explicitly, the DB is not queried and host names
        appear in the system_instruction sent to Gemini."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        prefs = dict(script.DEFAULT_PODCAST_PREFS, host_a_name="Sam", host_b_name="Kai")

        mock_client = MagicMock()
        mock_client.models.generate_content.return_value.text = json.dumps(SAMPLE_SCRIPT)

        with patch("script.genai.Client", return_value=mock_client), \
             patch("script.fetch_podcast_preferences") as mock_fetch:
            script.generate_script(SAMPLE_ARTICLES, prefs=prefs)

        mock_fetch.assert_not_called()
        sent_config = mock_client.models.generate_content.call_args[1]["config"]
        assert "SAM:" in sent_config.system_instruction


# ---------------------------------------------------------------------------
# save_to_supabase
# ---------------------------------------------------------------------------

class TestSaveToSupabase:
    def _patch_env(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fake-key")
        monkeypatch.setenv("USER_ID", "user-001")
        # Also patch the module-level variables that were set at import time
        monkeypatch.setattr(script, "SUPABASE_URL", "https://fake.supabase.co")
        monkeypatch.setattr(script, "SUPABASE_KEY", "fake-key")
        monkeypatch.setattr(script, "USER_ID", "user-001")

    def test_returns_episode_id_on_success(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_response.json.return_value = [{"id": "ep-999"}]

        with patch("script.requests.post", return_value=mock_response):
            episode_id = script.save_to_supabase(SAMPLE_SCRIPT, SAMPLE_ARTICLES)

        assert episode_id == "ep-999"

    def test_returns_none_on_api_error(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.text = "Bad Request"

        with patch("script.requests.post", return_value=mock_response):
            episode_id = script.save_to_supabase(SAMPLE_SCRIPT, SAMPLE_ARTICLES)

        assert episode_id is None

    def test_returns_none_when_credentials_missing(self, monkeypatch):
        monkeypatch.setattr(script, "SUPABASE_URL", None)
        monkeypatch.setattr(script, "SUPABASE_KEY", None)
        monkeypatch.setattr(script, "USER_ID", None)
        result = script.save_to_supabase(SAMPLE_SCRIPT, SAMPLE_ARTICLES)
        assert result is None

    def test_payload_contains_correct_article_ids(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_response.json.return_value = [{"id": "ep-001"}]

        with patch("script.requests.post", return_value=mock_response) as mock_post:
            script.save_to_supabase(SAMPLE_SCRIPT, SAMPLE_ARTICLES)

        payload = mock_post.call_args[1]["json"]
        assert payload["related_article_ids"] == ["1", "2"]


# ---------------------------------------------------------------------------
# upload_audio_to_supabase
# ---------------------------------------------------------------------------

class TestUploadAudioToSupabase:
    def test_returns_none_when_client_not_initialized(self):
        original = script.supabase_client
        script.supabase_client = None
        result = script.upload_audio_to_supabase("episode.mp3", "ep-001")
        script.supabase_client = original
        assert result is None

    def test_uploads_file_and_returns_url(self, tmp_path):
        fake_mp3 = tmp_path / "episode.mp3"
        fake_mp3.write_bytes(b"fake audio data")

        mock_storage = MagicMock()
        mock_storage.from_.return_value.upload.return_value = None
        mock_storage.from_.return_value.get_public_url.return_value = "https://cdn.example.com/ep.mp3"

        mock_client = MagicMock()
        mock_client.storage = mock_storage

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.upload_audio_to_supabase(str(fake_mp3), "ep-001")
        script.supabase_client = original

        assert result == "https://cdn.example.com/ep.mp3"


# ---------------------------------------------------------------------------
# update_episode_audio_url
# ---------------------------------------------------------------------------

class TestUpdateEpisodeAudioUrl:
    def test_returns_false_when_client_not_initialized(self):
        original = script.supabase_client
        script.supabase_client = None
        result = script.update_episode_audio_url("ep-001", "https://cdn.example.com/ep.mp3")
        script.supabase_client = original
        assert result is False

    def test_calls_update_with_audio_url_only(self):
        """When duration and size are None, only audio_url is in the payload."""
        mock_client = MagicMock()
        mock_client.table.return_value.update.return_value.eq.return_value.execute.return_value = None

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.update_episode_audio_url("ep-001", "https://cdn.example.com/ep.mp3")
        script.supabase_client = original

        mock_client.table.assert_called_with("podcast_episodes")
        mock_client.table.return_value.update.assert_called_with(
            {"audio_url": "https://cdn.example.com/ep.mp3"}
        )
        assert result is True

    def test_includes_duration_and_size_when_provided(self):
        """When duration and size are given, all three fields appear in the payload."""
        mock_client = MagicMock()
        mock_client.table.return_value.update.return_value.eq.return_value.execute.return_value = None

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.update_episode_audio_url(
            "ep-001", "https://cdn.example.com/ep.mp3",
            duration_seconds=1234, size_bytes=5000000
        )
        script.supabase_client = original

        mock_client.table.return_value.update.assert_called_with({
            "audio_url": "https://cdn.example.com/ep.mp3",
            "duration_seconds": 1234,
            "size_bytes": 5000000,
        })
        assert result is True


# ---------------------------------------------------------------------------
# get_audio_metadata
# ---------------------------------------------------------------------------

class TestGetAudioMetadata:
    def test_returns_size_and_duration_on_success(self, tmp_path):
        fake_mp3 = tmp_path / "episode.mp3"
        fake_mp3.write_bytes(b"x" * 4096)

        mock_result = MagicMock()
        mock_result.stdout = b"123.7\n"

        with patch("script.subprocess.run", return_value=mock_result):
            duration, size = script.get_audio_metadata(str(fake_mp3))

        assert duration == 123
        assert size == 4096

    def test_returns_none_duration_when_ffprobe_fails(self, tmp_path):
        fake_mp3 = tmp_path / "episode.mp3"
        fake_mp3.write_bytes(b"x" * 2048)

        with patch("script.subprocess.run", side_effect=Exception("ffprobe not found")):
            duration, size = script.get_audio_metadata(str(fake_mp3))

        assert duration is None
        assert size == 2048
