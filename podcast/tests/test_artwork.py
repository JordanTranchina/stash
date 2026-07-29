"""
Tests for podcast/artwork.py

Covers:
  - download_image: success and failure (bad response, decode error)
  - build_episode_collage: 1/2/3/4-image layouts and the all-failed case

All network calls are mocked; small in-memory PIL images stand in for real
downloads.
"""

import io
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PIL import Image
import artwork


def _fake_image_bytes(width=200, height=100, color="red"):
    """Encode a small solid-color image as JPEG bytes."""
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


def _mock_response(content, status_ok=True):
    response = MagicMock()
    response.content = content
    if status_ok:
        response.raise_for_status.return_value = None
    else:
        response.raise_for_status.side_effect = Exception("HTTP error")
    return response


# ---------------------------------------------------------------------------
# download_image
# ---------------------------------------------------------------------------

class TestDownloadImage:
    def test_returns_image_on_success(self):
        response = _mock_response(_fake_image_bytes(200, 100))
        with patch("artwork.requests.get", return_value=response):
            image = artwork.download_image("https://example.com/a.jpg")

        assert image is not None
        assert image.size == (200, 100)

    def test_returns_none_on_http_error(self):
        response = _mock_response(b"", status_ok=False)
        with patch("artwork.requests.get", return_value=response):
            image = artwork.download_image("https://example.com/missing.jpg")

        assert image is None

    def test_returns_none_on_undecodable_content(self):
        response = _mock_response(b"not an image")
        with patch("artwork.requests.get", return_value=response):
            image = artwork.download_image("https://example.com/bad.jpg")

        assert image is None

    def test_returns_none_on_request_exception(self):
        with patch("artwork.requests.get", side_effect=Exception("timeout")):
            image = artwork.download_image("https://example.com/timeout.jpg")

        assert image is None


# ---------------------------------------------------------------------------
# build_episode_collage
# ---------------------------------------------------------------------------

class TestBuildEpisodeCollage:
    def test_returns_none_when_no_urls(self, tmp_path):
        result = artwork.build_episode_collage([], str(tmp_path / "out.jpg"))
        assert result is None

    def test_returns_none_when_all_downloads_fail(self, tmp_path):
        with patch("artwork.download_image", return_value=None):
            result = artwork.build_episode_collage(
                ["https://example.com/a.jpg", "https://example.com/b.jpg"],
                str(tmp_path / "out.jpg"),
            )
        assert result is None

    def test_builds_collage_from_single_image(self, tmp_path):
        out_path = str(tmp_path / "out.jpg")
        with patch("artwork.download_image", return_value=Image.new("RGB", (300, 200), "red")):
            result = artwork.build_episode_collage(["https://example.com/a.jpg"], out_path, canvas_size=400)

        assert result == out_path
        saved = Image.open(out_path)
        assert saved.size == (400, 400)

    def test_builds_collage_from_multiple_images(self, tmp_path):
        out_path = str(tmp_path / "out.jpg")
        urls = ["https://example.com/a.jpg", "https://example.com/b.jpg", "https://example.com/c.jpg"]
        images = [Image.new("RGB", (300, 200), c) for c in ["red", "green", "blue"]]

        with patch("artwork.download_image", side_effect=images):
            result = artwork.build_episode_collage(urls, out_path, canvas_size=300)

        assert result == out_path
        saved = Image.open(out_path)
        # 3 cells of width 300//3=100 each -> 300 wide, 300 tall canvas
        assert saved.size == (300, 300)

    def test_skips_failed_downloads_and_uses_remaining(self, tmp_path):
        out_path = str(tmp_path / "out.jpg")
        urls = ["https://example.com/a.jpg", "https://example.com/bad.jpg", "https://example.com/c.jpg"]
        results = [Image.new("RGB", (300, 200), "red"), None, Image.new("RGB", (300, 200), "blue")]

        with patch("artwork.download_image", side_effect=results):
            result = artwork.build_episode_collage(urls, out_path, canvas_size=400)

        assert result == out_path
        saved = Image.open(out_path)
        # Only 2 images succeeded -> 2 cells of width 400//2=200 -> 400 wide canvas
        assert saved.size == (400, 400)

    def test_caps_at_max_collage_images(self, tmp_path):
        out_path = str(tmp_path / "out.jpg")
        urls = [f"https://example.com/{i}.jpg" for i in range(6)]
        images = [Image.new("RGB", (300, 200), "red") for _ in range(artwork.MAX_COLLAGE_IMAGES)]

        with patch("artwork.download_image", side_effect=images) as mock_download:
            artwork.build_episode_collage(urls, out_path, canvas_size=400)

        assert mock_download.call_count == artwork.MAX_COLLAGE_IMAGES
