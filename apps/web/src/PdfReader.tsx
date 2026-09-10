import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight, MessageSquarePlus } from "lucide-react";
import type { Content } from "../../../packages/core/src/model.js";
import { scopedStorage } from "./client.js";
import { SelectionActions } from "./SelectionActions.js";

GlobalWorkerOptions.workerSrc = workerUrl;
type Pdf = Extract<Content, { kind: "pdf" }>;
export function PdfAttachment({ url }: { url: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const task = getDocument({
      url,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    let stopped = false;
    void task.promise
      .then((p) => {
        if (!stopped) setPdf(p);
      })
      .catch(() => {
        if (!stopped) setError("无法打开 PDF，请检查文件和连接。");
      });
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, Math.min(900, entries[0]!.contentRect.width))),
    );
    if (root.current) observer.observe(root.current);
    return () => {
      stopped = true;
      observer.disconnect();
      void task.destroy();
    };
  }, [url]);
  return (
    <div ref={root}>
      {error ? (
        <p role="alert">{error}</p>
      ) : pdf ? (
        <>
          <div className="pdf-controls">
            <button
              disabled={page <= 1}
              aria-label="附件上一页"
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft />
            </button>
            <span>
              {page} / {pdf.numPages}
            </span>
            <button
              disabled={page >= pdf.numPages}
              aria-label="附件下一页"
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </button>
          </div>
          <Page key={page} pdf={pdf} number={page} width={width} />
        </>
      ) : (
        <p>正在读取 PDF…</p>
      )}
    </div>
  );
}
function Page({
  pdf,
  number,
  width,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    layer = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  useEffect(() => {
    let stopped = false,
      render: RenderTask | undefined,
      text: TextLayer | undefined;
    void (async () => {
      const page = await pdf.getPage(number);
      if (stopped || !canvas.current || !layer.current) return;
      const scale = width / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (
        !Number.isFinite(viewport.height) ||
        viewport.height <= 0 ||
        viewport.height > 10000 ||
        viewport.width * viewport.height * ratio * ratio > 12_000_000
      )
        throw new Error("Page canvas exceeds safe dimensions");
      canvas.current.width = Math.floor(viewport.width * ratio);
      canvas.current.height = Math.floor(viewport.height * ratio);
      canvas.current.style.width = `${viewport.width}px`;
      canvas.current.style.height = `${viewport.height}px`;
      layer.current.style.setProperty("--total-scale-factor", String(scale));
      render = page.render({
        canvas: canvas.current,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      const textContentSource = await page.getTextContent();
      if (stopped) return;
      text = new TextLayer({
        textContentSource,
        container: layer.current,
        viewport,
      });
      await Promise.all([render.promise, text.render()]);
      if (!stopped) setReady(true);
    })().catch(() => {
      if (!stopped)
        setError("这一页未能渲染。可切换页码，或使用下方提取文字。");
    });
    return () => {
      stopped = true;
      render?.cancel();
      text?.cancel();
    };
  }, [pdf, number, width]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {!ready && !error && <p role="status">正在渲染第 {number} 页…</p>}
      <div
        className="pdf-page"
        style={{ width }}
        aria-label={`PDF 第 ${number} 页`}
      >
        <canvas ref={canvas} />
        <div ref={layer} className="pdf-text-layer" />
      </div>
    </>
  );
}
export default function PdfReader({
  content,
  onSelect,
  initialPage,
  onRead,
}: {
  content: Pdf;
  onSelect: (quote: string, page: number, annotation?: boolean) => void;
  onRead?: (quote: string) => void;
  initialPage?: number | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { readLocal, writeLocal } = useState(() => scopedStorage())[0];
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [error, setError] = useState("");
  const [number, setNumber] = useState(() => {
    const saved =
      initialPage ?? readLocal<number>("pdf-page:" + content.assetId, 1);
    return Number.isInteger(saved) &&
      saved >= 1 &&
      saved <= content.pages.length
      ? saved
      : 1;
  });
  const [width, setWidth] = useState(600),
    [quote, setQuote] = useState("");
  useEffect(() => {
    const task = getDocument({
      url: "/api/assets/" + content.assetId,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      useSystemFonts: false,
      verbosity: 0,
    });
    let stopped = false;
    void task.promise
      .then((value) => {
        if (!stopped) setPdf(value);
      })
      .catch(() => {
        if (!stopped)
          setError("PDF 原文件暂时无法读取，请检查中心连接后重新打开。");
      });
    const observer = new ResizeObserver((entries) => {
      const available = Math.floor(entries[0]?.contentRect.width ?? 600);
      setWidth(Math.max(240, Math.min(available - 2, 920)));
    });
    if (root.current) observer.observe(root.current);
    return () => {
      stopped = true;
      observer.disconnect();
      void task.destroy();
    };
  }, [content.assetId]);
  function go(page: number) {
    setNumber(page);
    setQuote("");
    writeLocal("pdf-page:" + content.assetId, page);
  }
  function selection() {
    const value = window.getSelection();
    if (
      !value?.anchorNode ||
      !value.focusNode ||
      !root.current?.contains(value.anchorNode) ||
      !root.current.contains(value.focusNode)
    )
      return;
    setQuote(exactQuote(value.toString().trim()));
  }
  function exactQuote(raw: string) {
    const source = content.pages[number - 1]!;
    // PDF visual runs may insert line breaks/spaces differently. Map back to the exact stored page slice.
    let exact = source.includes(raw) ? raw : "";
    if (!exact && raw) {
      const chars: string[] = [],
        offsets: number[] = [];
      for (let i = 0; i < source.length; i++)
        if (!/\s/u.test(source[i]!)) {
          chars.push(source[i]!);
          offsets.push(i);
        }
      const needle = raw.replace(/\s/gu, ""),
        start = chars.join("").indexOf(needle);
      if (needle && start >= 0)
        exact = source.slice(
          offsets[start],
          offsets[start + needle.length - 1]! + 1,
        );
    }
    return exact.length <= 10000 ? exact : "";
  }
  return (
    <div
      className="pdf-reader"
      ref={root}
      onMouseUp={selection}
      onKeyUp={selection}
    >
      <SelectionActions
        root={root}
        onAction={(action, raw) => {
          const exact = exactQuote(raw);
          if (!exact) return;
          if (action === "read") onRead?.(exact);
          else onSelect(exact, number, action === "annotate");
        }}
      />
      <div className="pdf-controls">
        <button
          aria-label="PDF 上一页"
          disabled={number === 1}
          onClick={() => go(number - 1)}
        >
          <ChevronLeft />
        </button>
        <label>
          页码{" "}
          <select
            aria-label="PDF 页码"
            value={number}
            onChange={(e) => go(Number(e.target.value))}
          >
            {content.pages.map((_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>{" "}
          / {content.pages.length}
        </label>
        <button
          aria-label="PDF 下一页"
          disabled={number === content.pages.length}
          onClick={() => go(number + 1)}
        >
          <ChevronRight />
        </button>
        <button disabled={!quote} onClick={() => onSelect(quote, number)}>
          <MessageSquarePlus />
          引用选中文字
        </button>
      </div>
      {error ? (
        <p role="alert" className="error-banner">
          {error}
        </p>
      ) : pdf ? (
        <Page
          key={`${number}:${width}`}
          pdf={pdf}
          number={number}
          width={width}
        />
      ) : (
        <p role="status">正在打开 PDF…</p>
      )}
      <details className="pdf-extracted">
        <summary>第 {number} 页的提取文字</summary>
        <p>
          {content.pages[number - 1] ||
            "这一页没有可提取文字。可阅读页面图像；暂不提供 OCR。"}
        </p>
      </details>
    </div>
  );
}
