"""Synthetic-photo eval over the real index (stand-in until real phone photos exist).

``python -m app.cli eval --lang en --n 200``: for N random indexed cards, render a degraded
"photo" of the cached reference image (rotation, scale, glare, blur, JPEG) and identify it,
(a) normally and (b) with the true card removed from the candidate set (hard negatives:
what does the service say about a card it has never seen?). Prints a threshold sweep.
"""

from __future__ import annotations

import json
import random
import time

import cv2
import numpy as np

from app.core import constants
from app.core.config import Settings
from app.recognize.pipeline import Recognizer
from app.reference.images import image_path
from app.synth import add_glare, jpeg_bytes, on_table  # reuse the synthetic helpers


def degrade(ref_rgb: np.ndarray, rng: random.Random) -> bytes:
    ref = cv2.resize(ref_rgb, (constants.CARD_WIDTH_PX, constants.CARD_HEIGHT_PX), interpolation=cv2.INTER_CUBIC)
    photo = on_table(ref, angle=rng.uniform(-15, 15), scale=rng.uniform(0.45, 0.7), seed=rng.randrange(10**6))
    photo = add_glare(photo, rng.uniform(0.0, 0.45))
    sigma = rng.uniform(0, 1.5)
    if sigma > 0.2:
        photo = cv2.GaussianBlur(photo, (0, 0), sigma)
    photo = np.clip(photo.astype(np.float32) * rng.uniform(0.75, 1.15), 0, 255).astype(np.uint8)
    return jpeg_bytes(photo, rng.randint(55, 85))


def run(settings: Settings, lang: str, n: int, seed: int = 7) -> dict:
    rec = Recognizer.from_settings(settings)
    assert rec.index is not None
    index = rec.index
    rows = [i for i, c in enumerate(index.cards) if c.language == lang]
    rng = random.Random(seed)
    sample = rng.sample(rows, min(n, len(rows)))
    pos: list[dict] = []
    neg: list[dict] = []
    t0 = time.time()
    for row in sample:
        card = index.cards[row]
        path = image_path(settings.cache_dir, card)
        ref = cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB)
        data = degrade(ref, rng)
        for bucket, excl in ((pos, None), (neg, {row})):
            res = rec.identify_bytes(data, lang=lang, max_candidates=3) if excl is None else \
                rec.identify_array(_decode(data), lang=lang, max_candidates=3, exclude_rows=excl)
            ids = [c["cardId"] for c in res["candidates"]]
            bucket.append({"id": card.card_id, "status": res["status"], "conf": res["confidence"],
                           "top1": ids[:1] == [card.card_id], "top3": card.card_id in ids,
                           "ms": res["timingMs"].get("total", 0.0), "ocr": res.get("ocr")})
    return summarise(pos, neg, time.time() - t0)


def _decode(data: bytes) -> np.ndarray:
    from app.vision.imaging import decode_upload

    return decode_upload(data)


def summarise(pos: list[dict], neg: list[dict], elapsed: float) -> dict:
    n = len(pos)
    out: dict = {"n": n, "elapsedSec": round(elapsed, 1)}
    out["top1"] = round(sum(p["top1"] for p in pos) / n, 4)
    out["top3"] = round(sum(p["top3"] for p in pos) / n, 4)
    for name, items in (("positive", pos), ("negativeCardRemoved", neg)):
        statuses: dict[str, int] = {}
        for p in items:
            statuses[p["status"]] = statuses.get(p["status"], 0) + 1
        out[f"{name}Statuses"] = statuses
    out["matchPrecision"] = _ratio([p for p in pos if p["status"] == "match"], "top1")
    out["falseMatchRateOnRemoved"] = round(sum(p["status"] == "match" for p in neg) / n, 4)
    out["latencyMs"] = {"p50": round(float(np.percentile([p["ms"] for p in pos], 50)), 0),
                        "p95": round(float(np.percentile([p["ms"] for p in pos], 95)), 0)}
    sweep = []
    for t in (0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85):
        hit = [p for p in pos if p["conf"] >= t]
        sweep.append({"threshold": t, "coverage": round(len(hit) / n, 3),
                      "precision": round(sum(p["top1"] for p in hit) / len(hit), 4) if hit else None,
                      "falseOnRemoved": round(sum(p["conf"] >= t for p in neg) / n, 4)})
    out["thresholdSweep"] = sweep
    out["worstPositives"] = sorted(pos, key=lambda p: p["conf"])[:8]
    out["highestNegatives"] = sorted(neg, key=lambda p: -p["conf"])[:8]
    return out


def _ratio(items: list[dict], key: str) -> float | None:
    return round(sum(i[key] for i in items) / len(items), 4) if items else None


def main(lang: str = "en", n: int = 200) -> None:
    print(json.dumps(run(Settings.from_env(), lang, n), indent=1, default=str))
