# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/vision/detect.py -- see THIRD_PARTY_NOTICES.md
"""Card detection: find the card's quadrilateral in a photo.

Classic contour approach (bilateral blur, auto-Canny, largest plausible convex quad).
Additions vs pokeum (RECOGNITION-DESIGN §3): a second pass on the saturation channel
when the grayscale pass finds nothing, and :func:`looks_blank` for the ``no_card`` verdict.
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

from app.core import constants
from app.vision import geometry
from app.vision.imaging import cap_long_side, to_gray, to_saturation

logger = logging.getLogger(__name__)

_MAX_CONTOURS = 10
_HULL_EPSILONS = (0.02, 0.04, 0.08)


def _edges(channel: np.ndarray) -> np.ndarray:
    blurred = cv2.bilateralFilter(channel, 9, 75, 75)
    median = float(np.median(np.asarray(blurred, dtype=np.uint8)))
    lower = int(max(0.0, constants.CANNY_MEDIAN_LO * median))
    upper = int(min(255.0, constants.CANNY_MEDIAN_HI * median))
    if upper <= lower:  # very dark / flat channel: keep Canny's thresholds ordered
        lower, upper = 20, 60
    edged = cv2.Canny(blurred, lower, upper)
    return cv2.dilate(edged, np.ones((3, 3), np.uint8), iterations=1)


def _edges_smooth(channel: np.ndarray) -> np.ndarray:
    """Heavily smoothed edge map with closing: survives grain / wood texture that fragments the card outline."""
    blurred = cv2.GaussianBlur(channel, (0, 0), 2.5)
    median = float(np.median(blurred))
    lower = int(max(0.0, 0.66 * median * 0.6))
    upper = int(min(255.0, max(lower + 10, 1.33 * median * 0.6)))
    edged = cv2.Canny(blurred, lower, upper)
    return cv2.morphologyEx(edged, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)


_EDGE_VARIANTS = (_edges, _edges_smooth)
_CARD_ASPECT = 0.716  # 63 x 88 mm


def _score_quad(quad: np.ndarray, contour_area: float, frame_area: float) -> float:
    """Card-likeness: big, aspect near 63:88, contour fills its quad (a clean rectangle)."""
    area = geometry.polygon_area(quad)
    if area <= 0:
        return 0.0
    ratio = geometry.aspect_ratio(quad)
    if ratio > 1.0:
        ratio = 1.0 / ratio
    aspect_fit = float(np.exp(-(((ratio - _CARD_ASPECT) / 0.09) ** 2)))
    fill = min(1.0, contour_area / area / 0.9)
    return min(area / frame_area, 0.9) * aspect_fit * fill


def _search(channel: np.ndarray, frame_area: float) -> tuple[np.ndarray, float] | None:
    """Best-scoring plausible quad over the edge-map variants, or ``None``."""
    best: tuple[np.ndarray, float] | None = None
    for variant in _EDGE_VARIANTS:
        contours, _ = cv2.findContours(variant(channel), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        ranked = sorted(contours, key=cv2.contourArea, reverse=True)[:_MAX_CONTOURS]
        for contour in ranked:
            quad = _quad_from_contour(contour)
            if quad is None or not geometry.is_plausible_card(quad, frame_area):
                continue
            score = _score_quad(quad, cv2.contourArea(contour), frame_area)
            if best is None or score > best[1]:
                best = (quad, score)
    return best


def detect_card_quad(image_rgb: np.ndarray) -> np.ndarray | None:
    """Detect the most card-like quadrilateral (TL, TR, BR, BL float32) or ``None``."""
    working = cap_long_side(image_rgb, constants.DETECT_MAX_SIDE)
    scale = image_rgb.shape[1] / float(working.shape[1])
    height, width = working.shape[:2]
    frame_area = float(height * width)
    best: tuple[np.ndarray, float] | None = None
    for channel in (to_gray(working), to_saturation(working)):
        found = _search(channel, frame_area)
        if found is not None and (best is None or found[1] > best[1]):
            best = found
    if best is not None:
        return geometry.order_corners(best[0] * scale)
    logger.debug("no plausible card quad (working frame %dx%d)", width, height)
    return None


def looks_blank(image_rgb: np.ndarray) -> bool:
    """True when the frame is featureless (flat colour / blank): nothing card-like at all."""
    working = cap_long_side(image_rgb, 480)
    gray = to_gray(working)
    if float(gray.std()) > constants.BLANK_GRAY_STD_MAX:
        return False
    edges = cv2.Canny(gray, 30, 90)
    return float(np.count_nonzero(edges)) / edges.size < constants.BLANK_EDGE_DENSITY_MAX


def _quad_from_contour(contour: np.ndarray) -> np.ndarray | None:
    perimeter = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
    if len(approx) == 4 and cv2.isContourConvex(approx):
        return approx.reshape(4, 2).astype(np.float32)
    hull = cv2.convexHull(contour)
    hull_perimeter = cv2.arcLength(hull, True)
    for epsilon in _HULL_EPSILONS:
        approx = cv2.approxPolyDP(hull, epsilon * hull_perimeter, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return approx.reshape(4, 2).astype(np.float32)
    return None
