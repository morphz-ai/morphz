import { useEffect, useRef, useState } from "react";
import { ScanText, Square, Pencil } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type { ReadingSection } from "../../../packages/core/src/reader.js";
import {
  readingPage,
  type OcrLayout,
  type ReaderOcrStatus,
} from "../../../packages/core/src/reader-ocr.js";

export function ReaderOcrControls({
  client,
  artifactId,
  revision,
  section,
  active,
  onOpen,
  onFocusLine,
}: {
  client: WorkspaceClient;
  artifactId: string;
  revision: number;
  section: ReadingSection;
  active: boolean;
  onOpen: (id: string) => void;
  onFocusLine: (line: number) => void;
}) {
  const [expanded, setExpanded] = useState(!section.text.trim()),
    [status, setStatus] = useState<ReaderOcrStatus | null>(null);
  const [layout, setLayout] = useState<OcrLayout>(
      section.ocr?.layout ?? "horizontal",
    ),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [line, setLine] = useState(0),
    [correction, setCorrection] = useState("");
  const job = useRef<string | null>(null),
    mounted = useRef(true);
  const binding = { artifactId, revision, page: readingPage(section.id) };
  const running = !!status && ["loading", "recognizing"].includes(status.state);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (job.current)
        void client
          .readingOcr({ operation: "cancel", ...binding, jobId: job.current })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!active && job.current)
      void client
        .readingOcr({ operation: "cancel", ...binding, jobId: job.current })
        .catch(() => {});
  }, [active]);
  useEffect(() => {
    if (!expanded || !active) return;
    const abort = new AbortController();
    void client
      .readingOcr({ operation: "status", ...binding }, abort.signal)
      .then(setStatus)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [expanded, active]);
  useEffect(() => {
    if (!running || !status?.jobId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.readingOcr(
          { operation: "status", ...binding, jobId: status.jobId! },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setStatus(next);
        if (next.state === "complete" && next.sectionId) {
          job.current = null;
          onOpen(next.sectionId);
        } else if (["loading", "recognizing"].includes(next.state))
          timer = setTimeout(() => void poll(), 1000);
        else {
          job.current = null;
          setError(next.message ?? "");
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setError((e as Error).message);
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 300);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [running, status?.jobId]);
  async function start() {
    setBusy(true);
    setError("");
    const jobId = crypto.randomUUID();
    job.current = jobId;
    try {
      const next = await client.readingOcr({
        operation: "start",
        ...binding,
        jobId,
        layout,
        download: !status?.installed,
        force: !!section.ocr,
      });
      if (!mounted.current) {
        void client
          .readingOcr({ operation: "cancel", ...binding, jobId })
          .catch(() => {});
        return;
      }
      setStatus(next);
      if (next.state === "complete" && next.sectionId) {
        job.current = null;
        onOpen(next.sectionId);
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      job.current = null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function saveCorrection() {
    setBusy(true);
    setError("");
    try {
      const next = await client.readingOcr({
        operation: "correct",
        ...binding,
        sectionId: section.id,
        line,
        text: correction,
      });
      if (mounted.current && next.sectionId) onOpen(next.sectionId);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    const item = section.ocr?.items[line];
    setCorrection(item?.correction ?? item?.text ?? "");
  }, [section.id, line]);
  return (
    <details
      className="reader-ocr-controls"
      open={expanded}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary>
        <ScanText />
        {section.ocr
          ? "OCR 识别文本 · 校对与版式"
          : !section.text.trim()
            ? "扫描页没有文字层 · 可在本机识别"
            : "扫描文字识别"}
      </summary>
      <div className="reader-ocr-actions">
        <label>
          版式{" "}
          <select
            aria-label="OCR 阅读顺序"
            value={layout}
            disabled={running || busy}
            onChange={(e) => setLayout(e.target.value as OcrLayout)}
          >
            <option value="horizontal">横排</option>
            <option value="columns">左右双栏</option>
            <option value="vertical">古籍竖排 · 右起</option>
          </select>
        </label>
        {running ? (
          <>
            <span role="status">
              {status?.state === "loading"
                ? "准备本地模型…"
                : "正在识别这一页…"}
            </span>
            <button
              onClick={() =>
                void client
                  .readingOcr({
                    operation: "cancel",
                    ...binding,
                    jobId: job.current!,
                  })
                  .then(setStatus)
                  .catch((e) => setError(e.message))
              }
            >
              <Square />
              取消识别
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={busy || !status?.available}
            onClick={() => void start()}
          >
            {status?.installed
              ? section.ocr
                ? "重新识别这一页"
                : "识别这一页"
              : "下载模型并识别（31 MB）"}
          </button>
        )}
        {status?.sectionId && status.sectionId !== section.id && (
          <button onClick={() => onOpen(status.sectionId!)}>
            查看已保存的识别文本
          </button>
        )}
        {section.ocr && (
          <button onClick={() => onOpen(`page-${binding.page}`)}>
            只看原页
          </button>
        )}
      </div>
      <p>
        本地处理，不上传书籍。模型由 PaddlePaddle
        官方提供；复杂表格、竖排和模糊字可能出错。识别分数不是正确率，引用前请核对。
      </p>
      {status?.state === "cancelled" && (
        <p role="status">已取消识别，原页和已保存的识别结果未改变。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {status && !status.available && (
        <p>当前连接没有本地 OCR 引擎，请使用本机 Desktop。</p>
      )}
      {section.ocr && section.ocr.items.length > 0 && (
        <details className="reader-ocr-correction">
          <summary>
            <Pencil />
            校对识别文字
          </summary>
          <label>
            校对行{" "}
            <select
              aria-label="选择校对行"
              value={line}
              onChange={(e) => {
                setLine(Number(e.target.value));
                onFocusLine(Number(e.target.value));
              }}
            >
              {section.ocr.items.map((item, i) => (
                <option key={i} value={i}>
                  {i + 1} · {(item.correction ?? item.text).slice(0, 38)}
                  {item.score < 0.9 ? "（建议核对）" : ""}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="校对后的文字"
            value={correction}
            rows={2}
            maxLength={4000}
            onChange={(e) => setCorrection(e.target.value)}
          />
          <button disabled={busy} onClick={() => void saveCorrection()}>
            保存校对版本
          </button>
          <small>保留原识别结果；已有批注和聊天引用仍指向原版本。</small>
        </details>
      )}
    </details>
  );
}
