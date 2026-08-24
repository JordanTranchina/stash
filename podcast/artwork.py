import io
import requests
from PIL import Image

DOWNLOAD_TIMEOUT = 10
MAX_COLLAGE_IMAGES = 4


def download_image(url, timeout=DOWNLOAD_TIMEOUT):
    """Download an image and decode it with Pillow.

    Returns a PIL Image on success, or None on any failure (bad URL, timeout,
    non-image content, decode error) — this is best-effort enrichment, so
    callers should skip a failed image rather than fail the run.
    """
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        return Image.open(io.BytesIO(response.content)).convert("RGB")
    except Exception as e:
        print(f"Warning: could not download artwork image {url}: {e}")
        return None


def _crop_to_fill(image, width, height):
    """Center-crop and resize ``image`` to exactly ``width`` x ``height``."""
    src_ratio = image.width / image.height
    target_ratio = width / height

    if src_ratio > target_ratio:
        # Source is wider than target: crop the sides.
        new_width = int(image.height * target_ratio)
        left = (image.width - new_width) // 2
        image = image.crop((left, 0, left + new_width, image.height))
    else:
        # Source is taller than target: crop top/bottom.
        new_height = int(image.width / target_ratio)
        top = (image.height - new_height) // 2
        image = image.crop((0, top, image.width, top + new_height))

    return image.resize((width, height), Image.LANCZOS)


def build_episode_collage(image_urls, output_path, canvas_size=1400):
    """Build a square collage of article images for episode artwork.

    Downloads up to MAX_COLLAGE_IMAGES of the given URLs (skipping any that
    fail) and arranges them as an even vertical strip of center-cropped
    squares-ish cells across a ``canvas_size`` x ``canvas_size`` canvas.
    Saves a JPEG to ``output_path``.

    Returns ``output_path`` on success, or None if no image could be
    downloaded (the episode simply gets no artwork).
    """
    images = []
    for url in image_urls[:MAX_COLLAGE_IMAGES]:
        image = download_image(url)
        if image is not None:
            images.append(image)

    if not images:
        return None

    n = len(images)
    cell_width = canvas_size // n
    canvas = Image.new("RGB", (cell_width * n, canvas_size), "black")

    for i, image in enumerate(images):
        cell = _crop_to_fill(image, cell_width, canvas_size)
        canvas.paste(cell, (i * cell_width, 0))

    canvas.save(output_path, "JPEG", quality=85)
    return output_path
