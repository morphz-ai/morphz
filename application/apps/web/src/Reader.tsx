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
import { RequestError } from "./application-transport.js";
import { projectDisplayLabel } from "./project-display-label.js";
import { useContentDirectory } from "./useContentDirectory.js";
import {
  readerOffsets,
  readerRange,
  readerSelection,
  readerViewport,
  readerSourceSpanAtPoint,
  readerMarksAtSourceSpan,
} from "./reader-dom.js";
import type { ReadingContextChange, ReadingFocus } from "./ReadingContext.js";
import { useModal } from "./useModal.js";
import "./reader.css";
import {
  readingBaseSection,
  readingPage,
} from "../../../packages/core/src/reader-ocr.js";
import { ReaderOcrControls } from "./ReaderOcrControls.js";
import { useTextQuotes } from "./TextQuotes.js";
import { captureTextQuote, quoteSource } from "./text-quote-dom.js";
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
  const directory = useContentDirectory(
    client,
    {
      ...(!globalLibrary ? { projectId } : {}),
      appIds: ["morphz.objects", "morphz.reader"],
      kinds: ["document", "pdf", "publication"],
      ...(query.trim() ? { query: query.trim() } : {}),
      sort: "updated",
    },
    !(artifact && readable(artifact.content)),
  );
  const loadedBooks = new Map(
    state.artifacts
      .filter((a) => readable(a.content))
      .map((book) => [book.id, book]),
  );
  const books = directory.items.map(
    (entry) => loadedBooks.get(entry.id) ?? entry,
  );
  useEffect(() => {
    const input = file.current;
    const cancel = () => onNativeDialog?.(false);
    input?.addEventListener("cancel", cancel);
    return () => input?.removeEventListener("cancel", cancel);
  }, [artifactId]);
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
        <label className="reader-library-search">
          <Search />
          <input
            type="search"
            aria-label="查找读物"
            placeholder="按书名查找"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="reader-library-count">
          {directory.count ?? books.length} 份读物
        </span>
        <button
          className="primary"
          aria-label={importing ? "正在导入读物" : "导入读物"}
          disabled={importing}
          onClick={() => {
            onNativeDialog?.(true);
            file.current?.click();
          }}
        >
          <Plus />
          {importing ? "正在导入…" : "导入"}
        </button>
      </header>
      {directory.error && (
        <p className="reader-empty" role="alert">
          {directory.error} <button onClick={directory.retry}>重试</button>
        </p>
      )}
      {!books.length &&
        !directory.busy &&
        !directory.error &&
        !query.trim() && (
          <div className="reader-empty">
            <BookOpen />
            <h3>暂无读物</h3>
            <p>EPUB · PDF · Markdown · Word · TXT · HTML · RTF</p>
          </div>
        )}
      {!books.length &&
        !directory.busy &&
        !directory.error &&
        !!query.trim() && <p className="reader-empty">没有找到相关读物。</p>}
      <ul className="reader-books">
        {books.map((a) => {
          const label =
            "content" in a && a.content.kind === "publication"
              ? {
                  epub: "EPUB",
                  pdf: "PDF",
                  docx: "DOCX",
                  doc: "DOC",
                  rtf: "RTF",
                  html: "HTML",
                  markdown: "Markdown",
                  text: "TXT",
                }[a.content.format]
              : ("content" in a ? a.content.kind : a.kind) === "pdf"
                ? "PDF"
                : "content" in a
                  ? "Markdown"
                  : a.kind === "publication"
                    ? "读物"
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
                    {"content" in a &&
                    a.content.kind === "publication" &&
                    a.content.author
                      ? `${a.content.author} · `
                      : ""}
                    {label}
                  </small>
                  {globalLibrary && (
                    <small>
                      {projectDisplayLabel(
                        state.projects.find((p) => p.id === a.projectId),
                      ) ?? "无项目"}
                    </small>
                  )}
                </span>
                <ArrowUpRight />
              </button>
            </li>
          );
        })}
      </ul>
      {directory.nextCursor && (
        <button
          type="button"
          className="outline content-load-more"
          disabled={directory.busy}
          onClick={() => void directory.loadMore()}
        >
          继续加载
        </button>
      )}
      <details className="reader-privacy">
        <summary>文件与阅读数据</summary>
        <p>文件保存到当前工作中心；连接远程中心时，文件会上传至该中心。</p>
        <p>选文会随提问提供给模型，其余原文由 Morphz 按需读取。</p>
      </details>
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
  onContext,
  onNotice,
}: ReaderProps & { artifact: Artifact }) {
  const textQuotes = useTextQuotes();
  const version = artifact.versions.find(
    (v) => v.revision === (revision ?? artifact.revision),
  )!;
  const isPdf =
    version.content.kind === "pdf" ||
    (version.content.kind === "publication" &&
      version.content.format === "pdf");
  const pdfAssetId =
    version.content.kind === "pdf" || version.content.kind === "publication"
      ? version.content.assetId
      : "";
  const pdfUrl =
    version.content.kind === "publication" && version.content.format === "pdf"
      ? `/api/reader/original?artifactId=${encodeURIComponent(artifact.id)}&revision=${version.revision}`
      : undefined;
  const owner = client.boot!.principalId;
  const centerId = client.boot!.centerId;
  const [visibleMarks, setVisibleMarks] = useState<ReadingMark[]>([]);
  const [visibleMarksReady, setVisibleMarksReady] = useState(false);
  const pendingMarkPoint = useRef<{
    section: ReadingSection;
    x: number;
    y: number;
    scrollTop: number;
    location: ReadingLocation;
  } | null>(null);
  const [marks, setMarks] = useState<ReadingMark[]>([]);
  const sidebarRows = useRef(marks);
  sidebarRows.current = marks;
  const [marksLoading, setMarksLoading] = useState(false);
  const [marksError, setMarksError] = useState("");
  const [marksRefresh, setMarksRefresh] = useState(0);
  const markReadGeneration = useRef(0);
  const marksPanel = useRef<HTMLElement>(null);
  const [visibleRange, setVisibleRange] = useState<ReadingLocation | null>(
    null,
  );
  const [readerReady, setReaderReady] = useState(false);
  const [preferences, setPreferences] = useState(() =>
    readingPreferencesSchema.parse({}),
  );
  const [sections, setSections] = useState<
    Array<{ id: string; title: string; characters: number }>
  >([]);
  const [sectionId, setSectionId] = useState(() =>
    target?.artifactId === artifact.id ? target.location.sectionId : "",
  );
  const [section, setSection] = useState<ReadingSection | null>(null),
    [error, setError] = useState("");
  const [panel, setPanel] = useState<"contents" | "marks" | "settings" | null>(
    null,
  );
  const [selected, setSelected] = useState<
      | (ReadingLocation & {
          x: number;
          y: number;
          markIds?: string[];
          hitLocation?: ReadingLocation;
        })
      | null
    >(null),
    [note, setNote] = useState<ReadingLocation | null>(null),
    [busy, setBusy] = useState(false);
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [editing, setEditing] = useState<ReadingMark | null>(null),
    [removed, setRemoved] = useState<ReadingMark | null>(null);
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  useEffect(() => {
    const cancel = () => {
      pendingMarkPoint.current = null;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", key);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", key);
    };
  }, [section, active]);
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
  const citationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const loadedAttempt = useRef<number | null>(null);
  const jump = useRef<ReadingLocation | null>(
    target?.artifactId === artifact.id ? target.location : null,
  );
  const anchorJump = useRef<string | null>(null);
  const latest = useRef({ section, preferences, active });
  latest.current = { section, preferences, active };
  const progress = useRef<ReadingLocation | null>(null),
    progressQueue = useRef(Promise.resolve());
  const positionRevision = useRef(0);
  const savedPosition = useRef<{
    location: ReadingLocation;
    preferences: ReadingPreferences;
  } | null>(null);
  const hydrated = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingPosition = useRef<ReadingLocation | null>(null);
  const sourceMarks = visibleMarks.filter(
    (m) =>
      section &&
      m.location.sourceId === section.sourceId &&
      m.location.sectionId === section.id,
  );
  const textSelection = selected && !selected.markIds ? selected : null;
  const focusedMarkRange =
    textSelection ??
    selected?.hitLocation ??
    pendingMarkPoint.current?.location;
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
    void progressQueue.current
      .then(() =>
        client.readingState(artifact.id, version.revision, abort.signal),
      )
      .then((state) => {
        if (abort.signal.aborted) return;
        positionRevision.current = state.position?.revision ?? 0;
        savedPosition.current = state.position
          ? {
              location: state.position.location,
              preferences: state.position.preferences,
            }
          : null;
        if (!hydrated.current && state.position) {
          setPreferences(state.position.preferences);
          progress.current = state.position.location;
          if (!target || target.artifactId !== artifact.id) {
            jump.current = state.position.location;
            setSectionId(state.position.location.sectionId);
          }
        }
        hydrated.current = true;
        setReaderReady(true);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [artifact.id, version.revision, active, retry, client.workspaceChangeRevision]);
  useEffect(() => {
    if (!active || !readerReady) return;
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
  }, [artifact.id, version.revision, active, retry, readerReady]);
  useEffect(() => {
    if (!active || !readerReady || !sectionId) return;
    // Switching applications only hides this reader. Reuse the loaded page so
    // returning does not clear its DOM, selection or scroll position.
    if (
      latest.current.section?.id === sectionId &&
      loadedAttempt.current === retry
    )
      return;
    const abort = new AbortController();
    setError("");
    setSection(null);
    setSelected(null);
    void client
      .readReading(artifact.id, version.revision, sectionId, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        loadedAttempt.current = retry;
        setSection(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [artifact.id, version.revision, sectionId, active, retry, readerReady]);
  useLayoutEffect(() => {
    const root = article.current,
      view = viewport.current;
    if (!active || !section || !root || !view) {
      setVisibleRange(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!root.getClientRects().length || !view.clientHeight) return;
        const range = readerViewport(root, section.text, view, "visible");
        if (!range) return; // Hidden or not-yet-rendered text grants no fallback.
        const next = {
          sourceId: section.sourceId,
          sectionId: section.id,
          ...range,
        };
        setVisibleRange((old) =>
          JSON.stringify(old) === JSON.stringify(next) ? old : next,
        );
      });
    };
    const sizes = new ResizeObserver(measure),
      changes = new MutationObserver(measure);
    sizes.observe(root);
    sizes.observe(view);
    changes.observe(root, { childList: true, subtree: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      changes.disconnect();
    };
  }, [section, active]);
  useEffect(() => {
    if (
      !active ||
      !section ||
      !visibleRange ||
      visibleRange.sourceId !== section.sourceId ||
      visibleRange.sectionId !== section.id
    )
      return;
    const abort = new AbortController(),
      generation = markReadGeneration.current;
    setVisibleMarksReady(false);
    const live = () =>
      !abort.signal.aborted && markReadGeneration.current === generation;
    const read = async () => {
      const collected = new Map<string, ReadingMark>();
      const ranges = [visibleRange];
      // A real text selection can extend beyond the scrolled viewport. Read
      // exactly that additional span, not the gap or the rest of the chapter,
      // so selecting an existing long highlight still offers its edit actions.
      if (
        focusedMarkRange &&
        focusedMarkRange.sourceId === section.sourceId &&
        focusedMarkRange.sectionId === section.id &&
        (focusedMarkRange.start < visibleRange.start ||
          focusedMarkRange.end > visibleRange.end)
      )
        ranges.push(focusedMarkRange);
      for (const range of ranges) {
        let after: string | undefined;
        do {
          const page = await client.readingMarks(
            {
              artifactId: artifact.id,
              revision: version.revision,
              sectionId: range.sectionId,
              start: range.start,
              end: range.end,
              ...(after ? { after } : {}),
              limit: 50,
            },
            abort.signal,
          );
          if (!live()) return;
          for (const mark of page.marks) collected.set(mark.id, mark);
          after = page.nextCursor ?? undefined;
        } while (after);
      }
      // Fetch dense ranges in bounded pages, then paint once. Repainting every
      // growing prefix would repeatedly traverse the same DOM ranges.
      if (live()) {
        setVisibleMarks([...collected.values()]);
        setVisibleMarksReady(true);
      }
    };
    // Scrolling already measures the exact visible span below. Coalesce
    // successive ranges instead of dispatching a query for every wheel frame.
    const delay = setTimeout(() => {
      void read().catch((e) => {
        if (live()) {
          setVisibleMarks([]);
          pendingMarkPoint.current = null;
          onNotice(e.message);
        }
      });
    }, 80);
    return () => {
      clearTimeout(delay);
      abort.abort();
    };
  }, [
    artifact.id,
    version.revision,
    section,
    visibleRange,
    focusedMarkRange?.sourceId,
    focusedMarkRange?.sectionId,
    focusedMarkRange?.start,
    focusedMarkRange?.end,
    active,
    marksRefresh,
    client.workspaceChangeRevision,
  ]);
  useEffect(() => {
    const view = marksPanel.current;
    if (panel !== "marks" || !active || !view) return;
    const abort = new AbortController(),
      generation = markReadGeneration.current;
    const live = () =>
      !abort.signal.aborted && markReadGeneration.current === generation;
    const targetCount = Math.max(50, sidebarRows.current.length);
    let after: string | undefined,
      done = false,
      pending = false,
      initial = true,
      frame = 0;
    const collected = new Map<string, ReadingMark>();
    const check = () => {
      if (
        view.clientHeight &&
        view.scrollTop + view.clientHeight >= view.scrollHeight - 120
      )
        void load();
    };
    const load = async () => {
      if (!live() || pending || done) return;
      pending = true;
      setMarksLoading(true);
      setMarksError("");
      try {
        do {
          const page = await client.readingMarks(
            {
              artifactId: artifact.id,
              revision: version.revision,
              ...(after ? { after } : {}),
              limit: 50,
            },
            abort.signal,
          );
          if (!live()) return;
          for (const mark of page.marks) collected.set(mark.id, mark);
          after = page.nextCursor ?? undefined;
          done = !after;
          // Refresh exactly the already displayed prefix before replacing it.
          // Repaint/undo must not shrink a two-page list back to page one.
        } while (initial && collected.size < targetCount && !done);
        initial = false;
        setMarks([...collected.values()]);
        frame = requestAnimationFrame(check);
      } catch (e) {
        if (live()) setMarksError((e as Error).message);
      } finally {
        pending = false;
        if (live()) setMarksLoading(false);
      }
    };
    const sizes = new ResizeObserver(check);
    sizes.observe(view);
    view.addEventListener("scroll", check, { passive: true });
    void load();
    return () => {
      abort.abort();
      cancelAnimationFrame(frame);
      sizes.disconnect();
      view.removeEventListener("scroll", check);
    };
  }, [artifact.id, version.revision, panel, active, marksRefresh, client.workspaceChangeRevision]);
  function refreshMarks() {
    markReadGeneration.current++;
    pendingMarkPoint.current = null;
    setVisibleMarksReady(false);
    setMarksRefresh((value) => value + 1);
  }
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
          !snapshot ||
          snapshot.principalId !== owner ||
          snapshot.centerId !== centerId
        )
          return;
        const previous = savedPosition.current;
        if (
          JSON.stringify(previous?.location) === JSON.stringify(location) &&
          JSON.stringify(previous?.preferences) === JSON.stringify(prefs)
        )
          return;
        const receipt = await client.readerCommand(
          artifact.id,
          version.revision,
          {
            action: "save-position",
            artifactId: artifact.id,
            artifactRevision: version.revision,
            location,
            preferences: prefs,
            expectedRevision: positionRevision.current,
          },
        );
        positionRevision.current = receipt.revision;
        savedPosition.current = { location, preferences: prefs };
      })
      .catch(async (error) => {
        // Another mounted view of this book may have committed the same
        // position first. Confirm the authoritative state before reporting a
        // failed save; a different position remains a real revision conflict.
        if (
          !(error instanceof RequestError) ||
          error.code === "conflict" ||
          error.status === 408 ||
          error.status >= 500
        ) {
          try {
            const current = (
              await client.readingState(artifact.id, version.revision)
            ).position;
            if (
              current &&
              JSON.stringify(current.location) === JSON.stringify(location) &&
              JSON.stringify(current.preferences) === JSON.stringify(prefs)
            ) {
              positionRevision.current = current.revision;
              savedPosition.current = {
                location: current.location,
                preferences: current.preferences,
              };
              return;
            }
          } catch {
            // Preserve the original write error if verification is unavailable.
          }
        }
        onNotice(`阅读进度未保存：${(error as Error).message}`);
      });
  }
  function flushPosition() {
    clearTimeout(timer.current);
    const pending = pendingPosition.current;
    pendingPosition.current = null;
    if (pending) savePosition(pending);
  }
  // Persist the last observed location, not geometry measured after the reader
  // has been hidden or unmounted. Fast navigation must not cancel the last save.
  useLayoutEffect(() => () => flushPosition(), []);
  useLayoutEffect(() => {
    if (!active) flushPosition();
  }, [active]);
  useEffect(
    () => () => {
      clearTimeout(citationTimer.current);
      citationTimer.current = undefined;
      (
        CSS as unknown as { highlights?: Map<string, unknown> }
      ).highlights?.delete(`${markClass}-citation`);
    },
    [section, active],
  );
  useEffect(() => {
    if (!section || !article.current || !viewport.current || !active) return;
    const root = article.current,
      view = viewport.current;
    // Updating a highlight must not scroll the reader back to the start.
    let restored = restoredSection.current === section;
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
        const location = jump.current ?? progress.current;
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
            view.scrollTop =
              location.start === 0
                ? 0
                : view.scrollTop +
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
              clearTimeout(citationTimer.current);
              citationTimer.current = setTimeout(() => {
                registry.delete(`${markClass}-citation`);
                citationTimer.current = undefined;
              }, 1800);
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
      ])
        h?.delete(`${markClass}-${c}`);
    };
  }, [section, signature, active]);
  useEffect(() => {
    const pending = pendingMarkPoint.current;
    if (pending && visibleMarksReady) {
      pendingMarkPoint.current = null;
      if (
        active &&
        pending.section === section &&
        pending.scrollTop === viewport.current?.scrollTop
      )
        openMarks(pending.x, pending.y, pending.location);
    }
    const selection = currentSelection.current,
      root = article.current;
    if (
      !active ||
      !section ||
      !root ||
      !visibleMarksReady ||
      !selection?.hitLocation ||
      selection.sourceId !== section.sourceId ||
      selection.sectionId !== section.id
    )
      return;
    const markIds = readerMarksAtSourceSpan(
      sourceMarks,
      selection.hitLocation,
    ).map((mark) => mark.id);
    // Reconcile only a complete current read against the source glyph. Old
    // viewport pixels change meaning on reflow; they are not mark identity.
    if (JSON.stringify(markIds) !== JSON.stringify(selection.markIds))
      setSelected((current) =>
        current !== selection
          ? current
          : markIds.length
            ? { ...current, markIds }
            : null,
      );
  }, [section, signature, active, visibleMarksReady]);
  function capture() {
    pendingMarkPoint.current = null;
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
  function openMarks(x: number, y: number, location?: ReadingLocation) {
    if (!section || !article.current) return false;
    const span =
      location ?? readerSourceSpanAtPoint(article.current, section.text, x, y);
    if (!span) return false;
    const hitLocation = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start: span.start,
      end: span.end,
    };
    const hits = readerMarksAtSourceSpan(sourceMarks, hitLocation);
    if (!hits.length) {
      // The original text can render before its authorized annotation page.
      // Preserve this first click only until that exact visible read finishes;
      // never turn it into a selection or manufacture a mark from the write.
      pendingMarkPoint.current = visibleMarksReady
        ? null
        : {
            section,
            x,
            y,
            scrollTop: viewport.current?.scrollTop ?? 0,
            location: hitLocation,
          };
      return false;
    }
    pendingMarkPoint.current = null;
    selectionScrollTop.current = viewport.current?.scrollTop ?? 0;
    setSelectionMenuOpen(true);
    setSelected({
      ...hits[0]!.location,
      x,
      y: y + 16,
      markIds: hits.map((m) => m.id),
      hitLocation,
    });
    return true;
  }
  function changeSection(id: string, location?: ReadingLocation) {
    flushPosition();
    pendingMarkPoint.current = null;
    setSelected(null);
    jump.current =
      location ??
      (section?.id === id
        ? { sourceId: section.sourceId, sectionId: id, start: 0, end: 0 }
        : null);
    setSectionId(id);
    // A deliberate TOC click navigates even if that chapter is already open.
    // Saving zero without restoring the viewport would leave the two out of sync.
    if (id === sectionId) setRetry((n) => n + 1);
  }
  async function addMark(
    location: ReadingLocation,
    kind: ReadingMark["kind"],
    body = "",
  ) {
    if (!section) return;
    setBusy(true);
    try {
      await client.readerCommand(artifact.id, version.revision, {
        action: "mark-add",
        artifactId: artifact.id,
        artifactRevision: version.revision,
        location,
        quote: section.text.slice(location.start, location.end),
        kind,
        note: body,
        color: "yellow",
      });
      refreshMarks();
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
    const captured = captureTextQuote();
    textQuotes?.comment({
      point: { x: selected.x + 300, y: selected.y },
      quote: {
        id: crypto.randomUUID(),
        text: section.text.slice(start, end),
        comment: question,
        ...(captured?.quote.anchor ? { anchor: captured.quote.anchor } : {}),
        source: {
          kind: "reading",
          artifactId: artifact.id,
          revision: version.revision,
          projectId: artifact.projectId,
          title: version.title,
          chapter: section.title,
          location: { sourceId, sectionId, start, end },
        },
      },
    });
    setSelected(null);
    setSelectionMenuOpen(false);
  }
  async function changeMark(
    mark: ReadingMark,
    action: "mark-remove" | "mark-restore" | "mark-update",
    body = mark.note,
    color = mark.color,
  ) {
    setBusy(true);
    try {
      const receipt = await client.readerCommand(
        artifact.id,
        version.revision,
        action === "mark-update"
          ? {
              action,
              markId: mark.id,
              expectedRevision: mark.revision,
              note: body,
              color,
            }
          : { action, markId: mark.id, expectedRevision: mark.revision },
      );
      refreshMarks();
      const apply = (rows: ReadingMark[]) =>
        action === "mark-remove"
          ? rows.filter((row) => row.id !== mark.id)
          : rows.map((row) =>
              row.id === mark.id
                ? {
                    ...row,
                    revision: receipt.revision,
                    note: body,
                    color,
                    deletedAt: null,
                  }
                : row,
            );
      setVisibleMarks(apply);
      setMarks(apply);
      if (action === "mark-remove")
        setRemoved({ ...mark, revision: receipt.revision });
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
    flushPosition();
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
            ref={marksPanel}
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
                {!marks.length && !marksLoading && !marksError && (
                  <p>暂无书签或标注</p>
                )}
                {marksError && (
                  <p role="alert">
                    {marksError}{" "}
                    <button onClick={refreshMarks}>重试读取</button>
                  </p>
                )}
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
                {marksLoading && <p role="status">正在读取标注…</p>}
              </div>
            )}
            {panel === "settings" && (
              <div className="reader-settings">
                {(!isPdf || section?.ocr) && (
                  <>
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
                  </>
                )}
                <label>
                  {isPdf && !section?.ocr ? "背景" : "主题"}
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
            if (
              pendingMarkPoint.current?.scrollTop !==
              viewport.current?.scrollTop
            )
              pendingMarkPoint.current = null;
            // Scroll events can arrive after mouseup from the previous frame.
            // Only navigation after this selection invalidates its context.
            setSelected((current) =>
              selectionScrollTop.current === viewport.current?.scrollTop
                ? current
                : null,
            );
            if (
              !active ||
              !section ||
              !article.current ||
              restoredSection.current !== section
            )
              return;
            clearTimeout(timer.current);
            const position = readerViewport(
              article.current,
              section.text,
              viewport.current!,
              "visible",
            );
            if (!position) return;
            const range = {
              sourceId: section.sourceId,
              sectionId: section.id,
              ...position,
            };
            setVisibleRange((old) =>
              JSON.stringify(old) === JSON.stringify(range) ? old : range,
            );
            const location = {
              sourceId: section.sourceId,
              sectionId: section.id,
              start: position.start,
              end: position.start,
            };
            progress.current = location;
            pendingPosition.current = location;
            timer.current = setTimeout(flushPosition, 700);
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
              {isPdf && (
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
                {section.ocr && isPdf && (
                  <aside
                    className="reader-ocr-original"
                    aria-label="OCR 原页对照"
                  >
                    <Suspense fallback={<p>正在打开原页…</p>}>
                      <ReaderPdf
                        assetId={pdfAssetId}
                        url={pdfUrl}
                        page={readingPage(section.id)}
                        ocr={section.ocr}
                        line={ocrLine}
                      />
                    </Suspense>
                  </aside>
                )}
                <div
                  ref={article}
                  data-quote-menu="local"
                  {...quoteSource({
                    kind: "reading",
                    projectId: artifact.projectId,
                    artifactId: artifact.id,
                    revision: version.revision,
                    title: version.title,
                    chapter: section.title,
                    location: {
                      sourceId: section.sourceId,
                      sectionId: section.id,
                      start: 0,
                      end: 0,
                    },
                  })}
                  className={`reader-text ${isPdf ? "reader-pdf" : ""}`}
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
                  {isPdf && !section.ocr ? (
                    <Suspense fallback={<p role="status">正在打开 PDF…</p>}>
                      <ReaderPdf
                        assetId={pdfAssetId}
                        url={pdfUrl}
                        page={readingPage(section.id)}
                      />
                    </Suspense>
                  ) : (
                    <ReadingHtml html={section.html} />
                  )}
                </div>
              </div>
              {isPdf && !section.text.trim() && (
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
                  上一{isPdf ? "页" : "章"}
                </button>
                <span>{section.title}</span>
                <button
                  disabled={index < 0 || index >= sections.length - 1}
                  onClick={() => changeSection(sections[index + 1]!.id)}
                >
                  下一{isPdf ? "页" : "章"}
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
                title="解释选文"
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
                评论
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
