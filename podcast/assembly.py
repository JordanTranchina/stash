import os
import subprocess
from pathlib import Path
from datetime import datetime


def _escape_ffmeta(value):
    """Escape a value for an FFMETADATA file (=, ;, #, \\ and newlines)."""
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace("=", "\\=")
        .replace(";", "\\;")
        .replace("#", "\\#")
        .replace("\n", "\\\n")
    )


def build_ffmetadata(metadata=None, chapters=None, total_duration=None):
    """Build an FFMETADATA1 document string with global tags and chapters.

    Args:
        metadata (dict): title / artist / album / description tags.
        chapters (list): ordered [{"startTime": seconds, "title": str}, ...].
        total_duration (float): episode length in seconds, used as the END of
            the final chapter. Falls back to the last start + 60s if omitted.

    Returns:
        str: the FFMETADATA document.
    """
    lines = [";FFMETADATA1"]

    if metadata:
        tag_map = {
            "title": "title",
            "artist": "artist",
            "album": "album",
            "description": "comment",  # 'comment' is commonly used for description
        }
        for key, ffkey in tag_map.items():
            if metadata.get(key):
                lines.append(f"{ffkey}={_escape_ffmeta(metadata[key])}")

    for i, chapter in enumerate(chapters or []):
        start = float(chapter.get("startTime", 0))
        if i + 1 < len(chapters):
            end = float(chapters[i + 1].get("startTime", start))
        elif total_duration is not None:
            end = float(total_duration)
        else:
            end = start + 60.0
        # Guarantee END > START so ffmpeg accepts the chapter.
        if end <= start:
            end = start + 1.0
        lines.append("[CHAPTER]")
        lines.append("TIMEBASE=1/1000")
        lines.append(f"START={int(round(start * 1000))}")
        lines.append(f"END={int(round(end * 1000))}")
        lines.append(f"title={_escape_ffmeta(chapter.get('title', f'Chapter {i + 1}'))}")

    return "\n".join(lines) + "\n"


def assemble_episode(audio_dir, output_file="podcast/output/episode.mp3", metadata=None,
                     chapters=None, total_duration=None):
    """
    Assembles audio clips from a directory into a single MP3 file.

    Args:
        audio_dir (str): Directory containing .mp3 segments.
        output_file (str): Path for the final output file.
        metadata (dict): Metadata for ID3 tags (title, artist, etc.).
        chapters (list): Optional chapter markers (#14) as
            [{"startTime": seconds, "title": str}, ...]. When provided, they are
            embedded into the MP3 as ID3 chapters via an FFMETADATA file.
        total_duration (float): Optional episode length in seconds (END of the
            last chapter).

    Returns:
        str: Path to the generated file, or None if failed.
    """
    input_path = Path(audio_dir)
    output_path = Path(output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 1. List audio files
    # Assuming files are named line_000.mp3, line_001.mp3, etc.
    files = sorted([f for f in input_path.glob("*.mp3")])

    if not files:
        print(f"No audio files found in {audio_dir}")
        return None

    print(f"Found {len(files)} audio segments to assemble.")

    # 2. Create file list for ffmpeg
    list_file_path = input_path / "files.txt"
    with open(list_file_path, "w") as f:
        for file_path in files:
            # escaped_path = str(file_path.absolute()).replace("'", "'\\''")
            f.write(f"file '{file_path.absolute()}'\n")

    # 3. Build ffmpeg command
    cmd = [
        "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_file_path.absolute()),
    ]

    meta_file_path = None
    if chapters:
        # Chapters (and tags) come from an FFMETADATA input, embedded as ID3 chapters.
        meta_file_path = input_path / "ffmeta.txt"
        with open(meta_file_path, "w") as f:
            f.write(build_ffmetadata(metadata, chapters, total_duration))
        cmd.extend([
            "-i", str(meta_file_path.absolute()),
            "-map", "0",
            "-map_metadata", "1",
            "-map_chapters", "1",
            "-c", "copy",
            "-y",
        ])
    else:
        cmd.extend(["-c", "copy", "-y"])
        # Add metadata inline when there are no chapters.
        if metadata:
            if "title" in metadata:
                cmd.extend(["-metadata", f"title={metadata['title']}"])
            if "artist" in metadata:
                cmd.extend(["-metadata", f"artist={metadata['artist']}"])
            if "album" in metadata:
                cmd.extend(["-metadata", f"album={metadata['album']}"])
            if "description" in metadata:
                cmd.extend(["-metadata", f"comment={metadata['description']}"])

    cmd.append(str(output_path.absolute()))

    print(f"Running ffmpeg command: {' '.join(cmd)}")

    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        print(f"Successfully created episode: {output_file}")

        # Cleanup temp files
        list_file_path.unlink()
        if meta_file_path is not None:
            meta_file_path.unlink()

        return str(output_path)
    except subprocess.CalledProcessError as e:
        print(f"Error running ffmpeg: {e}")
        print(f"Detailed error: {e.stderr.decode()}")
        return None
    except Exception as e:
        print(f"Unexpected error during assembly: {e}")
        return None

if __name__ == "__main__":
    # Test execution
    test_metadata = {
        "title": f"Listen Later Test - {datetime.now().strftime('%Y-%m-%d')}",
        "artist": "Listen Later AI",
        "album": "Stash Podcast",
        "description": "A test episode generated by the assembly script."
    }
    assemble_episode("podcast/temp_audio", "podcast/output/test_episode.mp3", test_metadata)
