import pathlib

p = pathlib.Path("tests/test_units.py")
s = p.read_bytes().decode()
crlf = "\r\n" in s
s = s.replace("\r\n", "\n")
old = '''    raw2 = fusion.fuse_raw({**sig, "hash": np.array([1.0, 0.0], np.float32)}, None)
    assert raw2[0] == pytest.approx(1.0) and raw2[1] == pytest.approx((0.4 * 0.5) / 0.6)
'''
new = '''    both = {**sig, "hash": np.array([1.0, 0.0], np.float32)}
    raw2 = fusion.fuse_raw(both, None)
    # hash is boost-only: a hash of 0.0 (unaligned photo) never drags the embedding score down
    assert raw2[0] == pytest.approx(1.0) and raw2[1] == pytest.approx(0.5)
    sig3 = {**sig, "hash": np.array([0.9, 0.9], np.float32)}
    assert fusion.fuse_raw(sig3, None)[1] == pytest.approx((0.4 * 0.5 + 0.2 * 0.9) / 0.6)  # agreeing hash raises it


def test_hash_weighted_mean_when_boost_only_is_off(monkeypatch):
    monkeypatch.setattr(constants, "HASH_BOOST_ONLY", False)
    raw = fusion.fuse_raw({"emb_full": np.array([1.0, 0.5], np.float32), "hash": np.array([1.0, 0.0], np.float32)}, None)
    assert raw[1] == pytest.approx((0.4 * 0.5) / 0.6)
'''
assert old in s
s = s.replace(old, new)
old2 = '''    assert ag.factor[1] == pytest.approx(1 - 0.4 * 0.9)  # number mismatch: penalty, not removal'''
new2 = '''    assert ag.factor[1] == pytest.approx(1 - constants.OCR_PENALTY * 0.9)  # mismatch: at most a mild penalty'''
assert old2 in s
s = s.replace(old2, new2)
if crlf:
    s = s.replace("\n", "\r\n")
p.write_bytes(s.encode())
