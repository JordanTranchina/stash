"""
Tests for podcast/discover.py

discover.py is stdlib-only (urllib, not requests), so these tests mock
urllib.request.urlopen directly rather than the `requests` library used
elsewhere in podcast/.
"""

import io
import json
import os
import sys
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import discover


def _patch_env(monkeypatch):
    monkeypatch.setattr(discover, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(discover, "SUPABASE_KEY", "fake-key")


def _mock_response(payload, status=200):
    """A context-manager mock standing in for urllib's urlopen() response."""
    response = MagicMock()
    response.status = status
    response.read.return_value = json.dumps(payload).encode()
    response.__enter__ = MagicMock(return_value=response)
    response.__exit__ = MagicMock(return_value=False)
    return response


# ---------------------------------------------------------------------------
# fetch_subscribed_user_ids
# ---------------------------------------------------------------------------

class TestFetchSubscribedUserIds:
    def test_returns_user_ids_from_response(self, monkeypatch):
        _patch_env(monkeypatch)
        rows = [{"user_id": "user-1"}, {"user_id": "user-2"}]
        with patch("urllib.request.urlopen", return_value=_mock_response(rows)):
            result = discover.fetch_subscribed_user_ids(25)
        assert result == ["user-1", "user-2"]

    def test_empty_result_returns_empty_list_without_raising(self, monkeypatch):
        _patch_env(monkeypatch)
        with patch("urllib.request.urlopen", return_value=_mock_response([])):
            result = discover.fetch_subscribed_user_ids(25)
        assert result == []

    def test_query_filters_on_subscribed_and_orders_oldest_first(self, monkeypatch):
        _patch_env(monkeypatch)
        captured = {}

        def fake_urlopen(request, timeout=30):
            captured["url"] = request.full_url
            return _mock_response([])

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            discover.fetch_subscribed_user_ids(25)

        assert "subscribed=eq.true" in captured["url"]
        assert "order=created_at.asc" in captured["url"]
        assert "limit=25" in captured["url"]

    def test_non_200_raises_rather_than_returning_empty(self, monkeypatch):
        """A broken query must not read as 'nobody is subscribed' — that
        would silently drop every subscriber's episode behind a green run."""
        _patch_env(monkeypatch)
        import urllib.error

        def fake_urlopen(request, timeout=30):
            raise urllib.error.HTTPError(
                request.full_url, 500, "Internal Server Error", {}, io.BytesIO(b"boom")
            )

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            try:
                discover.fetch_subscribed_user_ids(25)
                assert False, "expected RuntimeError"
            except RuntimeError as e:
                assert "Could not list subscribed users" in str(e)


# ---------------------------------------------------------------------------
# main() — stdout contract ($GITHUB_OUTPUT)
# ---------------------------------------------------------------------------

class TestMainOutputContract:
    def test_prints_exactly_two_compact_lines(self, monkeypatch, capsys):
        """Output is appended straight to $GITHUB_OUTPUT; an embedded newline
        or extra line would corrupt that file, so this pins the exact shape."""
        _patch_env(monkeypatch)
        monkeypatch.setenv("PODCAST_MAX_USERS", "25")
        monkeypatch.delenv("PODCAST_ONLY_USER", raising=False)
        rows = [{"user_id": "6c7a3a96-16cd-4702-ac7b-0c7a4a81346d"}]

        with patch("urllib.request.urlopen", return_value=_mock_response(rows)):
            discover.main()

        out_lines = capsys.readouterr().out.strip().split("\n")
        assert len(out_lines) == 2
        assert out_lines[0].startswith("users=")
        assert out_lines[1] == "count=1"

        users = json.loads(out_lines[0][len("users="):])
        assert users == [{"user_id": "6c7a3a96-16cd-4702-ac7b-0c7a4a81346d", "label": "6c7a3a96"}]
        # Compact JSON — no embedded newline that could split across
        # $GITHUB_OUTPUT lines.
        assert "\n" not in out_lines[0]

    def test_zero_subscribers_is_not_an_error(self, monkeypatch, capsys):
        _patch_env(monkeypatch)
        monkeypatch.delenv("PODCAST_ONLY_USER", raising=False)
        with patch("urllib.request.urlopen", return_value=_mock_response([])):
            discover.main()  # must not raise / exit
        out = capsys.readouterr().out
        assert "users=[]" in out
        assert "count=0" in out

    def test_podcast_max_users_becomes_the_query_limit(self, monkeypatch, capsys):
        _patch_env(monkeypatch)
        monkeypatch.setenv("PODCAST_MAX_USERS", "3")
        monkeypatch.delenv("PODCAST_ONLY_USER", raising=False)
        captured = {}

        def fake_urlopen(request, timeout=30):
            captured["url"] = request.full_url
            return _mock_response([])

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            discover.main()

        assert "limit=3" in captured["url"]

    def test_truncation_warns_on_stderr(self, monkeypatch, capsys):
        _patch_env(monkeypatch)
        monkeypatch.setenv("PODCAST_MAX_USERS", "2")
        monkeypatch.delenv("PODCAST_ONLY_USER", raising=False)
        rows = [{"user_id": "a"}, {"user_id": "b"}]  # hits the cap exactly

        with patch("urllib.request.urlopen", return_value=_mock_response(rows)):
            discover.main()

        assert "cap" in capsys.readouterr().err.lower()

    def test_podcast_only_user_short_circuits_the_query(self, monkeypatch, capsys):
        _patch_env(monkeypatch)
        monkeypatch.setenv("PODCAST_ONLY_USER", "solo-user")

        with patch("urllib.request.urlopen") as mock_urlopen:
            discover.main()
            mock_urlopen.assert_not_called()

        out = capsys.readouterr().out
        assert '"user_id":"solo-user"' in out
        assert "count=1" in out

    def test_refuses_more_than_githubs_matrix_limit(self, monkeypatch):
        _patch_env(monkeypatch)
        monkeypatch.delenv("PODCAST_ONLY_USER", raising=False)
        too_many = [{"user_id": f"user-{i}"} for i in range(300)]

        with patch("urllib.request.urlopen", return_value=_mock_response(too_many)):
            with patch.object(discover, "fetch_subscribed_user_ids", return_value=[r["user_id"] for r in too_many]):
                try:
                    discover.main()
                    assert False, "expected SystemExit"
                except SystemExit as e:
                    assert "256" in str(e)

    def test_missing_credentials_exits_loudly(self, monkeypatch):
        monkeypatch.setattr(discover, "SUPABASE_URL", None)
        monkeypatch.setattr(discover, "SUPABASE_KEY", None)
        try:
            discover.main()
            assert False, "expected SystemExit"
        except SystemExit as e:
            assert "SUPABASE_URL" in str(e)
