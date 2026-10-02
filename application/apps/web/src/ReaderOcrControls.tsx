import { useEffect, useRef, useState } from "react";
import { ScanText, Square, Pencil } from "lucide-react";
import { useObservedRead } from "./useObservedRead.js";
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
  const binding = { artifactId, revision, page: readingPage(section.id) };
  const scope = JSON.stringify([
    client.boot?.centerId,
    client.boot?.principalId,
    client.boot?.csrfToken,
    artifactId,
    revision,
    binding.page,
  ]);
  const [expanded, setExpanded] = useState(!section.text.trim()),
    [storedStatus, storeStatus] = useState<{
      scope: string;
      value: ReaderOcrStatus;
    } | null>(null);
  const status = storedStatus?.scope === scope ? storedStatus.value : null;
  const setStatus = (value: ReaderOcrStatus) => storeStatus({ scope, value });
  const identityGeneration = client.boot?.csrfToken;
  const readOcr = (
    request: Parameters<WorkspaceClient["readingOcr"]>[0],
    signal?: AbortSignal,
  ) => client.readingOcr(request, signal, identityGeneration);
  const [layout, setLayout] = useState<OcrLayout>(
      section.ocr?.layout ?? "horizontal",
    ),
    [storedError, storeError] = useState({ scope, value: "" });
  const error = storedError.scope === scope ? storedError.value : "";
  const setError = (value: string) => storeError({ scope, value });
  const [storedBusy, storeBusy] = useState({ scope, value: false }),
    [line, setLine] = useState(0),
    [correction, setCorrection] = useState("");
  const busy = storedBusy.scope === scope && storedBusy.value;
  const setBusy = (value: boolean) => storeBusy({ scope, value });
  const job = useRef<{ id: string; scope: string } | null>(null),
    mounted = useRef(true);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const running = !!status && ["loading", "recognizing"].includes(status.state);
  useObservedRead({
    scope: JSON.stringify([scope, status?.jobId ?? null]),
    enabled: expanded && active && client.online,
    revision: client.workspaceChangeRevision,
    read: (signal) =>
      readOcr(
        {
          operation: "status",
          ...binding,
          ...(status?.jobId ? { jobId: status.jobId } : {}),
        },
        signal,
      ),
    publish: (next) => {
      setStatus(next);
      setError(next.message ?? "");
      if (["complete", "cancelled", "failed"].includes(next.state)) {
        const owned =
          job.current?.scope === scope && job.current.id === next.jobId;
        job.current = null;
        if (owned && next.state === "complete" && next.sectionId)
          onOpen(next.sectionId);
      }
    },
    failed: (cause) =>
      setError(cause instanceof Error ? cause.message : "无法读取识别状态。"),
  });
  useEffect(() => {
    mounted.current = true;
    setBusy(false);
    setError("");
    setLayout(section.ocr?.layout ?? "horizontal");
    setLine(0);
    setCorrection(
      section.ocr?.items[0]?.correction ?? section.ocr?.items[0]?.text ?? "",
    );
    return () => {
      mounted.current = false;
      if (job.current?.scope === scope) {
        const jobId = job.current.id;
        job.current = null;
        void readOcr({ operation: "cancel", ...binding, jobId }).catch(
          () => {},
        );
      }
    };
  }, [scope]);
  useEffect(() => {
    if (!active && job.current?.scope === scope)
      void readOcr({
        operation: "cancel",
        ...binding,
        jobId: job.current.id,
      }).catch(() => {});
  }, [active, scope]);
  async function start() {
    setBusy(true);
    setError("");
    const jobId = crypto.randomUUID();
    job.current = { id: jobId, scope };
    try {
      const next = await readOcr({
        operation: "start",
        ...binding,
        jobId,
        layout,
        download: !status?.installed,
        force: !!section.ocr,
      });
      if (!mounted.current || currentScope.current !== scope) {
        void readOcr({ operation: "cancel", ...binding, jobId }).catch(
          () => {},
        );
        return;
      }
      setStatus(next);
      if (next.state === "complete" && next.sectionId) {
        job.current = null;
        onOpen(next.sectionId);
      }
    } catch (e) {
      if (mounted.current && currentScope.current === scope)
        setError((e as Error).message);
      if (job.current?.scope === scope) job.current = null;
    } finally {
      if (mounted.current && currentScope.current === scope) setBusy(false);
    }
  }
  async function saveCorrection() {
    setBusy(true);
    setError("");
    try {
      const next = await readOcr({
        operation: "correct",
        ...binding,
        sectionId: section.id,
        line,
        text: correction,
      });
      if (mounted.current && currentScope.current === scope && next.sectionId)
        onOpen(next.sectionId);
    } catch (e) {
      if (mounted.current && currentScope.current === scope)
        setError((e as Error).message);
    } finally {
      if (mounted.current && currentScope.current === scope) setBusy(false);
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
                void readOcr({
                  operation: "cancel",
                  ...binding,
                  jobId: status!.jobId!,
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
