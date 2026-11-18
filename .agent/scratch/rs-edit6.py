import pathlib

p = pathlib.Path("app/vision/imaging.py")
s = p.read_bytes().decode().replace("\r\n", "\n")
s = s.replace('''from pathlib import Path

import cv2
import numpy as np
''', '''import functools
from pathlib import Path

import cv2
import numpy as np

# ISO-BMFF ``ftyp`` major brands accepted as HEIC/HEIF (iPhone photos). AVIF is deliberately not listed.
HEIC_BRANDS = (b"heic", b"heix", b"mif1", b"msf1")


@functools.cache
def heif_available() -> bool:
    """True when ``pillow-heif`` imports and its Pillow opener registers (HEIC decode works)."""
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001 - optional dependency
        return False
    return True
''', 1)
s = s.replace('''    import io

    from PIL import Image, ImageOps

    try:''', '''    import io

    from PIL import Image, ImageOps

    heif_available()  # registers the HEIC opener once, if pillow-heif is installed
    try:''', 1)
p.write_bytes(s.encode())

r = pathlib.Path("requirements.txt")
t = r.read_bytes().decode()
t = t.replace("pillow==13.0.0\n", "pillow==13.0.0\npillow-heif==1.8.1\n")
r.write_bytes(t.encode())
