import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;

/** First-page preview of the existing authorized asset; no import or indexing. */
export default function PdfPreview({ assetId }: { assetId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    let stopped = false,
      render: RenderTask | undefined;
    const task = getDocument({
      url: `/api/assets/${assetId}`,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    void (async () => {
      const doc = await task.promise;
      if (stopped) return;
      const page = await doc.getPage(1);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(440 / natural.width, 300 / natural.height),
      });
      if (stopped || !canvas.current) return;
      if (
        !Number.isFinite(viewport.width * viewport.height) ||
        viewport.width < 1 ||
        viewport.height < 1
      )
        throw new Error("Invalid page size");
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      render = page.render({ canvas: canvas.current, viewport });
      await render.promise;
    })().catch(() => {
      if (!stopped) setError(true);
    });
    return () => {
      stopped = true;
      render?.cancel();
      void task.destroy();
    };
  }, [assetId]);
  return error ? (
    <span>预览暂不可用，仍可打开阅读</span>
  ) : (
    <canvas ref={canvas} aria-label="PDF 首页预览" role="img" />
  );
}
