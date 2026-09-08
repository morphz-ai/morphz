import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowUp,
  ChevronDown,
  Inbox,
  Layers2,
  MessageCircle,
  PanelRight,
  Palette,
  PanelsTopLeft,
  Plus,
  X,
  Link2,
  MessageSquarePlus,
  RefreshCw,
  Folder,
  ChevronRight,
  PanelLeft,
  CircleCheck,
  Search,
  FileUp,
  Mic,
  Scan,
  Brain,
  Maximize2,
  Minimize2,
  History,
  MoreHorizontal,
} from "lucide-react";
import {
  inboxFor,
  spaceKind,
  type Artifact,
  type TaskContent,
} from "../../../packages/core/src/model.js";
import {
  actorName,
  scopedStorage,
  draftKey,
  useWorkspace,
  storageScope,
} from "./client.js";
import { ArtifactEditor, TaskFields } from "./ArtifactEditor.js";
import { Conversation, type ExchangePosition } from "./Conversation.js";
import { BrandMark } from "./BrandMark.js";
import { ObjectCollection } from "./ObjectCollection.js";
import { ProjectDirectory } from "./WorkspaceViews.js";
import { ApplicationHost } from "./ApplicationHost.js";
import { objectsApplication } from "../../../packages/core/src/applications.js";
import { ImportDocuments, SearchDocuments } from "./LibraryDialogs.js";
import { UnderstandingDialog } from "./UnderstandingDialog.js";
import { emptyInteractive } from "../../../packages/core/src/interactive.js";
import { SpeechDialog } from "./SpeechDialog.js";
import type { SpeechScope } from "./client.js";
import { CaptureDialog } from "./CaptureDialog.js";
import { Notifications } from "./Notifications.js";
import { afterSend, revealInput, type InteractionMode } from "./interaction.js";
import { useModal } from "./useModal.js";

type View = "inbox" | "desk" | "projects";
type Preferences = {
  accent: "cyan" | "iris" | "coral" | "mono";
  appearance: "system" | "light" | "dark";
  view: View;
  projectId: string;
  artifactId: string | null;
  artifactRevision: number | null;
  artifactPage?: number | null;
  collaboration: boolean;
  composer: boolean;
  conversation: boolean | null;
  sidebar: boolean;
  projectOpen: boolean;
  applications?: Record<string, string | null>;
  interactions?: Record<string, InteractionMode>;
};
type InputDraft = {
  body: string;
  selection: string;
  revision: number | null;
  page?: number;
};
const defaultPrefs: Preferences = {
  accent: "cyan",
  appearance: "system",
  view: "desk",
  projectId: "first-project",
  artifactId: null,
  artifactRevision: null,
  collaboration: false,
  composer: true,
  conversation: null,
  sidebar: true,
  projectOpen: false,
};
const emptyDraft: InputDraft = { body: "", selection: "", revision: null };
const labels: Record<View, string> = {
  inbox: "事项",
  desk: "工作台",
  projects: "项目",
};
const taskStatus: Record<TaskContent["execution"], string> = {
  planned: "已计划",
  active: "进行中",
  waiting: "等待",
  completed: "已完成",
  cancelled: "已取消",
};
export function App() {
  const client = useWorkspace();
  if (client.authenticationRequired) return <CenterLogin client={client} />;
  if (!client.boot)
    return (
      <main className="connection-screen">
        <BrandMark />
        <h1>Morphz</h1>
        <p>{client.error || "正在连接中心…"}</p>
        <button onClick={() => void client.refresh()}>重新连接</button>
      </main>
    );
  storageScope(client.boot.centerId, client.boot.principalId);
  return (
    <WorkspaceApp
      key={`${client.boot.centerId}:${client.boot.principalId}`}
      client={client}
    />
  );
}
function CenterLogin({ client }: { client: ReturnType<typeof useWorkspace> }) {
  const [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="connection-screen">
      <BrandMark />
      <h1>连接工作中心</h1>
      <p>使用中心管理员提供的个人连接凭据。每位参与者使用自己的身份。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await client.login(token.trim());
            setToken("");
          } catch (e) {
            setError(e instanceof Error ? e.message : "连接失败。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          连接凭据
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            maxLength={128}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="button primary" disabled={busy || !token.trim()}>
          {busy ? "连接中…" : "连接"}
        </button>
      </form>
      <small>凭据不会保存到页面的本地存储。</small>
    </main>
  );
}
function WorkspaceApp({ client }: { client: ReturnType<typeof useWorkspace> }) {
  const state = client.boot?.workspace;
  const { readLocal, writeLocal } = useState(() => scopedStorage())[0];
  const [prefs, setPrefs] = useState<Preferences>(() => {
    const p = readLocal<Partial<Preferences>>("preferences", {});
    return {
      ...defaultPrefs,
      ...p,
      projectOpen: p.projectOpen ?? p.view === "projects",
      accent: ["cyan", "iris", "coral", "mono"].includes(p.accent ?? "")
        ? p.accent!
        : defaultPrefs.accent,
      view: ["inbox", "desk", "projects"].includes(p.view ?? "")
        ? p.view!
        : defaultPrefs.view,
    };
  });
  const [notice, setNotice] = useState(""),
    [taskFilter, setTaskFilter] = useState<
      "mine" | "active" | "waiting" | "completed" | "all"
    >("mine"),
    [speech, setSpeech] = useState<{
      scope: SpeechScope;
      title: string;
      key: string;
      draft: InputDraft;
    } | null>(null),
    [capture, setCapture] = useState<{
      projectId: string;
      artifactId?: string;
      artifactRevision?: number;
    } | null>(null),
    [importOpen, setImportOpen] = useState(false),
    [understandingOpen, setUnderstandingOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [themeOpen, setThemeOpen] = useState(false),
    [spaceMenu, setSpaceMenu] = useState(false),
    [creating, setCreating] = useState<
      | "document"
      | "task"
      | "project"
      | "save-project"
      | "website"
      | "interactive"
      | null
    >(null),
    [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, InputDraft>>(() =>
    readLocal(draftKey("inputs"), {}),
  );
  const input = useRef<HTMLTextAreaElement>(null),
    main = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    file = useRef<HTMLInputElement>(null),
    theme = useRef<HTMLDivElement>(null),
    spaceOptions = useRef<HTMLDetailsElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [compact, setCompact] = useState(
      () => matchMedia("(max-width:850px)").matches,
    ),
    [mobileCollaboration, setMobileCollaboration] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width:850px)");
    const changed = () => {
      setCompact(media.matches);
      setMobileCollaboration(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const personalSpace = (kind: "desk" | "inbox") =>
    state?.projects.find(
      (p) => p.kind === kind && p.ownerPrincipalId === client.boot!.principalId,
    );
  const project =
    prefs.view === "desk" || (prefs.view === "projects" && !prefs.projectOpen)
      ? personalSpace("desk")
      : prefs.view === "inbox"
        ? personalSpace("inbox")
        : (state?.projects.find(
            (p) => p.id === prefs.projectId && spaceKind(p) === "project",
          ) ??
          state?.projects.find((p) => spaceKind(p) === "project") ??
          personalSpace("desk"));
  const applicationWorkspaceOpen =
    prefs.view === "desk" || (prefs.view === "projects" && prefs.projectOpen);
  const activeId =
    project && applicationWorkspaceOpen
      ? prefs.applications?.[project.id] === null
        ? null
        : (prefs.applications?.[project.id] ??
          state?.applicationInstances.find(
            (i) => i.workspaceId === project.id && i.status === "open",
          )?.id ??
          null)
      : null;
  const activeInstance = state?.applicationInstances.find(
    (i) =>
      i.id === activeId && i.workspaceId === project?.id && i.status === "open",
  );
  const artifact = state?.artifacts.find(
    (a) =>
      a.projectId === project?.id &&
      a.id ===
        (prefs.artifactId ??
          (prefs.view !== "inbox" &&
          activeInstance?.applicationId === objectsApplication.id
            ? activeInstance.state.artifactId
            : null)),
  );
  const contextKey =
    (project?.id ?? "") +
    ":" +
    (artifact?.id ?? activeInstance?.id ?? prefs.view);
  const interaction = prefs.interactions?.[project?.id ?? ""] ?? "input";
  const inputVisible = interaction !== "hidden";
  const conversationVisible =
    interaction === "recent" || interaction === "history";
  const historyVisible = interaction === "history";
  const latestInteraction = useRef(interaction);
  latestInteraction.current = interaction;
  const positions = useRef(new Map<string, number>());
  const exchangePositions = useRef(new Map<string, ExchangePosition>());
  const [revealedInputs, setRevealedInputs] = useState<Record<string, string>>(
    {},
  );
  const [seenReplies, setSeenReplies] = useState<Record<string, string>>({});
  const replies = client.boot!.runtime.messages.filter(
    (m) => m.projectId === project?.id,
  );
  const replyVersion = replies.map((m) => m.id + ":" + m.text.length).join("|");
  const unseenReply =
    !!replyVersion && replyVersion !== seenReplies[project?.id ?? ""];
  useEffect(() => {
    if (conversationVisible && project)
      setSeenReplies((old) => ({ ...old, [project.id]: replyVersion }));
  }, [conversationVisible, project?.id, replyVersion]);
  useEffect(() => {
    setSpaceMenu(false);
  }, [project?.id, prefs.view, activeId]);
  useLayoutEffect(() => {
    const element = main.current;
    element?.scrollTo({ top: positions.current.get(contextKey) ?? 0 });
    return () => {
      if (element) positions.current.set(contextKey, element.scrollTop);
    };
  }, [contextKey]);
  useEffect(() => {
    document.title = `${artifact?.title ?? (prefs.view === "projects" && prefs.projectOpen ? project?.title : labels[prefs.view])} — Morphz`;
  }, [artifact?.title, project?.title, prefs.view, prefs.projectOpen]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const navigationGeneration = useRef(0);
  const collaborationVisible =
    !!artifact && (compact ? mobileCollaboration : prefs.collaboration);
  const draft = drafts[contextKey] ?? emptyDraft;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform),
    shortcut = mac ? "⌘J" : "Ctrl+J";
  function prefer(change: Partial<Preferences>) {
    if (
      "view" in change ||
      "projectId" in change ||
      "artifactId" in change ||
      "applications" in change
    )
      navigationGeneration.current++;
    setPrefs((previous) => {
      const next = {
        ...previous,
        ...("artifactId" in change ? { artifactRevision: null } : {}),
        ...change,
        ...(change.interactions
          ? {
              interactions: {
                ...previous.interactions,
                ...change.interactions,
              },
            }
          : {}),
      };
      try {
        writeLocal("preferences", next);
      } catch {
        setNotice("外观设置暂时无法持久保存。");
      }
      return next;
    });
  }
  function setInteraction(mode: InteractionMode, id = project?.id) {
    if (id) prefer({ interactions: { [id]: mode } });
  }
  function setDraft(key: string, value: InputDraft) {
    setDrafts((previous) => {
      const next = { ...previous, [key]: value };
      try {
        writeLocal(draftKey("inputs"), next);
      } catch {
        setNotice("本地草稿保存失败，请不要刷新页面。");
      }
      return next;
    });
  }
  function open(id: string, revision?: number, page?: number) {
    const a = state?.artifacts.find((x) => x.id === id);
    if (a) void openObject(a.projectId, id, revision, page);
  }
  async function openObject(
    workspaceId: string,
    id: string,
    revision?: number,
    page?: number,
  ) {
    const generation = ++navigationGeneration.current;
    try {
      const result = await client.execute({
        type: "launch-application",
        workspaceId,
        applicationId: objectsApplication.id,
        applicationVersion: objectsApplication.version,
        artifactId: id,
      });
      // A slow open must not undo a later navigation or object selection.
      if (generation !== navigationGeneration.current) return;
      setCreating(null);
      const owner = state?.projects.find((p) => p.id === workspaceId);
      prefer({
        view:
          owner && spaceKind(owner) === "project"
            ? "projects"
            : owner?.kind === "inbox"
              ? "inbox"
              : "desk",
        projectOpen: !!owner && spaceKind(owner) === "project",
        projectId: workspaceId,
        artifactId: id,
        artifactRevision: revision ?? null,
        artifactPage: page ?? null,
        ...(prefs.interactions?.[workspaceId] === "history"
          ? { interactions: { [workspaceId]: "recent" as const } }
          : {}),
        applications: { ...prefs.applications, [workspaceId]: result.entityId },
      });
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function activateApplication(id: string | null) {
    if (!project) return;
    setCreating(null);
    prefer({
      applications: { ...prefs.applications, [project.id]: id },
      artifactId: null,
      ...(historyVisible
        ? { interactions: { [project.id]: "recent" as const } }
        : {}),
    });
  }
  function navigate(view: View) {
    setCreating(null);
    prefer({ view, artifactId: null, projectOpen: false });
  }
  function openProject(id: string) {
    setCreating(null);
    prefer({
      view: "projects",
      projectId: id,
      projectOpen: true,
      artifactId: null,
    });
  }
  function showInput() {
    setMobileCollaboration(false);
    previousFocus.current = document.activeElement as HTMLElement;
    setInteraction(revealInput(interaction));
    requestAnimationFrame(() => input.current?.focus());
  }
  function hideInput() {
    setInteraction("hidden");
    if (document.activeElement === input.current) {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
      else toggle.current?.focus();
    }
  }
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      // Native dialogs own Escape/focus while modal. Global composer shortcuts
      // must not consume their cancel event or open a second modal behind them.
      if (document.querySelector("dialog[open]")) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setSearchOpen((previous) => !previous);
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "j"
      ) {
        if (creating) return;
        e.preventDefault();
        if (!e.repeat) {
          setThemeOpen(false);
          if (inputVisible) hideInput();
          else showInput();
        }
      } else if (e.key === "Escape") {
        if (creating) return;
        if (spaceMenu) {
          e.preventDefault();
          setSpaceMenu(false);
          spaceOptions.current?.querySelector<HTMLElement>("summary")?.focus();
        } else if (themeOpen) {
          e.preventDefault();
          setThemeOpen(false);
        } else if (mobileCollaboration) {
          e.preventDefault();
          setMobileCollaboration(false);
        } else if (
          inputVisible &&
          input.current?.contains(document.activeElement)
        ) {
          e.preventDefault();
          hideInput();
        }
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [
    interaction,
    contextKey,
    creating,
    themeOpen,
    spaceMenu,
    mobileCollaboration,
  ]);
  useEffect(() => {
    function outside(e: PointerEvent) {
      if (!theme.current?.contains(e.target as Node)) setThemeOpen(false);
      if (!spaceOptions.current?.contains(e.target as Node))
        setSpaceMenu(false);
    }
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.appearance = prefs.appearance;
  }, [prefs.appearance]);
  async function send(asAnnotation = false) {
    if (!project || !draft.body.trim() || sending) return;
    const key = contextKey,
      captured = { ...draft };
    setSending(true);
    try {
      if (asAnnotation && artifact && captured.selection && captured.revision)
        await client.execute({
          type: "annotate",
          artifactId: artifact.id,
          artifactRevision: captured.revision,
          quote: captured.selection,
          ...(captured.page ? { page: captured.page } : {}),
          body: captured.body,
        });
      else {
        const receipt = await client.execute(
          {
            type: "record-input",
            projectId: project.id,
            ...(activeInstance
              ? { applicationInstanceId: activeInstance.id }
              : {}),
            artifactId: artifact?.id ?? null,
            artifactRevision: artifact
              ? (captured.revision ?? artifact.revision)
              : null,
            selection: captured.selection,
            body: captured.body,
            targetActantId: "morphz-agent",
          },
          !!client.boot?.runtime.configured,
        );
        setRevealedInputs((old) => ({
          ...old,
          [project.id]: receipt.entityId,
        }));
      }
      setDraft(key, { ...emptyDraft });
      if (currentContext.current === key) {
        if (asAnnotation) {
          if (compact) setMobileCollaboration(true);
          else prefer({ collaboration: true });
        } else {
          setMobileCollaboration(false);
          setInteraction(afterSend(latestInteraction.current));
          if (latestInteraction.current !== "hidden")
            requestAnimationFrame(() => input.current?.focus());
        }
      }
      setNotice(
        asAnnotation
          ? "批注已保存，原文版本已关联。"
          : client.boot?.runtime.configured
            ? "消息已保存并排队发送给 Morphz。"
            : "输入已保存到中心；尚未发送给 Morphz Runtime。",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "保存失败，草稿已保留。");
    } finally {
      setSending(false);
    }
  }
  async function importImage(image: File | undefined) {
    if (!image || !project || importing) return;
    setImporting(true);
    try {
      const { assetId } = await client.upload(image);
      const receipt = await client.execute({
        type: "create-artifact",
        projectId: project.id,
        title: image.name.replace(/\.[^.]+$/, "").slice(0, 180) || "导入的图片",
        content: { kind: "image", assetId, alt: "" },
      });
      await openObject(project.id, receipt.entityId);
      setNotice("图片已保存，可以添加关联和讨论。");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "导入失败。");
    } finally {
      setImporting(false);
      if (file.current) file.current.value = "";
    }
  }
  if (!state || !project)
    return (
      <div className="startup">
        <h1>Morphz</h1>
        <p>{client.error ? "暂时无法连接本机中心。" : "正在打开工作空间…"}</p>
        {client.error && (
          <>
            <p className="muted">请确认本机中心已启动。现有数据不会被重置。</p>
            <button onClick={() => void client.refresh()}>
              <RefreshCw />
              重新连接
            </button>
          </>
        )}
      </div>
    );
  const tasks = inboxFor(state, client.boot!.principalId),
    objects = state.artifacts.filter((a) => a.projectId === project.id);
  const visibleTasks =
    taskFilter === "mine"
      ? tasks
      : state.artifacts
          .filter(
            (a) =>
              a.content.kind === "task" &&
              (taskFilter === "all" || a.content.execution === taskFilter),
          )
          .sort((a, b) => {
            if (a.content.kind !== "task" || b.content.kind !== "task")
              return 0;
            const priority = { high: 0, normal: 1, low: 2 };
            return (
              priority[a.content.priority] - priority[b.content.priority] ||
              (a.content.dueDate ?? "9999").localeCompare(
                b.content.dueDate ?? "9999",
              ) ||
              b.updatedAt.localeCompare(a.updatedAt)
            );
          });
  const inputs = state.inputs.filter((i) => i.projectId === project.id);
  const annotations = artifact
    ? state.annotations.filter((a) => a.artifactId === artifact.id)
    : [];
  const contextTitle = artifact?.title ?? project.title;
  return (
    <div
      className={
        "app " +
        (!collaborationVisible ? "without-collaboration" : "") +
        (compact && mobileCollaboration ? " mobile-collaboration" : "") +
        (!prefs.sidebar ? " sidebar-hidden" : "")
      }
      data-accent={prefs.accent}
      data-appearance={prefs.appearance}
      data-desktop={
        /Electron\//.test(navigator.userAgent) && mac ? "mac" : undefined
      }
    >
      <aside
        className="sidebar"
        id="workspace-sidebar"
        aria-label="工作空间导航"
      >
        <div className="wordmark">
          <BrandMark />
          <span>Morphz</span>
        </div>
        <div className="space-label">{state.name}</div>
        <button
          className="sidebar-search"
          onClick={() => setSearchOpen(true)}
          aria-label="搜索工作空间"
        >
          <Search />
          <span>搜索</span>
          <kbd>{mac ? "⌘K" : "Ctrl+K"}</kbd>
        </button>
        <nav aria-label="主导航">
          {(["inbox", "desk", "projects"] as View[]).map((view) => {
            const Icon = {
              inbox: Inbox,
              desk: PanelsTopLeft,
              projects: Layers2,
            }[view];
            return (
              <button
                key={view}
                aria-current={prefs.view === view ? "page" : undefined}
                onClick={() => navigate(view)}
              >
                <Icon />
                {labels[view]}
                {view === "inbox" && <small>{tasks.length}</small>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-section">
          <div className="section-label">
            项目
            <button
              aria-label="新建项目"
              onClick={() => setCreating("project")}
            >
              <Plus />
            </button>
          </div>
          {state.projects
            .filter((p) => spaceKind(p) === "project")
            .map((p) => (
              <button
                className="project-link"
                key={p.id}
                aria-current={
                  prefs.view === "projects" &&
                  prefs.projectOpen &&
                  project.id === p.id
                    ? "true"
                    : undefined
                }
                onClick={() => openProject(p.id)}
              >
                <Folder />
                <span>{p.title}</span>
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
          <Notifications client={client} onOpen={open} />
          <span className="avatar">我</span>
          <div>
            {actorName(state, client.boot!.actantId)}
            <small>
              <span className="presence-dot" data-online={client.online} />
              {client.online ? "工作中心已连接" : "工作中心已断开"}
            </small>
          </div>
          {client.boot?.capabilities.teamAuthentication && (
            <button
              title="退出当前身份"
              className="icon-button"
              onClick={() =>
                void client.logout().catch((e) => setNotice(e.message))
              }
            >
              <X size={16} />
            </button>
          )}
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button sidebar-toggle"
            aria-label={prefs.sidebar ? "隐藏侧边栏" : "显示侧边栏"}
            title={prefs.sidebar ? "隐藏侧边栏" : "显示侧边栏"}
            aria-expanded={prefs.sidebar}
            aria-controls="workspace-sidebar"
            onClick={() => prefer({ sidebar: !prefs.sidebar })}
          >
            <PanelLeft />
          </button>
          <div className="breadcrumb">
            <button onClick={() => navigate(prefs.view)}>
              {labels[prefs.view]}
            </button>
            {prefs.view === "projects" && prefs.projectOpen && (
              <>
                <ChevronRight />
                <button onClick={() => openProject(project.id)}>
                  {project.title}
                </button>
              </>
            )}
            {artifact && (
              <>
                <ChevronRight />
                <strong>{artifact.title}</strong>
              </>
            )}
          </div>
          <div className="top-actions">
            <details
              ref={spaceOptions}
              className="workspace-options"
              open={spaceMenu}
              onToggle={(e) => setSpaceMenu(e.currentTarget.open)}
            >
              <summary aria-label="工作空间选项">
                <MoreHorizontal />
              </summary>
              <div className="workspace-options-menu">
                <button
                  title="核对项目当前理解"
                  aria-label="当前理解"
                  className="icon-button"
                  onClick={() => {
                    spaceOptions.current
                      ?.querySelector<HTMLElement>("summary")
                      ?.focus();
                    setSpaceMenu(false);
                    setUnderstandingOpen(true);
                  }}
                >
                  <Brain />
                  当前理解
                </button>
                <button
                  className="icon-button"
                  aria-label="导入资料"
                  title="导入资料"
                  onClick={() => {
                    spaceOptions.current
                      ?.querySelector<HTMLElement>("summary")
                      ?.focus();
                    setSpaceMenu(false);
                    setImportOpen(true);
                  }}
                >
                  <FileUp />
                  导入资料
                </button>
              </div>
            </details>
            <button
              ref={toggle}
              className="input-toggle"
              aria-label={inputVisible ? "隐藏 AI 输入框" : "显示 AI 输入框"}
              aria-expanded={inputVisible}
              aria-controls="global-composer"
              title={`AI 输入 · ${shortcut}`}
              onClick={() => (inputVisible ? hideInput() : showInput())}
            >
              <MessageCircle />
              <kbd>{shortcut}</kbd>
            </button>
            <div className="theme-wrap" ref={theme}>
              <button
                title="外观设置"
                aria-label="外观设置"
                aria-expanded={themeOpen}
                onClick={() => setThemeOpen(!themeOpen)}
              >
                <Palette />
              </button>
              {themeOpen && (
                <section className="theme-menu" aria-label="外观设置面板">
                  <span className="section-label">外观模式</span>
                  <div className="mode-options">
                    {(["system", "light", "dark"] as const).map((mode) => (
                      <button
                        key={mode}
                        aria-pressed={prefs.appearance === mode}
                        onClick={() => prefer({ appearance: mode })}
                      >
                        {
                          { system: "跟随系统", light: "亮色", dark: "暗色" }[
                            mode
                          ]
                        }
                      </button>
                    ))}
                  </div>
                  <span className="section-label">主题色</span>
                  <div className="color-options">
                    {(["cyan", "iris", "coral", "mono"] as const).map(
                      (color) => (
                        <button
                          key={color}
                          aria-pressed={prefs.accent === color}
                          onClick={() => {
                            prefer({ accent: color });
                            setThemeOpen(false);
                          }}
                        >
                          <span className={"swatch " + color} />
                          {
                            {
                              cyan: "电光青",
                              iris: "鸢尾紫",
                              coral: "暖珊瑚",
                              mono: "纯单色",
                            }[color]
                          }
                        </button>
                      ),
                    )}
                  </div>
                </section>
              )}
            </div>
            {artifact && (
              <button
                className="icon-button"
                aria-label={collaborationVisible ? "收起批注栏" : "展开批注栏"}
                title={artifact ? "对象批注" : "打开对象后查看批注"}
                disabled={!artifact}
                aria-pressed={collaborationVisible}
                onClick={() =>
                  compact
                    ? setMobileCollaboration(!mobileCollaboration)
                    : prefer({ collaboration: !prefs.collaboration })
                }
              >
                <PanelRight />
              </button>
            )}
          </div>
        </header>
        <div className="workspace-body">
          <div className="primary-panel" data-interaction={interaction}>
            <main ref={main} aria-label="主工作区" hidden={historyVisible}>
              {creating === "document" && (
                <CreateDialog
                  key={project.id}
                  kind="document"
                  projectId={project.id}
                  client={client}
                  onClose={() => setCreating(null)}
                  onCreated={(id) => {
                    setCreating(null);
                    void openObject(project.id, id);
                  }}
                />
              )}
              <div className="object-surface" hidden={creating === "document"}>
                <ApplicationHost
                  client={client}
                  foreground={!historyVisible && creating !== "document"}
                  workspaceId={project.id}
                  activeId={activeId}
                  enabled={
                    prefs.view !== "inbox" &&
                    (prefs.view !== "projects" || prefs.projectOpen)
                  }
                  onActivate={activateApplication}
                  onOpen={open}
                  onNotice={setNotice}
                  onSaveProject={() => setCreating("save-project")}
                  onCompose={(text, artifactId) => {
                    if (artifactId) {
                      const target = state.artifacts.find(
                        (a) =>
                          a.id === artifactId && a.projectId === project.id,
                      );
                      if (!target) return;
                      prefer({ artifactId: target.id });
                      const key = project.id + ":" + target.id;
                      setDraft(key, {
                        body: [drafts[key]?.body, text]
                          .filter(Boolean)
                          .join("\n"),
                        selection: "",
                        revision: target.revision,
                      });
                    } else
                      setDraft(contextKey, {
                        ...draft,
                        body: [draft.body, text].filter(Boolean).join("\n"),
                      });
                    showInput();
                  }}
                >
                  {artifact ? (
                    <ArtifactEditor
                      key={
                        artifact.id +
                        ":" +
                        (prefs.artifactRevision ?? "current") +
                        ":" +
                        (prefs.artifactPage ?? "saved")
                      }
                      artifact={artifact}
                      state={state}
                      client={client}
                      onOpen={open}
                      onNotice={setNotice}
                      initialRevision={prefs.artifactRevision}
                      initialPage={prefs.artifactPage}
                      onSelect={(quote, revision, page) => {
                        setDraft(contextKey, {
                          ...draft,
                          selection: quote,
                          revision,
                          page,
                        });
                        showInput();
                      }}
                    />
                  ) : prefs.view === "inbox" ? (
                    <section className="collection">
                      <div className="collection-title">
                        <h1>事项</h1>
                        <button
                          className="outline"
                          onClick={() => setCreating("task")}
                        >
                          <Plus />
                          新建事项
                        </button>
                      </div>
                      <p className="intro">
                        指派给你的事项，以及接下来需要推进的工作。
                      </p>
                      <div
                        className="matter-filters"
                        role="group"
                        aria-label="事项状态"
                      >
                        {(
                          [
                            "mine",
                            "active",
                            "waiting",
                            "completed",
                            "all",
                          ] as const
                        ).map((filter) => (
                          <button
                            key={filter}
                            aria-pressed={taskFilter === filter}
                            onClick={() => setTaskFilter(filter)}
                          >
                            {
                              {
                                mine: "待我处理",
                                active: "进行中",
                                waiting: "等待",
                                completed: "已完成",
                                all: "全部",
                              }[filter]
                            }
                          </button>
                        ))}
                        <small>{visibleTasks.length} 项</small>
                      </div>
                      {visibleTasks.length ? (
                        visibleTasks.map((a) => (
                          <TaskRow
                            key={a.id}
                            artifact={a}
                            onOpen={open}
                            assignee={
                              a.content.kind === "task"
                                ? actorName(state, a.content.assigneeId)
                                : ""
                            }
                          />
                        ))
                      ) : (
                        <div className="empty-state">
                          <span className="empty-icon">
                            <Inbox />
                          </span>
                          <h2>
                            {taskFilter === "mine"
                              ? "目前没有待处理事项"
                              : "这个分类下还没有事项"}
                          </h2>
                          <p>
                            交给你的工作会集中在这里。
                            <br />
                            也可以新建事项，安排负责人和时间。
                          </p>
                        </div>
                      )}
                    </section>
                  ) : prefs.view === "projects" && !prefs.projectOpen ? (
                    <ProjectDirectory
                      state={state}
                      onOpen={openProject}
                      onCreate={() => setCreating("project")}
                    />
                  ) : (
                    <ObjectCollection
                      key={project.id}
                      project={project}
                      objects={objects}
                      onOpen={open}
                      onCreate={setCreating}
                      onImport={() => file.current?.click()}
                      importing={importing}
                    />
                  )}
                </ApplicationHost>
              </div>
            </main>
            {inputVisible && (
              <div className="exchange-header">
                <button
                  aria-label={
                    conversationVisible ? "收起交流记录" : "查看交流记录"
                  }
                  onClick={() =>
                    setInteraction(conversationVisible ? "input" : "recent")
                  }
                >
                  <History />
                  {conversationVisible ? "收起交流" : "交流记录"}
                  {inputs.length > 0 && <small>{inputs.length}</small>}
                  {!conversationVisible && unseenReply && (
                    <span className="unread-label">有新回复</span>
                  )}
                </button>
                <span className="exchange-space">{project.title}</span>
                {conversationVisible && (
                  <button
                    aria-label={
                      historyVisible ? "返回工作内容" : "展开完整记录"
                    }
                    onClick={() =>
                      setInteraction(historyVisible ? "recent" : "history")
                    }
                  >
                    {historyVisible ? <Minimize2 /> : <Maximize2 />}
                    {historyVisible ? "返回内容" : "展开"}
                  </button>
                )}
              </div>
            )}
            {conversationVisible && (
              <Conversation
                key={project.id}
                inputs={inputs}
                positions={exchangePositions.current}
                revealInputId={revealedInputs[project.id] ?? null}
                state={state}
                contextTitle={project.title}
                runtime={client.boot!.runtime}
                projectId={project.id}
                artifactId={artifact?.id ?? null}
                client={client}
                onOpen={open}
                onRetry={async (id) => {
                  try {
                    await client.dispatchInput(id);
                  } catch (error) {
                    setNotice(
                      error instanceof Error ? error.message : "发送失败。",
                    );
                  }
                }}
              />
            )}
            <div className="composer-dock">
              {inputVisible ? (
                <section
                  className="composer"
                  id="global-composer"
                  aria-label="AI 输入"
                >
                  <div className="composer-heading">
                    {
                      <span className="context-chip">
                        <Link2 />
                        {contextTitle}
                        {draft.revision ? " · v" + draft.revision : ""}
                      </span>
                    }
                    <button
                      className="icon-button"
                      aria-label="收起 AI 输入框"
                      onClick={hideInput}
                    >
                      <ChevronDown />
                    </button>
                  </div>
                  {draft.selection && (
                    <div className="selection-quote">
                      <blockquote>{draft.selection}</blockquote>
                      <button
                        aria-label="移除引用"
                        onClick={() =>
                          setDraft(contextKey, { ...draft, selection: "" })
                        }
                      >
                        <X />
                      </button>
                    </div>
                  )}
                  <textarea
                    ref={input}
                    aria-label="AI 输入内容"
                    placeholder="提出想法，或让工作继续…"
                    rows={2}
                    maxLength={30000}
                    value={draft.body}
                    disabled={sending}
                    onChange={(e) =>
                      setDraft(contextKey, {
                        ...draft,
                        body: e.target.value,
                        revision: artifact
                          ? (draft.revision ?? artifact.revision)
                          : null,
                      })
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        event.keyCode !== 229
                      ) {
                        event.preventDefault();
                        if (client.online) void send();
                      }
                    }}
                  />
                  <div className="composer-actions">
                    <small className="model-status">
                      <BrandMark />
                      {client.boot!.runtime.configured
                        ? client.boot!.runtime.connected
                          ? client.boot!.runtime.model || "Morphz"
                          : "连接中 · 消息将保留并排队"
                        : "Agent 未连接 · 仅保存，不会回复"}
                    </small>
                    <div className="inline">
                      <button
                        aria-label="截图输入"
                        disabled={sending || !client.online}
                        onClick={() =>
                          setCapture({
                            projectId: project.id,
                            ...(artifact
                              ? {
                                  artifactId: artifact.id,
                                  artifactRevision:
                                    draft.revision ??
                                    prefs.artifactRevision ??
                                    artifact.revision,
                                }
                              : {}),
                          })
                        }
                      >
                        <Scan />
                      </button>
                      <button
                        aria-label="语音输入"
                        disabled={sending || !client.online}
                        onClick={() =>
                          setSpeech({
                            scope: {
                              projectId: project.id,
                              ...(artifact
                                ? {
                                    artifactId: artifact.id,
                                    revision:
                                      draft.revision ??
                                      prefs.artifactRevision ??
                                      artifact.revision,
                                  }
                                : {}),
                            },
                            title: contextTitle,
                            key: contextKey,
                            draft: { ...draft },
                          })
                        }
                      >
                        <Mic />
                      </button>
                      {draft.selection && (
                        <button
                          aria-label="保存为批注"
                          disabled={
                            !draft.body.trim() || sending || !client.online
                          }
                          onClick={() => void send(true)}
                        >
                          <MessageSquarePlus />
                          <span className="optional">批注</span>
                        </button>
                      )}
                      <span className="compose-hint">
                        Enter 发送 · Shift+Enter 换行
                      </span>
                      <button
                        className="send"
                        aria-label={
                          client.boot!.runtime.configured
                            ? "发送消息"
                            : "保存输入"
                        }
                        disabled={
                          !draft.body.trim() || sending || !client.online
                        }
                        onClick={() => void send()}
                      >
                        <ArrowUp />
                      </button>
                    </div>
                  </div>
                </section>
              ) : (
                <button className="composer-reopen" onClick={showInput}>
                  <MessageCircle />向 Morphz 输入<kbd>{shortcut}</kbd>
                  {unseenReply && (
                    <span className="unread-label">有新回复</span>
                  )}
                </button>
              )}
            </div>
          </div>
          {collaborationVisible && (
            <aside className="collaboration" aria-label="对象批注">
              <header>
                <h2>批注</h2>
                <button
                  aria-label="关闭批注栏"
                  onClick={() => {
                    setMobileCollaboration(false);
                    prefer({ collaboration: false });
                  }}
                >
                  <X />
                </button>
              </header>
              <p className="collaboration-context">{contextTitle}</p>
              <div className="collaboration-scroll">
                {!annotations.length ? (
                  <div className="discussion-empty">
                    <MessageSquarePlus />
                    <p>
                      选中正文，在输入框写下想法，
                      <br />
                      选择“保存为批注”。
                    </p>
                    <small>对话显示在主工作区。</small>
                  </div>
                ) : (
                  <>
                    {annotations.map((a) => (
                      <section className="message annotation" key={a.id}>
                        <div className="message-author">
                          <MessageSquarePlus />
                          {actorName(state, a.author.actantId)}
                          <small>
                            批注 · v{a.artifactRevision}
                            {a.page ? ` · 第 ${a.page} 页` : ""}
                          </small>
                        </div>
                        <blockquote>{a.quote}</blockquote>
                        <p>{a.body}</p>
                      </section>
                    ))}
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
        {(notice || !client.online) && (
          <footer className="statusbar">
            <span role="status" aria-live="polite">
              {notice ||
                (client.online
                  ? "本机中心已连接 · 修改保存在中心"
                  : "与中心断开 · 草稿保留在本机")}
            </span>
            <button
              onClick={() => void client.refresh()}
              aria-label="同步工作空间"
            >
              <RefreshCw />
              {client.online ? "已同步" : "重新连接"}
            </button>
            {client.online && (
              <button aria-label="关闭状态提示" onClick={() => setNotice("")}>
                <X />
              </button>
            )}
          </footer>
        )}
      </div>
      <input
        className="hidden-file"
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="导入图片文件"
        onChange={(e) => void importImage(e.target.files?.[0])}
      />
      {creating && creating !== "document" && (
        <CreateDialog
          kind={creating}
          projectId={project.id}
          client={client}
          onClose={() => setCreating(null)}
          onCreated={(id, kind) => {
            setCreating(null);
            if (kind === "project" || kind === "save-project") openProject(id);
            else void openObject(project.id, id);
            setNotice("已创建并保存到中心。");
          }}
        />
      )}
      {importOpen && (
        <ImportDocuments
          client={client}
          project={project}
          onClose={() => setImportOpen(false)}
          onOpen={open}
        />
      )}
      {speech && (
        <SpeechDialog
          client={client}
          scope={speech.scope}
          title={speech.title}
          onClose={() => setSpeech(null)}
          onInsert={(text) => {
            const saved = speech.draft;
            const body = [saved.body, text].filter(Boolean).join("\n");
            if (body.length > 30000)
              throw new Error(
                "这段文字超过单条消息长度，请先保存为文档，再围绕文档输入；文字不会被截断。",
              );
            setDraft(speech.key, {
              ...saved,
              body,
              revision: speech.scope.revision ?? null,
            });
            setSpeech(null);
            setInteraction("input");
            setNotice(
              saved.selection
                ? "语音文字已放入输入框，可修改后保存为批注。"
                : "语音文字已放入输入框，确认后再发送。",
            );
            requestAnimationFrame(() => input.current?.focus());
          }}
        />
      )}
      {understandingOpen && (
        <UnderstandingDialog
          client={client}
          projectId={project.id}
          onOpen={open}
          onClose={() => setUnderstandingOpen(false)}
        />
      )}
      {capture && (
        <CaptureDialog
          client={client}
          {...capture}
          onClose={() => setCapture(null)}
          onSaved={(id) => {
            const projectId = capture.projectId;
            setCapture(null);
            void openObject(projectId, id);
            setNotice("截图已保存为对象，可围绕它继续输入。");
          }}
        />
      )}
      {searchOpen && (
        <SearchDocuments
          client={client}
          onClose={() => setSearchOpen(false)}
          onOpen={open}
          onQuote={(id, revision, quote, page) => {
            const target = state.artifacts.find((a) => a.id === id);
            if (!target) return;
            const key = target.projectId + ":" + target.id;
            setDraft(key, {
              ...(drafts[key] ?? emptyDraft),
              selection: quote,
              revision,
              page,
            });
            void openObject(target.projectId, id, revision, page).then(() => {
              setInteraction("input", target.projectId);
              requestAnimationFrame(() => input.current?.focus());
            });
          }}
        />
      )}
    </div>
  );
}
function TaskRow({
  artifact,
  onOpen,
  assignee,
}: {
  artifact: Artifact;
  onOpen: (id: string) => void;
  assignee: string;
}) {
  const c = artifact.content as TaskContent;
  return (
    <button
      className="task-row"
      aria-label="打开事项"
      onClick={() => onOpen(artifact.id)}
    >
      <span className="task-check">
        <CircleCheck />
      </span>
      <span className="task-summary">
        <h2>{artifact.title}</h2>
        <span className="task-description">
          {c.description || "打开事项查看与调整安排。"}
        </span>
      </span>
      <span className="task-meta">
        {assignee} ·{" "}
        <span className="priority-dot" data-priority={c.priority} />
        {{ high: "高", normal: "普通", low: "低" }[c.priority]}优先级 ·{" "}
        {taskStatus[c.execution]}
        {c.dueDate && " · " + c.dueDate}
      </span>
      <ChevronRight />
    </button>
  );
}
function CreateDialog({
  kind,
  projectId,
  client,
  onClose,
  onCreated,
}: {
  kind:
    | "document"
    | "task"
    | "project"
    | "save-project"
    | "website"
    | "interactive";
  projectId: string;
  client: ReturnType<typeof useWorkspace>;
  onClose: () => void;
  onCreated: (id: string, kind: string) => void;
}) {
  const [storage] = useState(() => scopedStorage());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const draftId = draftKey("create-document:" + projectId);
  const cached =
    kind === "document"
      ? storage.readLocal<{ title: string; markdown: string }>(draftId, {
          title: "",
          markdown: "",
        })
      : { title: "", markdown: "" };
  const dialog = useRef<HTMLDialogElement>(null),
    [title, setTitle] = useState(cached.title),
    [markdown, setMarkdown] = useState(cached.markdown),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [task, setTask] = useState<TaskContent>({
    kind: "task",
    description: "",
    assigneeId: client.boot!.actantId,
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    runRequested: 0,
    notBefore: null,
    everySeconds: null,
    dependsOnIds: [],
    watchSourceIds: [],
  });
  useModal(dialog);
  useEffect(() => {
    if (kind === "document") {
      try {
        storage.writeLocal(draftId, { title, markdown });
      } catch {
        setError("草稿未能保存，请保留当前页面。\n");
      }
    }
  }, [title, markdown, kind, draftId, storage]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.execute(
        kind === "save-project"
          ? { type: "save-workspace-as-project", workspaceId: projectId, title }
          : kind === "project"
            ? { type: "create-project", title }
            : {
                type: "create-artifact",
                projectId,
                title,
                content:
                  kind === "document"
                    ? { kind: "document", markdown }
                    : kind === "website"
                      ? { kind: "website", url: markdown, description: "" }
                      : kind === "interactive"
                        ? structuredClone(emptyInteractive)
                        : task,
              },
      );
      if (kind === "document") {
        try {
          storage.writeLocal(draftId, { title: "", markdown: "" });
        } catch {
          /* Creation already succeeded; never repeat it on a local storage failure. */
        }
      }
      if (alive.current) onCreated(result.entityId, kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败。");
    } finally {
      setBusy(false);
    }
  }
  const form = (
    <form onSubmit={(e) => void submit(e)}>
      <header>
        <h2 id="create-title">
          新建
          {
            {
              document: "文档",
              task: "事项",
              project: "项目",
              "save-project": "项目（保留当前工作）",
              website: "网站",
              interactive: "交互产物",
            }[kind]
          }
        </h2>
        <button
          type="button"
          aria-label="关闭新建窗口"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <label className="field">
        标题
        <input
          autoFocus={kind === "document"}
          aria-label="新对象标题"
          maxLength={180}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>
      {kind === "document" && (
        <label className="field">
          正文 · Markdown
          <textarea
            aria-label="新文档正文"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={8}
            placeholder="开始写作…"
          />
        </label>
      )}
      {kind === "task" && (
        <TaskFields
          value={task}
          editable={!busy}
          state={client.boot!.workspace}
          projectId={projectId}
          onChange={setTask}
        />
      )}
      {kind === "website" && (
        <label className="field">
          网站地址
          <input
            aria-label="新网站地址"
            type="url"
            required
            placeholder="https://"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
        </label>
      )}
      <div role="alert" className="form-error">
        {error}
      </div>
      <footer>
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button className="primary" disabled={busy || !title.trim()}>
          {busy ? "保存中…" : "创建"}
        </button>
      </footer>
    </form>
  );
  if (kind === "document")
    return (
      <section className="document-draft" aria-label="新建文档编辑区">
        {form}
      </section>
    );
  return (
    <dialog
      ref={dialog}
      className={"create-dialog" + (kind === "task" ? " task-dialog" : "")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="create-title"
    >
      {form}
    </dialog>
  );
}
