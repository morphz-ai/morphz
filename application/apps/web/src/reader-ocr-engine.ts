import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PaddleOCR } from "@paddleocr/paddleocr-js";

declare global {
  interface Window {
    readingOcr?: {
      input(): Promise<{ pdf: Uint8Array; page: number }>;
      result(value: unknown): Promise<void>;
      failed(): Promise<void>;
    };
  }
}
// Only the disposable Desktop OCR sandbox supplies this bridge. Visiting this
// static page in the ordinary application grants no capabilities.
const host = window.readingOcr;
if (host)
  void (async () => {
    GlobalWorkerOptions.workerSrc = workerUrl;
    let pdf: ReturnType<typeof getDocument> | undefined;
    let engine: Awaited<ReturnType<typeof PaddleOCR.create>> | undefined;
    try {
      const input = await host.input();
      pdf = getDocument({
        data: new Uint8Array(input.pdf),
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
        useSystemFonts: false,
        verbosity: 0,
      });
      const document = await pdf.promise,
        page = await document.getPage(input.page),
        unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(2.5, 2000 / Math.max(unscaled.width, unscaled.height)),
      });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvas,
        viewport,
        canvasContext: canvas.getContext("2d")!,
        background: "#ffffff",
      }).promise;
      engine = await PaddleOCR.create({
        textDetectionModelName: "PP-OCRv6_small_det",
        textRecognitionModelName: "PP-OCRv6_small_rec",
        textDetectionModelAsset: { url: "morphz://app/ocr-model/0.tar" },
        textRecognitionModelAsset: { url: "morphz://app/ocr-model/1.tar" },
        worker: false,
        ortOptions: {
          backend: "wasm",
          wasmPaths: "morphz://app/ocr-runtime/",
          numThreads: 1,
        },
      });
      const [result] = await engine.predict(canvas);
      if (!result) throw new Error("Empty OCR result");
      await host.result({
        image: result.image,
        items: result.items.map(({ poly, text, score }) => ({
          poly,
          text,
          score,
        })),
      });
    } catch {
      await host.failed();
    } finally {
      await engine?.dispose();
      await pdf?.destroy();
    }
  })();
