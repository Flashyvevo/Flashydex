import pathlib

for name in ("tests/test_api.py", "tests/test_security.py"):
    p = pathlib.Path(name)
    s = p.read_bytes().decode()
    crlf = "\r\n" in s
    s = s.replace("\r\n", "\n")
    s = s.replace('"UNSUPPORTED_IMAGE_TYPE"', '"UNSUPPORTED_IMAGE"')
    s = s.replace('"IMAGE_TOO_LARGE"', '"PAYLOAD_TOO_LARGE"')
    s = s.replace('["error"]["code"] == "BUSY"', '["error"]["code"] == "RECOGNIZER_BUSY"')
    s = s.replace('''    heic = b"\\x00\\x00\\x00\\x18ftypheic\\x00\\x00\\x00\\x00heicmif1"
    r = post(c, heic)
    assert r.status_code == 415 and r.json()["error"]["code"] == "HEIC_UNSUPPORTED"
''', '''    avif = b"\\x00\\x00\\x00\\x18ftypavif\\x00\\x00\\x00\\x00avifmif1"  # not decodable here -> 415
    r = post(c, avif)
    assert r.status_code == 415 and r.json()["error"] == {
        "code": "UNSUPPORTED_IMAGE", "message": r.json()["error"]["message"], "retryable": False}
''')
    s = s.replace('''def test_heic_unsupported_code():
    heic = b"\\x00\\x00\\x00\\x18ftypheic\\x00\\x00\\x00\\x00heicmif1"
    r = post(client(), heic)
    assert r.status_code == 415 and r.json()["error"]["code"] == "HEIC_UNSUPPORTED"
''', '''def test_heic_accepted_when_pillow_heif_present():
    from app.vision.imaging import heif_available

    assert heif_available()  # pinned in requirements.txt
    heic = b"\\x00\\x00\\x00\\x18ftypheic\\x00\\x00\\x00\\x00heicmif1"
    assert post(client(), heic).status_code == 200  # sniffed as HEIC (fake recognizer ignores the payload)
''')
    if crlf:
        s = s.replace("\n", "\r\n")
    p.write_bytes(s.encode())
