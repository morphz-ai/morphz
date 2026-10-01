import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  scriptLocationSchema,
  type ScriptLocation,
} from "../../../packages/core/src/script-delivery.js";
import {
  ArrowLeft,
  Download,
  FilePlus2,
  Folder,
  PanelLeft,
  Sparkles,
  Settings2,
  X,
} from "lucide-react";
import { flushSync } from "react-dom";
import type { ApplicationInstance } from "../../../packages/core/src/applications.js";
import {
  harnessReadinessError,
  scriptStudioApplication,
} from "../../../packages/core/src/applications.js";
import {
  emptyScriptDraft,
  scriptItemKinds,
  scriptKindLabels,
  scriptIssues,
  scriptStructureIssues,
  scriptImpact,
  type ScriptCommand,
  type ScriptGeneration,
  type ScriptItem,
} from "../../../packages/core/src/script-studio.js";
import { buildScriptDocx } from "../../../packages/core/src/script-studio-docx.js";
import type { Receipt } from "../../../packages/core/src/model.js";
import { spaceKind } from "../../../packages/core/src/model.js";
import { contentOwnershipTitle } from "../../../packages/core/src/content.js";
import { ContentMetadata } from "./ContentMetadata.js";
import type { CatalogContentEntry } from "./catalog-content-entries.js";
import { scopedStorage, type WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";
import { ScriptItemEditor } from "./ScriptStudioEditor.js";
import { scriptFocusReturn } from "./script-studio-focus.js";
import { scriptDisplayTime } from "../../../packages/core/src/script-studio-presentation.js";
import type { ScriptEditorProduction } from "./script-editor-reader.js";
import type { ScriptDirectoryItem } from "../../../packages/core/src/script-editor.js";
import { useScriptEditorRead } from "./useScriptEditorRead.js";
import {
  ScriptStudioNavigation,
  scriptCreateLabels,
} from "./ScriptStudioNavigation.js";
import "./script-studio.css";
import { ScriptStudioLibrary } from "./ScriptStudioLibrary.js";
import { ComposerOptions } from "./ComposerOptions.js";

type Props = {
  client: WorkspaceClient;
  instance: ApplicationInstance;
  activeView: boolean;
  locationRequest?: ScriptLocation & {
    requestId: string;
    view?: "library" | "editor";
  };
  onNavigate?: (
    productionId: string,
    itemId: string,
    view: "library" | "editor",
  ) => void;
  onCompose: (
    text: string,
    generation?: ScriptGeneration,
  ) => ScriptComposeResult;
  onConceive: () => void;
  globalLibrary?: boolean;
  onOpenScript: (id: string, itemId?: string) => void;
  onLibrary: () => void;
  onNotice: (text: string) => void;
  onNativeDialog?: (open: boolean) => void;
};
export type ScriptComposeResult = { ok: true } | { ok: false; error: string };
export type ScriptRun = (command: ScriptCommand) => Promise<Receipt>;
export function StudioDialog({
  title,
  children,
  onClose,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModal(dialog);
  return (
    <dialog
      ref={dialog}
      className={`create-dialog script-dialog${compact ? " script-dialog-compact" : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export const scriptStatusLabels = {
  draft: "草稿",
  "in-review": "待审",
  approved: "已批准",
  locked: "已锁稿",
};

export function ScriptStudio({
  client,
  instance,
  activeView,
  locationRequest,
  onNavigate,
  onCompose,
  onConceive,
  globalLibrary = false,
  onOpenScript,
  onLibrary,
  onNotice,
  onNativeDialog,
}: Props) {
  const boot = client.boot!;
  const storage = scopedStorage(`${boot.centerId}:${boot.principalId}`);
  const locationKey = `script-location:${instance.id}`;
  const initial = storage.readLocal<{
    productionId?: string;
    itemId?: string;
    view?: "library" | "editor";
  }>(locationKey, instance.state);
  const [productionId, setProductionId] = useState(initial.productionId ?? "");
  const [itemId, setItemId] = useState(initial.itemId ?? "");
  const [view, setView] = useState(initial.view ?? "library");
  const [organizing, setOrganizing] = useState<CatalogContentEntry | null>(
    null,
  );
  useLayoutEffect(() => {
    if (
      instance.state.navigationId &&
      instance.state.scriptTarget === null &&
      instance.state.view === "library"
    ) {
      setView("library");
      storage.writeLocal(locationKey, {
        productionId: initial.productionId ?? "",
        itemId: initial.itemId ?? "",
        view: "library",
      });
    }
  }, [instance.state.navigationId]);
  const [deliveryTarget, setDeliveryTarget] = useState<
    (ScriptLocation & { requestId: string }) | null
  >(null);
  const savedTarget = scriptLocationSchema.safeParse(
    instance.state.scriptTarget,
  );
  const externalTarget =
    locationRequest ??
    (savedTarget.success && typeof instance.state.navigationId === "string"
      ? { ...savedTarget.data, requestId: instance.state.navigationId }
      : null);
  const externalKey = JSON.stringify(externalTarget);
  const externalProductionReady = Boolean(
    externalTarget &&
    boot.scriptLibrary.find((entry) => entry.id === externalTarget.productionId)
      ?.projectId === instance.workspaceId,
  );
  useLayoutEffect(() => {
    if (!externalTarget || !externalProductionReady) return;
    setProductionId(externalTarget.productionId);
    setItemId(externalTarget.itemId ?? "");
    const nextView = locationRequest?.view ?? "editor";
    setView(nextView);
    setDeliveryTarget(externalTarget);
    try {
      storage.writeLocal(locationKey, {
        productionId: externalTarget.productionId,
        itemId: externalTarget.itemId ?? "",
        view: nextView,
      });
    } catch {
      onNotice("定位暂时无法保存；文稿未受影响。");
    }
  }, [externalKey, externalProductionReady]);
  const [query, setQuery] = useState("");
  const space = boot.workspace.projects.find(
    (p) => p.id === instance.workspaceId,
  )!;
  const [dialog, setDialog] = useState<
    "production" | "item" | "settings" | null
  >(null);
  const [createDefaults, setCreateDefaults] = useState<{
    kind: ScriptItem["kind"];
    parentId?: string;
  }>({ kind: "episode" });
  const openCreate = (kind: ScriptItem["kind"], parentId?: string) => {
    setCreateDefaults({ kind, parentId });
    setDialog("item");
  };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportStatus, setExportStatus] = useState<{
    productionId: string;
    message: string;
  } | null>(null);
  const studio = useRef<HTMLElement>(null);
  const libraryFocus = useRef<{ id: string; anchor: Element | null } | null>(
    null,
  );
  const editorFocus = useRef<{
    productionId: string;
    itemId?: string;
    anchor: Element | null;
  } | null>(null);
  useEffect(() => {
    // A delayed directory page must not steal focus after another user action.
    const cancel = () => {
      libraryFocus.current = null;
      editorFocus.current = null;
    };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
    };
  }, []);
  const directoryId = useId();
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const directoryPreference = `script-directory-visible:${instance.id}`;
  const [wideDirectoryOpen, setWideDirectoryOpen] = useState(() =>
    storage.readLocal(directoryPreference, true),
  );
  const [compactDirectory, setCompactDirectory] = useState(false);
  const [narrowDirectoryOpen, setNarrowDirectoryOpen] = useState(false);
  const directoryOpen = compactDirectory
    ? narrowDirectoryOpen
    : wideDirectoryOpen;
  function closeDirectory(restoreFocus = true) {
    if (compactDirectory) setNarrowDirectoryOpen(false);
    else {
      setWideDirectoryOpen(false);
      try {
        storage.writeLocal(directoryPreference, false);
      } catch {
        onNotice("目录显示状态暂时无法保存；文稿未受影响。");
      }
    }
    if (restoreFocus) directoryTrigger.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    const element = studio.current!;
    let previousCompact = false;
    const measure = () => {
      const compact = element.clientWidth <= 680;
      if (previousCompact !== compact) {
        // Moving to a drawer must not leave focus in a now-hidden directory.
        if (
          document.getElementById(directoryId)?.contains(document.activeElement)
        )
          directoryTrigger.current?.focus({ preventScroll: true });
        setNarrowDirectoryOpen(false);
      }
      previousCompact = compact;
      setCompactDirectory(compact);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [directoryId]);
  useEffect(() => {
    if (!compactDirectory || !directoryOpen) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !document.getElementById(directoryId)?.contains(target) &&
        !directoryTrigger.current?.contains(target)
      )
        setNarrowDirectoryOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [compactDirectory, directoryOpen, directoryId]);
  const exportHistory = useRef<HTMLDetailsElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportSelection, setExportSelection] = useState<{
    production: ScriptEditorProduction;
    trigger: HTMLButtonElement;
  } | null>(null);
  const savingRef = useRef(false);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const catalogEntry = boot.scriptLibrary.find(
    (entry) =>
      entry.id === productionId && entry.projectId === instance.workspaceId,
  );
  const editorRead = useScriptEditorRead(
    `${boot.csrfToken}:${productionId}`,
    catalogEntry?.activityRevision ?? 0,
    () => client.readScriptEditor(productionId),
    view === "editor" && !!productionId && !!catalogEntry,
  );
  const production = catalogEntry ? editorRead.value : undefined;
  const [issuesOpen, setIssuesOpen] = useState(false);
  const reviewRead = useScriptEditorRead(
    `issues:${boot.csrfToken}:${productionId}`,
    production?.activityRevision ?? 0,
    () => client.readScriptEditorPage(production!, "reviews"),
    !!production && issuesOpen,
  );
  const issues = production
    ? reviewRead.value
      ? scriptIssues({
          head: production,
          items: production.items,
          reviews: reviewRead.value.reviews,
        })
      : scriptStructureIssues({ head: production, items: production.items })
    : [];
  const exportRead = useScriptEditorRead(
    `exports:${boot.csrfToken}:${productionId}`,
    production?.activityRevision ?? 0,
    async () => {
      const headers = await client.readScriptEditorPage(production!, "exports");
      const result = [];
      for (const header of headers.exports) {
        const record = await client.readScriptExport(production!, header.id);
        const titles = [];
        for (const ref of record.items) {
          const title = await client.readScriptVersionTitle(
            production!,
            ref.itemId,
            ref.revision,
          );
          titles.push(`${title} · v${ref.revision}`);
        }
        result.push({ ...record, titles });
      }
      return result;
    },
    !!production && historyOpen,
  );
  const currentProductionRef = useRef(production?.id);
  currentProductionRef.current = production?.id;
  const item = production?.items.find((i) => i.id === itemId);
  const sorted = [...(production?.items ?? [])].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const library = view === "library" || !productionId || !catalogEntry;
  const canWrite =
    activeView &&
    client.online &&
    !busy &&
    !saving &&
    (library || editorRead.fresh);
  function restoreEditorFocus() {
    const request = editorFocus.current;
    if (
      !request ||
      library ||
      !activeView ||
      request.productionId !== production?.id ||
      (request.itemId && request.itemId !== item?.id)
    )
      return;
    const target = editorFocusTarget();
    if (!target) return;
    editorFocus.current = null;
    if (
      document.activeElement === document.body ||
      document.activeElement === request.anchor
    )
      target.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    restoreEditorFocus();
  }, [library, item?.id, production?.id, activeView]);
  const executionIssue =
    boot.runtime.configured && boot.runtime.connected
      ? harnessReadinessError(
          scriptStudioApplication.harness!,
          boot.runtime.harnesses,
        )
      : null;
  const choose = (
    nextProduction: string,
    nextItem = "",
    nextView: "library" | "editor" = "editor",
  ) => {
    libraryFocus.current = null;
    editorFocus.current = null;
    setError("");
    setDeliveryTarget(null);
    if (nextProduction !== production?.id) {
      setExportStatus(null);
      setHistoryOpen(false);
    }
    setProductionId(nextProduction);
    setItemId(nextItem);
    setView(nextView);
    onNavigate?.(nextProduction, nextItem, nextView);
    try {
      storage.writeLocal(locationKey, {
        productionId: nextProduction,
        itemId: nextItem,
        view: nextView,
      });
    } catch {
      onNotice("定位暂时无法保存；文稿未受影响。");
    }
    // Only view location enters application state, never text or a generation request.
    void client
      .execute({
        type: "set-application-state",
        instanceId: instance.id,
        expectedRevision: instance.revision,
        state: {
          productionId: nextProduction,
          itemId: nextItem,
          view: nextView,
        },
      })
      .catch((e) => onNotice(`定位同步失败：${e.message}；本机定位已保留。`));
  };
  const showLibrary = () => {
    if (globalLibrary && spaceKind(space) === "project") {
      onLibrary();
      return;
    }
    flushSync(() => choose(production?.id ?? "", itemId, "library"));
    // The directory arrives asynchronously. Focus a stable control while
    // loading, then return to the card only if the user has not moved on.
    const card = Array.from(
      studio.current?.querySelectorAll<HTMLElement>("[data-production-id]") ??
        [],
    ).find((element) => element.dataset.productionId === production?.id);
    (
      card ??
      studio.current?.querySelector<HTMLElement>('[aria-label="查找剧本"]')
    )?.focus({ preventScroll: true });
    if (!card && production)
      libraryFocus.current = {
        id: production.id,
        anchor: document.activeElement,
      };
  };
  const run: ScriptRun = async (command) => {
    if (!activeView || !client.online || working.current)
      throw new Error("请在已连接的剧本工作区操作。");
    working.current = true;
    // A rejected modal command stays open. Its temporarily disabled submit
    // button needs its own return path; the workspace path must not escape it.
    const restoreDialogFocus = scriptFocusReturn(
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        "dialog",
      ) ?? null,
    );
    const restoreFocus = scriptFocusReturn(
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        ".script-editor",
      ) ?? studio.current,
    );
    setBusy(true);
    setError("");
    try {
      return await client.execute({ type: "script-command", command });
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
      // Export owns a longer native-picker lifecycle. Restoring here while its
      // trigger is still disabled focuses the editor fallback; the picker then
      // mistakes that programmatic move for newer user navigation.
      if (command.action !== "record-export") {
        restoreDialogFocus();
        restoreFocus();
      }
    }
  };
  function focusCreated(nextProductionId: string, nextItemId?: string) {
    editorFocus.current = {
      productionId: nextProductionId,
      itemId: nextItemId,
      anchor: document.activeElement,
    };
    requestAnimationFrame(restoreEditorFocus);
  }
  function editorFocusTarget() {
    if (
      !alive.current ||
      !activeViewRef.current ||
      document.querySelector("dialog[open]")
    )
      return null;
    return (
      studio.current?.querySelector<HTMLElement>(
        '.script-editor [aria-label="文稿标题"]',
      ) ??
      studio.current?.querySelector<HTMLElement>("[data-script-focus-anchor]")
    );
  }
  async function download(
    p: ScriptEditorProduction,
    existingExportId: string | null,
    trigger: HTMLButtonElement,
    selection?: { itemId: string; revision: number }[],
    workingCopy = false,
  ) {
    if (!activeView || !client.online || savingRef.current || working.current)
      return;
    savingRef.current = true;
    const identity = { centerId: boot.centerId, principalId: boot.principalId };
    const sameView = () =>
      alive.current &&
      activeViewRef.current &&
      currentProductionRef.current === p.id &&
      client.getSnapshot()?.centerId === identity.centerId &&
      client.getSnapshot()?.principalId === identity.principalId &&
      trigger.isConnected &&
      trigger.getClientRects().length > 0;
    let nativeDialog = false;
    setSaving(true);
    setError("");
    setExportStatus(null);
    try {
      let exportId = existingExportId;
      if (!exportId) {
        if (!selection?.length) throw new Error("请选择需要导出的分集或分场。");
        const receipt = await run({
          action: "record-export",
          productionId: p.id,
          expectedRevision: p.revision,
          items: selection,
          template: p.template,
          ...(workingCopy ? { workingCopy: true as const } : {}),
        });
        const snapshot = client.getSnapshot();
        if (
          !snapshot ||
          snapshot.centerId !== identity.centerId ||
          snapshot.principalId !== identity.principalId
        )
          throw new Error("身份已变化，未保存文件。");
        exportId = receipt.entityId;
      }
      if (!sameView())
        throw new Error("工作现场已变化，请从原剧本导出历史重试。");
      if (window.morphzDesktop?.application) {
        if (!window.morphzDesktop.scriptExports)
          throw new Error("当前桌面尚未提供剧本保存接口；请更新桌面后重试。");
        if (!p.contentId) throw new Error("剧本目录尚未就绪，请刷新后重试。");
        nativeDialog = true;
        // Suspend composer auto-collapse before the native dialog can blur the app.
        flushSync(() => onNativeDialog?.(true));
        const receipt = await window.morphzDesktop.scriptExports.save({
          ...identity,
          contentId: p.contentId,
          productionId: p.id,
          exportId,
        });
        if (receipt.exportId !== exportId)
          throw new Error("保存回执与导出记录不一致。");
        if (sameView())
          setExportStatus({
            productionId: p.id,
            message:
              receipt.status === "saved"
                ? `Word 已保存：${receipt.filename}（${receipt.bytes} 字节）${
                    receipt.warning === "temporary-file-cleanup-failed"
                      ? "；临时文件清理失败，请检查保存目录中的 .morphz-script-*.tmp，无需重复导出。"
                      : ""
                  }`
                : "已取消保存；可到概览的导出历史重新下载。",
          });
        return;
      }
      const bytes = buildScriptDocx(
        await client.readScriptExportManifest(p, exportId),
      );
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${p.title.replace(/[\\/:*?"<>|]/g, "_")}-${exportId.slice(0, 8)}.docx`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (sameView())
        setExportStatus({
          productionId: p.id,
          message: "Word 文件已生成并发起下载；保存位置以浏览器下载结果为准。",
        });
    } catch (e) {
      if (sameView())
        setError(
          `文件生成或保存失败：${(e as Error).message}。导出版本记录保留，可重试。`,
        );
    } finally {
      savingRef.current = false;
      // Commit the enabled state before restoring focus. A frame callback may
      // run before React commits batched async updates; focusing a still-disabled
      // trigger silently leaves focus on <body>, even when the window is active.
      flushSync(() => {
        if (alive.current) setSaving(false);
        if (nativeDialog) onNativeDialog?.(false);
      });
      requestAnimationFrame(() => {
        // Never steal focus from newer navigation or a different control.
        if (
          sameView() &&
          (document.activeElement === document.body ||
            document.activeElement === trigger)
        )
          trigger.focus({ preventScroll: true });
      });
    }
  }
  return (
    <section
      ref={studio}
      className="script-studio"
      aria-label="剧本工作区"
      aria-busy={busy}
    >
      <header className="script-toolbar">
        {!library && (
          <button
            ref={directoryTrigger}
            type="button"
            className="script-directory-toggle"
            aria-label="剧本目录开关"
            aria-expanded={directoryOpen}
            aria-controls={directoryId}
            title={`${directoryOpen ? "收起" : "展开"}目录 · ${item ? item.title : "概览"}`}
            onClick={() => {
              if (directoryOpen) closeDirectory();
              else if (compactDirectory) setNarrowDirectoryOpen(true);
              else {
                setWideDirectoryOpen(true);
                try {
                  storage.writeLocal(directoryPreference, true);
                } catch {
                  onNotice("目录显示状态暂时无法保存；文稿未受影响。");
                }
              }
            }}
          >
            <PanelLeft />
            <span>目录</span>
          </button>
        )}
        {!library && (
          <button
            type="button"
            className="script-library-back"
            onClick={showLibrary}
            disabled={!activeView || busy || saving}
          >
            <ArrowLeft />
            全部剧本
          </button>
        )}
        <div className="script-location">
          <h2
            aria-label={library ? "剧本列表" : "当前剧本"}
            title={library ? "剧本" : production?.title}
            tabIndex={-1}
            data-script-focus-anchor={!item || library || undefined}
          >
            {library ? "剧本" : production?.title}
          </h2>
          {library ? (
            <span
              className="script-project"
              title={
                library && globalLibrary
                  ? "全部剧本"
                  : `归属项目：${contentOwnershipTitle(space)}`
              }
            >
              <Folder />
              <span>
                {library && globalLibrary
                  ? "全部剧本"
                  : contentOwnershipTitle(space)}
              </span>
            </span>
          ) : (
            production && (
              <button
                type="button"
                className="script-project"
                aria-label="设置项目"
                title={`归属项目：${contentOwnershipTitle(space)} · 点击设置`}
                onClick={() =>
                  void client
                    .resolveCatalogContent(production.contentId)
                    .then((entry) => {
                      if (entry)
                        setOrganizing({ kind: "catalog", value: entry });
                    })
                    .catch((error) => onNotice(error.message))
                }
                disabled={!canWrite}
              >
                <Folder />
                <span>{contentOwnershipTitle(space)}</span>
              </button>
            )
          )}
        </div>
        {library ? (
          <>
            <button
              type="button"
              className={library ? "primary" : undefined}
              onClick={onConceive}
              disabled={!canWrite}
            >
              构思新剧
            </button>
            <button
              type="button"
              className={library ? "secondary-action" : "icon-button"}
              title="手动新建剧本"
              aria-label="手动新建剧本"
              onClick={() => setDialog("production")}
              disabled={!canWrite}
            >
              <FilePlus2 />
              {library && <span>手动新建剧本</span>}
            </button>
          </>
        ) : (
          <ComposerOptions
            label="剧本选项"
            menuLabel="剧本选项菜单"
            below
            options={[
              {
                label: "构思新剧",
                icon: <Sparkles />,
                onSelect: onConceive,
                disabled: !canWrite,
              },
              {
                label: "手动新建剧本",
                icon: <FilePlus2 />,
                onSelect: () => setDialog("production"),
                disabled: !canWrite,
              },
            ]}
          />
        )}
        {!library && production && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label="剧本设置"
              title="剧本设置"
              onClick={() => setDialog("settings")}
              disabled={!canWrite}
            >
              <Settings2 />
            </button>
            <button
              ref={exportTrigger}
              type="button"
              disabled={!canWrite}
              onClick={(event) =>
                setExportSelection({
                  production: structuredClone(production),
                  trigger: event.currentTarget,
                })
              }
            >
              <Download />
              导出 Word
            </button>
          </>
        )}
      </header>
      {!library &&
        exportStatus?.productionId === production?.id &&
        exportStatus && (
          <div className="script-export-status" role="status">
            <span>{exportStatus.message}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                flushSync(() => {
                  choose(production!.id);
                  setHistoryOpen(true);
                });
                const summary = exportHistory.current?.querySelector("summary");
                summary?.focus();
                summary?.scrollIntoView({ block: "nearest" });
              }}
            >
              查看导出历史
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭导出提示"
              title="关闭导出提示"
              onClick={() => {
                setExportStatus(null);
                exportTrigger.current?.focus({ preventScroll: true });
              }}
            >
              <X />
            </button>
          </div>
        )}
      {executionIssue && (
        <p className="script-warning" role="status">
          {executionIssue} 手动编辑不受影响。
        </p>
      )}
      {(error ||
        (issuesOpen && reviewRead.error) ||
        (historyOpen && exportRead.error)) && (
        <p className="script-error" role="alert">
          {error ||
            (issuesOpen && reviewRead.error) ||
            (historyOpen && exportRead.error)}
        </p>
      )}
      {library ? (
        <ScriptStudioLibrary
          client={client}
          projectId={instance.workspaceId}
          projects={boot.workspace.projects}
          global={globalLibrary}
          lastOpenedId={productionId}
          query={query}
          onQuery={setQuery}
          onReady={() => {
            const request = libraryFocus.current;
            libraryFocus.current = null;
            if (
              !request ||
              !activeView ||
              document.activeElement !== request.anchor
            )
              return;
            Array.from(
              studio.current?.querySelectorAll<HTMLElement>(
                "[data-production-id]",
              ) ?? [],
            )
              .find((element) => element.dataset.productionId === request.id)
              ?.focus({ preventScroll: true });
          }}
          disabled={!activeView || busy || saving}
          onOpen={(id) => {
            editorFocus.current = {
              productionId: id,
              anchor: document.activeElement,
            };
            // The paged library does not load item bodies. Keep the remembered
            // ID and let the existing resolver verify it against the original.
            onOpenScript(
              id,
              id === productionId && itemId ? itemId : undefined,
            );
          }}
        />
      ) : !production ? (
        <p className="script-hint" role={editorRead.error ? "alert" : "status"}>
          {editorRead.error || "正在打开剧本…"}
        </p>
      ) : (
        <div
          className="script-layout"
          data-directory-open={directoryOpen}
          data-compact={compactDirectory}
        >
          <ScriptStudioNavigation
            key={`${boot.centerId}:${boot.principalId}:${instance.id}:${production.id}`}
            items={production.items}
            itemId={itemId}
            storageScope={`${boot.centerId}:${boot.principalId}`}
            locationKey={`script-directory:${instance.id}:${production.id}`}
            directoryId={directoryId}
            open={directoryOpen}
            compact={compactDirectory}
            onClose={closeDirectory}
            canWrite={canWrite}
            onChoose={(id) => choose(production.id, id)}
            onCreate={openCreate}
            onNotice={onNotice}
          />
          <div className="script-main">
            {item ? (
              <ScriptItemEditor
                key={`${boot.centerId}:${boot.principalId}:${production.id}:${item.id}`}
                client={client}
                production={production}
                item={item}
                deliveryTarget={
                  deliveryTarget?.itemId === item.id
                    ? deliveryTarget
                    : undefined
                }
                run={run}
                canWrite={canWrite}
                onCompose={onCompose}
                onReady={restoreEditorFocus}
              />
            ) : (
              <div className="script-overview">
                <section className="script-writing-start" aria-label="创作入口">
                  <header>
                    <h2>
                      {production.items.some(
                        (value) =>
                          value.kind === "episode" || value.kind === "outline",
                      )
                        ? "继续创作"
                        : "开始创作"}
                    </h2>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={!canWrite}
                      onClick={() => openCreate("episode")}
                    >
                      新建一集
                    </button>
                  </header>
                  {sorted.some(
                    (value) =>
                      value.kind === "episode" || value.kind === "outline",
                  ) ? (
                    <div className="script-writing-list">
                      {sorted
                        .filter(
                          (value) =>
                            value.kind === "outline" ||
                            value.kind === "episode",
                        )
                        .map((value) => (
                          <button
                            type="button"
                            key={value.id}
                            onClick={() => choose(production.id, value.id)}
                            title={value.title}
                          >
                            <span>{value.title}</span>
                            <small>
                              {scriptKindLabels[value.kind]} ·{" "}
                              {scriptStatusLabels[value.status]}
                            </small>
                          </button>
                        ))}
                    </div>
                  ) : (
                    <p className="script-hint">
                      从任意一集开始，也可以先
                      <button
                        type="button"
                        className="text-button"
                        disabled={!canWrite}
                        onClick={() => openCreate("outline")}
                      >
                        写全剧大纲
                      </button>
                      。设定、角色和资料可随时补充。
                    </p>
                  )}
                </section>
                <section className="script-brief" aria-label="创作简报">
                  <header>
                    <h2>创作简报</h2>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={!canWrite}
                      onClick={() => setDialog("settings")}
                    >
                      编辑简报
                    </button>
                  </header>
                  <p className="script-brief-format">
                    {production.brief.mode === "adaptation" ? "改编" : "原创"} ·{" "}
                    {production.brief.episodeCount} 集 · 每集{" "}
                    {production.brief.episodeSeconds} 秒
                  </p>
                  <dl>
                    {(
                      [
                        ["题材", production.brief.genre],
                        ["受众", production.brief.audience],
                        ["风格", production.brief.style],
                        ["创作限制", production.brief.constraints],
                      ] as const
                    )
                      .filter(([, value]) => value.trim())
                      .map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                  </dl>
                  {!production.brief.genre &&
                    !production.brief.audience &&
                    !production.brief.style &&
                    !production.brief.constraints && (
                      <p className="script-hint">
                        可补充题材、受众、风格与制作限制；不影响先写正文。
                      </p>
                    )}
                  <button
                    type="button"
                    className="text-button script-permission"
                    disabled={!canWrite}
                    onClick={() => setDialog("settings")}
                  >
                    {production.brief.modelProcessingAllowed &&
                    production.brief.rightsStatement.trim()
                      ? "资料权利与模型处理许可：已声明，可查看"
                      : "资料权利与模型处理许可：生成前需确认"}
                  </button>
                </section>
                <details
                  className="script-overview-details"
                  key={`issues:${production.id}`}
                  onToggle={(event) => setIssuesOpen(event.currentTarget.open)}
                >
                  <summary>
                    结构检查与修改影响（
                    {issues.length +
                      (reviewRead.value
                        ? 0
                        : production.items.reduce(
                            (sum, item) => sum + item.blockingReviewCount,
                            0,
                          ))}
                    ）
                  </summary>
                  <small>
                    仅检查版本依赖、分集归属和阻断意见，不代表戏剧质量审查。
                  </small>
                  {issues.map((issue, n) => (
                    <p key={n}>
                      <button
                        type="button"
                        onClick={() => choose(production.id, issue.itemId)}
                      >
                        {issue.message}
                      </button>
                    </p>
                  ))}
                  {production.items
                    .filter(
                      (i) =>
                        scriptImpact(
                          { head: production, items: production.items },
                          [i.id],
                        ).length,
                    )
                    .map((i) => (
                      <p key={i.id}>
                        {i.title} →{" "}
                        {scriptImpact(
                          { head: production, items: production.items },
                          [i.id],
                        )
                          .map(
                            (id) =>
                              production.items.find((x) => x.id === id)!.title,
                          )
                          .join("、")}
                      </p>
                    ))}
                </details>
                <details
                  className="script-overview-details"
                  key={`exports:${production.id}`}
                  ref={exportHistory}
                  open={historyOpen}
                  onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
                >
                  <summary>导出历史（{production.totals.exports}）</summary>
                  <small>
                    按保存的版本和模板重新生成；不代表制作方已收到。
                  </small>
                  {(exportRead.value ?? []).map((record) => (
                    <article className="script-export-record" key={record.id}>
                      <time>{scriptDisplayTime(record.createdAt)}</time>
                      <small>
                        {" "}
                        · {record.workingCopy ? "创作文稿" : "正式交付"}
                      </small>
                      <p>{record.titles.join("；")}</p>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={!canWrite}
                        onClick={(event) =>
                          void download(
                            production,
                            record.id,
                            event.currentTarget,
                          )
                        }
                      >
                        重新下载
                      </button>
                      <details>
                        <summary>追溯信息</summary>
                        <small>
                          导出记录：{record.id} · 剧本规范 v
                          {record.contextRevision}
                        </small>
                      </details>
                    </article>
                  ))}
                </details>
              </div>
            )}
          </div>
        </div>
      )}
      {organizing && (
        <ContentMetadata
          entry={organizing}
          projects={boot.workspace.projects}
          client={client}
          mode="move"
          onClose={() => setOrganizing(null)}
          onSaved={(old) => {
            setOrganizing(null);
            onOpenScript(
              old.kind === "catalog" ? old.value.appObjectId : old.value.id,
            );
          }}
        />
      )}
      {dialog === "production" && (
        <CreateDialog
          title="手动新建剧本"
          onClose={() => setDialog(null)}
          onSubmit={async (title) => {
            const receipt = await run({
              action: "create-production",
              projectId: instance.workspaceId,
              title,
            });
            flushSync(() => {
              choose(receipt.entityId);
              setDialog(null);
            });
            focusCreated(receipt.entityId);
          }}
        />
      )}
      {dialog === "item" && production && (
        <CreateItemDialog
          production={production}
          initialKind={createDefaults.kind}
          initialParent={createDefaults.parentId}
          run={run}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            flushSync(() => {
              choose(production.id, id);
              setDialog(null);
            });
            focusCreated(production.id, id);
          }}
        />
      )}
      {dialog === "settings" && production && (
        <ProductionSettings
          key={production.id}
          production={production}
          client={client}
          run={run}
          onClose={() => setDialog(null)}
        />
      )}
      {exportSelection && (
        <ExportDialog
          production={exportSelection.production}
          onClose={() => setExportSelection(null)}
          onSubmit={(selection, workingCopy) => {
            const frozen = exportSelection;
            flushSync(() => setExportSelection(null));
            void download(
              frozen.production,
              null,
              frozen.trigger,
              selection,
              workingCopy,
            );
          }}
        />
      )}
    </section>
  );
}
function ExportDialog({
  production,
  onClose,
  onSubmit,
}: {
  production: ScriptEditorProduction;
  onClose: () => void;
  onSubmit: (
    selection: { itemId: string; revision: number }[],
    workingCopy: boolean,
  ) => void;
}) {
  const [workingCopy, setWorkingCopy] = useState(true);
  const items = production.items
    .filter((i) => i.kind === "episode" || i.kind === "scene")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const issues = scriptStructureIssues({
    head: production,
    items: production.items,
  });
  const ready = (item: ScriptDirectoryItem) =>
    item.status === "locked" &&
    !!item.approval &&
    item.approvalCurrent &&
    item.blockingReviewCount === 0 &&
    !issues.some((issue) => issue.itemId === item.id) &&
    item.dependencies.every((ref) => {
      const dependency = production.items.find((i) => i.id === ref.itemId);
      return (
        !!dependency?.approval &&
        dependency.approval.revision === ref.revision &&
        dependency.approvalCurrent
      );
    });
  const deliveryEligible = new Set(
    items
      .filter(
        (item) =>
          ready(item) &&
          (item.kind !== "scene" ||
            items.some(
              (parent) => parent.id === item.parentId && ready(parent),
            )),
      )
      .map((i) => i.id),
  );
  const copyEligible = new Set(
    items
      .filter(
        (item) =>
          item.hasText ||
          (item.kind === "episode" &&
            items.some((child) => child.parentId === item.id && child.hasText)),
      )
      .map((item) => item.id),
  );
  const eligible = workingCopy ? copyEligible : deliveryEligible;
  const [selected, setSelected] = useState(() => new Set(copyEligible));
  return (
    <StudioDialog title="导出 Word" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.size)
            onSubmit(
              items
                .filter((i) => selected.has(i.id))
                .map((i) => ({ itemId: i.id, revision: i.revision })),
              workingCopy,
            );
        }}
      >
        <label>
          导出用途
          <select
            aria-label="导出用途"
            value={workingCopy ? "working-copy" : "delivery"}
            onChange={(event) => {
              const copy = event.target.value === "working-copy";
              setWorkingCopy(copy);
              setSelected(new Set(copy ? copyEligible : deliveryEligible));
            }}
          >
            <option value="working-copy">创作文稿 · 无需审阅</option>
            <option value="delivery">正式交付 · 仅已审阅锁稿版本</option>
          </select>
        </label>
        <p className="script-hint">
          {workingCopy
            ? "导出已保存的正文，不改变文稿状态；文件标记为创作副本，不含本机未保存的修改。"
            : "正式交付只包含审阅有效的锁定稿。"}
          选择分场时同时包含所属集。
        </p>
        <fieldset className="script-export-items">
          <legend>导出内容</legend>
          {items.map((item) => (
            <label key={item.id} className="script-checkbox">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                disabled={!eligible.has(item.id)}
                onChange={(event) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (event.target.checked) {
                      next.add(item.id);
                      const parentId = item.parentId;
                      if (parentId) next.add(parentId);
                    } else {
                      next.delete(item.id);
                      for (const child of items)
                        if (child.parentId === item.id) next.delete(child.id);
                    }
                    return next;
                  })
                }
              />
              {scriptKindLabels[item.kind]} · {item.title} · v{item.revision}
              {!eligible.has(item.id) &&
                (workingCopy ? " · 尚无已保存正文" : " · 需完成审阅锁稿")}
            </label>
          ))}
          {!items.length && <p>尚无分集或分场。</p>}
        </fieldset>
        <footer>
          <button className="primary" type="submit" disabled={!selected.size}>
            导出所选
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
function CreateDialog({
  title,
  onClose,
  onSubmit,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <StudioDialog title={title} onClose={onClose} compact>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(name);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-input-row">
          <input
            aria-label="剧本名称"
            placeholder="剧本名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={180}
            required
          />
          <footer>
            <button
              className="primary"
              type="submit"
              disabled={busy || !name.trim()}
            >
              创建
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={onClose}
            >
              取消
            </button>
          </footer>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </StudioDialog>
  );
}
function CreateItemDialog({
  production,
  initialKind,
  initialParent,
  run,
  onClose,
  onCreated,
}: {
  production: ScriptEditorProduction;
  initialKind: ScriptItem["kind"];
  initialParent?: string;
  run: ScriptRun;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<ScriptItem["kind"]>(initialKind);
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState(initialParent ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <StudioDialog title={scriptCreateLabels[kind]} onClose={onClose} compact>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const draft = emptyScriptDraft(title, production.items.length);
            if (kind === "scene") {
              const episode = production.items.find(
                (i) => i.id === parent && i.kind === "episode",
              );
              if (!episode) throw new Error("请先选择所属分集。");
              draft.parentId = episode.id;
              draft.dependencies = [
                { itemId: episode.id, revision: episode.revision },
              ];
            }
            const receipt = await run({
              action: "create-item",
              productionId: production.id,
              kind,
              draft,
            });
            onCreated(receipt.entityId);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          类型
          <select
            aria-label="条目类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as ScriptItem["kind"])}
          >
            {scriptItemKinds.map((k) => (
              <option key={k} value={k}>
                {scriptKindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input
            aria-label="条目标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={180}
          />
        </label>
        {kind === "scene" && (
          <label>
            所属分集
            <select
              aria-label="所属分集"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              required
            >
              <option value="">请选择</option>
              {production.items
                .filter((i) => i.kind === "episode")
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="primary"
            type="submit"
            disabled={busy || !title.trim()}
          >
            创建条目
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
function ProductionSettings({
  production,
  client,
  run,
  onClose,
}: {
  production: ScriptEditorProduction;
  client: WorkspaceClient;
  run: ScriptRun;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => structuredClone(production));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const brief = value.brief;
  const template = value.template;
  const people = client.boot!.workspace.actants.filter(
    (a) =>
      a.kind === "human" &&
      client
        .boot!.workspace.projects.find((p) => p.id === production.projectId)
        ?.members.includes(a.principalId),
  );
  return (
    <StudioDialog title="剧本设置" onClose={onClose}>
      <form
        className="script-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await run({
              action: "update-production",
              productionId: value.id,
              expectedRevision: value.revision,
              title: value.title,
              brief,
              reviewerPrincipalIds: value.reviewerPrincipalIds,
              template,
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="script-hint">
          创作要求、资料许可或审阅人变更需要重新审阅；改名和 Word
          排版不影响已批准的稿件。
        </p>
        <label>
          剧名
          <input
            value={value.title}
            required
            maxLength={180}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
        </label>
        <div className="script-form-grid">
          <label>
            创作方式
            <select
              value={brief.mode}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: {
                    ...brief,
                    mode: e.target.value as "original" | "adaptation",
                  },
                })
              }
            >
              <option value="original">原创</option>
              <option value="adaptation">改编</option>
            </select>
          </label>
          <label>
            集数
            <input
              type="number"
              min={1}
              max={500}
              value={brief.episodeCount}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: { ...brief, episodeCount: Number(e.target.value) },
                })
              }
            />
          </label>
          <label>
            每集秒数
            <input
              type="number"
              min={15}
              max={14400}
              value={brief.episodeSeconds}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: { ...brief, episodeSeconds: Number(e.target.value) },
                })
              }
            />
          </label>
        </div>
        {(
          [
            ["audience", "受众", 2000],
            ["genre", "题材", 500],
            ["style", "风格", 5000],
            ["constraints", "制作约束", 10000],
            ["rightsStatement", "资料权利与使用范围", 5000],
          ] as const
        ).map(([field, label, max]) => (
          <label key={field}>
            {label}
            <textarea
              rows={2}
              maxLength={max}
              value={brief[field]}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: { ...brief, [field]: e.target.value },
                })
              }
            />
          </label>
        ))}
        <label className="script-checkbox">
          <input
            type="checkbox"
            checked={brief.modelProcessingAllowed}
            onChange={(e) =>
              setValue({
                ...value,
                brief: { ...brief, modelProcessingAllowed: e.target.checked },
              })
            }
          />
          我确认本剧本所选资料允许交给当前模型服务处理
        </label>
        <fieldset>
          <legend>指定审阅人（人工）</legend>
          {people.map((a) => (
            <label key={a.id} className="script-checkbox">
              <input
                type="checkbox"
                checked={value.reviewerPrincipalIds.includes(a.principalId)}
                onChange={(e) =>
                  setValue({
                    ...value,
                    reviewerPrincipalIds: e.target.checked
                      ? [
                          ...new Set([
                            ...value.reviewerPrincipalIds,
                            a.principalId,
                          ]),
                        ]
                      : value.reviewerPrincipalIds.filter(
                          (id) => id !== a.principalId,
                        ),
                  })
                }
              />
              {a.name}
            </label>
          ))}
        </fieldset>
        <details>
          <summary>Word 交付模板</summary>
          <label>
            模板标题
            <input
              value={template.title}
              maxLength={100}
              required
              onChange={(e) =>
                setValue({
                  ...value,
                  template: { ...template, title: e.target.value },
                })
              }
            />
          </label>
          <label>
            场景标题前缀
            <input
              value={template.sceneHeading}
              maxLength={80}
              required
              onChange={(e) =>
                setValue({
                  ...value,
                  template: { ...template, sceneHeading: e.target.value },
                })
              }
            />
          </label>
          <div className="script-form-grid">
            <label>
              字体
              <select
                value={template.font}
                onChange={(e) =>
                  setValue({
                    ...value,
                    template: {
                      ...template,
                      font: e.target.value as typeof template.font,
                    },
                  })
                }
              >
                {["宋体", "等线", "Microsoft YaHei", "Arial"].map((font) => (
                  <option key={font}>{font}</option>
                ))}
              </select>
            </label>
            <label>
              字号
              <input
                type="number"
                min={9}
                max={24}
                value={template.fontSize}
                onChange={(e) =>
                  setValue({
                    ...value,
                    template: { ...template, fontSize: Number(e.target.value) },
                  })
                }
              />
            </label>
          </div>
          {(
            [
              ["includeNotes", "包含制作说明"],
              ["includeContinuity", "包含连续性说明"],
              ["pageBreakEpisodes", "按分集分页"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="script-checkbox">
              <input
                type="checkbox"
                checked={template[key]}
                onChange={(e) =>
                  setValue({
                    ...value,
                    template: { ...template, [key]: e.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
        </details>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="primary"
            type="submit"
            disabled={busy || !value.reviewerPrincipalIds.length}
          >
            保存规范
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
