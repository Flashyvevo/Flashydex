import pathlib

p = pathlib.Path("app/recognize/pipeline.py")
s = p.read_bytes().decode()
crlf = "\r\n" in s
s = s.replace("\r\n", "\n")


def rep(old: str, new: str) -> None:
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)


rep('''        if quad is not None and self._ambiguous_quad(image, quad):
            hypotheses.append(("whole", rectify.center_crop_to_card(image)))
''', '''        whole = self._whole_frame_card(image, quad)
        if whole is not None:
            hypotheses.append(("whole", whole))
''')
rep('''        def score_hypothesis(label: str, candidate_card: np.ndarray) -> None:
            nonlocal chosen_label, card, sims, best_top
            tensors = prepare_card(candidate_card)
''', '''        prepare_ms = 0.0

        def score_hypothesis(label: str, candidate_card: np.ndarray) -> None:
            nonlocal chosen_label, card, sims, best_top, prepare_ms
            t_prep = time.perf_counter()
            tensors = prepare_card(candidate_card)
            prepare_ms += (time.perf_counter() - t_prep) * 1000
''')
rep('''        for label, candidate_card in hypotheses:
            score_hypothesis(label, candidate_card)
            if label == hypotheses[0][0]:
                t = lap("prepare", t)
''', '''        for label, candidate_card in hypotheses:
            score_hypothesis(label, candidate_card)
''')
rep('''        t = lap("embed", t)
        timing["hypotheses"]''', '''        t = lap("embed", t)  # all hypotheses: prepare + ORT + scoring (prepare alone is reported separately)
        timing["prepare"] = prepare_ms
        timing["hypotheses"]''')
i = s.index("    @staticmethod\n    def _ambiguous_quad(")
j = s.index("    # -- helpers")
s = s[:i] + '''    @staticmethod
    def _whole_frame_card(image: np.ndarray, quad: np.ndarray | None) -> np.ndarray | None:
        """The whole frame as a card, when the frame itself is card-shaped (either orientation).

        A tightly cropped card (screenshot / flat scan) has no outer edge, so the contour search can
        lock onto an inner or skewed outline; the frame is then the better rectification. Phone photos
        (3:4, 2:3) are not card-shaped and never take this path. A sideways frame is turned upright.
        """
        from app.vision import geometry

        h, w = image.shape[:2]
        if not 0.69 <= min(w, h) / max(w, h) <= 0.74:
            return None
        if quad is not None and geometry.polygon_area(quad) / float(h * w) >= constants.WHOLE_FRAME_TRY_BELOW:
            return None
        return rectify.center_crop_to_card(image if w <= h else np.ascontiguousarray(np.rot90(image, 1)))

''' + s[j:]
if crlf:
    s = s.replace("\n", "\r\n")
p.write_bytes(s.encode())
