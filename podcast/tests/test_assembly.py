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
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, mock_open, call
import subprocess

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import assembly


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
