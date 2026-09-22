import { useEffect, useRef, useState } from "react";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import { PdfPage } from "./PdfReader.js";

/** Lazy: the PDF engine does not increase the normal conversation startup cost. */
export default function ReaderPdf({
  assetId,
  page,
  ocr,
  line,
}: {
  assetId: string;
  page: number;
  ocr?: import("../../../packages/core/src/reader-ocr.js").ReadingOcr;
  line?: number;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    setPdf(null);
    setError("");
    const task = getDocument({
      url: `/api/assets/${assetId}`,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      useSystemFonts: false,
      verbosity: 0,
    });
    let stopped = false;
    void task.promise
      .then((p) => {
        if (!stopped) setPdf(p);
      })
      .catch(() => {
        if (!stopped) setError("PDF 原页无法读取，请重新打开。");
      });
    return () => {
      stopped = true;
      void task.destroy();
    };
  }, [assetId]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, Math.min(1000, entries[0]!.contentRect.width))),
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} className="reader-pdf-page">
      {error ? (
        <p role="alert">{error}</p>
      ) : pdf ? (
        <PdfPage
          key={`${assetId}:${page}:${width}`}
          pdf={pdf}
          number={page}
          width={width}
        />
      ) : (
        <p role="status">正在渲染原页…</p>
      )}
      {ocr && ocr.items[line ?? 0] && (
        <svg
          className="reader-ocr-box"
          viewBox={`0 0 ${ocr.image.width} ${ocr.image.height}`}
          aria-hidden="true"
        >
          <polygon
            points={ocr.items[line ?? 0]!.poly.map((p) => p.join(",")).join(
              " ",
            )}
          />
        </svg>
      )}
    </div>
  );
}
