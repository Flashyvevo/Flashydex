import re,pathlib
p=pathlib.Path('app/recognize/fusion.py'); s=p.read_text()
s=s.replace('''    if ocr is None or not ocr.is_useful or ocr.confidence <= 0:
        return None''','''    if ocr is None or not ocr.is_useful or ocr.confidence < constants.OCR_MIN_CONFIDENCE:
        return None  # nothing (trustworthy) read -> neutral: no boost, no penalty, no 0.0 signal''')
p.write_text(s)
g=pathlib.Path('app/vision/geometry.py'); t=g.read_text()
t=t.replace('''    ratio = aspect_ratio(points)
    return constants.CARD_ASPECT_MIN <= ratio <= constants.CARD_ASPECT_MAX''','''    ratio = aspect_ratio(points)
    if ratio > 1.0:  # card lying sideways in the photo; rectify() turns it upright
        ratio = 1.0 / ratio
    return constants.CARD_ASPECT_MIN <= ratio <= constants.CARD_ASPECT_MAX''')
g.write_text(t)
r=pathlib.Path('app/vision/rectify.py'); t=r.read_text()
t=t.replace('''    source = geometry.order_corners(quad)
    dest''','''    source = geometry.order_corners(quad)
    if geometry.aspect_ratio(source) > 1.0:
        # Sideways card: make the long edges the vertical ones (a 90 degree turn; whether the
        # result is upright or upside-down is settled by the pipeline's 180 degree hypothesis).
        source = np.roll(source, -1, axis=0)
    dest''')
r.write_text(t)
