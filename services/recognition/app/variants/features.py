# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/variants/features.py -- see THIRD_PARTY_NOTICES.md
"""Small NumPy image measurements shared by the variant detectors.

Pure functions over ``uint8`` RGB (or grayscale) arrays: no OpenCV, no models,
so the variant rules that build on them stay deterministic and easy to test with
synthetic images.
"""

from __future__ import annotations

import numpy as np


def _gray(image: np.ndarray) -> np.ndarray:
    """Return a ``float32`` grayscale image in ``[0, 1]`` from RGB or gray input."""
    arr = np.asarray(image, dtype=np.float32)
    if arr.ndim == 3:
        arr = arr.mean(axis=2)
    return arr / 255.0


def high_frequency_energy(image: np.ndarray) -> float:
    """Return mean squared local gradient — a proxy for foil sparkle/texture.

    Args:
        image: RGB or grayscale region.

    Returns:
        Mean of squared horizontal and vertical differences, in ``[0, ~1]``.
    """
    gray = _gray(image)
    if gray.shape[0] < 2 or gray.shape[1] < 2:
        return 0.0
    gx = np.diff(gray, axis=1)
    gy = np.diff(gray, axis=0)
    return float((np.mean(gx**2) + np.mean(gy**2)) / 2.0)


def dark_fraction(image: np.ndarray, threshold: float = 0.35) -> float:
    """Return the fraction of pixels darker than ``threshold`` (0-1 brightness)."""
    gray = _gray(image)
    return float(np.mean(gray < threshold))


def brightness_std(image: np.ndarray) -> float:
    """Return the standard deviation of region brightness in ``[0, 1]``.

    A drop shadow adds a darker band and raises the spread; a flat, shadowless
    region stays near zero. More robust than a single-edge gradient, which
    averages away over a wide crop.
    """
    return float(np.std(_gray(image)))


def mean_saturation(image: np.ndarray) -> float:
    """Return the mean per-pixel saturation (max-min over channels) in ``[0, 1]``."""
    arr = np.asarray(image, dtype=np.float32) / 255.0
    if arr.ndim != 3:
        return 0.0
    return float(np.mean(arr.max(axis=2) - arr.min(axis=2)))
