# Adapted from pokeum (MIT, (c) 2026 TBLgGamin) app/recognize/pipeline.py -- see THIRD_PARTY_NOTICES.md
"""Recognition orchestration: decode -> detect/rectify -> OCR || embeddings+hashes -> fuse -> variants."""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from app.core import constants
from app.core.config import Settings
from app.index.features import prepare_card
from app.index.store import LoadedIndex, load_index
from app.models import CardRef, OcrObservation, VariantGuess
from app.recognize import fusion
from app.signals.embedding import OnnxEmbedder, cosine_scores
from app.signals.hashes import hash_similarity
from app.signals.ocr import RapidOcrEngine, read_card
from app.variants.assess import assess_variants
from app.vision import detect, rectify
from app.vision.imaging import cap_long_side, decode_upload

logger = logging.getLogger(__name__)

_VARIANT_KEYS = {"reverse_holo": "reverseHolo", "first_edition": "firstEdition", "promo_stamp": "stamp"}


class IndexNotReadyError(RuntimeError):
    """No index has been built/loaded."""


class Recognizer:
    """Stateless-per-request identification over a loaded index."""

    def __init__(self, index: LoadedIndex | None, embedder: OnnxEmbedder, ocr: RapidOcrEngine | None) -> None:
        self.index = index
        self.embedder = embedder
        self.ocr = ocr
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ocr")

    @classmethod
    def from_settings(cls, settings: Settings) -> Recognizer:
        model = settings.models_dir / constants.EMBED_MODEL_FILE
        embedder = OnnxEmbedder(model, threads=settings.ort_threads)
        index = load_index(settings.index_dir, settings.langs)
        ocr: RapidOcrEngine | None
        try:
            ocr = RapidOcrEngine()
        except Exception:  # noqa: BLE001 - OCR is a nudge, never a hard dependency
            logger.exception("OCR engine unavailable; continuing without OCR")
            ocr = None
        return cls(index, embedder, ocr)

    # -- public ---------------------------------------------------------------------------
    def identify_bytes(self, data: bytes, *, lang: str = "any", max_candidates: int = 3) -> dict:
        t0 = time.perf_counter()
        image = decode_upload(data)
        return self.identify_array(image, lang=lang, max_candidates=max_candidates,
                                   decode_ms=(time.perf_counter() - t0) * 1000)

    def identify_array(self, image: np.ndarray, *, lang: str = "any", max_candidates: int = 3,
                       decode_ms: float = 0.0, exclude_rows: set[int] | None = None) -> dict:
        if self.index is None or len(self.index) == 0:
            raise IndexNotReadyError("no recognition index loaded")
        index = self.index
        max_candidates = max(1, min(max_candidates, constants.MAX_CANDIDATES_CAP))
        timing: dict[str, float] = {"decode": decode_ms}
        t_start = time.perf_counter()

        def lap(name: str, since: float) -> float:
            now = time.perf_counter()
            timing[name] = (now - since) * 1000
            return now

        # 1. detect + rectify ---------------------------------------------------------
        t = time.perf_counter()
        image = cap_long_side(image, constants.INGEST_MAX_SIDE)
        quad = detect.detect_card_quad(image)
        t = lap("detect", t)
        if quad is None and detect.looks_blank(image):
            timing["total"] = decode_ms + (time.perf_counter() - t_start) * 1000
            return self._response(fusion.Status.NO_CARD, 0.0, [], timing, index,
                                  detection={"quadFound": False, "fallback": "none"})
        primary = rectify.rectify_or_whole(image, quad)
        # A tightly cropped card (screenshot / flat scan) has no outer edge, so the contour
        # search can lock onto an inner frame. When the quad covers well under the frame but
        # the frame itself is card-shaped, also try the whole frame and keep the better fit.
        hypotheses = [("quad" if quad is not None else "centre", primary)]
        if quad is not None and self._ambiguous_quad(image, quad):
            hypotheses.append(("whole", rectify.center_crop_to_card(image)))
        t = lap("rectify", t)

        # 2. OCR (thread, single hypothesis) || hashes + embeddings ------------------------
        mask = None if lang in ("any", "", None) else (index.lang_of_row == lang)
        if exclude_rows:  # eval only: pretend these cards are not in the catalogue
            mask = np.ones(len(index), bool) if mask is None else mask.copy()
            mask[list(exclude_rows)] = False
        ocr_future = (self._pool.submit(self._timed_ocr, primary)
                      if self.ocr is not None and len(hypotheses) == 1 else None)
        chosen_label, card, sims = "", primary, {}
        best_top = float("-inf")
        for label, candidate_card in hypotheses:
            tensors = prepare_card(candidate_card)
            t = lap("prepare", t) if label == hypotheses[0][0] else t
            emb = self.embedder.embed_tensors(np.stack([tensors.full, tensors.art]))
            hyp_sims = {
                "emb_full": fusion.rescale(cosine_scores(index.emb_full, emb[0]), constants.EMBED_COS_FLOOR),
                "emb_art": fusion.rescale(cosine_scores(index.emb_art, emb[1]), constants.EMBED_COS_FLOOR),
                "hash": fusion.rescale(hash_similarity(index.hashes, tensors.hashes),
                                       constants.HASH_SIM_FLOOR),
            }
            raw0 = fusion.fuse_raw(hyp_sims, None)
            top = float(raw0.max() if mask is None else np.where(mask, raw0, -1.0).max())
            if top > best_top:
                best_top, chosen_label, card, sims = top, label, candidate_card, hyp_sims
        t = lap("embed", t)
        timing["hypotheses"] = float(len(hypotheses))

        ocr_obs: OcrObservation | None = None
        if ocr_future is not None:
            ocr_obs, timing["ocr"] = ocr_future.result()
        elif self.ocr is not None:
            ocr_obs, timing["ocr"] = self._timed_ocr(card)
        agreement = fusion.ocr_agreement(ocr_obs, index.numbers, index.official, index.totals)

        raw = fusion.fuse_raw(sims, agreement)
        order, conf = fusion.rank(raw, mask, max_candidates)
        status = fusion.decide(conf)
        t = lap("fuse", t)

        # 3. variants on the winner only -----------------------------------------------------
        candidates: list[dict] = []
        if status is not fusion.Status.NO_MATCH:
            for position, (row, c) in enumerate(zip(order, conf, strict=True)):
                card_ref = index.cards[int(row)]
                cand = self._candidate(card_ref, float(c), int(row), sims, agreement)
                if position == 0:
                    cand["variantHints"] = self._variant_hints(assess_variants(card, card_ref))
                candidates.append(cand)
        t = lap("variants", t)
        timing["total"] = decode_ms + (time.perf_counter() - t_start) * 1000
        top_conf = float(conf[0]) if conf.size else 0.0
        return self._response(status, top_conf, candidates, timing, index, detection={
            "quadFound": quad is not None,
            "fallback": "none" if quad is not None and chosen_label == "quad" else "centre"},
            ocr=ocr_obs)

    @staticmethod
    def _ambiguous_quad(image: np.ndarray, quad: np.ndarray) -> bool:
        from app.vision import geometry

        h, w = image.shape[:2]
        frame_fraction = geometry.polygon_area(quad) / float(h * w)
        return frame_fraction < 0.9 and 0.62 <= w / h <= 0.80

    # -- helpers --------------------------------------------------------------------------
    def _timed_ocr(self, card: np.ndarray) -> tuple[OcrObservation, float]:
        t0 = time.perf_counter()
        try:
            obs = read_card(self.ocr, card)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001
            logger.exception("ocr failed")
            obs = OcrObservation()
        return obs, (time.perf_counter() - t0) * 1000

    @staticmethod
    def _candidate(card: CardRef, confidence: float, row: int, sims: dict[str, np.ndarray],
                   agreement: fusion.OcrAgreement | None) -> dict:
        embed = (constants.WEIGHT_EMBED_FULL * sims["emb_full"][row]
                 + constants.WEIGHT_EMBED_ART * sims["emb_art"][row]) / (
                     constants.WEIGHT_EMBED_FULL + constants.WEIGHT_EMBED_ART)
        return {
            "language": card.language,
            "cardId": card.card_id,
            "localId": card.local_id,
            "name": card.name,
            "setId": card.set_id,
            "setName": card.set_name,
            "imageUrl": f"{card.image_url}/low.webp" if card.image_url else None,
            "score": round(confidence, 4),
            "signals": {
                "hash": round(float(sims["hash"][row]), 4),
                "embed": round(float(embed), 4),
                "ocr": None if agreement is None else round(float(agreement.score[row]), 2),
                "symbol": None,  # stub (signals/symbol.py)
            },
            "variantHints": {},
        }

    @staticmethod
    def _variant_hints(guesses: tuple[VariantGuess, ...]) -> dict[str, float]:
        hints: dict[str, float] = {}
        for guess in guesses:
            key = _VARIANT_KEYS.get(str(guess.kind))
            if key:  # shadowless has no slot in the owner contract
                hints[key] = round(guess.confidence, 3) if guess.present else 0.0
        return hints

    @staticmethod
    def _response(status: fusion.Status, confidence: float, candidates: list[dict], timing: dict[str, float],
                  index: LoadedIndex, *, detection: dict, ocr: OcrObservation | None = None) -> dict:
        return {
            "status": str(status),
            "confidence": round(confidence, 4),
            "candidates": candidates,
            "timingMs": {k: round(v, 1) for k, v in timing.items()},
            "indexVersion": index.version,
            "detection": detection,
            "ocr": None if ocr is None else {
                "number": ocr.number, "total": ocr.number_total, "setCode": ocr.set_code,
                "confidence": round(ocr.confidence, 3)},
        }
