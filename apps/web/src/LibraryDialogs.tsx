import { useEffect, useRef, useState } from "react";
import {
  FileUp,
  FolderOpen,
  Search,
  X,
  Check,
  AlertCircle,
} from "lucide-react";
import {
  documentImportIssue,
  documentTextIssue,
  maxDocumentBytes,
  maxImportFiles,
} from "../../../packages/core/src/sources.js";
import type { SearchResult } from "../../../packages/core/src/retrieval.js";
import type { WorkspaceClient } from "./client.js";
import { ObjectIcon } from "./ArtifactEditor.js";
import SourceConnections from "./SourceConnections.js";
import { useModal } from "./useModal.js";
import { maxPdfBytes, pdfImportIssue } from "../../../packages/core/src/pdf.js";

type Selection = {
  file: File;
  path: string;
  issue: string | null;
  done: boolean;
  artifactId?: string;
};
export function ImportDocuments({
  client,
  project,
  onClose,
  onOpen,
}: {
  client: WorkspaceClient;
  project: { id: string; title: string };
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null),
    directory = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [mode, setMode] = useState<"copy" | "linked">("copy");
  useModal(dialog);
  function choose(list: FileList | null) {
    if (!list) return;
    const entries = Array.from(list);
    setError("");
    if (entries.length > 5000) {
      setError("所选目录超过 5000 个条目，请选择更具体的资料目录。");
      return;
    }
    const next = entries.map((file) => {
      const path = file.webkitRelativePath || file.name;
      return {
        file,
        path,
        done: false,
        issue: /\.pdf$/i.test(path)
          ? (pdfImportIssue(path) ??
            (file.size > maxPdfBytes ? "PDF 超过 20 MB。" : null))
          : (documentImportIssue(path) ??
            (file.size > maxDocumentBytes ? "文件超过 8 MB。" : null)),
      };
    });
    if (next.filter((item) => !item.issue).length > maxImportFiles) {
      setError(`每次最多导入 ${maxImportFiles} 篇资料，请缩小选择范围。`);
      return;
    }
    setSelection(next);
  }
  async function start() {
    setBusy(true);
    setError("");
    stop.current = false;
    try {
      for (let i = 0; i < selection.length; i++) {
        if (stop.current) break;
        const item = selection[i]!;
        if (item.issue || item.done) continue;
        if (/\.pdf$/i.test(item.path)) {
          const receipt = await client.importPdf(
            item.file,
            project.id,
            item.path,
          );
          setSelection((previous) =>
            previous.map((x, j) =>
              j === i ? { ...x, done: true, artifactId: receipt.entityId } : x,
            ),
          );
          continue;
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            await item.file.arrayBuffer(),
          );
        } catch {
          setSelection((previous) =>
            previous.map((x, j) =>
              j === i ? { ...x, issue: "无法按 UTF-8 读取。" } : x,
            ),
          );
          continue;
        }
        const issue = documentTextIssue(text);
        if (issue) {
          setSelection((previous) =>
            previous.map((x, j) => (j === i ? { ...x, issue } : x)),
          );
          continue;
        }
        if (stop.current) break;
        const receipt = await client.execute({
          type: "import-document",
          projectId: project.id,
          relativePath: item.path,
          text,
        });
        setSelection((previous) =>
          previous.map((x, j) =>
            j === i ? { ...x, done: true, artifactId: receipt.entityId } : x,
          ),
        );
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "导入失败，请重试未完成的资料。",
      );
    } finally {
      setBusy(false);
    }
  }
  const pending = selection.filter((item) => !item.issue && !item.done).length;
  const completed = selection.filter((item) => item.done).length;
  return (
    <dialog
      ref={dialog}
      className="create-dialog library-dialog"
      aria-labelledby="import-title"
      onCancel={(e) => {
        e.preventDefault();
        if (busy) stop.current = true;
        else onClose();
      }}
    >
      <header>
        <div>
          <h2 id="import-title">导入资料</h2>
          <p className="muted">保存到「{project.title}」</p>
        </div>
        <button aria-label="关闭资料导入" disabled={busy} onClick={onClose}>
          <X />
        </button>
      </header>
      <div
        className="filter-tabs import-mode"
        role="group"
        aria-label="资料接入方式"
      >
        <button
          aria-pressed={mode === "copy"}
          disabled={busy}
          onClick={() => setMode("copy")}
        >
          导入副本
        </button>
        <button
          aria-pressed={mode === "linked"}
          disabled={busy}
          onClick={() => setMode("linked")}
        >
          连接来源
        </button>
      </div>
      {mode === "linked" ? (
        <SourceConnections projectId={project.id} />
      ) : (
        <>
          <p className="import-explanation">
            导入 Markdown、UTF-8 文本或 PDF
            副本。原文件不会被修改；后续编辑只更新工作空间中的版本。
          </p>
          <div className="import-choices">
            <button
              className="outline"
              disabled={busy}
              onClick={() => files.current?.click()}
            >
              <FileUp />
              选择文件
            </button>
            <button
              className="outline"
              disabled={busy}
              onClick={() => directory.current?.click()}
            >
              <FolderOpen />
              选择资料目录
            </button>
          </div>
          <input
            ref={files}
            type="file"
            multiple
            accept=".md,.markdown,.txt,.pdf"
            className="hidden-file"
            aria-label="选择资料文件"
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={directory}
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            className="hidden-file"
            aria-label="选择资料目录文件"
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="muted">
            每次最多 100 篇；文本不超过 1 MB，PDF 不超过 20 MB／300
            页。隐藏文件、凭据、依赖目录和构建产物会被跳过。PDF
            提取文字后可引用，扫描件暂不做 OCR。
          </p>
          {selection.length > 0 && (
            <ul className="import-selection">
              {selection.map((item, i) => (
                <li key={i} data-skipped={!!item.issue}>
                  {item.done ? (
                    <Check />
                  ) : item.issue ? (
                    <AlertCircle />
                  ) : (
                    <FileUp />
                  )}
                  <span>
                    <strong>{item.path}</strong>
                    <small>
                      {item.done
                        ? "已保存"
                        : (item.issue ??
                          `${Math.ceil(item.file.size / 1024)} KB · 待导入`)}
                    </small>
                  </span>
                  {item.artifactId && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        onClose();
                        onOpen(item.artifactId!);
                      }}
                    >
                      打开
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <footer>
            <span role="status" className="muted">
              {completed
                ? `已导入 ${completed} 篇`
                : "选择的文件会先列出，确认后再保存"}
            </span>
            {busy ? (
              <button
                onClick={() => {
                  stop.current = true;
                }}
              >
                停止后续导入
              </button>
            ) : (
              <button
                className="primary"
                disabled={!pending || !client.online}
                onClick={() => void start()}
              >
                导入 {pending} 篇资料
              </button>
            )}
          </footer>
        </>
      )}
    </dialog>
  );
}

export function SearchDocuments({
  client,
  onClose,
  onOpen,
  onQuote,
}: {
  client: WorkspaceClient;
  onClose: () => void;
  onOpen: (id: string, revision: number, page?: number) => void;
  onQuote: (id: string, revision: number, quote: string, page?: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const backdropPointer = useRef(false);
  const outsidePanel = (x: number, y: number) => {
    const bounds = dialog.current?.getBoundingClientRect();
    return (
      !!bounds &&
      (x < bounds.left ||
        x > bounds.right ||
        y < bounds.top ||
        y > bounds.bottom)
    );
  };
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState(""),
    [projectId, setProjectId] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const revision = client.boot?.workspace.revision;
  const search = useRef(client.search);
  search.current = client.search;
  useModal(dialog, searchInput);
  useEffect(() => {
    setSelected(0);
    setResult(null);
    setError("");
    if (!query.trim()) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void search
        .current(
          { query, ...(projectId ? { projectId } : {}), offset },
          abort.signal,
        )
        .then((value) => {
          if (!abort.signal.aborted) setResult(value);
        })
        .catch((e) => {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : "搜索失败。");
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, projectId, offset, revision]);
  const recent = [...(client.boot?.workspace.artifacts ?? [])]
    .filter((a) => !projectId || a.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const choices = query.trim() ? (result?.hits ?? []) : recent;
  const openSelected = () => {
    const item = choices[selected];
    if (!item) return;
    onClose();
    if ("artifactId" in item) onOpen(item.artifactId, item.revision, item.page);
    else onOpen(item.id, item.revision);
  };
  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label="搜索工作空间"
      onPointerDown={(e) => {
        backdropPointer.current =
          e.button === 0 &&
          e.target === e.currentTarget &&
          outsidePanel(e.clientX, e.clientY);
      }}
      onPointerCancel={() => {
        backdropPointer.current = false;
      }}
      onClick={(e) => {
        const dismiss =
          backdropPointer.current &&
          e.target === e.currentTarget &&
          outsidePanel(e.clientX, e.clientY);
        backdropPointer.current = false;
        if (dismiss) onClose();
      }}
      onKeyDown={(e) => {
        if (
          e.nativeEvent.isComposing ||
          e.keyCode === 229 ||
          e.target !== searchInput.current
        )
          return;
        if (["ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          const next = Math.max(
            0,
            Math.min(
              choices.length - 1,
              selected + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
          setSelected(next);
          dialog.current
            ?.querySelector(`[data-search-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
          e.preventDefault();
          openSelected();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="workspace-search-controls">
        <label className="search-field">
          <Search />
          <input
            ref={searchInput}
            aria-label="全文搜索"
            placeholder="搜索标题、正文和事项…"
            maxLength={200}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>
      <div className="search-scope">
        <select
          aria-label="搜索项目范围"
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部工作空间</option>
          {client.boot?.workspace.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <p className="muted" role="status">
          {loading
            ? "正在搜索…"
            : error ||
              (!query.trim()
                ? "最近修改"
                : `找到 ${result?.total ?? 0} 项内容`)}
        </p>
      </div>
      <div className="workspace-search-results">
        {!query.trim() &&
          recent.map((item, index) => (
            <article
              key={item.id}
              data-search-index={index}
              data-selected={index === selected}
            >
              <button
                className="search-result-open"
                onClick={() => {
                  onClose();
                  onOpen(item.id, item.revision);
                }}
              >
                <ObjectIcon kind={item.content.kind} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {
                      client.boot?.workspace.projects.find(
                        (p) => p.id === item.projectId,
                      )?.title
                    }
                  </small>
                </span>
              </button>
            </article>
          ))}
        {result?.hits.map((hit, index) => (
          <article
            key={hit.artifactId}
            data-search-index={index}
            data-selected={index === selected}
          >
            <button
              className="search-result-open"
              onClick={() => {
                onClose();
                onOpen(hit.artifactId, hit.revision, hit.page);
              }}
            >
              <ObjectIcon kind={hit.kind} />
              <span>
                <strong>{hit.title}</strong>
                <small>
                  {hit.projectTitle}
                  {hit.page ? ` · 第 ${hit.page} 页` : ""}
                </small>
              </span>
            </button>
            {hit.excerpt && <p>{hit.excerpt}</p>}
            <div className="search-result-footer">
              <small>{hit.source?.relativePath ?? "工作空间内容"}</small>
              {(hit.kind === "document" || hit.kind === "pdf") &&
                hit.quote.trim() && (
                  <button
                    onClick={() => {
                      onClose();
                      onQuote(
                        hit.artifactId,
                        hit.revision,
                        hit.quote,
                        hit.page,
                      );
                    }}
                  >
                    引用并提问
                  </button>
                )}
            </div>
          </article>
        ))}
        {!loading && !error && choices.length === 0 && (
          <p className="search-empty">
            {query.trim()
              ? "没有找到匹配的内容，试试其他关键词。"
              : "还没有内容，可以先打开应用或导入资料。"}
          </p>
        )}
      </div>
      <div className="search-help">
        <span>↑ ↓ 选择</span>
        <span>Enter 打开</span>
        <span>Esc 返回</span>
      </div>
      {result && (offset > 0 || result.hasMore) && (
        <footer>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </button>
          <span className="muted">第 {Math.floor(offset / 20) + 1} 页</span>
          <button
            disabled={!result.hasMore}
            onClick={() => setOffset(offset + 20)}
          >
            下一页
          </button>
        </footer>
      )}
    </dialog>
  );
}
