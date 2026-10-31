"""Synthetic image helpers (unit tests + app.eval): card-like images, table scenes, glare, JPEG."""

from __future__ import annotations

import cv2
import numpy as np

CARD_W, CARD_H = 630, 880


def make_card(seed: int = 0) -> np.ndarray:
    """A card-like RGB image: coloured frame, busy art window, text strip."""
    rng = np.random.default_rng(seed)
    card = np.zeros((CARD_H, CARD_W, 3), np.uint8)
    card[:] = (220, 190, 60)  # yellow-ish border
    inner = (rng.integers(150, 255, 3)).astype(np.uint8)
    card[30:CARD_H - 30, 30:CARD_W - 30] = inner
    art = rng.integers(0, 255, (400, 540, 3), dtype=np.uint8)
    art = cv2.GaussianBlur(art, (0, 0), 6 + seed % 5)
    card[90:490, 45:585] = art
    cv2.putText(card, f"CARD {seed}", (60, 70), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (10, 10, 10), 3)
    cv2.putText(card, f"{seed % 190 + 1:03d}/193", (440, 850), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 2)
    return card


def on_table(card: np.ndarray, *, angle: float = 0.0, scale: float = 0.6, size: tuple[int, int] = (1200, 1600),
             seed: int = 1) -> np.ndarray:
    """Place a card on a dark textured table, rotated by ``angle`` degrees."""
    rng = np.random.default_rng(seed)
    h, w = size
    table = (rng.normal(45, 6, (h, w, 3))).clip(0, 255).astype(np.uint8)
    table = cv2.GaussianBlur(table, (0, 0), 2)
    small = cv2.resize(card, (int(CARD_W * scale), int(CARD_H * scale)), interpolation=cv2.INTER_AREA)
    mask = np.full(small.shape[:2], 255, np.uint8)
    cx, cy = w // 2, h // 2
    m = cv2.getRotationMatrix2D((small.shape[1] / 2, small.shape[0] / 2), angle, 1.0)
    m[0, 2] += cx - small.shape[1] / 2
    m[1, 2] += cy - small.shape[0] / 2
    warped = cv2.warpAffine(small, m, (w, h))
    wmask = cv2.warpAffine(mask, m, (w, h))
    table[wmask > 0] = warped[wmask > 0]
    return table


def add_glare(img: np.ndarray, strength: float = 0.5) -> np.ndarray:
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dist = np.abs((xx / w) * 0.8 + (yy / h) * 0.6 - 0.7)
    glare = np.clip(1.0 - dist * 4.0, 0, 1)[..., None] * 255 * strength
    return np.clip(img.astype(np.float32) + glare, 0, 255).astype(np.uint8)


def jpeg_bytes(img_rgb: np.ndarray, quality: int = 60) -> bytes:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()
