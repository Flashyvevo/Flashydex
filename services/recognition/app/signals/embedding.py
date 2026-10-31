# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/signals/embedding.py -- see THIRD_PARTY_NOTICES.md
"""Embedding signal: DINOv2-small via ONNX Runtime (CPU), CLS token, L2-normalised.

Differences from pokeum (RECOGNITION-DESIGN §3): output selection is explicit.
``onnx-community/dinov2-small`` (verified 2026-10-31) exposes only ``last_hidden_state``
``(N, 257, 384)``; the CLS embedding is ``[:, 0, :]``. A model that exposes
``pooler_output`` is used directly. The dimension is probed and asserted at load.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path

import cv2
import numpy as np

from app.core import constants

logger = logging.getLogger(__name__)

_EPS = 1e-8
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    vec = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(vec, axis=-1, keepdims=True)
    return vec / np.maximum(norm, _EPS)


class ModelMissingError(RuntimeError):
    """The ONNX embedding model is absent or failed to load."""


class OnnxEmbedder:
    """Runs an exported ONNX image encoder on CPU."""

    def __init__(self, model_path: str | Path, *, sha256: str | None = None, threads: int = 0) -> None:
        import onnxruntime as ort

        path = Path(model_path)
        if not path.is_file():
            raise ModelMissingError(f"embedding model not found: {path}")
        self._path = path
        self.name = constants.EMBED_MODEL_NAME
        self.identifier = f"onnx:dinov2-small:{(sha256 or constants.EMBED_MODEL_SHA256)[:12]}"
        opts = ort.SessionOptions()
        if threads > 0:
            opts.intra_op_num_threads = threads
        try:
            self._session = ort.InferenceSession(
                str(path), sess_options=opts, providers=["CPUExecutionProvider"]
            )
        except Exception as error:  # noqa: BLE001
            raise ModelMissingError(f"cannot load {path}: {error}") from error
        self._input_name = self._session.get_inputs()[0].name
        outputs = self._session.get_outputs()
        self.output_name, self._take_cls = self._select_output(
            [(o.name, len(o.shape)) for o in outputs]
        )
        size = constants.EMBED_INPUT_SIZE
        probe = self._run(np.zeros((1, 3, size, size), dtype=np.float32))
        self.dim = int(probe.shape[1])
        if self.dim != constants.EMBED_DIM:
            raise ModelMissingError(f"unexpected embedding dim {self.dim}")
        logger.info("embedder %s output=%s cls=%s dim=%d", self.identifier, self.output_name,
                    self._take_cls, self.dim)

    @staticmethod
    def _select_output(outputs: list[tuple[str, int]]) -> tuple[str, bool]:
        """Pick (output name, take_cls_token): pooler_output > rank-3 CLS > rank-2."""
        for name, _rank in outputs:
            if name == "pooler_output":
                return name, False
        for name, rank in outputs:
            if rank == 3:
                return name, True
        for name, rank in outputs:
            if rank == 2:
                return name, False
        raise ModelMissingError(f"no usable output among {outputs}")

    @staticmethod
    def preprocess(image: np.ndarray) -> np.ndarray:
        size = constants.EMBED_INPUT_SIZE
        resized = cv2.resize(np.asarray(image, dtype=np.uint8), (size, size),
                             interpolation=cv2.INTER_AREA)
        arr = (resized.astype(np.float32) / 255.0 - _IMAGENET_MEAN) / _IMAGENET_STD
        return np.transpose(arr, (2, 0, 1)).astype(np.float32)

    def _run(self, batch: np.ndarray) -> np.ndarray:
        out = self._session.run([self.output_name], {self._input_name: batch})[0]
        out = np.asarray(out, dtype=np.float32)
        return out[:, 0, :] if self._take_cls else out.reshape(out.shape[0], -1)

    def embed_batch(self, images: Sequence[np.ndarray]) -> np.ndarray:
        """L2-normalised ``(N, 384)`` float32 embeddings, one ORT run."""
        if not len(images):
            return np.zeros((0, self.dim), dtype=np.float32)
        batch = np.stack([self.preprocess(i) for i in images])
        return l2_normalize(self._run(batch))

    def embed_tensors(self, batch: np.ndarray) -> np.ndarray:
        return l2_normalize(self._run(batch))


def cosine_scores(matrix: np.ndarray, vector: np.ndarray) -> np.ndarray:
    """Cosine of an L2-normalised matrix (N, D) against one query vector -> (N,)."""
    if matrix.size == 0:
        return np.zeros(0, dtype=np.float32)
    return matrix @ l2_normalize(vector).astype(matrix.dtype)
