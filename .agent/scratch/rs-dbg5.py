import sys
sys.path.insert(0, ".")
import cv2, numpy as np
from app.core.config import Settings
from app.index.store import load_index
from app.reference.images import image_path
from app.vision import detect, geometry
from app.vision.imaging import decode_upload, cap_long_side, to_gray, to_saturation
from app.core import constants
settings = Settings.from_env()
index = load_index(settings.index_dir, settings.langs)
for cid in ["hgss2-63", "dp3-120", "ex11-76", "swsh3-136"]:
    card = next(c for c in index.cards if c.card_id == cid)
    img = decode_upload(image_path(settings.cache_dir, card).read_bytes())
    h, w = img.shape[:2]
    q = detect.detect_card_quad(img)
    print(cid, img.shape[:2], "quad", None if q is None else (round(geometry.polygon_area(q)/(h*w),3), round(geometry.aspect_ratio(q),3), q.round().astype(int).tolist()))
    working = cap_long_side(img, constants.DETECT_MAX_SIDE); fa = working.shape[0]*working.shape[1]
    for chn, ch in (("gray", to_gray(working)), ("sat", to_saturation(working))):
        for vn, var in (("canny", detect._edges), ("smooth", detect._edges_smooth)):
            cs, _ = cv2.findContours(var(ch), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for cnt in sorted(cs, key=cv2.contourArea, reverse=True)[:3]:
                qq = detect._quad_from_contour(cnt)
                if qq is None: continue
                print("   ", chn, vn, round(cv2.contourArea(cnt)/fa,3), "ar", round(geometry.aspect_ratio(qq),3), "plaus", geometry.is_plausible_card(qq, fa), "score", round(detect._score_quad(qq, cv2.contourArea(cnt), fa),3))
