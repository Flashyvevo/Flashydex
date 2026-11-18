import pathlib
p=pathlib.Path('app/recognize/pipeline.py'); s=p.read_bytes().decode()
crlf='\r\n' in s; s=s.replace('\r\n','\n')
old='''        ocr_obs: OcrObservation | None = None
        if ocr_future is not None and card is primary:
            ocr_obs, timing["ocr"] = ocr_future.result()
        elif self.ocr is not None:
            ocr_obs, timing["ocr"] = self._timed_ocr(card)
'''
new='''        ocr_obs: OcrObservation | None = None
        if self._visually_decisive(fusion.fuse_raw(sims, None), mask):
            # OCR is boost-only; it cannot reorder a clear visual winner, so do not wait for it
            # (a thread already started on the primary card just finishes in the background).
            timing["ocrSkipped"] = 1.0
        elif ocr_future is not None and card is primary:
            ocr_obs, timing["ocr"] = ocr_future.result()
        elif self.ocr is not None:
            ocr_obs, timing["ocr"] = self._timed_ocr(card)
'''
assert old in s
s=s.replace(old,new)
old2='''    @staticmethod
    def _ambiguous_quad('''
new2='''    @staticmethod
    def _visually_decisive(raw: np.ndarray, mask: np.ndarray | None) -> bool:
        """Top visual fit is high and the runner-up is too far behind for an OCR boost to overtake it."""
        scores = raw if mask is None else np.where(mask, raw, -np.inf)
        if scores.size < 2:
            return False
        top2 = np.partition(scores, -2)[-2:]
        runner, top = float(top2[0]), float(top2[1])
        return top >= constants.OCR_SKIP_FIT and max(runner, 0.0) * (1.0 + constants.OCR_BOOST) <= top

    @staticmethod
    def _ambiguous_quad('''
assert old2 in s
s=s.replace(old2,new2,1)
if crlf: s=s.replace('\n','\r\n')
p.write_bytes(s.encode())
