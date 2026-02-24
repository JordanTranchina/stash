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
        mock_model = MagicMock()
        mock_model.generate_content.return_value.text = json.dumps(SAMPLE_SCRIPT)

        with patch("script.genai.configure"), \
             patch("script.genai.GenerativeModel", return_value=mock_model):
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result == SAMPLE_SCRIPT

    def test_strips_markdown_fences_from_response(self, monkeypatch):
        """Gemini sometimes returns ```json ... ``` — we must strip that."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        fenced = f"```json\n{json.dumps(SAMPLE_SCRIPT)}\n```"
        mock_model = MagicMock()
        mock_model.generate_content.return_value.text = fenced

        with patch("script.genai.configure"), \
             patch("script.genai.GenerativeModel", return_value=mock_model):
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result == SAMPLE_SCRIPT

    def test_returns_none_on_gemini_exception(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_model = MagicMock()
        mock_model.generate_content.side_effect = Exception("API error")

        with patch("script.genai.configure"), \
             patch("script.genai.GenerativeModel", return_value=mock_model):
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result is None


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

    def test_calls_update_with_correct_args(self):
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
