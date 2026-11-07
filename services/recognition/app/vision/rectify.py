# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/vision/rectify.py -- see THIRD_PARTY_NOTICES.md
"""Perspective rectification to the canonical card.

Warps a detected quad onto a fixed-size, front-facing rectangle so every card is
compared at the same scale and every fractional crop box lands in the same place.
When no quad was detected, a known scanner guide can be recovered from its
margin-expanded capture; other callers centre-crop the whole image instead.
"""

from __future__ import annotations

import cv2
import numpy as np

from app.core import constants
from app.vision import geometry
from app.vision.imaging import resize

_CANON_W = constants.CARD_WIDTH_PX
_CANON_H = constants.CARD_HEIGHT_PX


def rectify(image_rgb: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Warp the quad region of an image to the canonical card rectangle.

    Args:
        image_rgb: Source RGB image.
        quad: A ``(4, 2)`` quad; corner order is normalised internally.

    Returns:
        The rectified card as a ``(CARD_HEIGHT_PX, CARD_WIDTH_PX, 3)`` RGB array.
    """
    source = geometry.order_corners(quad)
    if geometry.aspect_ratio(source) > 1.0:
        # Sideways card: make the long edges the vertical ones (a 90 degree turn; whether the
        # result is upright or upside-down is settled by the pipeline's 180 degree hypothesis).
        source = np.roll(source, -1, axis=0)
    dest = np.array(
        [[0, 0], [_CANON_W - 1, 0], [_CANON_W - 1, _CANON_H - 1], [0, _CANON_H - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(source, dest)
    return cv2.warpPerspective(image_rgb, matrix, (_CANON_W, _CANON_H))


def center_crop_to_card(image_rgb: np.ndarray) -> np.ndarray:
    """Centre-crop an image to the card aspect ratio, then resize to canonical.

    Args:
        image_rgb: Source RGB image (assumed to already frame a card).

    Returns:
        A canonical-size RGB card.
    """
    height, width = image_rgb.shape[:2]
    target = _CANON_W / _CANON_H
    current = width / height
    if current > target:
        new_w = int(round(height * target))
        x0 = (width - new_w) // 2
        cropped = image_rgb[:, x0 : x0 + new_w]
    else:
        new_h = int(round(width / target))
        y0 = (height - new_h) // 2
        cropped = image_rgb[y0 : y0 + new_h, :]
    return resize(cropped, _CANON_W, _CANON_H)


def crop_guided_card(image_rgb: np.ndarray, margin: float) -> np.ndarray:
    """Recover the card guide from a capture expanded by ``margin`` on each side.

    Args:
        image_rgb: Capture centred on the on-screen card guide.
        margin: Background added around each side as a fraction of the guide size.

    Returns:
        The central guide region resized to canonical card dimensions.

    Raises:
        ValueError: When the margin is negative.
    """
    if margin < 0.0:
        raise ValueError("guide margin must be non-negative")
    height, width = image_rgb.shape[:2]
    expansion = 1.0 + 2.0 * margin
    guide_width = max(1, int(round(width / expansion)))
    guide_height = max(1, int(round(height / expansion)))
    x0 = (width - guide_width) // 2
    y0 = (height - guide_height) // 2
    cropped = image_rgb[y0 : y0 + guide_height, x0 : x0 + guide_width]
    return resize(cropped, _CANON_W, _CANON_H)


def rectify_or_whole(
    image_rgb: np.ndarray,
    quad: np.ndarray | None,
    *,
    guide_margin: float | None = None,
) -> np.ndarray:
    """Rectify a quad, recover a guide crop, or centre-crop the whole image."""
    if quad is not None:
        return rectify(image_rgb, quad)
    if guide_margin is not None:
        return crop_guided_card(image_rgb, guide_margin)
    return center_crop_to_card(image_rgb)
