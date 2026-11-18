import pathlib
c=pathlib.Path('app/core/constants.py'); s=c.read_text()
s=s.replace('''OCR_BOOST = 0.5
OCR_PENALTY = 0.4
''','''OCR_BOOST = 0.5
OCR_PENALTY = 0.4
# OCR below this confidence (or with no digits read) is ignored entirely: neutral, not 0.0.
OCR_MIN_CONFIDENCE = 0.0
# When the best embed+hash fit of the upright hypotheses is below this, also try the card
# turned 180 degrees (and, for landscape frames without a quad, 90/270 frame rotations).
ROTATE_RETRY_BELOW = 0.80
''')
c.write_text(s)
p=pathlib.Path('app/recognize/pipeline.py'); s=p.read_text()
old=s[s.index('        chosen_label, card, sims = "", primary, {}'):s.index('        t = lap("embed", t)')]
new='''        chosen_label, card, sims = "", primary, {}
        best_top = float("-inf")

        def score_hypothesis(label: str, candidate_card: np.ndarray) -> None:
            nonlocal chosen_label, card, sims, best_top
            tensors = prepare_card(candidate_card)
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

        for label, candidate_card in hypotheses:
            score_hypothesis(label, candidate_card)
            if label == hypotheses[0][0]:
                t = lap("prepare", t)
        n_hypotheses = len(hypotheses)
        if best_top < constants.ROTATE_RETRY_BELOW:
            # Upside-down / sideways cards: embeddings are not rotation invariant.
            retries = [("rot180", np.ascontiguousarray(np.rot90(card, 2)))]
            h, w = image.shape[:2]
            if quad is None and w / h > 1.1:
                retries += [("rot90", rectify.center_crop_to_card(np.ascontiguousarray(np.rot90(image, 1)))),
                            ("rot270", rectify.center_crop_to_card(np.ascontiguousarray(np.rot90(image, 3))))]
            for label, candidate_card in retries:
                score_hypothesis(label, candidate_card)
                n_hypotheses += 1
        hypotheses = hypotheses[:1] * n_hypotheses  # only the count is used below
'''
s=s.replace(old,new)
s=s.replace('''        ocr_obs: OcrObservation | None = None
        if ocr_future is not None:
            ocr_obs, timing["ocr"] = ocr_future.result()
        elif self.ocr is not None:''','''        ocr_obs: OcrObservation | None = None
        if ocr_future is not None and card is primary:
            ocr_obs, timing["ocr"] = ocr_future.result()
        elif self.ocr is not None:''')
s=s.replace('timing["hypotheses"] = float(len(hypotheses))','timing["hypotheses"] = float(n_hypotheses)')
p.write_text(s)
