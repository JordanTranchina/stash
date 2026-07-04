"""
Tests for podcast/assembly.py

These tests validate that assemble_episode:
  - Handles empty directories gracefully
  - Builds the correct ffmpeg command with metadata
  - Returns the output path on success
  - Returns None when ffmpeg fails (CalledProcessError)
All subprocess calls are mocked so no real ffmpeg is needed.
"""

import sys
import os
import json
import shutil
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, mock_open, call
import subprocess

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import assembly

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


class TestAssembleEpisode:
    def test_returns_none_when_no_audio_files(self, tmp_path):
        """Should return None and print message when directory has no .mp3 files."""
        result = assembly.assemble_episode(str(tmp_path), str(tmp_path / "out.mp3"))
        assert result is None

    def test_calls_ffmpeg_with_correct_base_args(self, tmp_path):
        """Verifies the ffmpeg concat command is constructed correctly."""
        # Create fake mp3 files
        (tmp_path / "line_000.mp3").touch()
        (tmp_path / "line_001.mp3").touch()
        output = str(tmp_path / "output" / "episode.mp3")

        with patch("assembly.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = assembly.assemble_episode(str(tmp_path), output)

        assert result is not None
        args = mock_run.call_args[0][0]  # The command list
        assert "ffmpeg" in args
        assert "-f" in args
        assert "concat" in args
        assert "-c" in args
        assert "copy" in args

    def test_includes_metadata_in_ffmpeg_command(self, tmp_path):
        """Metadata flags should appear in the ffmpeg command when provided."""
        (tmp_path / "line_000.mp3").touch()
        output = str(tmp_path / "out.mp3")
        metadata = {"title": "Episode 1", "artist": "Listen Later", "album": "Stash"}

        with patch("assembly.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            assembly.assemble_episode(str(tmp_path), output, metadata=metadata)

        args = mock_run.call_args[0][0]
        args_str = " ".join(args)
        assert "title=Episode 1" in args_str
        assert "artist=Listen Later" in args_str
        assert "album=Stash" in args_str

    def test_returns_output_path_on_success(self, tmp_path):
        """Should return the output path as a string on success."""
        (tmp_path / "line_000.mp3").touch()
        output = str(tmp_path / "out.mp3")

        with patch("assembly.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = assembly.assemble_episode(str(tmp_path), output)

        assert result == output

    def test_returns_none_on_ffmpeg_failure(self, tmp_path):
        """Should return None if ffmpeg exits with a non-zero code."""
        (tmp_path / "line_000.mp3").touch()
        output = str(tmp_path / "out.mp3")

        with patch("assembly.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.CalledProcessError(
                returncode=1, cmd="ffmpeg", stderr=b"Error"
            )
            result = assembly.assemble_episode(str(tmp_path), output)

        assert result is None

    def test_creates_output_directory_if_missing(self, tmp_path):
        """Output parent directory should be created if it does not exist."""
        (tmp_path / "line_000.mp3").touch()
        nested_output = str(tmp_path / "nested" / "deep" / "episode.mp3")

        with patch("assembly.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            assembly.assemble_episode(str(tmp_path), nested_output)

        assert Path(nested_output).parent.exists()

    def test_chapters_add_map_chapters_flag(self, tmp_path):
        """When chapters are provided, the ffmpeg command wires the metadata input."""
        (tmp_path / "line_000.mp3").touch()
        output = str(tmp_path / "out.mp3")
        chapters = [{"startTime": 0, "title": "Intro"}]

        with patch("assembly.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            assembly.assemble_episode(str(tmp_path), output, chapters=chapters, total_duration=10)

        args = mock_run.call_args[0][0]
        assert "-map_chapters" in args
        assert "-map_metadata" in args
        # An ffmeta.txt should have been written as the second input.
        assert any("ffmeta.txt" in a for a in args)


# ---------------------------------------------------------------------------
# build_ffmetadata (#14)
# ---------------------------------------------------------------------------

class TestBuildFfmetadata:
    def test_header_and_tags(self):
        doc = assembly.build_ffmetadata(
            metadata={"title": "Ep 1", "artist": "Listen Later"}, chapters=None
        )
        assert doc.startswith(";FFMETADATA1")
        assert "title=Ep 1" in doc
        assert "artist=Listen Later" in doc

    def test_chapter_blocks_and_end_times(self):
        chapters = [
            {"startTime": 0, "title": "Intro"},
            {"startTime": 5, "title": "Article One"},
        ]
        doc = assembly.build_ffmetadata(metadata=None, chapters=chapters, total_duration=12)
        assert doc.count("[CHAPTER]") == 2
        assert "START=0" in doc
        assert "END=5000" in doc     # first chapter ends where the second starts
        assert "END=12000" in doc    # last chapter ends at total_duration
        assert "title=Intro" in doc
        assert "title=Article One" in doc

    def test_escapes_special_characters(self):
        doc = assembly.build_ffmetadata(
            metadata=None,
            chapters=[{"startTime": 0, "title": "A=B; C#D"}],
        )
        assert "title=A\\=B\\; C\\#D" in doc

    @pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg/ffprobe not installed")
    def test_real_ffmpeg_roundtrip_embeds_chapters(self, tmp_path):
        """End-to-end: assemble real clips with chapters, read them back via ffprobe."""
        for i in range(3):
            subprocess.run(
                ["ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                 "-t", "2", "-q:a", "9", str(tmp_path / f"line_{i:03d}.mp3"), "-y"],
                check=True, capture_output=True,
            )
        chapters = [
            {"startTime": 0, "title": "Intro"},
            {"startTime": 2, "title": "Article One & Two"},
            {"startTime": 4, "title": "Wrap-up"},
        ]
        out = str(tmp_path / "episode.mp3")
        result = assembly.assemble_episode(
            str(tmp_path), out, metadata={"title": "Test"}, chapters=chapters, total_duration=6
        )
        assert result == out

        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters", out],
            capture_output=True, text=True, check=True,
        )
        embedded = json.loads(probe.stdout)["chapters"]
        assert len(embedded) == 3
        assert [c["tags"]["title"] for c in embedded] == ["Intro", "Article One & Two", "Wrap-up"]
