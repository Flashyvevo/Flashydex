import json, random, sys
sys.path.insert(0, ".")
import cv2, numpy as np
from app.core.config import Settings
from app.eval import t_photo1600, _bg, _quad_for, _paste_warped
from app.index.store import load_index
from app.reference.images import image_path
from app.vision import detect, rectify
from app.vision.imaging import decode_upload, cap_long_side
from app.signals.embedding import OnnxEmbedder, cosine_scores
from app.index.features import prepare_card
from app.core import constants

settings = Settings.from_env()
index = load_index(settings.index_dir, settings.langs)
emb = OnnxEmbedder(settings.models_dir / constants.EMBED_MODEL_FILE)
ids = ["swsh10-004", "xy8-92", "swsh11-135", "base4-15", "swsh3-136", "S12a-225"]
for cid in ids:
    row = next(i for i, c in enumerate(index.cards) if c.card_id == cid)
    card = index.cards[row]
    path = image_path(settings.cache_dir, card)
    ref = cv2.resize(cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB), (630, 880), interpolation=cv2.INTER_CUBIC)
    data = t_photo1600(path.read_bytes(), ref, random.Random(f"11:{cid}:photo1600"))
    img = cap_long_side(decode_upload(data), 2000)
    quad = detect.detect_card_quad(img)
    out = {"id": cid, "img": img.shape[:2], "quad": None if quad is None else quad.round(0).tolist()}
    if quad is not None:
        rect = rectify.rectify_or_whole(img, quad)
        g1 = cv2.cvtColor(rect, cv2.COLOR_RGB2GRAY).astype(np.float32)
        g2 = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY).astype(np.float32)
        ncc = float(np.corrcoef(g1.ravel(), g2.ravel())[0, 1])
        t = prepare_card(rect)
        e = emb.embed_tensors(np.stack([t.full, t.art]))
        sc = cosine_scores(index.emb_full, e[0])
        out["ncc"] = round(ncc, 3)
        out["cos_true"] = round(float(sc[row]), 3)
        out["cos_top"] = round(float(sc.max()), 3)
        # ref direct
        t2 = prepare_card(ref)
        e2 = emb.embed_tensors(np.stack([t2.full, t2.art]))
        out["cos_ref_true"] = round(float(cosine_scores(index.emb_full, e2[0])[row]), 3)
        cv2.imwrite(f"../../.agent/scratch/rs-rect-{cid}.png", cv2.cvtColor(rect, cv2.COLOR_RGB2BGR))
    print(json.dumps(out))
