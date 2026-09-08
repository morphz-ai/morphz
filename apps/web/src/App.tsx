import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
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
  SquareBottomDashedScissors,
  Pin,
  Brain,
  Maximize2,
  Minimize2,
  History,
  MoreHorizontal,
  ListChecks,
} from "lucide-react";
import {
  inboxFor,
  spaceKind,
  discussionId,
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
import { ArtifactEditor } from "./ArtifactEditor.js";
import {
  inputIntents,
  type InputIntent,
} from "../../../packages/core/src/input-intent.js";
import { Conversation, type ExchangePosition } from "./Conversation.js";
import { ExecutionDialog } from "./ExecutionDialog.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import { ProjectConversations } from "./ProjectConversations.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { BrandMark } from "./BrandMark.js";
import { ObjectCollection } from "./ObjectCollection.js";
import { ProjectDirectory } from "./WorkspaceViews.js";
import { ApplicationHost } from "./ApplicationHost.js";
import { objectsApplication } from "../../../packages/core/src/applications.js";
import { ImportDocuments, SearchDocuments } from "./LibraryDialogs.js";
import { UnderstandingDialog } from "./UnderstandingDialog.js";
import { SpeechDialog } from "./SpeechDialog.js";
import type { SpeechScope } from "./client.js";
import { CaptureDialog } from "./CaptureDialog.js";
import { Notifications } from "./Notifications.js";
import { afterSend, revealInput, type InteractionMode } from "./interaction.js";
import { useModal } from "./useModal.js";
import { useExchangeFocus } from "./useExchangeFocus.js";

type View = "dialogue" | "inbox" | "desk" | "projects";
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
  pinnedInputs?: Record<string, boolean>;
  selectedConversations?: Record<string, string>;
};
type InputDraft = {
  body: string;
  intent?: InputIntent;
  taskResult?: { taskId: string; revision: number };
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
  dialogue: "对话",
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
      view: ["dialogue", "inbox", "desk", "projects"].includes(p.view ?? "")
        ? p.view!
        : defaultPrefs.view,
    };
  });
  const [notice, setNotice] = useState(""),
    [inputErrors, setInputErrors] = useState<Record<string, string>>({}),
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
    [executions, setExecutions] = useState<ExecutionScope | null>(null),
    [understandingOpen, setUnderstandingOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [themeOpen, setThemeOpen] = useState(false),
    [spaceMenu, setSpaceMenu] = useState(false),
    [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null),
    [detailToolbarTarget, setDetailToolbarTarget] =
      useState<HTMLDivElement | null>(null),
    [pageToolbarTarget, setPageToolbarTarget] = useState<HTMLDivElement | null>(
      null,
    ),
    [creating, setCreating] = useState<
      "document" | "project" | "save-project" | null
    >(null),
    [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, InputDraft>>(() =>
    readLocal(draftKey("inputs"), {}),
  );
  const savingWorkspace = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null),
    exchange = useRef<HTMLDivElement>(null),
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
  const personalSpace = (kind: "desk" | "inbox" | "dialogue") =>
    state?.projects.find(
      (p) => p.kind === kind && p.ownerPrincipalId === client.boot!.principalId,
    );
  const project =
    creating === "save-project" && savingWorkspace.current
      ? state?.projects.find((p) => p.id === savingWorkspace.current)
      : prefs.view === "dialogue"
        ? personalSpace("dialogue")
        : prefs.view === "desk" ||
            (prefs.view === "projects" && !prefs.projectOpen)
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
  const selectedConversation =
    state?.conversations.find(
      (c) =>
        c.projectId === project?.id &&
        c.id === prefs.selectedConversations?.[project?.id ?? ""],
    ) ?? state?.conversations.find((c) => c.id === project?.id);
  const conversationId = selectedConversation?.id ?? project?.id ?? "";
  function conversationKey(workspaceId: string) {
    return workspaceId === project?.id
      ? conversationId
      : (prefs.selectedConversations?.[workspaceId] ?? workspaceId);
  }
  const contextKey =
    conversationId + ":" + (artifact?.id ?? activeInstance?.id ?? prefs.view);
  const dialogueCanvas = prefs.view === "dialogue" && !artifact;
  const interaction = prefs.interactions?.[conversationId] ?? "input";
  const inputVisible = interaction !== "hidden";
  const conversationVisible =
    dialogueCanvas ||
    !!selectedConversation?.archivedAt ||
    interaction === "recent" ||
    interaction === "history";
  const historyVisible = dialogueCanvas || interaction === "history";
  const inputPinned = !!prefs.pinnedInputs?.[conversationId];
  const keepExchangeOpen = useExchangeFocus({
    root: exchange,
    scope: conversationId,
    visible: inputVisible,
    pinned: inputPinned,
    suspended:
      !!speech || !!capture || searchOpen || !!creating || !!executions,
    onLeave: () => setInteraction("hidden"),
  });
  const latestInteraction = useRef(interaction);
  latestInteraction.current = interaction;
  const positions = useRef(new Map<string, number>());
  const exchangePositions = useRef(new Map<string, ExchangePosition>());
  const [revealedInputs, setRevealedInputs] = useState<Record<string, string>>(
    {},
  );
  const [seenReplies, setSeenReplies] = useState<Record<string, string>>({});
  const replies = client.boot!.runtime.messages.filter(
    (m) => m.projectId === project?.id && discussionId(m) === conversationId,
  );
  const replyVersion = replies.map((m) => m.id + ":" + m.text.length).join("|");
  const unseenReply =
    !!replyVersion && replyVersion !== seenReplies[conversationId];
  useEffect(() => {
    if (conversationVisible && project)
      setSeenReplies((old) => ({ ...old, [conversationId]: replyVersion }));
  }, [conversationVisible, conversationId, replyVersion]);
  useEffect(() => {
    setSpaceMenu(false);
  }, [project?.id, prefs.view, activeId]);
  useLayoutEffect(() => {
    const element =
      main.current?.querySelector<HTMLElement>(
        ".application-pane:not([hidden]) .library-results, .application-pane:not([hidden]):not(:has(.library-results))",
      ) ?? main.current;
    element?.scrollTo({ top: positions.current.get(contextKey) ?? 0 });
    return () => {
      if (element) positions.current.set(contextKey, element.scrollTop);
    };
  }, [contextKey, activeId]);
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
      "applications" in change ||
      "selectedConversations" in change
    )
      navigationGeneration.current++;
    setPrefs((previous) => {
      const next = {
        ...previous,
        ...("artifactId" in change ? { artifactRevision: null } : {}),
        ...change,
        ...(change.selectedConversations
          ? {
              selectedConversations: {
                ...previous.selectedConversations,
                ...change.selectedConversations,
              },
            }
          : {}),
        ...(change.interactions
          ? {
              interactions: {
                ...previous.interactions,
                ...change.interactions,
              },
            }
          : {}),
        ...(change.pinnedInputs
          ? {
              pinnedInputs: {
                ...previous.pinnedInputs,
                ...change.pinnedInputs,
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
    if (id) prefer({ interactions: { [conversationKey(id)]: mode } });
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
              : owner?.kind === "dialogue"
                ? "dialogue"
                : "desk",
        projectOpen: !!owner && spaceKind(owner) === "project",
        projectId: workspaceId,
        artifactId: id,
        artifactRevision: revision ?? null,
        artifactPage: page ?? null,
        ...(prefs.interactions?.[conversationKey(workspaceId)] === "history"
          ? {
              interactions: {
                [conversationKey(workspaceId)]: "recent" as const,
              },
            }
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
        ? { interactions: { [conversationId]: "recent" as const } }
        : {}),
    });
  }
  function navigate(view: View) {
    setCreating(null);
    prefer({ view, artifactId: null, projectOpen: false });
  }
  function selectConversation(id: string) {
    if (!project) return;
    prefer({
      selectedConversations: {
        ...prefs.selectedConversations,
        [project.id]: id,
      },
      interactions: {
        [id]: prefs.interactions?.[id] === "history" ? "history" : "recent",
      },
    });
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
    keepExchangeOpen();
    setMobileCollaboration(false);
    previousFocus.current = document.activeElement as HTMLElement;
    setInteraction(revealInput(interaction));
    requestAnimationFrame(() => input.current?.focus());
  }
  function composeIntent(intent: InputIntent) {
    // Preserve the exact workspace, object reference, selection and unfinished text.
    // Clicking a shortcut neither submits a request nor creates an empty object.
    setDraft(contextKey, { ...draft, intent });
    showInput();
  }
  function hideInput() {
    setInteraction("hidden");
    if (document.activeElement?.closest("#global-composer")) {
      requestAnimationFrame(() => {
        if (previousFocus.current?.isConnected) previousFocus.current.focus();
        else toggle.current?.focus();
      });
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
          theme.current?.querySelector<HTMLButtonElement>("button")?.focus();
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
    if (
      !project ||
      selectedConversation?.archivedAt ||
      !draft.body.trim() ||
      sending
    )
      return;
    const key = contextKey,
      captured = { ...draft };
    setSending(true);
    setInputErrors((old) => ({ ...old, [key]: "" }));
    try {
      if (captured.taskResult && !asAnnotation) {
        if (captured.taskResult.taskId !== artifact?.id)
          throw new Error("请回到这件事项后提交结果，草稿已保留。");
        await client.execute({
          type: "respond-task",
          taskId: captured.taskResult.taskId,
          expectedRevision: captured.taskResult.revision,
          body: captured.body,
        });
      } else if (
        asAnnotation &&
        artifact &&
        captured.selection &&
        captured.revision
      )
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
            conversationId,
            ...(activeInstance
              ? { applicationInstanceId: activeInstance.id }
              : {}),
            artifactId: artifact?.id ?? null,
            artifactRevision: artifact
              ? (captured.revision ?? artifact.revision)
              : null,
            selection: captured.selection,
            body: captured.body,
            ...(captured.intent ? { intent: captured.intent } : {}),
            targetActantId: "morphz-agent",
          },
          !!client.boot?.runtime.configured,
        );
        setRevealedInputs((old) => ({
          ...old,
          [conversationId]: receipt.entityId,
        }));
      }
      setDraft(key, { ...emptyDraft });
      if (currentContext.current === key) {
        if (asAnnotation) {
          if (compact) setMobileCollaboration(true);
          else prefer({ collaboration: true });
        } else if (!captured.taskResult) {
          setMobileCollaboration(false);
          setInteraction(afterSend(latestInteraction.current));
          if (latestInteraction.current !== "hidden")
            requestAnimationFrame(() => input.current?.focus());
        }
      }
    } catch (e) {
      setInputErrors((old) => ({
        ...old,
        [key]: e instanceof Error ? e.message : "保存失败，草稿已保留。",
      }));
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
  const inputs = state.inputs.filter(
    (i) => i.projectId === project.id && discussionId(i) === conversationId,
  );
  const annotations = artifact
    ? state.annotations.filter((a) => a.artifactId === artifact.id)
    : [];
  const contextTitle = artifact?.title ?? project.title;
  const openExecutions = () => {
    keepExchangeOpen();
    setExecutions({
      projectId: project.id,
      conversationId,
      artifactId: artifact?.id ?? null,
    });
  };
  const executionButton = (
    <button
      className="icon-button composer-executions"
      aria-label="执行记录与审批"
      title={
        client.boot!.runtime.configured
          ? "执行记录与审批"
          : "连接 Agent 后可查看执行记录与审批"
      }
      disabled={!client.boot!.runtime.configured}
      onClick={openExecutions}
    >
      <ListChecks />
    </button>
  );
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
        <div className="sidebar-header">
          <div className="wordmark">
            <BrandMark />
            <span>Morphz</span>
          </div>
          <div className="sidebar-tools">
            <div className="theme-wrap" ref={theme}>
              <button
                className="icon-button"
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
                            theme.current
                              ?.querySelector<HTMLButtonElement>("button")
                              ?.focus();
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
            <Notifications client={client} onOpen={open} />
          </div>
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
          {(["dialogue", "inbox", "desk", "projects"] as View[]).map((view) => {
            const Icon = {
              dialogue: MessageCircle,
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
          <span className="avatar">我</span>
          <div>
            {actorName(state, client.boot!.actantId)}
            <small>
              <span className="presence-dot" data-online={client.online} />
              {client.online ? "工作中心已连接" : "工作中心已断开"}
              {!client.online && (
                <button
                  className="icon-button"
                  aria-label="重新连接工作中心"
                  title="重新连接"
                  onClick={() => void client.refresh()}
                >
                  <RefreshCw />
                </button>
              )}
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
        <header
          className="topbar"
          aria-label={`${applicationWorkspaceOpen ? project.title : labels[prefs.view]}工具栏`}
        >
          <button
            className="icon-button sidebar-toggle"
            aria-label={prefs.sidebar ? "隐藏侧边栏" : "显示侧边栏"}
            title={prefs.sidebar ? "隐藏侧边栏" : "显示侧边栏"}
            aria-expanded={prefs.sidebar}
            aria-controls="workspace-sidebar"
            onClick={() => {
              setThemeOpen(false);
              prefer({ sidebar: !prefs.sidebar });
            }}
          >
            <PanelLeft />
          </button>
          <div
            className="application-toolbar-slot"
            ref={setToolbarTarget}
            hidden={!applicationWorkspaceOpen}
          />
          {!applicationWorkspaceOpen && artifact?.content.kind === "task" ? (
            <div className="breadcrumb task-breadcrumb">
              <button onClick={() => navigate(prefs.view)}>
                {labels[prefs.view]}
              </button>
              <ChevronRight />
              <h1 className="toolbar-title">{artifact.title}</h1>
            </div>
          ) : (
            !applicationWorkspaceOpen && (
              <div className="breadcrumb">
                <h1 className="toolbar-title">
                  {artifact ? (
                    <button onClick={() => navigate(prefs.view)}>
                      {labels[prefs.view]}
                    </button>
                  ) : (
                    labels[prefs.view]
                  )}
                </h1>
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
            )
          )}
          <div
            className="page-toolbar-slot"
            ref={setPageToolbarTarget}
            hidden={applicationWorkspaceOpen || !!artifact}
          >
            {prefs.view === "inbox" && !artifact && (
              <>
                <div
                  className="matter-filters"
                  role="group"
                  aria-label="事项状态"
                >
                  {(
                    ["mine", "active", "waiting", "completed", "all"] as const
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
                </div>
                <select
                  className="matter-filter-select"
                  aria-label="事项状态筛选"
                  value={taskFilter}
                  onChange={(e) =>
                    setTaskFilter(e.target.value as typeof taskFilter)
                  }
                >
                  <option value="mine">待我处理</option>
                  <option value="active">进行中</option>
                  <option value="waiting">等待</option>
                  <option value="completed">已完成</option>
                  <option value="all">全部</option>
                </select>
                <small className="toolbar-count">
                  {visibleTasks.length} 项
                </small>
                <button
                  aria-label="新建事项"
                  title="新建事项"
                  onClick={() => composeIntent("task")}
                >
                  <Plus />
                  <span className="toolbar-action-label">新建事项</span>
                </button>
              </>
            )}
          </div>
          <div
            className="detail-toolbar-slot"
            ref={setDetailToolbarTarget}
            hidden={!artifact && creating !== "document"}
          />
          <div className="top-actions">
            {prefs.view === "projects" &&
              prefs.projectOpen &&
              selectedConversation && (
                <ProjectConversations
                  key={project.id}
                  client={client}
                  projectId={project.id}
                  selected={selectedConversation}
                  onSelect={selectConversation}
                />
              )}
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
          <div
            className="primary-panel"
            data-interaction={historyVisible ? "history" : interaction}
          >
            <main
              ref={main}
              className={
                applicationWorkspaceOpen && creating !== "document"
                  ? "application-canvas"
                  : undefined
              }
              aria-label="主工作区"
              hidden={historyVisible}
            >
              {creating === "document" && (
                <CreateDialog
                  key={project.id}
                  kind="document"
                  toolbarTarget={detailToolbarTarget}
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
                  toolbarTarget={toolbarTarget}
                  client={client}
                  foreground={!historyVisible && creating !== "document"}
                  workspaceId={project.id}
                  activeId={activeId}
                  enabled={
                    prefs.view !== "inbox" &&
                    prefs.view !== "dialogue" &&
                    (prefs.view !== "projects" || prefs.projectOpen)
                  }
                  onActivate={activateApplication}
                  onOpen={open}
                  onNotice={setNotice}
                  onSaveProject={() => {
                    // The server creates the next blank desk before the command
                    // receipt arrives. Keep this application mounted until the
                    // completed save navigates to the same workspace as a project.
                    savingWorkspace.current = project.id;
                    setCreating("save-project");
                  }}
                  onCompose={(text, artifactId) => {
                    if (artifactId) {
                      const target = state.artifacts.find(
                        (a) =>
                          a.id === artifactId && a.projectId === project.id,
                      );
                      if (!target) return;
                      prefer({ artifactId: target.id });
                      const key = conversationId + ":" + target.id;
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
                      titleInToolbar={
                        !applicationWorkspaceOpen &&
                        artifact.content.kind === "task"
                      }
                      toolbarTarget={
                        creating === "document" ? null : detailToolbarTarget
                      }
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
                      onTaskInput={(result) => {
                        setDraft(contextKey, {
                          ...draft,
                          intent: undefined,
                          selection: "",
                          revision: artifact.revision,
                          taskResult: result
                            ? {
                                taskId: artifact.id,
                                revision: artifact.revision,
                              }
                            : undefined,
                        });
                        showInput();
                      }}
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
                    <section
                      className="collection matter-collection"
                      aria-label="事项列表"
                    >
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
                            告诉 Morphz 要做什么，它会整理事项并显示在这里。
                          </p>
                        </div>
                      )}
                    </section>
                  ) : prefs.view === "projects" && !prefs.projectOpen ? (
                    <ProjectDirectory
                      toolbarTarget={pageToolbarTarget}
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
                      onCreate={composeIntent}
                      onWrite={() => setCreating("document")}
                      onImport={() => file.current?.click()}
                      importing={importing}
                    />
                  )}
                </ApplicationHost>
              </div>
            </main>
            <div className="exchange-surface" ref={exchange}>
              {conversationVisible && (
                <Conversation
                  key={conversationId}
                  inputs={inputs}
                  positions={exchangePositions.current}
                  revealInputId={revealedInputs[conversationId] ?? null}
                  state={state}
                  runtime={client.boot!.runtime}
                  projectId={project.id}
                  conversationId={conversationId}
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
                {selectedConversation?.archivedAt ? (
                  <div className="archived-conversation-note">
                    <span>对话已归档，历史和后台工作仍保留。</span>
                    {executionButton}
                    <button
                      onClick={() =>
                        void client
                          .execute({
                            type: "update-conversation",
                            conversationId,
                            expectedRevision: selectedConversation.revision,
                            archived: false,
                          })
                          .catch((e) => setNotice(e.message))
                      }
                    >
                      恢复对话
                    </button>
                  </div>
                ) : inputVisible ? (
                  <section
                    className="composer"
                    id="global-composer"
                    aria-label="AI 输入"
                  >
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
                    <div className="composer-writing">
                      <textarea
                        ref={input}
                        aria-label="AI 输入内容"
                        placeholder={
                          draft.taskResult
                            ? "写下结果；提交后将以你的身份完成这件事项…"
                            : draft.intent
                              ? inputIntents[draft.intent].placeholder
                              : "提出想法，或让工作继续…"
                        }
                        rows={2}
                        maxLength={30000}
                        value={draft.body}
                        disabled={sending}
                        onFocus={() => {
                          if (!conversationVisible) setInteraction("recent");
                        }}
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
                    </div>
                    {inputErrors[contextKey] && (
                      <p className="composer-error" role="alert">
                        {inputErrors[contextKey]}
                      </p>
                    )}
                    {(draft.taskResult ||
                      !client.online ||
                      !client.boot!.runtime.connected) && (
                      <small className="model-status">
                        {draft.taskResult
                          ? `${actorName(state, client.boot!.actantId)} · 提交到工作中心`
                          : !client.online
                            ? "工作中心已断开 · 草稿保留在本机"
                            : client.boot!.runtime.configured
                              ? "连接中 · 消息将保留并排队"
                              : "Agent 未连接 · 仅保存，不会回复"}
                      </small>
                    )}
                    <div className="composer-actions">
                      <div className="composer-footer-info">
                        <div className="composer-meta">
                          {
                            <span
                              className="context-chip"
                              title={
                                contextTitle +
                                (draft.revision ? " · v" + draft.revision : "")
                              }
                            >
                              <Link2 />
                              {contextTitle}
                              {draft.revision ? " · v" + draft.revision : ""}
                            </span>
                          }
                          {(draft.taskResult || draft.intent) && (
                            <div
                              className={
                                "composer-intent" +
                                (draft.taskResult ? " task-result-intent" : "")
                              }
                            >
                              <span
                                title={
                                  draft.taskResult
                                    ? "提交结果并完成事项"
                                    : inputIntents[draft.intent!].label
                                }
                              >
                                {draft.taskResult
                                  ? `提交结果并完成 · v${draft.taskResult.revision}`
                                  : inputIntents[draft.intent!].label}
                              </span>
                              <button
                                className="icon-button"
                                aria-label={
                                  draft.taskResult
                                    ? "改为普通输入"
                                    : "移除输入意图"
                                }
                                title={
                                  draft.taskResult
                                    ? "改为普通输入，不完成事项"
                                    : "移除输入意图"
                                }
                                onClick={() => {
                                  const {
                                    taskResult: _,
                                    intent: __,
                                    ...rest
                                  } = draft;
                                  setDraft(contextKey, rest);
                                  input.current?.focus();
                                }}
                              >
                                <X />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="inline composer-input-tools">
                        <button
                          className="icon-button"
                          aria-label="截图输入"
                          title="截图输入"
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
                          <SquareBottomDashedScissors />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="语音输入"
                          title="语音输入"
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
                        {inputPinned && (
                          <button
                            className="icon-button composer-pin"
                            aria-label="取消固定输入框"
                            title="已固定 · 点击后恢复自动收起"
                            aria-pressed={true}
                            onClick={() => {
                              keepExchangeOpen();
                              prefer({
                                pinnedInputs: { [conversationId]: false },
                              });
                            }}
                          >
                            <Pin />
                          </button>
                        )}
                        <ComposerOptions
                          key={contextKey}
                          model={client.boot!.runtime.model || "未配置"}
                          unread={!conversationVisible && unseenReply}
                          options={[
                            {
                              label: "执行记录与审批",
                              icon: <ListChecks />,
                              onSelect: openExecutions,
                              disabled: !client.boot!.runtime.configured,
                              title: !client.boot!.runtime.configured
                                ? "连接 Agent 后可查看执行记录与审批"
                                : undefined,
                            },
                            ...(!dialogueCanvas
                              ? [
                                  {
                                    label: conversationVisible
                                      ? "收起交流记录"
                                      : "查看交流记录",
                                    icon: <History />,
                                    onSelect: () =>
                                      setInteraction(
                                        conversationVisible
                                          ? "input"
                                          : "recent",
                                      ),
                                  },
                                  ...(conversationVisible
                                    ? [
                                        {
                                          label: historyVisible
                                            ? "返回工作内容"
                                            : "展开完整记录",
                                          icon: historyVisible ? (
                                            <Minimize2 />
                                          ) : (
                                            <Maximize2 />
                                          ),
                                          onSelect: () =>
                                            setInteraction(
                                              historyVisible
                                                ? "recent"
                                                : "history",
                                            ),
                                        },
                                      ]
                                    : []),
                                ]
                              : []),
                            ...(!inputPinned
                              ? [
                                  {
                                    label: "固定输入框",
                                    icon: <Pin />,
                                    pressed: false,
                                    onSelect: () => {
                                      keepExchangeOpen();
                                      prefer({
                                        pinnedInputs: {
                                          [conversationId]: true,
                                        },
                                      });
                                    },
                                  },
                                ]
                              : []),
                            ...(draft.selection
                              ? [
                                  {
                                    label: "保存为批注",
                                    icon: <MessageSquarePlus />,
                                    disabled:
                                      !draft.body.trim() ||
                                      sending ||
                                      !client.online,
                                    onSelect: () => {
                                      void send(true);
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                        <button
                          className="icon-button"
                          aria-label="收起 AI 输入框"
                          title="收起 AI 输入框"
                          onClick={hideInput}
                        >
                          <ChevronDown />
                        </button>
                        <button
                          className="send"
                          aria-label={
                            draft.taskResult
                              ? "提交结果并完成事项"
                              : client.boot!.runtime.configured
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
                  <button
                    ref={toggle}
                    className="composer-reopen"
                    aria-controls="global-composer"
                    aria-expanded={false}
                    onClick={showInput}
                  >
                    <MessageCircle />向 Morphz 输入<kbd>{shortcut}</kbd>
                    {unseenReply && (
                      <span className="unread-label">有新回复</span>
                    )}
                  </button>
                )}
              </div>
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
        {notice && (
          <div className="workspace-notice">
            <span role="alert">{notice}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice("")}
            >
              <X />
            </button>
          </div>
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
      {executions && (
        <ExecutionDialog
          key={executions.conversationId + ":" + executions.artifactId}
          client={client}
          scope={executions}
          onClose={() => setExecutions(null)}
          onOpen={open}
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
            const key = conversationKey(target.projectId) + ":" + target.id;
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
  toolbarTarget,
}: {
  kind: "document" | "project" | "save-project";
  projectId: string;
  client: ReturnType<typeof useWorkspace>;
  onClose: () => void;
  onCreated: (id: string, kind: string) => void;
  toolbarTarget?: HTMLElement | null;
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
                content: { kind: "document", markdown },
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
  const heading = (
    <header className={kind === "document" ? "draft-toolbar" : undefined}>
      <h2 id="create-title">
        新建
        {
          {
            document: "文档",
            project: "项目",
            "save-project": "项目（保留当前工作）",
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
  );
  const form = (
    <form onSubmit={(e) => void submit(e)}>
      {kind === "document"
        ? toolbarTarget && createPortal(heading, toolbarTarget)
        : heading}
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
      className="create-dialog"
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
