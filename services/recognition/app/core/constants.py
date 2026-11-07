"""Tuning knobs (design decisions, not environment config).

Adapted from pokeum (MIT) app/core/constants.py -- see THIRD_PARTY_NOTICES.md.
Values marked CALIBRATED were re-fitted on this service's own eval runs
(see .agent/reports/sonnet-recog-service-report.md).
"""

from __future__ import annotations

FractionBox = tuple[float, float, float, float]

# --- Canonical card geometry -------------------------------------------------
CARD_WIDTH_PX = 630
CARD_HEIGHT_PX = 880

# --- Card detection ----------------------------------------------------------
DETECT_MIN_AREA_FRACTION = 0.05
CARD_ASPECT_MIN = 0.55
CARD_ASPECT_MAX = 0.85
INGEST_MAX_SIDE = 2000
# A detected quad covering less than this fraction of a card-shaped frame also gets the whole frame tried.
WHOLE_FRAME_TRY_BELOW = 0.985
DETECT_MAX_SIDE = 960
CANNY_MEDIAN_LO = 0.66
CANNY_MEDIAN_HI = 1.33
# "no_card": no quad AND the frame is nearly featureless (flat colour / blank).
BLANK_GRAY_STD_MAX = 10.0
BLANK_EDGE_DENSITY_MAX = 0.004

# --- Region crops (fractions of the rectified card) --------------------------
ARTWORK_BOX: FractionBox = (0.06, 0.10, 0.94, 0.56)
BOTTOM_STRIP_BOX: FractionBox = (0.0, 0.90, 1.0, 1.0)
SYMBOL_ZONE_MODERN: FractionBox = (0.55, 0.905, 0.82, 0.99)
SYMBOL_ZONE_WOTC: FractionBox = (0.80, 0.57, 0.975, 0.72)
REVERSE_HOLO_BODY_BOX: FractionBox = (0.06, 0.60, 0.94, 0.88)
FIRST_EDITION_STAMP_BOX: FractionBox = (0.05, 0.40, 0.24, 0.62)
ART_FRAME_RIGHT_BOX: FractionBox = (0.86, 0.14, 0.98, 0.52)
PROMO_STAMP_BOX: FractionBox = (0.06, 0.44, 0.36, 0.58)

# --- OCR ---------------------------------------------------------------------
OCR_DETECT_MAX_SIDE = 320
OCR_INTRA_OP_THREADS = 2
OCR_INTER_OP_THREADS = 1

# --- Hashing / embedding -----------------------------------------------------
HASH_SIZE = 16
HASH_BITS = HASH_SIZE * HASH_SIZE
HASH_VERSION = "cv2dct-v1"
HASH_KINDS = ("phash", "dhash", "phash_r", "phash_g", "phash_b")
EMBED_INPUT_SIZE = 224
EMBED_DIM = 384
EMBED_MODEL_NAME = "onnx-community/dinov2-small"
EMBED_MODEL_URL = "https://huggingface.co/onnx-community/dinov2-small/resolve/main/onnx/model.onnx"
EMBED_MODEL_FILE = "dinov2-small.onnx"
EMBED_MODEL_BYTES = 88_532_934
# SHA-256 of the file downloaded 2026-10-31 (HF repo sha 8b1f705a3a7f6f062f6bdd21986c1583d3ef105d).
EMBED_MODEL_SHA256 = "f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a"

# Raw cosine / hash-similarity are compressed (unrelated cards sit around 0.3-0.5 cosine,
# 0.5-0.6 hash sim). Score = clip((x - floor) / (1 - floor)). CALIBRATED.
EMBED_COS_FLOOR = 0.30
HASH_SIM_FLOOR = 0.60

# --- Fusion ------------------------------------------------------------------
WEIGHT_EMBED_FULL = 0.40
WEIGHT_EMBED_ART = 0.30
WEIGHT_HASH = 0.20
WEIGHT_SYMBOL = 0.10
# Hash can only raise the fused score above the embedding-only score (see fusion.fuse_raw).
HASH_BOOST_ONLY = True
OCR_BOOST = 0.5
OCR_PENALTY = 0.0  # disagreement is not evidence: OCR misreads are common at card-strip resolution (see report)
# Skip waiting for OCR when the visual fit is at least this high and no runner-up could be boosted past it.
OCR_SKIP_FIT = 0.90
# OCR below this confidence (or with no digits read) is ignored entirely: neutral, not 0.0.
OCR_MIN_CONFIDENCE = 0.0
# When the best embed+hash fit of the upright hypotheses is below this, also try the card
# turned 180 degrees (and, for landscape frames without a quad, 90/270 frame rotations).
ROTATE_RETRY_BELOW = 0.80
CONFIDENT_THRESHOLD = 0.80
CONFIDENT_MARGIN = 0.10
UNCERTAIN_THRESHOLD = 0.50
DEFAULT_MAX_CANDIDATES = 3
MAX_CANDIDATES_CAP = 5

# --- Era ---------------------------------------------------------------------
WOTC_ERA_UNTIL_YEAR = 2003
ERA_WOTC = "wotc"
ERA_MODERN = "modern"

# --- Variant heuristics ------------------------------------------------------
VARIANT_SINGLE_STILL_CONF_CAP = 0.85
REVERSE_HOLO_ENERGY_SCALE = 0.02
REVERSE_HOLO_MIN_ENERGY = 0.006
FIRST_EDITION_DARK_MIN = 0.04
FIRST_EDITION_DARK_MAX = 0.45
FIRST_EDITION_MIN_EDGE_ENERGY = 0.002
SHADOWLESS_MAX_STD = 0.06
PROMO_STAMP_MIN_SCORE = 0.35

# --- Index build -------------------------------------------------------------
IMAGE_QUALITY = "low"
IMAGE_EXTENSION = "webp"
DOWNLOAD_CONCURRENCY = 8
DOWNLOAD_RETRIES = 4
DOWNLOAD_BACKOFF_SECONDS = 1.5
HTTP_TIMEOUT_SECONDS = 25.0
EMBED_BATCH_CARDS = 16  # cards per ORT run (x2 images: full + artwork crop)

# --- API limits ---------------------------------------------------------------
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
RATE_LIMIT_PER_MIN = 30
RATE_LIMIT_PER_DAY = 300
RATE_LIMIT_GLOBAL_PER_HOUR = 600
MAX_CONCURRENT_IDENTIFY = 2
