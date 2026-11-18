import random, sys
sys.path.insert(0, ".")
import cv2, numpy as np
from app.core.config import Settings
from app.eval import t_photo1600, t_skew_persp
from app.index.store import load_index
from app.reference.images import image_path
from app.vision import detect, rectify, geometry
from app.vision.imaging import decode_upload, cap_long_side
settings = Settings.from_env()
index = load_index(settings.index_dir, settings.langs)
for tname, tfn, ids in (("photo1600", t_photo1600, ["SV2P-088","sv04-210","sv08-173","sv06-060","30th-059"]), ("skew", t_skew_persp, ["sm1-40","ex1-82","swshp-SWSH217","S12a-041","me03-005"])):
    for cid in ids:
        card = next(c for c in index.cards if c.card_id == cid)
        path = image_path(settings.cache_dir, card)
        ref = cv2.resize(cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB), (630, 880), interpolation=cv2.INTER_CUBIC)
        img = cap_long_side(decode_upload(tfn(path.read_bytes(), ref, random.Random(f"11:{cid}:{tname}"))), 2000)
        q = detect.detect_card_quad(img)
        h, w = img.shape[:2]
        if q is None: print(tname, cid, img.shape[:2], "NONE"); continue
        rect = rectify.rectify(img, q)
        g1 = cv2.cvtColor(rect, cv2.COLOR_RGB2GRAY).astype(np.float32); g2 = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY).astype(np.float32)
        print(tname, cid, img.shape[:2], "frac", round(geometry.polygon_area(q)/(h*w),3), "ar", round(geometry.aspect_ratio(q),3), "ncc", round(float(np.corrcoef(g1.ravel(), g2.ravel())[0,1]),3), "ref mean", round(float(g2.mean())), q.round().astype(int).tolist())
