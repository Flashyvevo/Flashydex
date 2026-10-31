# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/vision/geometry.py -- see THIRD_PARTY_NOTICES.md
"""Pure geometric helpers for card detection and rectification.

Kept free of OpenCV so the corner ordering, area, and plausibility maths can be
unit-tested with plain NumPy arrays. Everything here operates on a quadrilateral
given as a ``(4, 2)`` array of ``(x, y)`` points.
"""

from __future__ import annotations

import numpy as np

from app.core import constants


def order_corners(points: np.ndarray) -> np.ndarray:
    """Order four points as top-left, top-right, bottom-right, bottom-left.

    Uses the classic coordinate-sum/difference rule: the top-left has the
    smallest ``x + y`` and the bottom-right the largest, while the top-right has
    the smallest ``y - x`` and the bottom-left the largest.

    Args:
        points: A ``(4, 2)`` array of corner coordinates in any order.

    Returns:
        A ``(4, 2)`` ``float32`` array ordered TL, TR, BR, BL.
    """
    pts = np.asarray(points, dtype=np.float32).reshape(4, 2)
    total = pts.sum(axis=1)
    diff = pts[:, 1] - pts[:, 0]
    return np.array(
        [
            pts[int(np.argmin(total))],
            pts[int(np.argmin(diff))],
            pts[int(np.argmax(total))],
            pts[int(np.argmax(diff))],
        ],
        dtype=np.float32,
    )


def polygon_area(points: np.ndarray) -> float:
    """Return the absolute area of a polygon via the shoelace formula."""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    x = pts[:, 0]
    y = pts[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


def aspect_ratio(points: np.ndarray) -> float:
    """Return the width/height ratio of an ordered (or orderable) quad.

    Args:
        points: A ``(4, 2)`` quad; it is corner-ordered internally first.

    Returns:
        Mean top/bottom edge length divided by mean left/right edge length. A
        value below 1 means a portrait orientation, as expected for cards.
    """
    tl, tr, br, bl = order_corners(points)
    top = float(np.linalg.norm(tr - tl))
    bottom = float(np.linalg.norm(br - bl))
    left = float(np.linalg.norm(bl - tl))
    right = float(np.linalg.norm(br - tr))
    height = (left + right) / 2.0
    if height <= 0:
        return 0.0
    return (top + bottom) / 2.0 / height


def is_plausible_card(points: np.ndarray, frame_area: float) -> bool:
    """Return whether a quad looks like a card in a frame of ``frame_area``.

    A quad qualifies when it fills at least :data:`DETECT_MIN_AREA_FRACTION` of
    the frame and its aspect ratio lies within the portrait card band.

    Args:
        points: Candidate quad.
        frame_area: Area of the full image in pixels.

    Returns:
        ``True`` if the quad passes both the size and aspect tests.
    """
    if frame_area <= 0:
        return False
    area_fraction = polygon_area(points) / frame_area
    if area_fraction < constants.DETECT_MIN_AREA_FRACTION:
        return False
    ratio = aspect_ratio(points)
    return constants.CARD_ASPECT_MIN <= ratio <= constants.CARD_ASPECT_MAX
