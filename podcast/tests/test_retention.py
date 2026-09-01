"""
Tests for podcast/retention.py

All Supabase REST calls (requests) and Storage calls (the supabase-py client)
are mocked — no real network calls.
"""

import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import retention


def _patch_env(monkeypatch):
    monkeypatch.setattr(retention, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(retention, "SUPABASE_KEY", "fake-key")


def _response(status=200, json_data=None, text=""):
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = json_data if json_data is not None else []
    resp.text = text
    return resp


# ---------------------------------------------------------------------------
# storage_keys_for
# ---------------------------------------------------------------------------

class TestStorageKeysFor:
    def test_matches_script_pys_upload_naming_exactly(self):
        # script.py: upload_audio_to_supabase filename=f"episode_{episode_id}.mp3"
        #            upload_artwork_to_supabase filename=f"episode_{episode_id}_artwork.jpg"
        keys = retention.storage_keys_for("abc-123")
        assert keys == ["episode_abc-123.mp3", "episode_abc-123_artwork.jpg"]


# ---------------------------------------------------------------------------
# episodes_to_prune
# ---------------------------------------------------------------------------

class TestEpisodesToPrune:
    def test_returns_empty_when_user_has_fewer_than_keep(self, monkeypatch):
        _patch_env(monkeypatch)
        with patch("requests.get", return_value=_response(json_data=[])):
            assert retention.episodes_to_prune("user-1", keep=10) == []

    def test_uses_offset_equal_to_keep(self, monkeypatch):
        _patch_env(monkeypatch)
        with patch("requests.get", return_value=_response(json_data=[])) as mock_get:
            retention.episodes_to_prune("user-1", keep=10)
        assert mock_get.call_args.kwargs["params"]["offset"] == 10
        assert mock_get.call_args.kwargs["params"]["order"] == "created_at.desc"

    def test_non_200_raises(self, monkeypatch):
        _patch_env(monkeypatch)
        with patch("requests.get", return_value=_response(status=500, text="boom")):
            try:
                retention.episodes_to_prune("user-1", keep=10)
                assert False, "expected RuntimeError"
            except RuntimeError as e:
                assert "500" in str(e)


# ---------------------------------------------------------------------------
# prune_user — ordering and failure isolation
# ---------------------------------------------------------------------------

class TestPruneUser:
    def test_storage_delete_happens_before_row_delete(self, monkeypatch):
        """If storage delete succeeds and the row delete then fails, the next
        run re-selects the same row and re-issues an idempotent storage
        delete — self-healing. Reversed, a failed storage delete would orphan
        bytes nothing points at. This pins the ordering."""
        _patch_env(monkeypatch)
        stale = [{"id": "ep-1", "created_at": "2026-01-01T00:00:00Z"}]

        call_order = []
        mock_client = MagicMock()
        mock_client.storage.from_.return_value.remove.side_effect = (
            lambda keys: call_order.append("storage")
        )
        monkeypatch.setattr(retention, "supabase_client", mock_client)

        def fake_delete_rows(ids):
            call_order.append("rows")

        monkeypatch.setattr(retention, "delete_episode_rows", fake_delete_rows)
        monkeypatch.setattr(retention, "episodes_to_prune", lambda uid, keep: stale)

        retention.prune_user("user-1", keep=10)

        assert call_order == ["storage", "rows"]

    def test_storage_failure_prevents_the_row_delete(self, monkeypatch):
        _patch_env(monkeypatch)
        stale = [{"id": "ep-1", "created_at": "2026-01-01T00:00:00Z"}]

        mock_client = MagicMock()
        mock_client.storage.from_.return_value.remove.side_effect = Exception("storage down")
        monkeypatch.setattr(retention, "supabase_client", mock_client)

        delete_called = []
        monkeypatch.setattr(retention, "delete_episode_rows", lambda ids: delete_called.append(ids))
        monkeypatch.setattr(retention, "episodes_to_prune", lambda uid, keep: stale)

        try:
            retention.prune_user("user-1", keep=10)
            assert False, "expected RuntimeError"
        except RuntimeError:
            pass

        assert delete_called == []

    def test_returns_zero_and_writes_nothing_when_nothing_is_stale(self, monkeypatch):
        _patch_env(monkeypatch)
        mock_client = MagicMock()
        monkeypatch.setattr(retention, "supabase_client", mock_client)
        monkeypatch.setattr(retention, "episodes_to_prune", lambda uid, keep: [])

        result = retention.prune_user("user-1", keep=10)

        assert result == 0
        mock_client.storage.from_.assert_not_called()

    def test_dry_run_issues_zero_writes(self, monkeypatch):
        _patch_env(monkeypatch)
        stale = [{"id": "ep-1", "created_at": "2026-01-01T00:00:00Z"}]
        mock_client = MagicMock()
        monkeypatch.setattr(retention, "supabase_client", mock_client)
        monkeypatch.setattr(retention, "episodes_to_prune", lambda uid, keep: stale)
        delete_called = []
        monkeypatch.setattr(retention, "delete_episode_rows", lambda ids: delete_called.append(ids))

        result = retention.prune_user("user-1", keep=10, dry_run=True)

        assert result == 1
        mock_client.storage.from_.assert_not_called()
        assert delete_called == []

    def test_prunes_a_row_with_no_audio_url_since_keys_derive_from_id(self, monkeypatch):
        """A run that died mid-pipeline leaves audio_url null; the episode
        should still be prunable since storage keys are derived from the id,
        not parsed out of audio_url."""
        _patch_env(monkeypatch)
        stale = [{"id": "ep-orphan", "created_at": "2026-01-01T00:00:00Z"}]
        mock_client = MagicMock()
        monkeypatch.setattr(retention, "supabase_client", mock_client)
        monkeypatch.setattr(retention, "episodes_to_prune", lambda uid, keep: stale)
        monkeypatch.setattr(retention, "delete_episode_rows", lambda ids: None)

        result = retention.prune_user("user-1", keep=10)

        assert result == 1
        removed_keys = mock_client.storage.from_.return_value.remove.call_args[0][0]
        assert removed_keys == ["episode_ep-orphan.mp3", "episode_ep-orphan_artwork.jpg"]


# ---------------------------------------------------------------------------
# main() — per-user failure isolation
# ---------------------------------------------------------------------------

class TestMainFailureIsolation:
    def test_one_users_failure_does_not_prevent_pruning_others(self, monkeypatch, capsys):
        _patch_env(monkeypatch)
        monkeypatch.setattr(retention, "list_feed_user_ids", lambda: ["bad-user", "good-user"])

        def fake_prune(user_id, keep, dry_run=False):
            if user_id == "bad-user":
                raise RuntimeError("boom")
            return 3

        monkeypatch.setattr(retention, "prune_user", fake_prune)
        monkeypatch.setattr(sys, "argv", ["retention.py"])

        retention.main()  # must not raise

        out = capsys.readouterr().out
        assert "Pruned 3 episode(s)" in out
        assert "1 failure" in out

    def test_exits_nonzero_only_if_every_user_failed(self, monkeypatch):
        _patch_env(monkeypatch)
        monkeypatch.setattr(retention, "list_feed_user_ids", lambda: ["user-1", "user-2"])
        monkeypatch.setattr(
            retention, "prune_user",
            MagicMock(side_effect=RuntimeError("boom")),
        )
        monkeypatch.setattr(sys, "argv", ["retention.py"])

        try:
            retention.main()
            assert False, "expected SystemExit"
        except SystemExit:
            pass

    def test_dry_run_flag_is_threaded_through(self, monkeypatch):
        _patch_env(monkeypatch)
        monkeypatch.setattr(retention, "list_feed_user_ids", lambda: ["user-1"])
        seen = {}

        def fake_prune(user_id, keep, dry_run=False):
            seen["dry_run"] = dry_run
            return 0

        monkeypatch.setattr(retention, "prune_user", fake_prune)
        monkeypatch.setattr(sys, "argv", ["retention.py", "--dry-run"])

        retention.main()

        assert seen["dry_run"] is True
