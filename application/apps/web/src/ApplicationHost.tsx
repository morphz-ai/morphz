import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Film, Upload, X, PanelLeftClose } from "lucide-react";
import {
  applicationManifestSchema,
  applicationDescription,
  applicationMessageSchema,
  objectsApplication,
  type ApplicationManifest,
  type ApplicationCatalogEntry,
  type ApplicationInstance,
} from "../../../packages/core/src/applications.js";
import {
  applicationFor,
  operationSchema,
  spaceKind,
} from "../../../packages/core/src/model.js";
import { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";
import { NavigationIcon } from "./NavigationIcon.js";
import {
  catalogContentEntries,
  listingKind,
  type CatalogContentEntry,
} from "./catalog-content-entries.js";
import {
  recentContent,
  contentVisitTime,
  type ContentVisit,
} from "./recent-content.js";
import type { WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";
import { useTextQuotes } from "./TextQuotes.js";
import { authorizedApplications } from "./application-dock-model.js";
import { AppIcon, ApplicationLauncherIcon } from "./ApplicationIcon.js";
import type { ApplicationNavigationActions } from "./host/use-workspace-navigation.js";

export type ApplicationComposeResult =
  { ok: true } | { ok: false; error: string };

export type BuiltinApplicationSurface = Readonly<{
  view: Extract<ApplicationManifest["ui"], { type: "builtin" }>["view"];
  instance: ApplicationInstance;
  workspaceId: string;
  selected: boolean;
  activeView: boolean;
  onReturn: () => void;
  returnLabel: string;
  fallback: ReactNode;
}>;
export type BuiltinApplicationRenderer = (
  surface: BuiltinApplicationSurface,
) => ReactNode;

export function ApplicationHost({
  client,
  workspaceId,
  activeId,
  recentContentVisits = [],
  children,
  applicationActions,
  navigationId,
  onOpen,
  onCompose,
  onNotice,
  enabled = true,
  foreground = true,
  toolbarTarget,
  projectControls,
  renderBuiltin,
  onOpenRecent,
}: {
  client: WorkspaceClient;
  workspaceId: string;
  activeId: string | null;
  recentContentVisits?: ContentVisit[];
  children: ReactNode;
  navigationId: number;
  applicationActions: ApplicationNavigationActions;
  onOpen: (id: string) => void;
  onCompose: (text: string, artifactId?: string) => ApplicationComposeResult;
  onNotice: (message: string) => void;
  enabled?: boolean;
  foreground?: boolean;
  toolbarTarget: HTMLElement | null;
  projectControls?: ReactNode;
  renderBuiltin: BuiltinApplicationRenderer;
  onOpenRecent: (entry: CatalogContentEntry) => void;
}) {
  const state = client.boot!.workspace;
  const space = state.projects.find((p) => p.id === workspaceId)!;
  const instances = state.applicationInstances.filter(
    (i) => i.workspaceId === workspaceId && i.status === "open",
  );
  const navigationSnapshot = { workspaceId, navigationId, activeId, instances };
  const onActivate = applicationActions.activate;
  const active = instances.find((i) => i.id === activeId);
  const recent = recentContent(
    recentContentVisits,
    catalogContentEntries(state, client.contentCatalog),
    spaceKind(space) === "project" ? workspaceId : null,
  );
  const applications = authorizedApplications(
    state,
    client.boot!.principalId,
    workspaceId,
  );
  const [busy, setBusy] = useState(false),
    [installing, setInstalling] = useState<ApplicationManifest | null>(null);
  const launching = useRef(false);
  const upload = useRef<HTMLInputElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const instanceIds = instances.map((instance) => instance.id).join(":");
  useLayoutEffect(() => {
    const element = strip.current;
    if (!enabled || !element) return;
    const revealActive = () => {
      const selected = element.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      if (!selected) return;
      // Scroll only the tab containers, never the page or the reading canvas.
      // A resize or another application's close can otherwise leave the active
      // application outside the visible strip even though it is still selected.
      for (const container of [
        selected.closest<HTMLElement>(".application-tabs"),
        element,
      ]) {
        if (!container) continue;
        const bounds = container.getBoundingClientRect();
        const wholeTab = selected
          .closest(".application-tab")!
          .getBoundingClientRect();
        const tab =
          wholeTab.width <= bounds.width
            ? wholeTab
            : selected.getBoundingClientRect();
        if (tab.left < bounds.left)
          container.scrollLeft -= bounds.left - tab.left;
        else if (tab.right > bounds.right)
          container.scrollLeft += tab.right - bounds.right;
      }
    };
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeId, instanceIds, enabled, toolbarTarget]);
  async function launch(app: ApplicationCatalogEntry, contents = false) {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    try {
      const action = applicationActions.launch(
        app,
        navigationSnapshot,
        contents,
      );
      if (action.kind === "contents") {
        await action.pending;
        return;
      }
      action.commit(await action.pending);
    } catch (error) {
      onNotice((error as Error).message);
    } finally {
      launching.current = false;
      setBusy(false);
    }
  }
  async function close(instance: ApplicationInstance) {
    try {
      const action = applicationActions.close(instance, navigationSnapshot);
      await action.pending;
      action.commit();
    } catch (error) {
      onNotice((error as Error).message);
    }
  }
  if (!enabled) return <>{children}</>;
  const toolbar = (
    <div
      ref={strip}
      className="application-strip"
      aria-label={`${space.title}的应用`}
    >
      <button
        className="application-home"
        aria-label="应用启动台"
        title={`${space.title} · 应用启动台`}
        aria-pressed={!active}
        onClick={() => onActivate(null)}
      >
        <ApplicationLauncherIcon />
      </button>
      {!active && (
        <h1 className="toolbar-title">
          {spaceKind(space) === "project" ? space.title : "工作台"}
        </h1>
      )}
      {projectControls}
      <button
        className="workspace-content"
        aria-label={
          spaceKind(space) === "project" ? "查看项目内容" : "查看内容库"
        }
        title={
          spaceKind(space) === "project"
            ? `查看${space.title}的内容列表`
            : "查看内容库"
        }
        disabled={busy}
        onClick={() => void launch(objectsApplication, true)}
      >
        <NavigationIcon kind="content" />
        <span>{spaceKind(space) === "project" ? "项目内容" : "内容库"}</span>
      </button>
      <div
        role="tablist"
        aria-label="已打开的应用"
        className="application-tabs"
      >
        {instances.map((instance) => {
          const app = applicationFor(
            state,
            instance.applicationId,
            instance.applicationVersion,
          );
          return (
            <div
              className="application-tab"
              data-active={active?.id === instance.id}
              key={instance.id}
            >
              <button
                role="tab"
                aria-selected={active?.id === instance.id}
                title={`${app.title} · ${app.version}`}
                onClick={() => onActivate(instance.id)}
              >
                <AppIcon app={app} />
                <span>{app.title}</span>
              </button>
              <button
                aria-label={`关闭应用 ${app.title}`}
                onClick={() => void close(instance)}
              >
                <X />
              </button>
            </div>
          );
        })}
      </div>
      {!active && (
        <button
          className="toolbar-install"
          aria-label="安装应用"
          title="安装应用"
          onClick={() => upload.current?.click()}
        >
          <Upload />
          <span>安装应用</span>
        </button>
      )}
    </div>
  );
  return (
    <section className="application-host" aria-label="认知应用工作空间">
      {toolbarTarget && createPortal(toolbar, toolbarTarget)}
      {!active && (
        <div className="application-launcher">
          <section className="workspace-section" aria-label="继续工作">
            <div className="workspace-section-heading">
              <h2>继续工作</h2>
              <span>最近打开的内容</span>
            </div>
            {recent.length ? (
              <ul className="workspace-recent" aria-label="最近打开的内容">
                {recent.map(({ entry, openedAt }) => (
                  <li key={entry.value.id}>
                    <button
                      type="button"
                      onClick={() => onOpenRecent(entry)}
                      aria-label={`继续打开：${entry.value.title}`}
                      title={`${entry.value.title} · ${listingKind(entry) === "script" ? "剧本" : (kindLabel[listingKind(entry) as keyof typeof kindLabel] ?? "内容")} · ${contentVisitTime(openedAt)} 打开`}
                    >
                      {listingKind(entry) === "script" ? (
                        <Film />
                      ) : (
                        <ObjectIcon
                          kind={
                            listingKind(entry) as Parameters<
                              typeof ObjectIcon
                            >[0]["kind"]
                          }
                        />
                      )}
                      <span className="workspace-recent-text">
                        <span className="workspace-recent-title">
                          {entry.value.title}
                        </span>
                        <span className="workspace-recent-meta">
                          <span>
                            {listingKind(entry) === "script"
                              ? "剧本"
                              : (kindLabel[
                                  listingKind(entry) as keyof typeof kindLabel
                                ] ?? "内容")}
                          </span>
                          <time dateTime={new Date(openedAt).toISOString()}>
                            {contentVisitTime(openedAt)}
                          </time>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="workspace-recent-empty">暂无最近打开的内容</p>
            )}
          </section>
          <section className="workspace-section" aria-label="应用">
            <div className="workspace-section-heading">
              <h2>应用</h2>
            </div>
            <div
              className="application-grid"
              role="list"
              aria-label="应用列表"
              aria-busy={busy}
            >
              {applications.map((app) => (
                <div role="listitem" key={`${app.id}@${app.version}`}>
                  <button
                    type="button"
                    className="application-tile"
                    aria-label={`${app.title} ${app.version}`}
                    disabled={busy}
                    onClick={() => void launch(app)}
                  >
                    <span className="application-icon">
                      <AppIcon app={app} presentation="tile" />
                    </span>
                    <strong>{app.title}</strong>
                    <small>{applicationDescription(app)}</small>
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {instances.map((instance) => {
        const app = applicationFor(
          state,
          instance.applicationId,
          instance.applicationVersion,
        );
        return (
          <div
            className="application-pane"
            role="tabpanel"
            aria-label={app.title}
            hidden={active?.id !== instance.id}
            key={instance.id}
          >
            {app.ui.type === "builtin" ? (
              renderBuiltin({
                view: app.ui.view,
                instance,
                workspaceId,
                selected: active?.id === instance.id,
                activeView: foreground && active?.id === instance.id,
                onReturn: () => onActivate(null),
                returnLabel: spaceKind(space) === "desk" ? "工作台" : "项目",
                fallback: children,
              })
            ) : (
              <>
                {app.ui.presentation === "immersive" && (
                  <button
                    className="immersive-return"
                    aria-label="返回工作空间"
                    title="返回工作空间"
                    onClick={() => onActivate(null)}
                  >
                    <PanelLeftClose />
                  </button>
                )}
                <SandboxApplication
                  key={instance.id}
                  client={client}
                  instance={instance}
                  manifest={app}
                  active={foreground && active?.id === instance.id}
                  navigationId={navigationId}
                  onOpen={onOpen}
                  onCompose={onCompose}
                  onNotice={onNotice}
                />
              </>
            )}
          </div>
        );
      })}
      <input
        ref={upload}
        className="hidden-file"
        type="file"
        accept="application/json,.json"
        aria-label="应用包文件"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          try {
            if (file.size > 1500000)
              throw new Error("应用包超过 1.5 MB，请将大文件保存为工作对象。");
            const app = applicationManifestSchema.parse(
              JSON.parse(await file.text()),
            );
            if (app.ui.type !== "sandbox")
              throw new Error("不能导入内置应用。");
            setInstalling(app);
          } catch (error) {
            onNotice(error instanceof Error ? error.message : "应用包无效。");
          }
        }}
      />
      {installing && (
        <InstallApplication
          app={installing}
          client={client}
          onClose={() => setInstalling(null)}
          onInstalled={() => {
            setInstalling(null);
          }}
        />
      )}
    </section>
  );
}

function InstallApplication({
  app,
  client,
  onClose,
  onInstalled,
}: {
  app: ApplicationManifest;
  client: WorkspaceClient;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useModal(dialog);
  return (
    <dialog
      ref={dialog}
      className="create-dialog application-install"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-label="确认安装应用"
    >
      <header>
        <h2>安装 {app.title}</h2>
        <button aria-label="取消安装" disabled={busy} onClick={onClose}>
          <X />
        </button>
      </header>
      <p>{applicationDescription(app)}</p>
      <p className="muted">
        {app.id} · {app.version}
      </p>
      <p>包含可执行界面代码</p>
      <ul>
        {app.permissions.map((p) => (
          <li key={p}>
            {
              {
                "artifacts.read": "读取所在工作空间的对象",
                "artifacts.write": "创建、修订和关联所在工作空间的对象",
                "input.compose": "填入输入草稿",
              }[p]
            }
          </li>
        ))}
      </ul>
      <p>不能直接访问文件系统、账号、网络、相机或麦克风。</p>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await client.execute({
                type: "install-application",
                manifest: app,
              });
              onInstalled();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "安装中…" : "允许并安装"}
        </button>
      </footer>
    </dialog>
  );
}

function SandboxApplication({
  client,
  instance,
  manifest,
  active,
  navigationId,
  onOpen,
  onCompose,
  onNotice,
}: {
  client: WorkspaceClient;
  instance: ApplicationInstance;
  manifest: ApplicationCatalogEntry;
  active: boolean;
  navigationId: number;
  onOpen: (id: string) => void;
  onCompose: (text: string, artifactId?: string) => ApplicationComposeResult;
  onNotice: (text: string) => void;
}) {
  const textQuotes = useTextQuotes();
  const latestTextQuotes = useRef(textQuotes);
  latestTextQuotes.current = textQuotes;
  const frame = useRef<HTMLIFrameElement>(null),
    channel = useRef(crypto.randomUUID()),
    surfaceReady = useRef(false),
    paintFrame = useRef(0);
  const latest = useRef({
    client,
    instance,
    manifest,
    active,
    navigationId,
    onOpen,
    onCompose,
  });
  latest.current = {
    client,
    instance,
    manifest,
    active,
    navigationId,
    onOpen,
    onCompose,
  };
  const pending = useRef(new Set<string>());
  function context() {
    const { client, instance, manifest, active } = latest.current;
    const state = client.boot!.workspace;
    return {
      instanceId: instance.id,
      workspaceId: instance.workspaceId,
      workspaceTitle: state.projects.find((p) => p.id === instance.workspaceId)
        ?.title,
      revision: instance.revision,
      state: instance.state,
      active,
      presentation: {
        mode: manifest.ui.presentation ?? "workspace",
        // The host-owned return control cannot be removed by embedded content.
        returnControl:
          manifest.ui.presentation === "immersive"
            ? {
                left:
                  /Mac/.test(navigator.platform) &&
                  /Electron\//.test(navigator.userAgent)
                    ? 100
                    : 12,
                top: 12,
                width: 36,
                height: 32,
              }
            : null,
      },
      theme: {
        appearance: document.documentElement.dataset.appearance ?? "system",
        accent:
          frame.current?.closest<HTMLElement>(".app")?.dataset.accent ?? "cyan",
      },
      artifacts: manifest.permissions.includes("artifacts.read")
        ? [
            ...state.artifacts
              .filter((a) => a.projectId === instance.workspaceId)
              .map((a) => ({
                id: a.id,
                title: a.title,
                kind: a.content.kind,
                revision: a.revision,
              })),
            ...client.contentCatalog
              .filter(
                (entry) =>
                  entry.projectId === instance.workspaceId &&
                  !state.artifacts.some((a) => a.id === entry.id),
              )
              .map((entry) => ({
                id: entry.id,
                title: entry.title,
                kind: entry.kind,
                revision: Number(entry.observedVersionRef) || 1,
              })),
          ]
        : [],
    };
  }
  function initialize() {
    if (!surfaceReady.current) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: applicationMessagePrefix(latest.current.manifest.format) + "init",
        channel: channel.current,
        context: context(),
      },
      "*",
    );
  }
  function surfaceLoaded() {
    surfaceReady.current = false;
    cancelAnimationFrame(paintFrame.current);
    // The isolated frame's load event precedes compositor hit-test readiness.
    // Offer the host connection after a paint, not while clicks still land on
    // the outer iframe element instead of its own document.
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = requestAnimationFrame(() => {
        surfaceReady.current = true;
        initialize();
      });
    });
  }
  useEffect(() => () => cancelAnimationFrame(paintFrame.current), []);
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        event.data?.channel !== channel.current ||
        event.data?.type !==
          applicationMessagePrefix(latest.current.manifest.format) + "request"
      )
        return;
      const requestId = event.data.requestId;
      if (
        typeof requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          requestId,
        ) ||
        pending.current.has(requestId) ||
        pending.current.size >= 16
      )
        return;
      pending.current.add(requestId);
      const source = event.source as Window;
      try {
        const { client, instance, manifest, active, navigationId, onOpen } =
          latest.current;
        const identity = {
          centerId: client.boot?.centerId,
          principalId: client.boot?.principalId,
          actantId: client.boot?.actantId,
          generation: client.boot?.csrfToken,
        };
        const composeScope = {
          instanceId: instance.id,
          workspaceId: instance.workspaceId,
          applicationId: instance.applicationId,
          applicationVersion: instance.applicationVersion,
          format: manifest.format,
        };
        if (
          !active ||
          !client.boot?.workspace.applicationInstances.some(
            (i) => i.id === instance.id && i.status === "open",
          )
        )
          throw new Error("应用当前未激活。");
        const request = applicationMessageSchema.parse(event.data.request);
        const artifact = async (artifactId: string, revision?: number) => {
          if (!manifest.permissions.includes("artifacts.read"))
            throw new Error("应用没有读取权限。");
          const value = await client.resolveArtifact(artifactId, revision);
          if (!value || value.projectId !== instance.workspaceId)
            throw new Error("对象不在这个工作空间中。");
          return value;
        };
        let result: unknown = null;
        switch (request.method) {
          case "commentText": {
            if (!manifest.permissions.includes("input.compose"))
              throw new Error("应用没有输入权限。");
            const a = request.artifactId
              ? await artifact(request.artifactId, request.revision)
              : undefined;
            const revision = request.revision ?? a?.revision;
            const version = a?.versions.find((v) => v.revision === revision);
            if (a && !version) throw new Error("引用的版本不存在。");
            const bounds = frame.current!.getBoundingClientRect();
            const quoteId = latestTextQuotes.current?.comment({
              point: {
                x:
                  bounds.left +
                  Math.max(
                    0,
                    Math.min(
                      bounds.width,
                      request.point?.x ?? bounds.width / 2,
                    ),
                  ),
                y:
                  bounds.top +
                  Math.max(
                    0,
                    Math.min(
                      bounds.height,
                      request.point?.y ?? bounds.height / 2,
                    ),
                  ),
              },
              quote: {
                id: requestId,
                text: request.text,
                comment: request.comment ?? "",
                anchor: request.anchor,
                source:
                  a && version
                    ? {
                        kind: "artifact",
                        projectId: a.projectId,
                        artifactId: a.id,
                        revision: version.revision,
                        title: version.title,
                      }
                    : {
                        kind: "surface",
                        projectId: instance.workspaceId,
                        applicationInstanceId: instance.id,
                        title: manifest.title,
                      },
              },
            });
            if (!quoteId) throw new Error("暂时无法添加评论，请稍后重试。");
            result = { prepared: true, quoteId };
            break;
          }
          case "ready":
            result = context();
            break;
          case "saveState":
            result = await client.execute(
              {
                type: "set-application-state",
                instanceId: instance.id,
                expectedRevision: request.expectedRevision,
                state: request.state,
              },
              false,
              undefined,
              requestId,
            );
            break;
          case "readArtifact": {
            const a = await artifact(request.artifactId, request.revision),
              version = a.versions.find(
                (v) => v.revision === (request.revision ?? a.revision),
              );
            if (!version) throw new Error("对象版本不存在。");
            result = { id: a.id, ...version };
            break;
          }
          case "openArtifact":
            await artifact(request.artifactId);
            onOpen(request.artifactId);
            break;
          case "compose": {
            if (!manifest.permissions.includes("input.compose"))
              throw new Error("应用没有输入权限。");
            if (request.artifactId) await artifact(request.artifactId);
            const current = latest.current;
            const boot = current.client.boot;
            const liveInstance = boot?.workspace.applicationInstances.find(
              (i) => i.id === composeScope.instanceId && i.status === "open",
            );
            if (
              frame.current?.contentWindow !== source ||
              !current.active ||
              current.navigationId !== navigationId ||
              boot?.centerId !== identity.centerId ||
              boot?.principalId !== identity.principalId ||
              boot?.actantId !== identity.actantId ||
              boot?.csrfToken !== identity.generation ||
              current.instance.id !== composeScope.instanceId ||
              current.instance.workspaceId !== composeScope.workspaceId ||
              current.instance.applicationId !== composeScope.applicationId ||
              current.instance.applicationVersion !==
                composeScope.applicationVersion ||
              current.manifest.id !== composeScope.applicationId ||
              current.manifest.version !== composeScope.applicationVersion ||
              current.manifest.format !== composeScope.format ||
              !liveInstance ||
              liveInstance.workspaceId !== composeScope.workspaceId ||
              liveInstance.applicationId !== composeScope.applicationId ||
              liveInstance.applicationVersion !==
                composeScope.applicationVersion
            )
              throw new Error(
                "应用或输入范围已切换，请重新准备输入；原草稿已保留。",
              );
            if (
              !current.manifest.permissions.includes("input.compose") ||
              (request.artifactId &&
                !current.manifest.permissions.includes("artifacts.read"))
            )
              throw new Error("应用当前没有准备该输入的权限。");
            const composed = current.onCompose(
              request.text,
              request.artifactId,
            );
            if (!composed.ok) throw new Error(composed.error);
            break;
          }
          case "command":
            if (!manifest.permissions.includes("artifacts.write"))
              throw new Error("应用没有写入权限。");
            {
              const operation = operationSchema.parse(request.operation);
              if (
                ![
                  "create-artifact",
                  "revise-artifact",
                  "annotate",
                  "link-artifacts",
                ].includes(operation.type)
              )
                throw new Error("应用没有执行此操作的权限。");
              const inWorkspace = async (artifactId: string) => {
                const value = await client.resolveArtifact(artifactId);
                if (!value || value.projectId !== instance.workspaceId)
                  throw new Error("应用不能操作其他工作空间。");
                return value;
              };
              if (operation.type === "create-artifact") {
                if (operation.projectId !== instance.workspaceId)
                  throw new Error("应用不能操作其他工作空间。");
                if (
                  operation.content.kind === "task" &&
                  operation.content.runRequested > 0
                )
                  throw new Error("应用不能直接启动事项执行。");
              } else if (operation.type === "revise-artifact") {
                const existing = await inWorkspace(operation.artifactId);
                if (
                  operation.content.kind === "task" &&
                  (operation.content.runRequested > 0 ||
                    (existing.content.kind === "task" &&
                      existing.content.runRequested > 0))
                )
                  throw new Error("应用不能直接更改事项执行。");
              } else if (operation.type === "annotate") {
                await inWorkspace(operation.artifactId);
              } else if (operation.type === "link-artifacts") {
                await inWorkspace(operation.fromId);
                await inWorkspace(operation.toId);
              }
              result = await client.execute(
                operation,
                false,
                instance.id,
                requestId,
              );
            }
            break;
        }
        if (frame.current?.contentWindow === source)
          source.postMessage(
            {
              type:
                applicationMessagePrefix(latest.current.manifest.format) +
                "response",
              channel: channel.current,
              requestId,
              result,
              context: context(),
            },
            "*",
          );
      } catch (error) {
        if (frame.current?.contentWindow === source)
          source.postMessage(
            {
              type:
                applicationMessagePrefix(latest.current.manifest.format) +
                "response",
              channel: channel.current,
              requestId,
              error: error instanceof Error ? error.message : "请求失败。",
            },
            "*",
          );
      } finally {
        pending.current.delete(requestId);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    initialize();
  }, [active, instance.revision, client.boot?.workspace.revision]);
  useEffect(() => {
    const root = frame.current?.closest(".app");
    if (!root) return;
    const observer = new MutationObserver(initialize);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-appearance", "data-accent"],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <iframe
      ref={frame}
      className="cognitive-application-frame"
      title={`${manifest.title}应用界面`}
      sandbox="allow-scripts"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      src={`/api/application-view/${encodeURIComponent(`${manifest.id}@${manifest.version}`)}`}
      onLoad={surfaceLoaded}
      onError={() => onNotice("应用界面未能加载，已保存的内容仍保留。")}
    />
  );
}
import { applicationMessagePrefix } from "../../../packages/core/src/application-names.js";
