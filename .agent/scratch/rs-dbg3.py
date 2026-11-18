import random, sys, time
sys.path.insert(0, ".")
import cv2, numpy as np
from app.core.config import Settings
from app.eval import t_photo1600, t_skew_persp
from app.index.store import load_index
from app.reference.images import image_path
from app.vision import detect, rectify
from app.vision.imaging import decode_upload, cap_long_side

settings = Settings.from_env()
index = load_index(settings.index_dir, settings.langs)
rng = random.Random(5)
rows = [i for i, c in enumerate(index.cards) if image_path(settings.cache_dir, c).is_file()]
sample = rng.sample(rows, int(sys.argv[1]) if len(sys.argv) > 1 else 40)
for tname, tfn in (("photo1600", t_photo1600), ("skew", t_skew_persp)):
    good = 0
    t0 = time.time()
    bad = []
    for row in sample:
        card = index.cards[row]
        path = image_path(settings.cache_dir, card)
        ref = cv2.resize(cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB), (630, 880), interpolation=cv2.INTER_CUBIC)
        data = tfn(path.read_bytes(), ref, random.Random(f"11:{card.card_id}:{tname}"))
        img = cap_long_side(decode_upload(data), 2000)
        quad = detect.detect_card_quad(img)
        ok = False
        if quad is not None:
            rect = rectify.rectify(img, quad)
            g1 = cv2.cvtColor(rect, cv2.COLOR_RGB2GRAY).astype(np.float32)
            g2 = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY).astype(np.float32)
            ok = float(np.corrcoef(g1.ravel(), g2.ravel())[0, 1]) > 0.8
        good += ok
        if not ok:
            bad.append(card.card_id)
    print(tname, "good", good, "/", len(sample), f"{(time.time() - t0) / len(sample) * 1000:.0f} ms/img(detect+gen)", bad[:8])
