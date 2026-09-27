"""
Tests for custom blended episodes (#133): the user picks the saves, and the
hosts discuss them as one conversation instead of one article at a time.

Covers:
  - extract.fetch_articles_by_ids: query shape, ordering, missing/skipped saves
  - script.parse_custom_save_ids: validation of PODCAST_SAVE_IDS
  - the blended system prompt and length instructions
  - script.main in custom mode: fetch path, failure on too few usable saves,
    and not re-linking saves a daily episode already covered
All external API/network calls are mocked.
"""

import asyncio
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import extract

with patch("script.create_client", return_value=None):
    import script


ID_A = "11111111-1111-1111-1111-111111111111"
ID_B = "22222222-2222-2222-2222-222222222222"
ID_C = "33333333-3333-3333-3333-333333333333"

LONG_BODY = "This is the body content. " * 40


def _row(save_id, title, discussed_at=None, content=LONG_BODY):
    return {
        "id": save_id,
        "title": title,
        "url": f"https://example.com/{title}",
        "content": content,
        "excerpt": None,
        "site_name": "Example",
        "created_at": "2026-01-01T00:00:00Z",
        "podcast_discussed_at": discussed_at,
    }


# ---------------------------------------------------------------------------
# extract.fetch_articles_by_ids
# ---------------------------------------------------------------------------

class TestFetchArticlesByIds:
    def _response(self, rows, status=200):
        resp = MagicMock()
        resp.status_code = status
        resp.json.return_value = rows
        resp.text = "error"
        return resp

    def test_returns_empty_for_no_ids_without_querying(self):
        with patch("extract.requests.get") as get:
            assert extract.fetch_articles_by_ids([]) == []
        get.assert_not_called()

    def test_queries_by_id_and_user_with_no_recency_filter(self, monkeypatch):
        monkeypatch.setattr(extract, "USER_ID", "user-001")
        with patch("extract.requests.get", return_value=self._response([])) as get:
            extract.fetch_articles_by_ids([ID_A, ID_B])
        params = get.call_args.kwargs["params"]
        assert params["id"] == f"in.({ID_A},{ID_B})"
        assert params["user_id"] == "eq.user-001"
        # Picked saves may be old, archived or already discussed.
        assert "created_at" not in params
        assert "is_archived" not in params
        assert "podcast_discussed_at" not in params

    def test_keeps_the_requested_order(self):
        rows = [_row(ID_B, "b"), _row(ID_A, "a")]
        with patch("extract.requests.get", return_value=self._response(rows)):
            articles = extract.fetch_articles_by_ids([ID_A, ID_B])
        assert [a["id"] for a in articles] == [ID_A, ID_B]

    def test_carries_discussed_at_through(self):
        rows = [_row(ID_A, "a", discussed_at="2026-01-02T00:00:00Z")]
        with patch("extract.requests.get", return_value=self._response(rows)):
            articles = extract.fetch_articles_by_ids([ID_A])
        assert articles[0]["podcast_discussed_at"] == "2026-01-02T00:00:00Z"

    def test_reports_missing_and_skipped_saves(self):
        rows = [_row(ID_A, "a"), _row(ID_B, "stub", content="too short")]
        stats = {}
        with patch("extract.requests.get", return_value=self._response(rows)):
            articles = extract.fetch_articles_by_ids([ID_A, ID_B, ID_C], stats=stats)
        assert [a["id"] for a in articles] == [ID_A]
        assert stats["requested"] == 3
        assert stats["missing"] == [ID_C]
        assert stats["skipped"][0][0] == "stub"

    def test_raises_on_api_error(self):
        with patch("extract.requests.get", return_value=self._response([], status=500)):
            with pytest.raises(RuntimeError, match="500"):
                extract.fetch_articles_by_ids([ID_A])


# ---------------------------------------------------------------------------
# script.parse_custom_save_ids
# ---------------------------------------------------------------------------

class TestParseCustomSaveIds:
    @pytest.mark.parametrize("raw", [None, "", "  ", " , ,"])
    def test_blank_means_a_normal_daily_episode(self, raw):
        assert script.parse_custom_save_ids(raw) == []

    def test_parses_trims_lowercases_and_dedupes(self):
        raw = f" {ID_A.upper()} ,{ID_B},{ID_A}"
        assert script.parse_custom_save_ids(raw) == [ID_A, ID_B]

    def test_rejects_non_uuid(self):
        with pytest.raises(ValueError, match="not a valid save id"):
            script.parse_custom_save_ids(f"{ID_A},1),or(user_id.neq.x")

    def test_rejects_a_single_save(self):
        with pytest.raises(ValueError, match="at least"):
            script.parse_custom_save_ids(ID_A)

    def test_rejects_too_many_saves(self):
        ids = [f"{i:08d}-0000-0000-0000-000000000000" for i in range(script.MAX_CUSTOM_ARTICLES + 1)]
        with pytest.raises(ValueError, match="at most"):
            script.parse_custom_save_ids(",".join(ids))


# ---------------------------------------------------------------------------
# Blended prompt + length instructions
# ---------------------------------------------------------------------------

class TestBlendedPrompt:
    def test_daily_prompt_is_unchanged_by_default(self):
        prompt = script.build_system_prompt(script.DEFAULT_PODCAST_PREFS)
        assert prompt == script.SYSTEM_PROMPT
        assert "move through the articles in order" in prompt

    def test_blended_prompt_asks_for_one_woven_conversation(self):
        prompt = script.build_system_prompt(script.DEFAULT_PODCAST_PREFS, blended=True)
        assert "single blended discussion" in prompt
        assert "move through the articles in order" not in prompt
        assert '"article_index"' in prompt
        assert "Alex" in prompt and "Taylor" in prompt

    def test_blended_length_drops_equal_airtime(self):
        text = script.build_length_instructions(3, target_minutes=5, wpm=150, blended=True)
        assert "750 words" in text
        assert "all 3 articles" in text
        assert "per article" not in text

    def test_generate_script_uses_blended_prompt(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        client = MagicMock()
        client.models.generate_content.return_value = MagicMock(text="[]")
        articles = [
            {"title": "A", "site_name": "S", "content": "x"},
            {"title": "B", "site_name": "S", "content": "y"},
        ]
        with patch("script.genai.Client", return_value=client):
            script.generate_script(articles, prefs=script.DEFAULT_PODCAST_PREFS, blended=True)
        kwargs = client.models.generate_content.call_args.kwargs
        assert "single blended discussion" in kwargs["config"].system_instruction
        assert kwargs["contents"].startswith("Here are the articles to discuss together:")


# ---------------------------------------------------------------------------
# script.main in custom mode
# ---------------------------------------------------------------------------

class TestMainCustomEpisode:
    def test_invalid_save_ids_fail_loudly(self, monkeypatch):
        monkeypatch.setenv("PODCAST_SAVE_IDS", "not-an-id")
        with pytest.raises(SystemExit) as exc:
            asyncio.run(script.main())
        assert "PODCAST_SAVE_IDS" in str(exc.value.code)

    def test_too_few_usable_saves_fail_with_reason(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PODCAST_SAVE_IDS", f"{ID_A},{ID_B}")
        summary_file = tmp_path / "summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))

        def fake_fetch(ids, stats=None):
            stats.update({"requested": 2, "missing": [ID_B], "skipped": []})
            return [{"id": ID_A, "title": "A"}]
        monkeypatch.setattr(script, "fetch_articles_by_ids", fake_fetch)
        daily = MagicMock()
        monkeypatch.setattr(script, "fetch_recent_articles", daily)

        with pytest.raises(SystemExit) as exc:
            asyncio.run(script.main())
        assert "not found" in str(exc.value.code)
        assert "No custom episode generated" in summary_file.read_text()
        daily.assert_not_called()

    def test_blends_picked_saves_and_only_marks_undiscussed(self, monkeypatch):
        monkeypatch.setenv("PODCAST_SAVE_IDS", f"{ID_A},{ID_B}")
        articles = [
            {"id": ID_A, "title": "A", "podcast_discussed_at": None},
            {"id": ID_B, "title": "B", "podcast_discussed_at": "2026-01-02T00:00:00Z"},
        ]
        monkeypatch.setattr(script, "fetch_articles_by_ids", lambda ids, stats=None: articles)
        monkeypatch.setattr(script, "fetch_podcast_preferences", lambda: script.DEFAULT_PODCAST_PREFS)
        generate = MagicMock(return_value=[{"speaker": "Alex", "text": "hi"}])
        monkeypatch.setattr(script, "generate_script", generate)
        monkeypatch.setattr(script, "save_script_locally", lambda s: None)
        monkeypatch.setattr(script, "generate_episode_title", lambda a, prefs=None: "T")
        monkeypatch.setattr(script, "save_to_supabase", lambda *a, **kw: "ep-1")
        mark = MagicMock()
        monkeypatch.setattr(script, "mark_articles_discussed", mark)

        # Stop right after the parts under test; audio/upload are covered elsewhere.
        async def stop(*a, **kw):
            raise SystemExit("stop")
        monkeypatch.setattr(script, "generate_audio", stop)

        with pytest.raises(SystemExit, match="stop"):
            asyncio.run(script.main())

        assert generate.call_args.kwargs["blended"] is True
        mark.assert_called_once_with([ID_A], "ep-1")
