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

    def test_raises_on_gemini_exception(self, monkeypatch):
        """Real API errors (e.g. 429 quota) must surface, not be swallowed as None."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = Exception("429 RESOURCE_EXHAUSTED")

        with patch("script.genai.Client", return_value=mock_client):
            with pytest.raises(RuntimeError, match="Gemini script generation failed"):
                script.generate_script(SAMPLE_ARTICLES)

    def test_retries_on_transient_503_then_succeeds(self, monkeypatch):
        """A momentary 'high demand' 503 must not cost the day's episode."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        success_response = MagicMock()
        success_response.text = json.dumps(SAMPLE_SCRIPT)
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = [
            Exception("503 UNAVAILABLE. High demand"),
            success_response,
        ]

        with patch("script.genai.Client", return_value=mock_client), \
             patch("script.time.sleep") as mock_sleep:
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result == SAMPLE_SCRIPT
        assert mock_client.models.generate_content.call_count == 2
        mock_sleep.assert_called_once()

    def test_gives_up_after_max_retries_on_persistent_503(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = Exception("503 UNAVAILABLE. High demand")

        with patch("script.genai.Client", return_value=mock_client), \
             patch("script.time.sleep"):
            with pytest.raises(RuntimeError, match="Gemini script generation failed"):
                script.generate_script(SAMPLE_ARTICLES)

        assert mock_client.models.generate_content.call_count == script.GEMINI_MAX_RETRIES

    def test_does_not_retry_on_quota_exhaustion(self, monkeypatch):
        """429 quota errors surface immediately — a short retry can't fix them."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = Exception("429 RESOURCE_EXHAUSTED")

        with patch("script.genai.Client", return_value=mock_client), \
             patch("script.time.sleep") as mock_sleep:
            with pytest.raises(RuntimeError, match="Gemini script generation failed"):
                script.generate_script(SAMPLE_ARTICLES)

        assert mock_client.models.generate_content.call_count == 1
        mock_sleep.assert_not_called()

    def test_retries_on_malformed_json_then_succeeds(self, monkeypatch):
        """A one-off bad-JSON response from Gemini must not cost the day's episode."""
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        bad_response = MagicMock()
        bad_response.text = '[{"speaker": "Alex" "text": "missing comma"}]'
        good_response = MagicMock()
        good_response.text = json.dumps(SAMPLE_SCRIPT)
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = [bad_response, good_response]

        with patch("script.genai.Client", return_value=mock_client), \
             patch("script.time.sleep") as mock_sleep:
            result = script.generate_script(SAMPLE_ARTICLES)

        assert result == SAMPLE_SCRIPT
        assert mock_client.models.generate_content.call_count == 2
        mock_sleep.assert_called_once()

    def test_gives_up_after_max_retries_on_persistent_malformed_json(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        bad_response = MagicMock()
        bad_response.text = '[{"speaker": "Alex" "text": "still broken"}]'
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value = bad_response

        with patch("script.genai.Client", return_value=mock_client), \
             patch("script.time.sleep"):
            with pytest.raises(RuntimeError, match="Gemini script generation failed"):
                script.generate_script(SAMPLE_ARTICLES)

        assert mock_client.models.generate_content.call_count == script.GEMINI_MAX_RETRIES

    def test_uses_flash_lite_model_by_default(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value.text = json.dumps(SAMPLE_SCRIPT)

        with patch("script.genai.Client", return_value=mock_client):
            script.generate_script(SAMPLE_ARTICLES, prefs=script.DEFAULT_PODCAST_PREFS)

        assert mock_client.models.generate_content.call_args.kwargs["model"] == "gemini-2.5-flash-lite"


# ---------------------------------------------------------------------------
# main() failure handling (fail loudly, but not on empty input)
# ---------------------------------------------------------------------------

import asyncio


class TestMainFailsLoudly:
    def test_exits_cleanly_when_no_articles(self, monkeypatch):
        """No recent articles is a normal no-op, not a failure — exit 0."""
        monkeypatch.setattr(script, "fetch_recent_articles", lambda **kw: [])
        # Should complete without raising SystemExit.
        asyncio.run(script.main())

    def test_writes_reason_to_step_summary_when_no_saves(self, monkeypatch, tmp_path):
        """A quiet-day run must say *why* it produced nothing, not just go silent."""
        def fake_fetch(limit=3, stats=None):
            if stats is not None:
                stats["max_age_hours"] = 24
                stats["candidates"] = 0
                stats["skipped"] = []
            return []
        monkeypatch.setattr(script, "fetch_recent_articles", fake_fetch)

        summary_file = tmp_path / "summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))
        monkeypatch.setattr(script, "USER_ID", "test-user-id")

        asyncio.run(script.main())

        summary_text = summary_file.read_text()
        assert "test-user-id" in summary_text
        assert "No new saves in the last 24h" in summary_text

    def test_writes_skip_reasons_to_step_summary_when_all_candidates_skipped(self, monkeypatch, tmp_path):
        """Distinguish 'nothing saved' from 'saved, but unusable' in the surfaced reason."""
        def fake_fetch(limit=3, stats=None):
            if stats is not None:
                stats["max_age_hours"] = 24
                stats["candidates"] = 1
                stats["skipped"] = [("Some Article", "only 159 chars of body text (minimum 250)")]
            return []
        monkeypatch.setattr(script, "fetch_recent_articles", fake_fetch)

        summary_file = tmp_path / "summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))

        asyncio.run(script.main())

        summary_text = summary_file.read_text()
        assert "1 recent save(s) found" in summary_text
        assert "Some Article" in summary_text
        assert "only 159 chars" in summary_text

    def test_no_step_summary_write_outside_ci(self, monkeypatch):
        """GITHUB_STEP_SUMMARY is unset for local runs — must not raise."""
        monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
        monkeypatch.setattr(script, "fetch_recent_articles", lambda **kw: [])
        asyncio.run(script.main())

    def test_exits_nonzero_when_fetch_articles_raises(self, monkeypatch):
        """A real fetch failure (e.g. schema drift) must not be swallowed as 'no articles'."""
        def boom(**kw):
            raise RuntimeError("Error fetching articles: 400 - column does not exist")
        monkeypatch.setattr(script, "fetch_recent_articles", boom)

        with pytest.raises(SystemExit) as exc:
            asyncio.run(script.main())
        assert exc.value.code != 0
        assert "column does not exist" in str(exc.value.code)

    def test_exits_nonzero_when_script_generation_returns_none(self, monkeypatch):
        monkeypatch.setattr(script, "fetch_recent_articles", lambda **kw: SAMPLE_ARTICLES)
        monkeypatch.setattr(script, "fetch_podcast_preferences", lambda: script.DEFAULT_PODCAST_PREFS)
        monkeypatch.setattr(script, "generate_script", lambda *a, **kw: None)

        with pytest.raises(SystemExit) as exc:
            asyncio.run(script.main())
        assert exc.value.code != 0

    def test_exits_nonzero_when_script_generation_raises(self, monkeypatch):
        monkeypatch.setattr(script, "fetch_recent_articles", lambda **kw: SAMPLE_ARTICLES)
        monkeypatch.setattr(script, "fetch_podcast_preferences", lambda: script.DEFAULT_PODCAST_PREFS)

        def boom(*a, **kw):
            raise RuntimeError("Gemini script generation failed: 429")
        monkeypatch.setattr(script, "generate_script", boom)

        with pytest.raises(SystemExit) as exc:
            asyncio.run(script.main())
        assert exc.value.code != 0
        assert "429" in str(exc.value.code)


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


# ---------------------------------------------------------------------------
# Episode description with article links + timestamps
# ---------------------------------------------------------------------------

class TestFormatTimestamp:
    def test_under_a_minute(self):
        assert script.format_timestamp(5) == "0:05"

    def test_minutes_and_seconds(self):
        assert script.format_timestamp(83) == "1:23"

    def test_rounds_to_nearest_second(self):
        assert script.format_timestamp(83.6) == "1:24"

    def test_includes_hours_past_an_hour(self):
        assert script.format_timestamp(3725) == "1:02:05"


class TestBuildDescription:
    ARTICLES = [
        {"title": "Local-First Software", "url": "https://ex.com/a"},
        {"title": "The RSS Renaissance", "url": "https://ex.com/b"},
    ]

    def test_html_links_each_article_with_timestamp(self):
        desc = script.build_description(
            self.ARTICLES, {0: 0.0, 1: 83.0}, html=True
        )
        assert '<a href="https://ex.com/a" target="_blank" rel="noopener">Local-First Software</a> (0:00)' in desc
        assert '<a href="https://ex.com/b" target="_blank" rel="noopener">The RSS Renaissance</a> (1:23)' in desc
        assert desc.startswith("Discussing:<ul>")

    def test_html_without_timestamps_before_audio(self):
        desc = script.build_description(self.ARTICLES, html=True)
        assert '<a href="https://ex.com/a"' in desc
        assert "(" not in desc  # no timestamps yet

    def test_html_escapes_titles_and_urls(self):
        articles = [{"title": "A & B <script>", "url": 'https://ex.com/?x="y"&z'}]
        desc = script.build_description(articles, {0: 0.0}, html=True)
        assert "<script>" not in desc
        assert "A &amp; B &lt;script&gt;" in desc
        assert "&amp;z" in desc

    def test_html_falls_back_to_plain_title_without_url(self):
        articles = [{"title": "No Link Here"}]
        desc = script.build_description(articles, {0: 0.0}, html=True)
        assert "<a " not in desc
        assert "No Link Here (0:00)" in desc

    def test_plain_text_variant(self):
        desc = script.build_description(
            self.ARTICLES, {0: 0.0, 1: 83.0}, html=False
        )
        assert "<a" not in desc and "<ul>" not in desc
        assert "• Local-First Software [0:00] — https://ex.com/a" in desc
        assert "• The RSS Renaissance [1:23] — https://ex.com/b" in desc


class TestFormatDate:
    def test_formats_an_iso_timestamp(self):
        assert script.format_date("2026-02-20T10:00:00Z") == "Feb 20, 2026"

    def test_formats_an_offset_timestamp(self):
        assert script.format_date("2026-08-01T10:00:00+00:00") == "Aug 1, 2026"

    def test_formats_a_bare_date(self):
        assert script.format_date("2026-12-05") == "Dec 5, 2026"

    def test_returns_empty_for_missing_or_unparseable_values(self):
        assert script.format_date(None) == ""
        assert script.format_date("") == ""
        assert script.format_date("   ") == ""
        assert script.format_date("not a date") == ""


class TestBuildArticleDates:
    def test_includes_published_and_saved_dates(self):
        line = script.build_article_dates(
            {"published_at": "2026-02-20T10:00:00Z", "created_at": "2026-08-24T09:00:00Z"}
        )
        assert line == "Published Feb 20, 2026 · Saved Aug 24, 2026"

    def test_omits_published_when_the_source_had_no_date(self):
        line = script.build_article_dates({"created_at": "2026-08-24T09:00:00Z"})
        assert line == "Saved Aug 24, 2026"

    def test_empty_when_neither_date_is_available(self):
        assert script.build_article_dates({}) == ""


class TestDescriptionDates:
    DATED = [
        {
            "title": "Local-First Software",
            "url": "https://ex.com/a",
            "published_at": "2026-02-20T10:00:00Z",
            "created_at": "2026-08-24T09:00:00Z",
        },
    ]

    def test_html_shows_published_and_saved_dates(self):
        desc = script.build_description(self.DATED, {0: 0.0}, html=True)
        assert "<em>Published Feb 20, 2026 · Saved Aug 24, 2026</em>" in desc

    def test_plain_text_shows_published_and_saved_dates(self):
        desc = script.build_description(self.DATED, {0: 0.0}, html=False)
        assert "Published Feb 20, 2026 · Saved Aug 24, 2026" in desc
        assert "<em>" not in desc

    def test_dates_are_escaped_in_html(self):
        # A malformed stored date must never break out of the markup.
        articles = [{"title": "T", "created_at": "<script>", "published_at": None}]
        desc = script.build_description(articles, html=True)
        assert "<script>" not in desc

    def test_articles_without_dates_are_unchanged(self):
        desc = script.build_description([{"title": "T", "url": "https://ex.com/a"}], html=True)
        assert "Published" not in desc and "Saved" not in desc


class TestComputeArticleStartTimes:
    ARTICLES = [{"title": "A"}, {"title": "B"}]

    def test_maps_first_line_of_each_article(self):
        script_lines = [
            {"article_index": None},  # 1.0s intro
            {"article_index": 0},     # opens at 1.0s
            {"article_index": 0},
            {"article_index": 1},     # opens at 1+2+3 = 6.0s
        ]
        durations = [1.0, 2.0, 3.0, 4.0]
        starts = script.compute_article_start_times(script_lines, durations, self.ARTICLES)
        assert starts == {0: 1.0, 1: 6.0}

    def test_ignores_out_of_range_and_duplicates(self):
        script_lines = [
            {"article_index": 0},
            {"article_index": 5},
            {"article_index": 0},
        ]
        starts = script.compute_article_start_times(script_lines, [1.0, 1.0, 1.0], self.ARTICLES)
        assert starts == {0: 0.0}


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

    def test_generate_script_includes_length_instructions(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

        mock_client = MagicMock()
        mock_client.models.generate_content.return_value.text = json.dumps(SAMPLE_SCRIPT)

        with patch("script.genai.Client", return_value=mock_client):
            script.generate_script(SAMPLE_ARTICLES, prefs=script.DEFAULT_PODCAST_PREFS)

        sent_config = mock_client.models.generate_content.call_args[1]["config"]
        assert "EPISODE LENGTH" in sent_config.system_instruction


class TestBuildLengthInstructions:
    """The show is always TARGET_EPISODE_MINUTES long; that fixed runtime is
    divided evenly across however many articles are being discussed."""

    def test_empty_when_no_articles(self):
        assert script.build_length_instructions(0) == ""

    def test_one_article_gets_the_full_runtime(self):
        text = script.build_length_instructions(1, target_minutes=5, wpm=150)
        assert "5 minutes" in text
        # 5 min * 150 wpm * 0.9 (non-intro/outro share) == 675 words for the one article
        assert "675 words" in text

    def test_two_articles_split_the_runtime_evenly(self):
        text = script.build_length_instructions(2, target_minutes=5, wpm=150)
        assert "5 minutes" in text
        # Same total budget, halved per article.
        assert f"{round(675 / 2)} words" in text

    def test_three_articles_split_the_runtime_evenly(self):
        text = script.build_length_instructions(3, target_minutes=5, wpm=150)
        assert f"{round(675 / 3)} words" in text

    def test_total_runtime_stays_constant_regardless_of_article_count(self):
        for n in (1, 2, 3, 5, 10):
            text = script.build_length_instructions(n, target_minutes=5, wpm=150)
            assert "5 minutes" in text


# ---------------------------------------------------------------------------
# generate_episode_title
# ---------------------------------------------------------------------------

class TestGenerateEpisodeTitle:
    def test_returns_fallback_when_no_api_key(self, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        result = script.generate_episode_title(SAMPLE_ARTICLES)
        assert result == script.FALLBACK_EPISODE_TITLE

    def test_returns_fallback_when_no_articles(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        result = script.generate_episode_title([])
        assert result == script.FALLBACK_EPISODE_TITLE

    def test_returns_generated_title_on_success(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.return_value.text = '"AI Chips and the Future of Search"'

        with patch("script.genai.Client", return_value=mock_client):
            result = script.generate_episode_title(SAMPLE_ARTICLES)

        assert result == "AI Chips and the Future of Search"

    def test_returns_fallback_on_exception(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = Exception("quota exceeded")

        with patch("script.genai.Client", return_value=mock_client):
            result = script.generate_episode_title(SAMPLE_ARTICLES)

        assert result == script.FALLBACK_EPISODE_TITLE


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

    def test_payload_uses_passed_in_title(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_response.json.return_value = [{"id": "ep-001"}]

        with patch("script.requests.post", return_value=mock_response) as mock_post:
            script.save_to_supabase(SAMPLE_SCRIPT, SAMPLE_ARTICLES, title="Custom Episode Title")

        payload = mock_post.call_args[1]["json"]
        assert payload["title"] == "Custom Episode Title"

    def test_payload_falls_back_to_default_title_when_none(self, monkeypatch):
        self._patch_env(monkeypatch)
        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_response.json.return_value = [{"id": "ep-001"}]

        with patch("script.requests.post", return_value=mock_response) as mock_post:
            script.save_to_supabase(SAMPLE_SCRIPT, SAMPLE_ARTICLES)

        payload = mock_post.call_args[1]["json"]
        assert payload["title"] == script.FALLBACK_EPISODE_TITLE


# ---------------------------------------------------------------------------
# mark_articles_discussed (FIFO + dedup fix)
# ---------------------------------------------------------------------------

class TestMarkArticlesDiscussed:
    def test_returns_false_when_client_not_initialized(self):
        original = script.supabase_client
        script.supabase_client = None
        result = script.mark_articles_discussed(["1", "2"], "ep-001")
        script.supabase_client = original
        assert result is False

    def test_returns_false_when_no_article_ids(self):
        mock_client = MagicMock()
        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.mark_articles_discussed([], "ep-001")
        script.supabase_client = original

        assert result is False
        mock_client.table.assert_not_called()

    def test_updates_saves_with_episode_id_and_timestamp(self):
        mock_client = MagicMock()
        mock_client.table.return_value.update.return_value.in_.return_value.execute.return_value = None

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.mark_articles_discussed(["1", "2"], "ep-001")
        script.supabase_client = original

        assert result is True
        mock_client.table.assert_called_with("saves")
        update_call = mock_client.table.return_value.update.call_args[0][0]
        assert update_call["podcast_episode_id"] == "ep-001"
        assert "podcast_discussed_at" in update_call
        mock_client.table.return_value.update.return_value.in_.assert_called_with("id", ["1", "2"])

    def test_returns_false_on_exception(self):
        mock_client = MagicMock()
        mock_client.table.side_effect = Exception("boom")

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.mark_articles_discussed(["1"], "ep-001")
        script.supabase_client = original

        assert result is False


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
# upload_artwork_to_supabase
# ---------------------------------------------------------------------------

class TestUploadArtworkToSupabase:
    def test_returns_none_when_client_not_initialized(self):
        original = script.supabase_client
        script.supabase_client = None
        result = script.upload_artwork_to_supabase("artwork.jpg", "ep-001")
        script.supabase_client = original
        assert result is None

    def test_uploads_file_and_returns_url(self, tmp_path):
        fake_jpg = tmp_path / "artwork.jpg"
        fake_jpg.write_bytes(b"fake jpeg data")

        mock_storage = MagicMock()
        mock_storage.from_.return_value.upload.return_value = None
        mock_storage.from_.return_value.get_public_url.return_value = "https://cdn.example.com/ep_artwork.jpg"

        mock_client = MagicMock()
        mock_client.storage = mock_storage

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.upload_artwork_to_supabase(str(fake_jpg), "ep-001")
        script.supabase_client = original

        assert result == "https://cdn.example.com/ep_artwork.jpg"
        mock_storage.from_.return_value.upload.assert_called_once()
        assert mock_storage.from_.call_args_list[0][0][0] == "podcasts"


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

    def test_includes_artwork_url_when_provided(self):
        """When artwork_url is given, it appears in the update payload."""
        mock_client = MagicMock()
        mock_client.table.return_value.update.return_value.eq.return_value.execute.return_value = None

        original = script.supabase_client
        script.supabase_client = mock_client
        result = script.update_episode_audio_url(
            "ep-001", "https://cdn.example.com/ep.mp3",
            artwork_url="https://cdn.example.com/ep_artwork.jpg",
        )
        script.supabase_client = original

        mock_client.table.return_value.update.assert_called_with({
            "audio_url": "https://cdn.example.com/ep.mp3",
            "artwork_url": "https://cdn.example.com/ep_artwork.jpg",
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
