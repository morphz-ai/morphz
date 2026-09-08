import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Braces,
  FileText,
  Film,
  Globe,
  Grid2X2,
  Layers2,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  applicationManifestSchema,
  applicationMessageSchema,
  objectsApplication,
  type ApplicationManifest,
  type ApplicationInstance,
} from "../../../packages/core/src/applications.js";
import {
  applicationFor,
  operationSchema,
  spaceKind,
} from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";

export function AppIcon({ app }: { app: ApplicationManifest }) {
  const Icon = {
    layers: Layers2,
    document: FileText,
    globe: Globe,
    code: Braces,
    book: BookOpen,
    film: Film,
  }[app.icon];
  return app.iconImage ? (
    <img src={app.iconImage} alt="" />
  ) : (
    <Icon aria-hidden />
  );
}

export function ApplicationHost({
  client,
  workspaceId,
  activeId,
  children,
  onActivate,
  onOpen,
  onCompose,
  onSaveProject,
  onNotice,
  enabled = true,
  foreground = true,
}: {
  client: WorkspaceClient;
  workspaceId: string;
  activeId: string | null;
  children: ReactNode;
  onActivate: (id: string | null) => void;
  onOpen: (id: string) => void;
  onCompose: (text: string, artifactId?: string) => void;
  onSaveProject: () => void;
  onNotice: (message: string) => void;
  enabled?: boolean;
  foreground?: boolean;
}) {
  const state = client.boot!.workspace;
  const space = state.projects.find((p) => p.id === workspaceId)!;
  const instances = state.applicationInstances.filter(
    (i) => i.workspaceId === workspaceId && i.status === "open",
  );
  const active = instances.find((i) => i.id === activeId);
  const applications = [
    objectsApplication,
    ...state.applications.filter(
      (a) =>
        a.installedBy === client.boot!.principalId ||
        instances.some(
          (i) => i.applicationId === a.id && i.applicationVersion === a.version,
        ),
    ),
  ];
  const appKey = (app: ApplicationManifest) => `${app.id}@${app.version}`;
  const [selected, setSelected] = useState(appKey(objectsApplication)),
    [busy, setBusy] = useState(false),
    [installing, setInstalling] = useState<ApplicationManifest | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  async function launch(app: ApplicationManifest) {
    if (busy) return;
    setBusy(true);
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId,
        applicationId: app.id,
        applicationVersion: app.version,
      });
      onActivate(receipt.entityId);
    } catch (error) {
      onNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function close(instance: ApplicationInstance) {
    try {
      await client.execute({
        type: "close-application",
        instanceId: instance.id,
        expectedRevision: instance.revision,
      });
      if (activeId === instance.id) onActivate(null);
      onNotice("应用已关闭，视图状态和内容已保留；后台任务继续执行。");
    } catch (error) {
      onNotice((error as Error).message);
    }
  }
  if (!enabled) return <>{children}</>;
  return (
    <section className="application-host" aria-label="认知应用工作空间">
      <div className="application-strip">
        <button
          className="application-home"
          aria-label="应用启动台"
          aria-pressed={!active}
          onClick={() => onActivate(null)}
        >
          <Grid2X2 />
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
        {active?.applicationId === objectsApplication.id &&
          active.state.artifactId && (
            <button
              onClick={async () => {
                try {
                  await client.execute({
                    type: "set-application-state",
                    instanceId: active.id,
                    expectedRevision: active.revision,
                    state: { ...active.state, artifactId: null },
                  });
                  onActivate(active.id);
                } catch (e) {
                  onNotice((e as Error).message);
                }
              }}
            >
              所有资料
            </button>
          )}
        {spaceKind(space) === "desk" && (
          <button className="workspace-save" onClick={onSaveProject}>
            保存为项目
          </button>
        )}
      </div>
      {!active && (
        <div className="application-launcher">
          <div className="launcher-heading">
            <div>
              <h1>{space.title}</h1>
              <p>打开应用，或直接在下方提出想法。</p>
            </div>
            <button className="outline" onClick={() => upload.current?.click()}>
              <Upload />
              安装应用
            </button>
          </div>
          <div className="application-grid" role="list" aria-label="应用列表">
            {applications.map((app) => (
              <button
                role="listitem"
                className="application-tile"
                key={app.id + app.version}
                aria-label={`${app.title} ${app.version}`}
                aria-pressed={selected === appKey(app)}
                disabled={busy}
                onClick={() => setSelected(appKey(app))}
                onDoubleClick={() => void launch(app)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void launch(app);
                  }
                }}
              >
                <span className="application-icon">
                  <AppIcon app={app} />
                </span>
                <strong>{app.title}</strong>
                <small>{app.description}</small>
              </button>
            ))}
          </div>
          <div className="launcher-footer">
            <span>双击或按回车打开</span>
            <button
              className="outline"
              disabled={busy}
              onClick={() =>
                void launch(
                  applications.find((a) => appKey(a) === selected) ??
                    objectsApplication,
                )
              }
            >
              <Plus />
              打开应用
            </button>
          </div>
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
              children
            ) : (
              <SandboxApplication
                key={instance.id}
                client={client}
                instance={instance}
                manifest={app}
                active={foreground && active?.id === instance.id}
                onOpen={onOpen}
                onCompose={onCompose}
                onNotice={onNotice}
              />
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
            setSelected(appKey(installing));
            setInstalling(null);
            onNotice("应用已安装，双击图标即可启动。");
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
      <p>{app.description}</p>
      <p className="muted">
        {app.id} · {app.version}
      </p>
      <p>此应用包含可执行界面代码。请只安装你信任的来源。</p>
      <ul>
        {app.permissions.map((p) => (
          <li key={p}>
            {
              {
                "artifacts.read": "读取所在工作空间的对象",
                "artifacts.write": "创建、修订和关联所在工作空间的对象",
                "input.compose": "将建议放入 AI 输入框，由你确认发送",
              }[p]
            }
          </li>
        ))}
      </ul>
      <p>不能直接访问文件系统、账号、网络、相机或麦克风。</p>
      <p className="muted">
        {app.harness
          ? `使用已在 Runtime 安装的 Harness：${app.harness.id}@${app.harness.version}。缺失时执行会明确报错，不自动降级。`
          : "使用 Runtime 的默认执行方式。"}
      </p>
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
  onOpen,
  onCompose,
  onNotice,
}: {
  client: WorkspaceClient;
  instance: ApplicationInstance;
  manifest: ApplicationManifest;
  active: boolean;
  onOpen: (id: string) => void;
  onCompose: (text: string, artifactId?: string) => void;
  onNotice: (text: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    channel = useRef(crypto.randomUUID()),
    surfaceReady = useRef(false),
    paintFrame = useRef(0);
  const latest = useRef({
    client,
    instance,
    manifest,
    active,
    onOpen,
    onCompose,
  });
  latest.current = { client, instance, manifest, active, onOpen, onCompose };
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
      theme: {
        appearance: document.documentElement.dataset.appearance ?? "system",
        accent:
          frame.current?.closest<HTMLElement>(".app")?.dataset.accent ?? "cyan",
      },
      artifacts: manifest.permissions.includes("artifacts.read")
        ? state.artifacts
            .filter((a) => a.projectId === instance.workspaceId)
            .map((a) => ({
              id: a.id,
              title: a.title,
              kind: a.content.kind,
              revision: a.revision,
            }))
        : [],
    };
  }
  function initialize() {
    if (!surfaceReady.current) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: "morphz-work:init",
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
        event.data?.type !== "morphz-work:request"
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
        const { client, instance, manifest, active, onOpen, onCompose } =
          latest.current;
        if (
          !active ||
          !client.boot?.workspace.applicationInstances.some(
            (i) => i.id === instance.id && i.status === "open",
          )
        )
          throw new Error("应用当前未激活。");
        const request = applicationMessageSchema.parse(event.data.request);
        const state = client.boot.workspace;
        const artifact = (artifactId: string) => {
          if (!manifest.permissions.includes("artifacts.read"))
            throw new Error("应用没有读取权限。");
          const value = state.artifacts.find(
            (a) => a.id === artifactId && a.projectId === instance.workspaceId,
          );
          if (!value) throw new Error("对象不在这个工作空间中。");
          return value;
        };
        let result: unknown = null;
        switch (request.method) {
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
            const a = artifact(request.artifactId),
              version = a.versions.find(
                (v) => v.revision === (request.revision ?? a.revision),
              );
            if (!version) throw new Error("对象版本不存在。");
            result = { id: a.id, ...version };
            break;
          }
          case "openArtifact":
            artifact(request.artifactId);
            onOpen(request.artifactId);
            break;
          case "compose":
            if (!manifest.permissions.includes("input.compose"))
              throw new Error("应用没有输入权限。");
            if (request.artifactId) artifact(request.artifactId);
            onCompose(request.text, request.artifactId);
            break;
          case "command":
            result = await client.execute(
              operationSchema.parse(request.operation),
              false,
              instance.id,
              requestId,
            );
            break;
        }
        if (frame.current?.contentWindow === source)
          source.postMessage(
            {
              type: "morphz-work:response",
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
              type: "morphz-work:response",
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
      src={`/api/application-view/${encodeURIComponent(instance.id)}`}
      onLoad={surfaceLoaded}
      onError={() => onNotice("应用界面未能加载，内容仍保存在中心。")}
    />
  );
}
