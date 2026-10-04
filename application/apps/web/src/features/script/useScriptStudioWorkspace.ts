import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  scriptLocationSchema,
  type ScriptLocation,
} from "../../../../../packages/core/src/script-delivery.js";
import {
  harnessReadinessError,
  scriptStudioApplication,
  type ApplicationInstance,
} from "../../../../../packages/core/src/applications.js";
import {
  scriptIssues,
  scriptStructureIssues,
  type ScriptCommand,
  type ScriptItem,
} from "../../../../../packages/core/src/script-studio.js";
import { buildScriptDocx } from "../../../../../packages/core/src/script-studio-docx.js";
import {
  spaceKind,
  type Receipt,
} from "../../../../../packages/core/src/model.js";
import type { WorkspaceClient } from "../../client.js";
import type { CatalogContentEntry } from "../../catalog-content-entries.js";
import type { ScriptEditorProduction } from "../../script-editor-reader.js";
import { scopedStorage } from "../../local-preferences.js";
import { scriptFocusReturn } from "../../script-studio-focus.js";
import { useScriptEditorRead } from "../../useScriptEditorRead.js";

type ScriptStudioClient = Pick<
  WorkspaceClient,
  | "boot"
  | "online"
  | "execute"
  | "readScriptEditor"
  | "readScriptEditorPage"
  | "readScriptExport"
  | "readScriptVersionTitle"
  | "readScriptExportManifest"
  | "getSnapshot"
  | "resolveCatalogContent"
>;

export type ScriptRun = (command: ScriptCommand) => Promise<Receipt>;

/** Owns this workspace's location, explicit pane reads, focus leases, commands
 * and export/picker lifecycle. Render Boot and storage reads retain their
 * original timing; latest active/production refs are used only where they were.
 * Child forms, editor drafts, navigation authority and the rendered tree stay
 * with their existing owners. */
export function useScriptStudioWorkspace({
  client,
  instance,
  activeView,
  locationRequest,
  onNavigate,
  globalLibrary,
  onOpenScript,
  onLibrary,
  onNotice,
  onNativeDialog,
}: {
  client: ScriptStudioClient;
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
  globalLibrary: boolean;
  onOpenScript: (id: string, itemId?: string) => void;
  onLibrary: () => void;
  onNotice: (text: string) => void;
  onNativeDialog?: (open: boolean) => void;
}) {
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
  const toggleDirectory = () => {
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
  };

  const openOrganization = () =>
    void client
      .resolveCatalogContent(production!.contentId)
      .then((entry) => {
        if (entry) setOrganizing({ kind: "catalog", value: entry });
      })
      .catch((error) => onNotice(error.message));

  const openProductionDialog = () => setDialog("production");

  const openSettingsDialog = () => setDialog("settings");

  const beginExport = (event: MouseEvent<HTMLButtonElement>) =>
    setExportSelection({
      production: structuredClone(production!),
      trigger: event.currentTarget,
    });

  const showExportHistory = () => {
    flushSync(() => {
      choose(production!.id);
      setHistoryOpen(true);
    });
    const summary = exportHistory.current?.querySelector("summary");
    summary?.focus();
    summary?.scrollIntoView({ block: "nearest" });
  };

  const closeExportStatus = () => {
    setExportStatus(null);
    exportTrigger.current?.focus({ preventScroll: true });
  };

  const libraryReady = () => {
    const request = libraryFocus.current;
    libraryFocus.current = null;
    if (!request || !activeView || document.activeElement !== request.anchor)
      return;
    Array.from(
      studio.current?.querySelectorAll<HTMLElement>("[data-production-id]") ??
        [],
    )
      .find((element) => element.dataset.productionId === request.id)
      ?.focus({ preventScroll: true });
  };

  const openLibraryProduction = (id: string) => {
    editorFocus.current = {
      productionId: id,
      anchor: document.activeElement,
    };
    // The paged library does not load item bodies. Keep the remembered
    // ID and let the existing resolver verify it against the original.
    onOpenScript(id, id === productionId && itemId ? itemId : undefined);
  };

  const issuesToggle = (event: SyntheticEvent<HTMLDetailsElement>) =>
    setIssuesOpen(event.currentTarget.open);

  const historyToggle = (event: SyntheticEvent<HTMLDetailsElement>) =>
    setHistoryOpen(event.currentTarget.open);

  const closeOrganization = () => setOrganizing(null);

  const organizationSaved = (old: CatalogContentEntry) => {
    setOrganizing(null);
    onOpenScript(old.kind === "catalog" ? old.value.appObjectId : old.value.id);
  };

  const closeDialog = () => setDialog(null);

  const submitProduction = async (title: string) => {
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
  };

  const itemCreated = (id: string) => {
    flushSync(() => {
      choose(production!.id, id);
      setDialog(null);
    });
    focusCreated(production!.id, id);
  };

  const closeExportSelection = () => setExportSelection(null);

  const submitExport = (
    selection: { itemId: string; revision: number }[],
    workingCopy: boolean,
  ) => {
    const frozen = exportSelection!;
    flushSync(() => setExportSelection(null));
    void download(
      frozen.production,
      null,
      frozen.trigger,
      selection,
      workingCopy,
    );
  };

  return {
    boot,
    space,
    productionId,
    itemId,
    query,
    organizing,
    dialog,
    createDefaults,
    error,
    busy,
    saving,
    exportStatus,
    directoryId,
    compactDirectory,
    directoryOpen,
    historyOpen,
    exportSelection,
    editorRead,
    production,
    issuesOpen,
    reviewRead,
    issues,
    exportRead,
    item,
    sorted,
    library,
    canWrite,
    executionIssue,
    deliveryTarget,
    studio,
    directoryTrigger,
    exportTrigger,
    exportHistory,
    choose,
    showLibrary,
    closeDirectory,
    openCreate,
    run,
    restoreEditorFocus,
    download,
    toggleDirectory,
    openOrganization,
    openProductionDialog,
    openSettingsDialog,
    beginExport,
    showExportHistory,
    closeExportStatus,
    libraryReady,
    openLibraryProduction,
    issuesToggle,
    historyToggle,
    closeOrganization,
    organizationSaved,
    closeDialog,
    submitProduction,
    itemCreated,
    closeExportSelection,
    submitExport,
    queryChanged: setQuery as (query: string) => void,
  } as const;
}
