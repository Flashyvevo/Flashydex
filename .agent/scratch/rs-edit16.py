import pathlib
p=pathlib.Path('app/recognize/fusion.py'); s=p.read_bytes().decode()
crlf='\r\n' in s; s=s.replace('\r\n','\n')
old=s[s.index('def fuse_raw('):s.index('def rank(')]
new='''def fuse_raw(signals: dict[str, np.ndarray], ocr: OcrAgreement | None) -> np.ndarray:
    """Weighted mean over the present signals, times the OCR factor. Shape ``(N,)``.

    With ``HASH_BOOST_ONLY`` the perceptual hash can only *raise* a card's score above its
    embedding-only score: a photo that is not pixel-aligned with the reference (every real photo)
    scores ~0 on the hash even for the right card, which must not drag it down.
    """
    present = [name for name in signals if name in SIGNAL_WEIGHTS]
    denom = sum(SIGNAL_WEIGHTS[n] for n in present)
    if not present or denom <= 0:
        raise ValueError("no signals to fuse")
    raw = sum(SIGNAL_WEIGHTS[n] * signals[n] for n in present) / denom
    if constants.HASH_BOOST_ONLY and "hash" in present and len(present) > 1:
        others = [n for n in present if n != "hash"]
        embed_only = sum(SIGNAL_WEIGHTS[n] * signals[n] for n in others) / sum(SIGNAL_WEIGHTS[n] for n in others)
        raw = np.maximum(raw, embed_only)
    if ocr is not None:
        raw = raw * ocr.factor
    return np.asarray(raw, dtype=np.float32)


'''
s=s.replace(old,new)
if crlf: s=s.replace('\n','\r\n')
p.write_bytes(s.encode())
c=pathlib.Path('app/core/constants.py'); t=c.read_bytes().decode()
t=t.replace('WEIGHT_SYMBOL = 0.10\n','WEIGHT_SYMBOL = 0.10\n# Hash can only raise the fused score above the embedding-only score (see fusion.fuse_raw).\nHASH_BOOST_ONLY = True\n')
c.write_bytes(t.encode())
e=pathlib.Path('app/eval.py'); u=e.read_bytes().decode()
u=u.replace('''        base = ((wf + wa) * c["embed"] + wh * c["hash"]) / (wf + wa + wh)
''','''        base = ((wf + wa) * c["embed"] + wh * c["hash"]) / (wf + wa + wh)
        if params.get("hash_boost_only"):
            base = max(base, c["embed"])
''')
u=u.replace('''            "margin": constants.CONFIDENT_MARGIN, "candidates": constants.UNCERTAIN_THRESHOLD}''','''            "margin": constants.CONFIDENT_MARGIN, "candidates": constants.UNCERTAIN_THRESHOLD,
            "hash_boost_only": constants.HASH_BOOST_ONLY}''')
e.write_bytes(u.encode())
