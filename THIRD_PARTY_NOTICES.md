# Third-party notices

## Pokeum

Portions of `services/recognition/app/` are adapted from [TBLgGamin/pokeum](https://github.com/TBLgGamin/pokeum) v1.7.1 (MIT). Every adapted file carries an `Adapted from pokeum (MIT) <path>` header comment. Adapted: `vision/{geometry,regions,imaging,detect,rectify}.py`, `signals/{base,hashes,embedding,ocr}.py`, `recognize/{fusion,pipeline}.py`, `variants/*.py`, `core/constants.py`.

```
MIT License

Copyright (c) 2026 TBLgGamin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DINOv2-small ONNX export (recognition service model)

`onnx-community/dinov2-small` (`onnx/model.onnx`, Hugging Face repo sha `8b1f705a3a7f6f062f6bdd21986c1583d3ef105d`), an ONNX export of `facebook/dinov2-small` (Meta AI), licensed Apache-2.0. Downloaded at index-build time into `services/recognition/data/models/` (git-ignored); not redistributed in this repository.

## RapidOCR / PP-OCR (recognition service OCR)

`rapidocr-onnxruntime` (Apache-2.0) bundles PP-OCRv4 detection/recognition ONNX models (PaddlePaddle / PaddleOCR, Apache-2.0). Installed from PyPI, not vendored.

## Card images

Reference card images are downloaded locally from TCGdex (`assets.tcgdex.net`) to build the recognition index. They remain the property of their rights holders, are stored git-ignored under `services/recognition/data/cache/`, and are never redistributed by this repository.

## sql.js

The browser SQLite WASM asset is supplied transitively by sql.js through the Capacitor community SQLite stack. Its license is preserved in installed package metadata.
