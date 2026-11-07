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


# ======================================================================================
# M2 transform eval: 7 transforms x (EN + JA) cards, offline threshold re-fit.
#
# ``python -m app.cli eval-m2 --en 300 --ja 100 --out data/logs/eval-m2.json``
# Every identify records its top-5 candidates with raw hash/embed/ocr signals, so fusion
# parameters (OCR boost/penalty, match/margin/candidates thresholds) can be re-fitted offline
# by :func:`simulate` without re-running the pipeline.
# ======================================================================================

TRANSFORMS = ("reference", "rot90", "rot180", "rot270", "skew_persp", "blur", "glare", "jpeg40", "photo1600")


def _png(img_rgb: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR))
    assert ok
    return buf.tobytes()


def _bg(h: int, w: int, rng: random.Random, textured: bool = True) -> np.ndarray:
    """Background: low-frequency colour field (+ stripes and grain when ``textured``)."""
    nrng = np.random.default_rng(rng.randrange(10**9))
    base = np.array([rng.randint(25, 200) for _ in range(3)], np.float32)
    low = cv2.resize(nrng.normal(0, 28, (6, 6, 3)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    img = base + low
    if textured:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        theta = rng.uniform(0, np.pi)
        stripes = np.sin((xx * np.cos(theta) + yy * np.sin(theta)) / rng.uniform(4, 14)) * rng.uniform(4, 12)
        grain = cv2.GaussianBlur(nrng.normal(0, 14, (h, w, 3)).astype(np.float32), (0, 0), 1.2)
        img = img + stripes[..., None] + grain
    return np.clip(img, 0, 255).astype(np.uint8)


def _paste_warped(card: np.ndarray, bg: np.ndarray, dst_quad: np.ndarray) -> np.ndarray:
    h, w = card.shape[:2]
    src = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst_quad.astype(np.float32))
    size = (bg.shape[1], bg.shape[0])
    warped = cv2.warpPerspective(card, matrix, size, flags=cv2.INTER_CUBIC)
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), matrix, size)
    # Soft drop shadow so the card edge is not a perfect step.
    shadow = cv2.GaussianBlur(np.roll(mask, (6, 6), axis=(0, 1)), (0, 0), 7).astype(np.float32) / 255.0
    out = (bg.astype(np.float32) * (1 - 0.35 * shadow[..., None])).astype(np.uint8)
    out[mask > 0] = warped[mask > 0]
    return out


def _quad_for(card_w: int, card_h: int, canvas_w: int, canvas_h: int, angle: float, jitter: float,
              rng: random.Random) -> np.ndarray:
    cx = canvas_w / 2 + rng.uniform(-0.03, 0.03) * canvas_w
    cy = canvas_h / 2 + rng.uniform(-0.03, 0.03) * canvas_h
    corners = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], np.float32) * np.array([card_w / 2, card_h / 2])
    corners += np.array([[rng.uniform(-jitter, jitter) * card_w, rng.uniform(-jitter, jitter) * card_h]
                         for _ in range(4)], np.float32)
    a = np.deg2rad(angle)
    rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]], np.float32)
    return corners @ rot.T + np.array([cx, cy], np.float32)


def t_reference(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
    return ref_bytes


def _rot(k: int):  # noqa: ANN202
    def fn(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
        return _png(np.ascontiguousarray(np.rot90(ref, k)))
    return fn


def t_skew_persp(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
    h, w = ref.shape[:2]
    cw, ch = int(w * 1.4), int(h * 1.3)
    bg = _bg(ch, cw, rng, textured=False)
    quad = _quad_for(w, h, cw, ch, rng.choice((-7.0, 7.0)), 0.035, rng)
    return _png(_paste_warped(ref, bg, quad))


def t_blur(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
    return _png(cv2.GaussianBlur(ref, (0, 0), 1.5))


def t_glare(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
    h, w = ref.shape[:2]
    mask = np.zeros((h, w), np.float32)
    center = (int(rng.uniform(0.25, 0.75) * w), int(rng.uniform(0.25, 0.75) * h))
    axes = (int(rng.uniform(0.18, 0.32) * w), int(rng.uniform(0.12, 0.25) * h))
    cv2.ellipse(mask, center, axes, rng.uniform(0, 180), 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 6)
    mask = np.clip(mask, 0, 1) * 0.5  # white ellipse, alpha 0.5
    out = ref.astype(np.float32) * (1 - mask[..., None]) + 255.0 * mask[..., None]
    return _png(np.clip(out, 0, 255).astype(np.uint8))


def t_jpeg40(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
    return jpeg_bytes(ref, 40)


def t_photo1600(ref_bytes: bytes, ref: np.ndarray, rng: random.Random) -> bytes:  # noqa: ARG001
    """What the client uploads: 1200x1600 portrait JPEG q85, card on a textured surface, slight tilt."""
    cw, ch = 1200, 1600
    bg = _bg(ch, cw, rng)
    card_w = int(cw * rng.uniform(0.62, 0.8))
    card_h = int(card_w * 880 / 630)
    card = cv2.resize(ref, (card_w, card_h), interpolation=cv2.INTER_CUBIC)
    yy, xx = np.mgrid[0:card_h, 0:card_w].astype(np.float32)  # lighting gradient across the card
    grad = 1.0 + rng.uniform(-0.15, 0.15) * (xx / card_w - 0.5) + rng.uniform(-0.15, 0.15) * (yy / card_h - 0.5)
    card = np.clip(card.astype(np.float32) * grad[..., None], 0, 255).astype(np.uint8)
    quad = _quad_for(card_w, card_h, cw, ch, rng.uniform(-6, 6), 0.012, rng)
    photo = _paste_warped(card, bg, quad)
    photo = cv2.GaussianBlur(photo, (0, 0), rng.uniform(0.5, 1.0))
    nrng = np.random.default_rng(rng.randrange(10**9))
    photo = np.clip(photo.astype(np.float32) + nrng.normal(0, 3, photo.shape), 0, 255).astype(np.uint8)
    return jpeg_bytes(photo, 85)


_TRANSFORM_FNS = {"reference": t_reference, "rot90": _rot(1), "rot180": _rot(2), "rot270": _rot(3),
                  "skew_persp": t_skew_persp, "blur": t_blur, "glare": t_glare, "jpeg40": t_jpeg40,
                  "photo1600": t_photo1600}


def _compact(res: dict, truth: str) -> dict:
    cands = []
    for c in res["candidates"]:
        sig = c["signals"]
        cands.append({"id": c["cardId"], "hash": sig["hash"], "embed": sig["embed"], "ocr": sig["ocr"],
                      "score": c["score"]})
    return {"truth": truth, "status": res["status"], "conf": res["confidence"],
            "top1": bool(cands) and cands[0]["id"] == truth,
            "cands": cands, "ocr": res.get("ocr"), "timing": res["timingMs"],
            "detection": res.get("detection")}


def run_m2(settings: Settings, n_en: int, n_ja: int, out: str, seed: int = 11,
           transforms: tuple[str, ...] = TRANSFORMS, runs_path: str | None = None) -> dict:
    """Run the transform eval (resumable via the JSONL ``runs_path``) and write the summary JSON."""
    from pathlib import Path

    rec = Recognizer.from_settings(settings)
    assert rec.index is not None
    index = rec.index
    rng = random.Random(seed)
    sample: list[tuple[str, int]] = []
    for lang, n in (("en", n_en), ("ja", n_ja)):
        rows = [i for i, c in enumerate(index.cards)
                if c.language == lang and image_path(settings.cache_dir, c).is_file()]
        sample += [(lang, r) for r in rng.sample(rows, min(n, len(rows)))]
    runs_file = Path(runs_path or str(Path(out).with_suffix(".runs.jsonl")))
    done: set[tuple[str, str]] = set()
    runs: list[dict] = []
    if runs_file.is_file():
        for line in runs_file.read_text("utf-8").splitlines():
            r = json.loads(line)
            runs.append(r)
            done.add((r["transform"], r["lang"] + ":" + r["truth"]))
    rec.identify_bytes(image_path(settings.cache_dir, index.cards[sample[0][1]]).read_bytes(), lang="en")  # warm
    t0 = time.time()
    with runs_file.open("a", encoding="utf-8") as sink:
        for k, (lang, row) in enumerate(sample):
            card = index.cards[row]
            path = image_path(settings.cache_dir, card)
            ref_bytes = path.read_bytes()
            ref = cv2.resize(cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB),
                             (constants.CARD_WIDTH_PX, constants.CARD_HEIGHT_PX), interpolation=cv2.INTER_CUBIC)
            for name in transforms:
                if (name, f"{lang}:{card.card_id}") in done:
                    continue
                trng = random.Random(f"{seed}:{card.card_id}:{name}")
                data = _TRANSFORM_FNS[name](ref_bytes, ref, trng)
                try:
                    res = rec.identify_bytes(data, lang=lang, max_candidates=5)
                    row_out = {"transform": name, "lang": lang, **_compact(res, card.card_id)}
                except Exception as error:  # noqa: BLE001
                    row_out = {"transform": name, "lang": lang, "truth": card.card_id, "status": "error",
                               "error": repr(error), "conf": 0.0, "top1": False, "cands": [], "ocr": None,
                               "timing": {}}
                runs.append(row_out)
                sink.write(json.dumps(row_out) + "\n")
                sink.flush()
            if k % 10 == 0:
                print(f"[{k + 1}/{len(sample)}] {time.time() - t0:.0f}s", flush=True)
    summary = summarise_m2(runs, current_params())
    summary["elapsedSec"] = round(time.time() - t0, 1)
    summary["seed"] = seed
    summary["indexVersion"] = index.version
    Path(out).write_text(json.dumps(summary, indent=1, default=str), "utf-8")
    return summary


def current_params() -> dict:
    return {"boost": constants.OCR_BOOST, "penalty": constants.OCR_PENALTY,
            "ocr_min_conf": constants.OCR_MIN_CONFIDENCE, "match": constants.CONFIDENT_THRESHOLD,
            "margin": constants.CONFIDENT_MARGIN, "candidates": constants.UNCERTAIN_THRESHOLD,
            "hash_boost_only": constants.HASH_BOOST_ONLY}


def simulate(run: dict, params: dict, drop_truth: bool = False) -> tuple[str, str | None, float]:
    """Re-decide one recorded run under ``params`` from its recorded top-5 candidates.

    Returns ``(status, top_id, confidence)``. ``drop_truth`` pretends the true card is not in the
    catalogue (hard negative). Mirrors fusion.fuse_raw / rank / decide.
    """
    cands = [c for c in run.get("cands", []) if not (drop_truth and c["id"] == run["truth"])]
    if run.get("status") in ("no_card", "error") or not cands:
        return ("no_card" if run.get("status") == "no_card" else "no_match", None, 0.0)
    ocr = run.get("ocr") or {}
    ocr_conf = ocr.get("confidence", 0.0) or 0.0
    use_ocr = ocr.get("number") is not None and ocr_conf >= params["ocr_min_conf"]
    wf, wa, wh = constants.WEIGHT_EMBED_FULL, constants.WEIGHT_EMBED_ART, constants.WEIGHT_HASH
    raws = []
    for c in cands:
        base = ((wf + wa) * c["embed"] + wh * c["hash"]) / (wf + wa + wh)
        if params.get("hash_boost_only"):
            base = max(base, c["embed"])
        if use_ocr and c["ocr"] is not None:
            if c["ocr"] >= 1.0:
                base *= 1 + params["boost"] * ocr_conf
            elif c["ocr"] < 0.5:
                base *= 1 - params["penalty"] * ocr_conf
        raws.append(base)
    order = sorted(range(len(cands)), key=lambda i: -raws[i])
    top_raw = raws[order[0]]
    if top_raw <= 0:
        return "no_match", None, 0.0
    quality = min(top_raw, 1.0)
    conf = [min(max(raws[i] / top_raw * quality, 0.0), 1.0) for i in order]
    runner = conf[1] if len(conf) > 1 else 0.0
    top = conf[0]
    if top >= params["match"] and top - runner >= params["margin"]:
        status = "match"
    elif top >= params["candidates"]:
        status = "candidates"
    else:
        status = "no_match"
    return status, cands[order[0]]["id"], top


def summarise_m2(runs: list[dict], params: dict) -> dict:
    """Per-transform top-1 / status rates / false-match rate under ``params`` (offline re-decision)."""
    out: dict = {"params": params, "perTransform": {}, "n": len(runs)}
    total_false = total_runs = total_match = 0
    for name in TRANSFORMS:
        rows = [r for r in runs if r["transform"] == name]
        if not rows:
            continue
        sims = [(r, *simulate(r, params)) for r in rows]
        n = len(rows)
        stat = {s: sum(1 for _, st, _, _ in sims if st == s) for s in ("match", "candidates", "no_match", "no_card")}
        false_match = sum(1 for r, st, top, _ in sims if st == "match" and top != r["truth"])
        top1 = sum(1 for r, _st, top, _ in sims if top == r["truth"])
        top3 = sum(1 for r in rows if any(c["id"] == r["truth"] for c in r["cands"][:3]))
        out["perTransform"][name] = {
            "n": n, "top1": round(top1 / n, 4), "top3": round(top3 / n, 4),
            "matchRate": round(stat["match"] / n, 4), "candidatesRate": round(stat["candidates"] / n, 4),
            "noMatchRate": round((stat["no_match"] + stat["no_card"]) / n, 4),
            "falseMatchRate": round(false_match / n, 4), "falseMatches": false_match,
            "matchPrecision": round((stat["match"] - false_match) / stat["match"], 4) if stat["match"] else None}
        total_runs += n
        total_false += false_match
        total_match += stat["match"]
    out["overall"] = {"runs": total_runs, "matches": total_match, "falseMatches": total_false,
                      "falseMatchRate": round(total_false / max(total_runs, 1), 5)}
    neg = [simulate(r, params, drop_truth=True) for r in runs if r["transform"] in ("photo1600", "reference")]
    bad = sum(1 for st, _, _ in neg if st == "match")
    out["cardRemoved"] = {"n": len(neg), "falseMatches": bad, "falseMatchRate": round(bad / max(len(neg), 1), 5)}
    photo = [r["timing"] for r in runs if r["transform"] == "photo1600" and r.get("timing")]
    lat: dict = {}
    for phase in ("decode", "detect", "rectify", "prepare", "embed", "ocr", "fuse", "variants", "total"):
        vals = [t[phase] for t in photo if phase in t]
        if vals:
            lat[phase] = {"p50": round(float(np.percentile(vals, 50)), 1),
                          "p95": round(float(np.percentile(vals, 95)), 1)}
    out["latencyMs_photo1600"] = lat
    return out
