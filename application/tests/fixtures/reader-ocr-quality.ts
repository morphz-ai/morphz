import { PaddleOCR, type OcrRuntimeParamsInput } from "@paddleocr/paddleocr-js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  orderOcr,
  readingOcrScale,
  type OcrLayout,
} from "../../packages/core/src/reader-ocr.js";

GlobalWorkerOptions.workerSrc = workerUrl;
type QualityWindow = Window & {
  runQuality?: (input: {
    sample: number;
    page: number;
    layout: OcrLayout;
    maxEdge: number;
    maxScale: number | null;
    params: OcrRuntimeParamsInput;
  }) => Promise<unknown>;
};
let engine: Awaited<ReturnType<typeof PaddleOCR.create>> | undefined;
(window as QualityWindow).runQuality = async (input) => {
  engine ??= await PaddleOCR.create({
    textDetectionModelName: "PP-OCRv6_small_det",
    textRecognitionModelName: "PP-OCRv6_small_rec",
    textDetectionModelAsset: { url: "/quality-assets/model-0" },
    textRecognitionModelAsset: { url: "/quality-assets/model-1" },
    worker: true,
    ortOptions: {
      backend: "wasm",
      wasmPaths: "/quality-runtime/",
      numThreads: 1,
    },
  });
  const task = getDocument({
    url: `/quality-assets/pdf-${input.sample}`,
    cMapUrl: "/quality-pdf/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/quality-pdf/standard_fonts/",
    wasmUrl: "/quality-pdf/wasm/",
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise,
      page = await pdf.getPage(input.page);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale:
        input.maxScale === null
          ? readingOcrScale(natural.width, natural.height)
          : Math.min(
              input.maxScale,
              input.maxEdge / Math.max(natural.width, natural.height),
            ),
    });
    const canvas = document.querySelector("canvas")!;
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    const started = performance.now();
    const [result] = await engine.predict(canvas, input.params);
    return {
      milliseconds: performance.now() - started,
      ...orderOcr(result!, input.layout),
      metrics: result!.metrics,
    };
  } finally {
    await task.destroy();
  }
};
