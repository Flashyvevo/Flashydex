import io
import numpy as np
import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()
rng = np.random.default_rng(1)
arr = (rng.random((240, 180, 3)) * 255).astype("uint8")
buf = io.BytesIO()
Image.fromarray(arr).save(buf, format="HEIF", quality=85)
data = buf.getvalue()
print("pillow_heif", pillow_heif.__version__, "bytes", len(data), "magic", data[4:12])
back = Image.open(io.BytesIO(data)); back.load()
print(back.size, back.mode)
open("../../.agent/scratch/rs-sample.heic", "wb").write(data)
