# Reading / OCR dependency notices

These are license/attribution texts, not vendored application implementations.
Verified on 2026-09-23 for the versions locked in `application/package-lock.json`.
The application license generator includes them in the shipped license bundle.

- `onnxruntime-1.30.0/LICENSE` and `ThirdPartyNotices.txt` are unchanged upstream
  files from `https://github.com/microsoft/onnxruntime/tree/v1.30.0`. The complete
  third-party notice inventory is retained; it also names optional/native
  components that are not part of the WASM-only reader configuration.
- `PaddleOCR-LICENSE` is the upstream Apache-2.0 text and PaddlePaddle attribution
  from `https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE`, retrieved on
  the date above. The locked SDK is `@paddleocr/paddleocr-js@0.4.2`.
- `clipper-lib-6.4.2.txt` preserves the attributions in the locked `clipper.js`
  header and the JSBN grant. The package's `BSL` identifier denotes Boost Software
  License 1.0, as its README and source header explicitly state. It is not BUSL.
- `guid-typescript-1.0.9.txt` records the package's ISC declaration and author,
  with canonical ISC terms because upstream publishes no standalone license.
  The missing upstream copyright year is not invented.

PP-OCRv6 small detection and recognition weights are downloaded only after the
user confirms. They are not committed or bundled as source. Both official model
cards declare Apache-2.0:

- https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det
- https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec

The exact download origin, sizes and SHA-256 values are pinned in
`application/packages/application/src/reader-ocr.ts`. Changing a model or SDK
version requires a fresh provenance/license check, not just a matching name.
