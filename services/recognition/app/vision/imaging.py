# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/vision/imaging.py -- see THIRD_PARTY_NOTICES.md
"""Image loading and colour/space conversions.

A single choke point for turning files or upload bytes into the interchange
format the rest of the recognizer expects: a contiguous ``uint8`` RGB array of
shape ``(H, W, 3)``. OpenCV works in BGR, so every entry point converts here and
nothing downstream has to remember that.
"""

from __future__ import annotations

import functools
from pathlib import Path

import cv2
import numpy as np

# ISO-BMFF ``ftyp`` major brands accepted as HEIC/HEIF (iPhone photos). AVIF is deliberately not listed.
HEIC_BRANDS = (b"heic", b"heix", b"mif1", b"msf1")


@functools.cache
def heif_available() -> bool:
    """True when ``pillow-heif`` imports and its Pillow opener registers (HEIC decode works)."""
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001 - optional dependency
        return False
    return True


def load_image(path: str | Path) -> np.ndarray:
    """Load an image file as an RGB array.

    Args:
        path: Path to a readable image file.

    Returns:
        The image as ``uint8`` RGB.

    Raises:
        FileNotFoundError: When the file cannot be read or decoded.
    """
    data = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if data is None:
        raise FileNotFoundError(f"cannot read image: {path}")
    return cv2.cvtColor(data, cv2.COLOR_BGR2RGB)


def decode_bytes(data: bytes) -> np.ndarray:
    """Decode raw image bytes (e.g. an upload) as an RGB array.

    Args:
        data: Encoded image bytes (PNG, JPEG, ...).

    Returns:
        The image as ``uint8`` RGB.

    Raises:
        ValueError: When the bytes cannot be decoded as an image.
    """
    buffer = np.frombuffer(data, dtype=np.uint8)
    decoded = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if decoded is None:
        raise ValueError("cannot decode image bytes")
    return cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)


def cap_long_side(image: np.ndarray, max_side: int) -> np.ndarray:
    """Return the image resized so its longer side is at most ``max_side``.

    Recognition never benefits from more pixels than the canonical card size
    needs, while every filter and warp pays for them; capping here keeps huge
    phone photos cheap. Images already within the cap are returned unchanged.

    Args:
        image: An RGB image.
        max_side: Maximum allowed length of the longer side, in pixels.

    Returns:
        The same array when already small enough, else an area-interpolated copy.
    """
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest <= max_side:
        return image
    scale = max_side / float(longest)
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return cv2.resize(image, new_size, interpolation=cv2.INTER_AREA)


def encode_webp(image: np.ndarray, quality: int) -> bytes:
    """Encode an RGB image as lossy WebP bytes.

    Args:
        image: An RGB image.
        quality: WebP quality in ``[1, 100]``.

    Returns:
        The encoded bytes.

    Raises:
        ValueError: When the image cannot be encoded.
    """
    ok, buffer = cv2.imencode(
        ".webp",
        cv2.cvtColor(image, cv2.COLOR_RGB2BGR),
        [cv2.IMWRITE_WEBP_QUALITY, quality],
    )
    if not ok:
        raise ValueError("cannot encode image as webp")
    return buffer.tobytes()


def to_gray(image_rgb: np.ndarray) -> np.ndarray:
    """Convert an RGB image to single-channel grayscale."""
    return cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)


def resize(image: np.ndarray, width: int, height: int) -> np.ndarray:
    """Resize an image to an exact ``width`` x ``height`` using area interpolation."""
    return cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)


def decode_upload(data: bytes) -> np.ndarray:
    """Decode upload bytes honouring the EXIF orientation tag (phone photos).

    Adaptation per RECOGNITION-DESIGN §3 (not in pokeum): PIL ``exif_transpose``.

    Raises:
        ValueError: When the bytes are not a decodable image.
    """
    import io

    from PIL import Image, ImageOps

    heif_available()  # registers the HEIC opener once, if pillow-heif is installed
    try:
        with Image.open(io.BytesIO(data)) as pil:
            pil.load()
            oriented = ImageOps.exif_transpose(pil)
            return np.ascontiguousarray(np.asarray(oriented.convert("RGB"), dtype=np.uint8))
    except Exception as error:  # noqa: BLE001 - any decoder failure is "invalid image"
        raise ValueError("cannot decode image bytes") from error


def to_saturation(image_rgb: np.ndarray) -> np.ndarray:
    """Return the HSV saturation channel (used for a second detection pass)."""
    return cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)[:, :, 1]
