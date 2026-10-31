# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/signals/base.py -- see THIRD_PARTY_NOTICES.md
"""Interfaces shared by recognition signals.

Signals turn a rectified card image into per-card scores. The heavy concrete
implementations (an ONNX encoder, an OCR engine) live in sibling modules and are
imported lazily; here we only declare the small structural interfaces the
pipeline depends on, so pure-logic code and tests can inject fakes without ever
loading a model.

The interchange image type is a NumPy ``uint8`` RGB array of shape ``(H, W, 3)``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np

# RGB image as produced by the vision layer.
ImageArray = np.ndarray


@runtime_checkable
class Embedder(Protocol):
    """Maps an RGB image to a fixed-length, L2-normalized feature vector."""

    @property
    def identifier(self) -> str:
        """Stable id of the encoder, stored so a model change forces a rebuild."""
        ...

    @property
    def dim(self) -> int:
        """Dimensionality of the produced vectors."""
        ...

    def embed(self, image: ImageArray) -> np.ndarray:
        """Return the L2-normalized ``float32`` embedding of one RGB image."""
        ...


@runtime_checkable
class OcrEngine(Protocol):
    """Reads text lines and their confidences from an RGB image region."""

    def read_text(self, image: ImageArray) -> list[tuple[str, float]]:
        """Return ``(text, confidence)`` pairs found in the image."""
        ...
