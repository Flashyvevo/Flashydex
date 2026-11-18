import json, random, sys
sys.path.insert(0, ".")
import cv2, numpy as np
from app.core.config import Settings
from app.eval import t_photo1600
from app.index.store import load_index
from app.reference.images import image_path
from app.vision import detect, geometry
from app.vision.imaging import decode_upload, cap_long_side, to_gray, to_saturation
from app.core import constants

settings = Settings.from_env()
index = load_index(settings.index_dir, settings.langs)
for cid in ["swsh10-004", "xy8-92", "S12a-225", "swsh3-136"]:
    card = next(c for c in index.cards if c.card_id == cid)
    path = image_path(settings.cache_dir, card)
    ref = cv2.resize(cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB), (630, 880), interpolation=cv2.INTER_CUBIC)
    data = t_photo1600(path.read_bytes(), ref, random.Random(f"11:{cid}:photo1600"))
    img = decode_upload(data)
    working = cap_long_side(img, constants.DETECT_MAX_SIDE)
    h, w = working.shape[:2]
    fa = float(h * w)
    print(cid, working.shape)
    for chn, ch in (("gray", to_gray(working)), ("sat", to_saturation(working))):
        contours, _ = cv2.findContours(detect._edges(ch), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:4]:
            q = detect._quad_from_contour(cnt)
            if q is None:
                print("  ", chn, "area", round(cv2.contourArea(cnt) / fa, 3), "noquad")
                continue
            print("  ", chn, "area", round(cv2.contourArea(cnt) / fa, 3), "quadfrac", round(geometry.polygon_area(q) / fa, 3),
                  "ar", round(geometry.aspect_ratio(q), 3), "plaus", geometry.is_plausible_card(q, fa))
