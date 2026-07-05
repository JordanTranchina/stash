"""
Tests for podcast/youtube_sync.py

Validate playlist-item mapping, pagination, deduplication, and the insert
pipeline without any real network calls (YouTube API + Supabase are mocked).
"""

import sys
import os
from unittest.mock import patch, MagicMock

# Ensure the podcast directory is on the path so we can import modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import youtube_sync


def _patch_env(monkeypatch):
    # youtube_sync reads config into module globals; set them directly so the
    # payload/dedup helpers see them (env vars alone wouldn't reach the loaded
    # module).
    monkeypatch.setattr(youtube_sync, "SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setattr(youtube_sync, "SUPABASE_KEY", "fake-key")
    monkeypatch.setattr(youtube_sync, "USER_ID", "user-001")
    monkeypatch.setattr(youtube_sync, "YOUTUBE_API_KEY", "yt-key")
    monkeypatch.setattr(youtube_sync, "PLAYLIST_ID", "PL123")


def _playlist_item(video_id="dQw4w9WgXcQ", title="A Great Talk",
                   channel="Cool Channel", description="desc"):
    return {
        "snippet": {
            "title": title,
            "description": description,
            "videoOwnerChannelTitle": channel,
            "thumbnails": {
                "default": {"url": "http://img/default.jpg"},
                "high": {"url": "http://img/high.jpg"},
                "maxres": {"url": "http://img/maxres.jpg"},
            },
            "resourceId": {"videoId": video_id},
        },
        "contentDetails": {
            "videoId": video_id,
            "videoPublishedAt": "2026-06-01T00:00:00Z",
        },
    }


# ---------------------------------------------------------------------------
# item_to_save
# ---------------------------------------------------------------------------

class TestItemToSave:
    def test_maps_all_fields(self, monkeypatch):
        _patch_env(monkeypatch)
        payload = youtube_sync.item_to_save(_playlist_item())
        assert payload["url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        assert payload["title"] == "A Great Talk"
        assert payload["site_name"] == "Cool Channel"
        assert payload["excerpt"] == "desc"
        assert payload["image_url"] == "http://img/maxres.jpg"  # highest res
        assert payload["published_at"] == "2026-06-01T00:00:00Z"
        assert payload["source"] == "youtube-sync"
        assert payload["user_id"] == "user-001"

    def test_skips_private_video(self, monkeypatch):
        _patch_env(monkeypatch)
        item = _playlist_item(title="Private video")
        assert youtube_sync.item_to_save(item) is None

    def test_skips_deleted_video(self, monkeypatch):
        _patch_env(monkeypatch)
        item = _playlist_item(title="Deleted video")
        assert youtube_sync.item_to_save(item) is None

    def test_skips_item_without_video_id(self, monkeypatch):
        _patch_env(monkeypatch)
        item = {"snippet": {"title": "x"}, "contentDetails": {}}
        assert youtube_sync.item_to_save(item) is None

    def test_channel_falls_back_to_channel_title(self, monkeypatch):
        _patch_env(monkeypatch)
        item = _playlist_item()
        del item["snippet"]["videoOwnerChannelTitle"]
        item["snippet"]["channelTitle"] = "Fallback Channel"
        assert youtube_sync.item_to_save(item)["site_name"] == "Fallback Channel"

    def test_empty_description_is_none(self, monkeypatch):
        _patch_env(monkeypatch)
        item = _playlist_item(description="")
        assert youtube_sync.item_to_save(item)["excerpt"] is None


# ---------------------------------------------------------------------------
# fetch_playlist_items (pagination)
# ---------------------------------------------------------------------------

class TestFetchPlaylistItems:
    def test_follows_pagination(self, monkeypatch):
        _patch_env(monkeypatch)
        page1 = MagicMock()
        page1.status_code = 200
        page1.json.return_value = {"items": [_playlist_item("aaaaaaaaaaa")], "nextPageToken": "TOK"}
        page2 = MagicMock()
        page2.status_code = 200
        page2.json.return_value = {"items": [_playlist_item("bbbbbbbbbbb")]}

        with patch("youtube_sync.requests.get", side_effect=[page1, page2]) as mock_get:
            items = youtube_sync.fetch_playlist_items("PL123", "yt-key")

        assert len(items) == 2
        assert mock_get.call_count == 2
        # Second call must pass the page token.
        assert mock_get.call_args_list[1].kwargs["params"]["pageToken"] == "TOK"

    def test_raises_on_api_error(self, monkeypatch):
        _patch_env(monkeypatch)
        resp = MagicMock()
        resp.status_code = 403
        resp.text = "quota exceeded"
        with patch("youtube_sync.requests.get", return_value=resp):
            try:
                youtube_sync.fetch_playlist_items("PL123", "yt-key")
                assert False, "expected RuntimeError"
            except RuntimeError as e:
                assert "403" in str(e)


# ---------------------------------------------------------------------------
# fetch_existing_urls (dedup)
# ---------------------------------------------------------------------------

class TestFetchExistingUrls:
    def test_returns_matching_urls(self, monkeypatch):
        _patch_env(monkeypatch)
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [{"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"}]
        with patch("youtube_sync.requests.get", return_value=resp):
            existing = youtube_sync.fetch_existing_urls([
                "https://www.youtube.com/watch?v=aaaaaaaaaaa",
                "https://www.youtube.com/watch?v=bbbbbbbbbbb",
            ])
        assert existing == {"https://www.youtube.com/watch?v=aaaaaaaaaaa"}

    def test_empty_input_returns_empty(self, monkeypatch):
        _patch_env(monkeypatch)
        assert youtube_sync.fetch_existing_urls([]) == set()

    def test_read_failure_is_conservative(self, monkeypatch):
        # On an unreliable read, treat all as existing so we don't create dupes.
        _patch_env(monkeypatch)
        resp = MagicMock()
        resp.status_code = 500
        resp.text = "boom"
        with patch("youtube_sync.requests.get", return_value=resp):
            existing = youtube_sync.fetch_existing_urls(["u1", "u2"])
        assert existing == {"u1", "u2"}


# ---------------------------------------------------------------------------
# sync_playlist (end to end, mocked)
# ---------------------------------------------------------------------------

class TestSyncPlaylist:
    def test_inserts_only_new_videos(self, monkeypatch):
        _patch_env(monkeypatch)
        items = [_playlist_item("aaaaaaaaaaa"), _playlist_item("bbbbbbbbbbb")]

        existing_resp = MagicMock()
        existing_resp.status_code = 200
        existing_resp.json.return_value = [
            {"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"}
        ]
        insert_resp = MagicMock()
        insert_resp.status_code = 201

        with patch("youtube_sync.fetch_playlist_items", return_value=items), \
             patch("youtube_sync.requests.get", return_value=existing_resp), \
             patch("youtube_sync.requests.post", return_value=insert_resp) as mock_post:
            count = youtube_sync.sync_playlist()

        assert count == 1
        # Exactly the one new video is inserted.
        inserted = mock_post.call_args.kwargs["json"]
        assert len(inserted) == 1
        assert inserted[0]["url"] == "https://www.youtube.com/watch?v=bbbbbbbbbbb"

    def test_deduplicates_within_playlist(self, monkeypatch):
        _patch_env(monkeypatch)
        # Same video twice in the playlist -> one insert.
        items = [_playlist_item("aaaaaaaaaaa"), _playlist_item("aaaaaaaaaaa")]
        existing_resp = MagicMock()
        existing_resp.status_code = 200
        existing_resp.json.return_value = []
        insert_resp = MagicMock()
        insert_resp.status_code = 201

        with patch("youtube_sync.fetch_playlist_items", return_value=items), \
             patch("youtube_sync.requests.get", return_value=existing_resp), \
             patch("youtube_sync.requests.post", return_value=insert_resp) as mock_post:
            count = youtube_sync.sync_playlist()

        assert count == 1
        assert len(mock_post.call_args.kwargs["json"]) == 1

    def test_no_insert_when_all_existing(self, monkeypatch):
        _patch_env(monkeypatch)
        items = [_playlist_item("aaaaaaaaaaa")]
        existing_resp = MagicMock()
        existing_resp.status_code = 200
        existing_resp.json.return_value = [
            {"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa"}
        ]
        with patch("youtube_sync.fetch_playlist_items", return_value=items), \
             patch("youtube_sync.requests.get", return_value=existing_resp), \
             patch("youtube_sync.requests.post") as mock_post:
            count = youtube_sync.sync_playlist()

        assert count == 0
        mock_post.assert_not_called()

    def test_empty_playlist(self, monkeypatch):
        _patch_env(monkeypatch)
        with patch("youtube_sync.fetch_playlist_items", return_value=[]), \
             patch("youtube_sync.requests.post") as mock_post:
            count = youtube_sync.sync_playlist()
        assert count == 0
        mock_post.assert_not_called()
