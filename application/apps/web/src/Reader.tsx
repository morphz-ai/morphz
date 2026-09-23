import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  List,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Settings2,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import {
  readable,
  readerFileAccept,
  readingPreferencesSchema,
  readingReference,
  readingPosition,
  type ReadingLocation,
  type ReadingPreferences,
  type ReadingReference,
  type ReadingSection,
  type ReaderTarget,
  type ReadingMark,
} from "../../../packages/core/src/reader.js";
import type { Artifact } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import {
  readerOffsets,
  readerRange,
  readerSelection,
  readerViewport,
  readerMarksAtPoint,
} from "./reader-dom.js";
import type { ReadingContextChange, ReadingFocus } from "./ReadingContext.js";
import { useModal } from "./useModal.js";
import "./reader.css";
import {
  readingBaseSection,
  readingPage,
} from "../../../packages/core/src/reader-ocr.js";
import { ReaderOcrControls } from "./ReaderOcrControls.js";
const ReaderPdf = lazy(() => import("./ReaderPdf.js"));

// Workspace updates must not replace the book's DOM and destroy a live
// selection, anchor or accessibility node while the user is reading.
const ReadingHtml = memo(function ReadingHtml({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

export type ReadingCompose = (
  artifactId: string,
  revision: number,
  reference: ReadingReference,
  question: string,
) => { ok: boolean; error?: string };
type ReaderProps = {
  client: WorkspaceClient;
  projectId: string;
  artifactId?: string;
  revision?: number | null;
  target?: ReaderTarget | null;
  active: boolean;
  globalLibrary?: boolean;
  onOpen: (id: string) => void;
  onLibrary?: () => void;
  onJump: (target: ReaderTarget) => void;
  onTargetConsumed: (requestId: string) => void;
  onCompose: ReadingCompose;
  onContext?: ReadingContextChange;
  onNotice: (message: string) => void;
  onNativeDialog?: (open: boolean) => void;
};

export function Reader(props: ReaderProps) {
  const {
    client,
    projectId,
    artifactId,
    globalLibrary,
    onOpen,
    onNativeDialog,
    onNotice,
  } = props;
  const [query, setQuery] = useState(""),
    [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const state = client.boot!.workspace,
    artifact = state.artifacts.find((a) => a.id === artifactId);
  const books = state.artifacts.filter(
    (a) => readable(a.content) && (globalLibrary || a.projectId === projectId),
  );
  const owner = client.boot!.principalId;
  useEffect(() => {
    const input = file.current;
    const cancel = () => onNativeDialog?.(false);
    input?.addEventListener("cancel", cancel);
    return () => input?.removeEventListener("cancel", cancel);
  }, [artifactId]);
  const matches = books
    .filter((a) =>
      `${a.title} ${a.content.kind === "publication" ? a.content.author : ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => {
      const progress = (id: string) =>
        state.readingStates.find(
          (p) => p.ownerPrincipalId === owner && p.artifactId === id,
        )?.updatedAt ?? "";
      return (
        progress(b.id).localeCompare(progress(a.id)) ||
        b.updatedAt.localeCompare(a.updatedAt)
      );
    });
  if (artifact && readable(artifact.content))
    return (
      <ReadingBook
        key={`${artifact.id}:${props.revision ?? artifact.revision}`}
        {...props}
        artifact={artifact}
      />
    );
  return (
    <section className="reader-library" aria-label="阅读书库">
      <header className="reader-library-header">
        <h2>
          <BookOpen />
          阅读
        </h2>
        <button
          className="primary"
          disabled={importing}
          onClick={() => {
            onNativeDialog?.(true);
            file.current?.click();
          }}
        >
          <Plus />
          {importing ? "正在导入…" : "导入读物"}
        </button>
      </header>
      <div className="reader-library-filter">
        <label>
          <Search />
          <input
            type="search"
            aria-label="查找读物"
            placeholder="书名或作者"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span>{matches.length} 份读物</span>
      </div>
      {!books.length && (
        <div className="reader-empty">
          <BookOpen />
          <h3>带着 Morphz 一起读</h3>
          <p>打开一本书，选中原文，就能沿用平时的对话继续讨论。</p>
          <p>EPUB · PDF · Markdown · Word · TXT · HTML · RTF</p>
        </div>
      )}
      {!!books.length && !matches.length && (
        <p className="reader-empty">没有找到相关读物。</p>
      )}
      <ul className="reader-books">
        {matches.map((a) => {
          const p = state.readingStates.find(
            (p) => p.ownerPrincipalId === owner && p.artifactId === a.id,
          );
          const label =
            a.content.kind === "publication"
              ? {
                  epub: "EPUB",
                  docx: "DOCX",
                  doc: "DOC",
                  rtf: "RTF",
                  html: "HTML",
                  markdown: "Markdown",
                  text: "TXT",
                }[a.content.format]
              : a.content.kind === "pdf"
                ? "PDF"
                : "Markdown";
          return (
            <li key={a.id}>
              <button
                onClick={() => onOpen(a.id)}
                aria-label={`阅读：${a.title}`}
              >
                <span className="reader-book-spine">
                  <BookOpen />
                </span>
                <span className="reader-book-info">
                  <strong>{a.title}</strong>
                  <small>
                    {a.content.kind === "publication" && a.content.author
                      ? `${a.content.author} · `
                      : ""}
                    {label}
                  </small>
                  <small>
                    {p ? "继续阅读" : "开始阅读"}
                    {globalLibrary &&
                      ` · ${state.projects.find((p) => p.id === a.projectId)?.title ?? "未归项目"}`}
                  </small>
                </span>
                <ArrowUpRight />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="reader-privacy">
        读物导入当前工作中心；本地 Desktop 在本机解析。向 Morphz
        交流时默认只附带书籍和位置，选文后才附带原文及必要上下文；讨论原文时按需读取，不自动上传整本书。
      </p>
      <input
        ref={file}
        className="hidden-file"
        type="file"
        accept={readerFileAccept}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          onNativeDialog?.(false);
          if (!chosen) return;
          setImporting(true);
          void client
            .importReading(chosen, projectId)
            .then((r) => onOpen(r.entityId))
            .catch((e) => onNotice(e.message))
            .finally(() => setImporting(false));
        }}
      />
    </section>
  );
}

function ReadingBook({
  client,
  artifact,
  revision,
  target,
  active,
  onLibrary,
  onJump,
  onTargetConsumed,
  onCompose,
  onContext,
  onNotice,
}: ReaderProps & { artifact: Artifact }) {
  const version = artifact.versions.find(
    (v) => v.revision === (revision ?? artifact.revision),
  )!;
  const owner = client.boot!.principalId;
  const saved = client.boot!.workspace.readingStates.find(
    (p) => p.artifactId === artifact.id && p.ownerPrincipalId === owner,
  );
  const [preferences, setPreferences] = useState(
    () => saved?.preferences ?? readingPreferencesSchema.parse({}),
  );
  const [sections, setSections] = useState<
    Array<{ id: string; title: string; characters: number }>
  >([]);
  const [sectionId, setSectionId] = useState(() =>
    target?.artifactId === artifact.id
      ? target.location.sectionId
      : (saved?.location.sectionId ?? ""),
  );
  const [section, setSection] = useState<ReadingSection | null>(null),
    [error, setError] = useState("");
  const [panel, setPanel] = useState<"contents" | "marks" | "settings" | null>(
    null,
  );
  const [selected, setSelected] = useState<
      (ReadingLocation & { x: number; y: number; markIds?: string[] }) | null
    >(null),
    [note, setNote] = useState<ReadingLocation | null>(null),
    [busy, setBusy] = useState(false);
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [editing, setEditing] = useState<ReadingMark | null>(null),
    [removed, setRemoved] = useState<ReadingMark | null>(null);
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const [retry, setRetry] = useState(0);
  const [ocrLine, setOcrLine] = useState(0);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!feedback) return;
    if (removed) return; // Keep the undo action available until dismissed.
    const timer = setTimeout(() => setFeedback(""), 2500);
    return () => clearTimeout(timer);
  }, [feedback, removed]);
  const article = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const restoredSection = useRef<ReadingSection | null>(null);
  const jump = useRef<ReadingLocation | null>(
    target?.artifactId === artifact.id
      ? target.location
      : (saved?.location ?? null),
  );
  const anchorJump = useRef<string | null>(null);
  const latest = useRef({ section, preferences, active });
  latest.current = { section, preferences, active };
  const progress = useRef<ReadingLocation | null>(saved?.location ?? null),
    progressQueue = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const marks = client.boot!.workspace.readingMarks.filter(
    (m) =>
      m.artifactId === artifact.id &&
      m.ownerPrincipalId === owner &&
      !m.deletedAt,
  );
  const sourceMarks = marks.filter(
    (m) =>
      section &&
      m.location.sourceId === section.sourceId &&
      m.location.sectionId === section.id,
  );
  const signature = JSON.stringify(sourceMarks.map((m) => [m.id, m.revision]));
  const selectedMarks = selected
    ? sourceMarks.filter((m) =>
        selected.markIds
          ? selected.markIds.includes(m.id)
          : m.location.start === selected.start &&
            m.location.end === selected.end,
      )
    : [];
  const highlightId = useId().replace(/[^a-z\d]/gi, "");
  const markClass = `reader-mark-${highlightId}`;
  const contextKey = `reading-${highlightId}`;
  const lastViewport = useRef<ReadingLocation | null>(null);
  const selectionScrollTop = useRef(0);
  const captureContext = useRef<() => ReadingFocus | null>(() => null);
  captureContext.current = () => {
    if (
      !section ||
      section.id !== sectionId ||
      !article.current ||
      !viewport.current ||
      error
    )
      return null;
    const selection =
      selected?.sourceId === section.sourceId &&
      selected.sectionId === section.id
        ? selected
        : null;
    // Full message history temporarily hides, but does not navigate away from,
    // this book. Keep its last visible position, never measure hidden geometry
    // or fall back to a different chapter's saved progress.
    const visible = viewport.current.getClientRects().length > 0;
    const measured = visible
      ? readerViewport(article.current, section.text, viewport.current)
      : null;
    if (measured)
      lastViewport.current = {
        sourceId: section.sourceId,
        sectionId: section.id,
        ...measured,
      };
    const remembered = lastViewport.current;
    const position =
      selection ??
      (visible
        ? measured
        : remembered?.sourceId === section.sourceId &&
            remembered.sectionId === section.id
          ? remembered
          : null);
    if (!position) return null;
    const { start, end } = position;
    const location = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start,
      end,
    };
    return selection
      ? {
          reference: readingReference(section, location),
          selected: true,
        }
      : {
          reference: readingPosition(section, location),
          selected: false,
        };
  };
  const publishContext = useRef(() => {});
  publishContext.current = () => {
    onContext?.(contextKey, {
      key: contextKey,
      artifactId: artifact.id,
      revision: version.revision,
      focus: captureContext.current(),
      capture: () => captureContext.current(),
    });
  };
  useLayoutEffect(() => {
    if (!onContext) return;
    publishContext.current();
    return () => onContext?.(contextKey, null);
  }, [active, section, sectionId, selected, preferences, error, onContext]);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const changed = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => publishContext.current());
    };
    const view = viewport.current,
      root = article.current;
    const size = new ResizeObserver(changed),
      content = new MutationObserver(changed);
    if (view) {
      size.observe(view);
      view.addEventListener("scroll", changed, { passive: true });
    }
    if (root) {
      size.observe(root);
      content.observe(root, { childList: true, subtree: true });
    }
    changed();
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      content.disconnect();
      view?.removeEventListener("scroll", changed);
    };
  }, [active, section]);
  const index = sections.findIndex(
    (s) => s.id === readingBaseSection(sectionId),
  );
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    void client
      .readingContents(artifact.id, version.revision, abort.signal)
      .then((rows) => {
        setSections(rows);
        setSectionId((old) =>
          rows.some((s) => s.id === readingBaseSection(old))
            ? old
            : (rows[0]?.id ?? ""),
        );
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [artifact.id, version.revision, active, retry]);
  useEffect(() => {
    if (!active || !sectionId) return;
    const abort = new AbortController();
    setError("");
    setSection(null);
    setSelected(null);
    void client
      .readReading(artifact.id, version.revision, sectionId, abort.signal)
      .then(setSection)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [artifact.id, version.revision, sectionId, active, retry]);
  useEffect(() => {
    if (
      !active ||
      !target ||
      target.artifactId !== artifact.id ||
      target.revision !== version.revision
    )
      return;
    jump.current = target.location;
    setSectionId(target.location.sectionId);
    setSelected(null);
    setRetry((n) => n + 1);
    if (target.requestId) onTargetConsumed(target.requestId);
  }, [target?.requestId, active]);
  function savePosition(
    location: ReadingLocation,
    prefs = latest.current.preferences,
  ) {
    progress.current = location;
    progressQueue.current = progressQueue.current
      .catch(() => {})
      .then(async () => {
        const snapshot = client.getSnapshot();
        if (
          snapshot?.principalId !== owner ||
          snapshot.centerId !== client.boot!.centerId
        )
          return;
        const previous = snapshot.workspace.readingStates.find(
          (p) => p.artifactId === artifact.id && p.ownerPrincipalId === owner,
        );
        if (
          previous?.artifactRevision === version.revision &&
          JSON.stringify(previous.location) === JSON.stringify(location) &&
          JSON.stringify(previous.preferences) === JSON.stringify(prefs)
        )
          return;
        await client.execute({
          type: "reader-command",
          command: {
            action: "save-position",
            artifactId: artifact.id,
            artifactRevision: version.revision,
            location,
            preferences: prefs,
            expectedRevision: previous?.revision ?? 0,
          },
        });
      })
      .catch((e) => onNotice(`阅读进度未保存：${e.message}`));
  }
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!section || !article.current || !viewport.current || !active) return;
    const root = article.current,
      view = viewport.current;
    // Updating a highlight must not scroll the reader back to the start.
    let restored = restoredSection.current === section;
    let citationTimer: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      const offsets = readerOffsets(root.textContent ?? "", section.text);
      if (!offsets) return;
      const registry = (CSS as unknown as { highlights?: Map<string, unknown> })
        .highlights;
      const Highlight = (
        window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
      ).Highlight;
      if (registry && Highlight)
        for (const color of ["yellow", "green", "blue", "pink"]) {
          for (const kind of ["highlight", "note"]) {
            const ranges = sourceMarks
              .filter(
                (m) =>
                  m.color === color &&
                  m.kind === kind &&
                  m.location.end > m.location.start,
              )
              .map((m) =>
                readerRange(
                  root,
                  offsets.sourceToDom[m.location.start]!,
                  offsets.sourceToDom[m.location.end]!,
                ),
              )
              .filter((r): r is Range => !!r);
            registry.set(
              `${markClass}-${kind === "note" ? "note-" : ""}${color}`,
              new Highlight(...ranges),
            );
          }
        }
      if (!restored) {
        restored = true;
        restoredSection.current = section;
        const location = jump.current;
        const anchor = anchorJump.current
          ? root.querySelector(`[id="${CSS.escape(anchorJump.current)}"]`)
          : null;
        anchorJump.current = null;
        if (anchor) {
          view.scrollTop +=
            anchor.getBoundingClientRect().top -
            view.getBoundingClientRect().top -
            32;
        } else if (
          location?.sectionId === section.id &&
          location.sourceId === section.sourceId &&
          location.start <= section.text.length
        ) {
          const range = readerRange(
            root,
            offsets.sourceToDom[location.start]!,
            offsets.sourceToDom[
              Math.min(section.text.length, location.start + 1)
            ]!,
          );
          if (range)
            view.scrollTop +=
              range.getBoundingClientRect().top -
              view.getBoundingClientRect().top -
              32;
          if (location.end > location.start && registry && Highlight) {
            const cited = readerRange(
              root,
              offsets.sourceToDom[location.start]!,
              offsets.sourceToDom[location.end]!,
            );
            if (cited) {
              registry.set(`${markClass}-citation`, new Highlight(cited));
              citationTimer = setTimeout(
                () => registry.delete(`${markClass}-citation`),
                1800,
              );
            }
          }
        } else view.scrollTop = 0;
        const current =
          location?.sectionId === section.id &&
          location.sourceId === section.sourceId &&
          location.start <= section.text.length
            ? location
            : {
                sourceId: section.sourceId,
                sectionId: section.id,
                start: 0,
                end: 0,
              };
        savePosition({ ...current, end: current.start });
        jump.current = null;
      }
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearTimeout(citationTimer);
      const h = (CSS as unknown as { highlights?: Map<string, unknown> })
        .highlights;
      for (const c of [
        "yellow",
        "green",
        "blue",
        "pink",
        "note-yellow",
        "note-green",
        "note-blue",
        "note-pink",
        "citation",
      ])
        h?.delete(`${markClass}-${c}`);
    };
  }, [section, signature, active]);
  function capture() {
    if (!section || !article.current || !active) return;
    try {
      const selection = readerSelection(article.current, section.text);
      if (!selection) {
        setSelected(null);
        return;
      }
      selectionScrollTop.current = viewport.current?.scrollTop ?? 0;
      setSelectionMenuOpen(true);
      setSelected({
        sourceId: section.sourceId,
        sectionId: section.id,
        start: selection.start,
        end: selection.end,
        x: selection.rect.left,
        y: selection.rect.bottom + 8,
      });
    } catch (e) {
      onNotice((e as Error).message);
    }
  }
  function openMarks(x: number, y: number) {
    if (!section || !article.current) return false;
    const hits = readerMarksAtPoint(
      article.current,
      section.text,
      sourceMarks,
      x,
      y,
    );
    if (!hits.length) return false;
    selectionScrollTop.current = viewport.current?.scrollTop ?? 0;
    setSelectionMenuOpen(true);
    setSelected({
      ...hits[0]!.location,
      x,
      y: y + 16,
      markIds: hits.map((m) => m.id),
    });
    return true;
  }
  function changeSection(id: string, location?: ReadingLocation) {
    clearTimeout(timer.current);
    setSelected(null);
    jump.current = location ?? null;
    setSectionId(id);
    if (location && id === sectionId) setRetry((n) => n + 1);
    if (section && id === section.id && !location)
      savePosition({
        sourceId: section.sourceId,
        sectionId: id,
        start: 0,
        end: 0,
      });
  }
  async function addMark(
    location: ReadingLocation,
    kind: ReadingMark["kind"],
    body = "",
  ) {
    if (!section) return;
    setBusy(true);
    try {
      await client.execute({
        type: "reader-command",
        command: {
          action: "mark-add",
          artifactId: artifact.id,
          artifactRevision: version.revision,
          location,
          quote: section.text.slice(location.start, location.end),
          kind,
          note: body,
          color: "yellow",
        },
      });
      if (currentSelection.current === selected) {
        setSelected(null);
        window.getSelection()?.removeAllRanges();
      }
      setNote(null);
      setRemoved(null);
      setFeedback(
        kind === "bookmark"
          ? "书签已保存"
          : kind === "note"
            ? "批注已保存"
            : "已高亮",
      );
    } catch (e) {
      onNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function ask(question: string) {
    if (!selected || !section) return;
    const { sourceId, sectionId, start, end } = selected;
    const result = onCompose(
      artifact.id,
      version.revision,
      readingReference(section, { sourceId, sectionId, start, end }),
      question,
    );
    if (!result.ok) onNotice(result.error ?? "输入尚未准备。");
    else setSelected(null);
  }
  async function changeMark(
    mark: ReadingMark,
    action: "mark-remove" | "mark-restore" | "mark-update",
    body = mark.note,
    color = mark.color,
  ) {
    setBusy(true);
    try {
      await client.execute({
        type: "reader-command",
        command:
          action === "mark-update"
            ? {
                action,
                markId: mark.id,
                expectedRevision: mark.revision,
                note: body,
                color,
              }
            : { action, markId: mark.id, expectedRevision: mark.revision },
      });
      if (action === "mark-remove")
        setRemoved({ ...mark, revision: mark.revision + 1 });
      else setRemoved(null);
      setEditing(null);
      if (
        (action !== "mark-update" || color === mark.color) &&
        currentSelection.current === selected
      ) {
        setSelected(null);
        window.getSelection()?.removeAllRanges();
      }
      setFeedback(
        action === "mark-remove"
          ? mark.kind === "bookmark"
            ? "书签已删除"
            : mark.kind === "note"
              ? "批注已删除"
              : "高亮已取消"
          : action === "mark-restore"
            ? "标注已恢复"
            : color !== mark.color
              ? "颜色已更新"
              : "批注已更新",
      );
    } catch (e) {
      onNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function setPrefs(next: ReadingPreferences) {
    setPreferences(next);
    if (section)
      savePosition(
        progress.current?.sectionId === section.id
          ? progress.current
          : {
              sourceId: section.sourceId,
              sectionId: section.id,
              start: 0,
              end: 0,
            },
        next,
      );
  }
  return (
    <section
      className="reading-app"
      data-theme={preferences.theme}
      aria-label={`阅读 ${version.title}`}
    >
      {feedback && (
        <div className="reader-status" role="status">
          <span>{feedback}</span>
          {removed && (
            <>
              <button
                disabled={busy}
                onClick={() => void changeMark(removed, "mark-restore")}
              >
                撤销
              </button>
              <button
                className="icon-button"
                aria-label="关闭标注提示"
                onClick={() => {
                  setRemoved(null);
                  setFeedback("");
                }}
              >
                <X />
              </button>
            </>
          )}
        </div>
      )}
      <style>
        {["yellow", "green", "blue", "pink", "citation"]
          .map(
            (c, i) =>
              `::highlight(${markClass}-${c}){background:${["#e3b72c55", "#66b38c55", "#5d9dc755", "#cd77a755", "#56d0de66"][i]};color:inherit;}`,
          )
          .join("")}
        {["yellow", "green", "blue", "pink"]
          .map(
            (c, i) =>
              `::highlight(${markClass}-note-${c}){text-decoration:underline 2px ${["#b99421", "#66b38c", "#5d9dc7", "#cd77a7"][i]};color:inherit;}`,
          )
          .join("")}
      </style>
      <header className="reader-toolbar">
        {onLibrary && (
          <button
            className="icon-button"
            title="全部读物"
            aria-label="全部读物"
            onClick={onLibrary}
          >
            <ArrowLeft />
          </button>
        )}
        <button
          className="icon-button"
          title="目录"
          aria-label="目录"
          aria-expanded={panel === "contents"}
          onClick={() => setPanel(panel === "contents" ? null : "contents")}
        >
          <List />
        </button>
        <h2 title={version.title}>{version.title}</h2>
        <span className="reader-page-count">
          {index >= 0 ? `${index + 1} / ${sections.length}` : ""}
        </span>
        <button
          className="icon-button"
          title="书签与批注"
          aria-label="书签与批注"
          aria-expanded={panel === "marks"}
          onClick={() => setPanel(panel === "marks" ? null : "marks")}
        >
          <StickyNote />
        </button>
        <button
          className="icon-button"
          title="阅读设置"
          aria-label="阅读设置"
          aria-expanded={panel === "settings"}
          onClick={() => setPanel(panel === "settings" ? null : "settings")}
        >
          <Settings2 />
        </button>
      </header>
      {version.content.kind === "publication" &&
        ["doc", "rtf"].includes(version.content.format) && (
          <p className="reader-format-note">
            此文件以文字形式阅读，不保留原排版与图片；原文件仍保留。
          </p>
        )}
      <div className="reader-layout">
        {panel && (
          <aside
            className="reader-panel"
            aria-label={
              panel === "contents"
                ? "阅读目录"
                : panel === "marks"
                  ? "阅读标注"
                  : "阅读设置"
            }
          >
            <div className="reader-panel-heading">
              <strong>
                {panel === "contents"
                  ? "目录"
                  : panel === "marks"
                    ? "书签与批注"
                    : "阅读设置"}
              </strong>
              <button
                className="icon-button"
                aria-label="关闭阅读侧栏"
                onClick={() => setPanel(null)}
              >
                <X />
              </button>
            </div>
            {panel === "contents" && (
              <nav>
                {sections.map((s) => (
                  <button
                    key={s.id}
                    aria-current={
                      s.id === readingBaseSection(sectionId)
                        ? "location"
                        : undefined
                    }
                    onClick={() => changeSection(s.id)}
                  >
                    {s.title}
                  </button>
                ))}
              </nav>
            )}
            {panel === "marks" && (
              <div className="reader-mark-list">
                <button
                  className="reader-secondary"
                  disabled={!section || busy}
                  onClick={() => {
                    if (section && article.current && viewport.current) {
                      const p = readerViewport(
                        article.current,
                        section.text,
                        viewport.current,
                      );
                      if (!p) {
                        onNotice("暂时无法定位，请稍后重试。");
                        return;
                      }
                      void addMark(
                        {
                          sourceId: section.sourceId,
                          sectionId: section.id,
                          start: p.start,
                          end: p.start,
                        },
                        "bookmark",
                      );
                    }
                  }}
                >
                  <Bookmark />
                  保存当前位置
                </button>
                {!marks.length && <p>暂无书签或标注</p>}
                {marks.map((m) => (
                  <div key={m.id} className="reader-mark">
                    <button
                      onClick={() =>
                        m.artifactRevision === version.revision
                          ? changeSection(m.location.sectionId, m.location)
                          : onJump({
                              artifactId: artifact.id,
                              revision: m.artifactRevision,
                              location: m.location,
                              requestId: crypto.randomUUID(),
                            })
                      }
                    >
                      <small>
                        {m.kind === "bookmark"
                          ? "书签"
                          : m.kind === "highlight"
                            ? "高亮"
                            : "批注"}{" "}
                        ·{" "}
                        {sections.find(
                          (s) =>
                            s.id === readingBaseSection(m.location.sectionId),
                        )?.title ?? "原文位置"}
                        {m.location.sectionId !==
                        readingBaseSection(m.location.sectionId)
                          ? " · OCR"
                          : ""}
                        {m.artifactRevision !== version.revision
                          ? ` · v${m.artifactRevision}`
                          : ""}
                      </small>
                      <blockquote>{m.quote || "从这里继续"}</blockquote>
                      {m.note && <p>{m.note}</p>}
                    </button>
                    <div className="reader-mark-tools">
                      {m.kind !== "bookmark" && (
                        <button
                          className="icon-button"
                          disabled={busy}
                          title="编辑批注"
                          aria-label={`编辑批注：${m.quote.slice(0, 20)}`}
                          onClick={() => setEditing(m)}
                        >
                          <Pencil />
                        </button>
                      )}
                      <button
                        className="icon-button"
                        disabled={busy}
                        title="移除标注"
                        aria-label="移除此标注"
                        onClick={() => void changeMark(m, "mark-remove")}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {panel === "settings" && (
              <div className="reader-settings">
                <label>
                  字号 <span>{preferences.fontSize}</span>
                  <input
                    aria-label="阅读字号"
                    type="range"
                    min="14"
                    max="32"
                    value={preferences.fontSize}
                    onChange={(e) =>
                      setPrefs({
                        ...preferences,
                        fontSize: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  字体
                  <select
                    aria-label="阅读字体"
                    value={preferences.font}
                    onChange={(e) =>
                      setPrefs({
                        ...preferences,
                        font: e.target.value as ReadingPreferences["font"],
                      })
                    }
                  >
                    <option value="serif">书刊衬线</option>
                    <option value="sans">简洁无衬线</option>
                  </select>
                </label>
                <label>
                  主题
                  <select
                    aria-label="阅读主题"
                    value={preferences.theme}
                    onChange={(e) =>
                      setPrefs({
                        ...preferences,
                        theme: e.target.value as ReadingPreferences["theme"],
                      })
                    }
                  >
                    <option value="system">跟随应用</option>
                    <option value="paper">暖纸</option>
                    <option value="night">夜读</option>
                  </select>
                </label>
              </div>
            )}
          </aside>
        )}
        <div
          className="reader-viewport"
          ref={viewport}
          tabIndex={0}
          aria-label="阅读正文"
          onKeyDown={(e) => {
            if (
              e.target !== e.currentTarget ||
              e.ctrlKey ||
              e.metaKey ||
              e.altKey
            )
              return;
            if (e.key === "ArrowRight" && sections[index + 1]) {
              e.preventDefault();
              changeSection(sections[index + 1]!.id);
            }
            if (e.key === "ArrowLeft" && sections[index - 1]) {
              e.preventDefault();
              changeSection(sections[index - 1]!.id);
            }
          }}
          onScroll={() => {
            // Scroll events can arrive after mouseup from the previous frame.
            // Only navigation after this selection invalidates its context.
            setSelected((current) =>
              selectionScrollTop.current === viewport.current?.scrollTop
                ? current
                : null,
            );
            if (!section || !article.current) return;
            clearTimeout(timer.current);
            const root = article.current,
              view = viewport.current!;
            timer.current = setTimeout(() => {
              if (
                !latest.current.active ||
                latest.current.section?.id !== section.id
              )
                return;
              const offsets = readerOffsets(
                root.textContent ?? "",
                section.text,
              );
              if (!offsets) return;
              const bounds = view.getBoundingClientRect();
              let low = 0,
                high = root.textContent?.length ?? 0;
              while (low < high) {
                const mid = (low + high) >>> 1,
                  r = readerRange(root, mid, Math.min(mid + 1, high));
                if (r && r.getBoundingClientRect().bottom < bounds.top + 24)
                  low = mid + 1;
                else high = mid;
              }
              const start = offsets.domToSource[low] ?? 0;
              savePosition({
                sourceId: section.sourceId,
                sectionId: section.id,
                start,
                end: start,
              });
            }, 700);
          }}
        >
          {error ? (
            <div className="reader-empty" role="alert">
              <p>{error}</p>
              <button onClick={() => setRetry((n) => n + 1)}>重试读取</button>
            </div>
          ) : !section ? (
            <p className="reader-loading" role="status">
              正在读取原文…
            </p>
          ) : (
            <>
              {version.content.kind === "pdf" && (
                <ReaderOcrControls
                  key={readingBaseSection(section.id)}
                  client={client}
                  artifactId={artifact.id}
                  revision={version.revision}
                  section={section}
                  active={active}
                  onOpen={changeSection}
                  onFocusLine={setOcrLine}
                />
              )}
              <div className={section.ocr ? "reader-ocr-compare" : undefined}>
                {section.ocr && version.content.kind === "pdf" && (
                  <aside
                    className="reader-ocr-original"
                    aria-label="OCR 原页对照"
                  >
                    <Suspense fallback={<p>正在打开原页…</p>}>
                      <ReaderPdf
                        assetId={version.content.assetId}
                        page={readingPage(section.id)}
                        ocr={section.ocr}
                        line={ocrLine}
                      />
                    </Suspense>
                  </aside>
                )}
                <div
                  ref={article}
                  className={`reader-text ${version.content.kind === "pdf" ? "reader-pdf" : ""}`}
                  style={
                    {
                      fontSize: preferences.fontSize,
                      fontFamily:
                        preferences.font === "serif"
                          ? '"Noto Serif CJK SC", "Songti SC", "STSong", serif'
                          : "system-ui, sans-serif",
                    } as CSSProperties
                  }
                  onMouseUp={capture}
                  onKeyUp={(e) => {
                    if (e.key === "Shift") capture();
                  }}
                  onClick={(e) => {
                    const a = (e.target as HTMLElement).closest("a[href]");
                    if (!a) {
                      if (!window.getSelection()?.toString())
                        openMarks(e.clientX, e.clientY);
                      return;
                    }
                    e.preventDefault();
                    const href = a.getAttribute("href")!;
                    const match = /^#reader:(section-\d+):(.*)$/.exec(href);
                    if (match) {
                      const anchorId = decodeURIComponent(match[2]!);
                      if (match[1] === section.id) {
                        article.current
                          ?.querySelector(`[id="${CSS.escape(anchorId)}"]`)
                          ?.scrollIntoView({ block: "center" });
                      } else {
                        anchorJump.current = anchorId;
                        changeSection(match[1]!);
                      }
                    } else if (href.startsWith("#")) {
                      const anchor = article.current?.querySelector(
                        `[id="${CSS.escape(href.slice(1))}"]`,
                      );
                      anchor?.scrollIntoView({ block: "center" });
                    }
                  }}
                  onContextMenu={(e) => {
                    if (openMarks(e.clientX, e.clientY)) e.preventDefault();
                  }}
                >
                  {version.content.kind === "pdf" && !section.ocr ? (
                    <Suspense fallback={<p role="status">正在打开 PDF…</p>}>
                      <ReaderPdf
                        assetId={version.content.assetId}
                        page={readingPage(section.id)}
                      />
                    </Suspense>
                  ) : (
                    <ReadingHtml html={section.html} />
                  )}
                </div>
              </div>
              {version.content.kind === "pdf" && !section.text.trim() && (
                <p className="reader-scan-notice">
                  这一页没有可选文字；可展开“扫描文字识别”，在本机识别后选择文字提问或标注。
                </p>
              )}
              <footer className="reader-navigation">
                <button
                  disabled={index <= 0}
                  onClick={() => changeSection(sections[index - 1]!.id)}
                >
                  <ChevronLeft />
                  上一{version.content.kind === "pdf" ? "页" : "章"}
                </button>
                <span>{section.title}</span>
                <button
                  disabled={index < 0 || index >= sections.length - 1}
                  onClick={() => changeSection(sections[index + 1]!.id)}
                >
                  下一{version.content.kind === "pdf" ? "页" : "章"}
                  <ChevronRight />
                </button>
              </footer>
            </>
          )}
        </div>
      </div>
      {selected &&
        selectionMenuOpen &&
        active &&
        !note &&
        !editing &&
        createPortal(
          <ReadingSelection
            x={selected.x}
            y={selected.y}
            onClose={() => setSelectionMenuOpen(false)}
          >
            {selectedMarks.map((mark) => (
              <div className="reader-selected-mark" key={mark.id}>
                {mark.note && <p>{mark.note}</p>}
                <div className="reader-selection-row">
                  <span
                    className="reader-mark-colors"
                    role="group"
                    aria-label="标注颜色"
                  >
                    {(
                      [
                        ["yellow", "黄色"],
                        ["green", "绿色"],
                        ["blue", "蓝色"],
                        ["pink", "粉色"],
                      ] as const
                    ).map(([color, label]) => (
                      <button
                        key={color}
                        aria-label={label}
                        title={label}
                        aria-pressed={mark.color === color}
                        data-color={color}
                        disabled={busy}
                        onClick={() =>
                          void changeMark(mark, "mark-update", mark.note, color)
                        }
                      >
                        <span />
                      </button>
                    ))}
                  </span>
                  {(mark.kind === "note" || mark.note) && (
                    <button disabled={busy} onClick={() => setEditing(mark)}>
                      <Pencil />
                      编辑批注
                    </button>
                  )}
                  {mark.kind === "highlight" && mark.note && (
                    <button
                      disabled={busy}
                      onClick={() => void changeMark(mark, "mark-update", "")}
                    >
                      <X />
                      删除批注
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void changeMark(mark, "mark-remove")}
                  >
                    <Trash2 />
                    {mark.kind === "note"
                      ? "删除批注"
                      : mark.note
                        ? "删除高亮及批注"
                        : "取消高亮"}
                  </button>
                </div>
              </div>
            ))}
            <div className="reader-selection-row">
              {!selectedMarks.some((m) => m.kind === "highlight") && (
                <button
                  disabled={busy}
                  title="高亮"
                  aria-label="高亮选文"
                  onClick={() => {
                    const { sourceId, sectionId, start, end } = selected;
                    void addMark(
                      { sourceId, sectionId, start, end },
                      "highlight",
                    );
                  }}
                >
                  <Highlighter />
                  高亮
                </button>
              )}
              {!selectedMarks.some((m) => m.kind === "note" || m.note) && (
                <button
                  disabled={busy}
                  title="添加批注"
                  aria-label="批注选文"
                  onClick={() => {
                    const { sourceId, sectionId, start, end } = selected;
                    setNote({ sourceId, sectionId, start, end });
                  }}
                >
                  <StickyNote />
                  批注
                </button>
              )}
              <button
                title="在原输入框中准备提问"
                onClick={() =>
                  ask("简短解释这段原文，优先解答字词、主语和指代。")
                }
              >
                解释这段
              </button>
              <button
                onClick={() => ask("解释选文中的关键字词和句法，简短说明。")}
              >
                字词
              </button>
              <button
                onClick={() => ask("这段涉及哪些人物和背景？区分原文与推测。")}
              >
                背景
              </button>
              <button onClick={() => ask("")}>
                <MessageCircle />
                提问
              </button>
            </div>
          </ReadingSelection>,
          document.body,
        )}
      {note && section && (
        <NoteDialog
          quote={section.text.slice(note.start, note.end)}
          busy={busy}
          onClose={() => setNote(null)}
          onSave={(body) => void addMark(note, "note", body)}
        />
      )}
      {editing && (
        <NoteDialog
          key={editing.id}
          quote={editing.quote}
          initial={editing.note}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(body) => void changeMark(editing, "mark-update", body)}
        />
      )}
    </section>
  );
}

function ReadingSelection({
  x,
  y,
  children,
  onClose,
}: {
  x: number;
  y: number;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const element = ref.current!;
    const position = () => {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(x, innerWidth - bounds.width - 12))}px`;
      element.style.top = `${Math.max(12, Math.min(y, innerHeight - bounds.height - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="reader-selection"
      role="toolbar"
      aria-label="阅读选文操作"
      onMouseDown={(event) => event.preventDefault()}
    >
      {children}
    </div>
  );
}

function NoteDialog({
  quote,
  initial = "",
  busy,
  onClose,
  onSave,
}: {
  quote: string;
  initial?: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    [body, setBody] = useState(initial);
  useModal(ref, input);
  return (
    <dialog
      ref={ref}
      className="create-dialog reader-note-dialog"
      aria-labelledby="reader-note-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) onSave(body);
        }}
      >
        <header>
          <h2 id="reader-note-title">{initial ? "编辑批注" : "添加批注"}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <blockquote>{quote}</blockquote>
        <textarea
          ref={input}
          aria-label="批注内容"
          placeholder="记下你的理解或疑问…"
          rows={4}
          maxLength={8000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !body.trim()}>
            {busy ? "保存中…" : "保存批注"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
