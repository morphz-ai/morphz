import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  AudioLines,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Inbox,
  Layers2,
  Library,
  MessageCircle,
  MessageSquareText,
  Palette,
  PanelsTopLeft,
  Plus,
  X,
  Link2,
  MessageSquarePlus,
  RefreshCw,
  ChevronRight,
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
  ListChecks,
} from "lucide-react";
import {
  inboxFor,
  spaceKind,
  inConversation,
  discussionId,
  applicationFor,
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
import { ModelPicker } from "./ModelPicker.js";
import { ConnectionDetails } from "./ConnectionDetails.js";
import {
  inputIntents,
  type InputIntent,
} from "../../../packages/core/src/input-intent.js";
import { Conversation, type ExchangePosition } from "./Conversation.js";
import { ExecutionSidebar } from "./ExecutionSidebar.js";
import "./execution.css";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import { ProjectConversations } from "./ProjectConversations.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { ComposerToolButtons } from "./ComposerToolButtons.js";
import { BrandMark } from "./BrandMark.js";
import { ObjectCollection } from "./ObjectCollection.js";
import { ProjectDirectory } from "./WorkspaceViews.js";
import { ApplicationHost } from "./ApplicationHost.js";
import {
  objectsApplication,
  browserApplication,
} from "../../../packages/core/src/applications.js";
import { ImportDocuments, SearchDocuments } from "./LibraryDialogs.js";
import { UnderstandingPanel } from "./UnderstandingPanel.js";
import { SpeechDialog } from "./SpeechDialog.js";
import type { SpeechScope } from "./client.js";
import { CaptureDialog } from "./CaptureDialog.js";
import { MessageAttachments } from "./MessageAttachments.js";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import type { BrowserView } from "./desktop.js";
import { Notifications } from "./Notifications.js";
import { afterSend, revealInput, type InteractionMode } from "./interaction.js";
import { useModal } from "./useModal.js";
import { useExchangeFocus } from "./useExchangeFocus.js";
import { useDesktopAppearance } from "./useDesktopAppearance.js";
import { InspectorPanel, useInspectorLayout } from "./InspectorPanel.js";
import { SidebarToggle } from "./SidebarToggle.js";

type View = "dialogue" | "inbox" | "content" | "desk" | "projects";
type Preferences = {
  executionPinned?: boolean;
  executionWidth?: number;
  inspectorWidth?: number;
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
  attachments?: InputAttachment[];
  annotation?: boolean;
  model?: string;
  reasoningEffort?: import("../../../packages/core/src/inference.js").ReasoningEffort;
  body: string;
  intent?: InputIntent;
  taskResult?: { taskId: string; revision: number };
  selection: string;
  revision: number | null;
  page?: number;
};
type ConversationDraft = {
  id: string;
  projectId: string;
  title: string;
  inputId: string;
};
type NavigationPlace = Pick<
  Preferences,
  | "view"
  | "projectId"
  | "projectOpen"
  | "artifactId"
  | "artifactRevision"
  | "artifactPage"
  | "applications"
>;
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
  content: "内容",
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
      view: ["dialogue", "inbox", "content", "desk", "projects"].includes(
        p.view ?? "",
      )
        ? p.view!
        : defaultPrefs.view,
    };
  });
  const [notice, setNotice] = useState(""),
    [connectionOpen, setConnectionOpen] = useState(false),
    [inputErrors, setInputErrors] = useState<Record<string, string>>({}),
    [uploadingDrafts, setUploadingDrafts] = useState<Record<string, boolean>>(
      {},
    ),
    [taskFilter, setTaskFilter] = useState<
      "mine" | "active" | "waiting" | "completed" | "all"
    >("mine"),
    [speech, setSpeech] = useState<{
      scope: SpeechScope;
      title: string;
      key: string;
      draft: InputDraft;
      modal?: boolean;
    } | null>(null),
    [capture, setCapture] = useState<{
      key: string;
      projectId: string;
      artifactId?: string;
      artifactRevision?: number;
    } | null>(null),
    [importOpen, setImportOpen] = useState(false),
    [importMode, setImportMode] = useState<"copy" | "linked">("copy"),
    [executions, setExecutions] = useState<ExecutionScope | null>(() =>
      prefs.executionPinned
        ? {
            projectId: state!.projects.find(
              (p) =>
                p.kind === "dialogue" &&
                p.ownerPrincipalId === client.boot!.principalId,
            )!.id,
            artifactId: null,
          }
        : null,
    ),
    [understandingOpen, setUnderstandingOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [themeOpen, setThemeOpen] = useState(false),
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
  const [conversationDrafts, setConversationDrafts] = useState<
    Record<string, ConversationDraft>
  >(() => readLocal(draftKey("conversations"), {}));
  const conversationDraftsRef = useRef(conversationDrafts);
  conversationDraftsRef.current = conversationDrafts;
  const sendPending = useRef(false);
  const startedConversations = new Set([
    ...(state?.inputs.map(discussionId) ?? []),
    ...(client.boot?.runtime.messages.map(discussionId) ?? []),
  ]);
  const hasConversationDraft = (id: string) =>
    Object.entries(drafts).some(
      ([key, value]) =>
        key.startsWith(id + ":") &&
        !!(
          value.body.trim() ||
          value.attachments?.length ||
          value.selection ||
          value.intent
        ),
    );
  const [openingObject, setOpeningObject] = useState(false);
  const [restoredPlace, setRestoredPlace] = useState<NavigationPlace | null>(
    null,
  );
  const trail = useRef<{ places: NavigationPlace[]; index: number }>({
    places: [],
    index: -1,
  });
  const [trailVersion, setTrailVersion] = useState(0);
  const restoring = useRef(false);
  const [websiteIntent, setWebsiteIntent] = useState<string | null>(null);
  const [browserPage, setBrowserPage] = useState<BrowserView | null>(null);
  const [attachmentSlot, setAttachmentSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const [dictationSlot, setDictationSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const savingWorkspace = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null),
    exchange = useRef<HTMLDivElement>(null),
    main = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    file = useRef<HTMLInputElement>(null),
    theme = useRef<HTMLDivElement>(null),
    spaceOptions = useRef<HTMLDivElement>(null),
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
  const navigationProject =
    creating === "save-project" && savingWorkspace.current
      ? state?.projects.find((p) => p.id === savingWorkspace.current)
      : prefs.view === "dialogue"
        ? personalSpace("dialogue")
        : prefs.view === "desk" ||
            prefs.view === "content" ||
            (prefs.view === "projects" && !prefs.projectOpen)
          ? personalSpace("desk")
          : prefs.view === "inbox"
            ? personalSpace("inbox")
            : (state?.projects.find(
                (p) => p.id === prefs.projectId && spaceKind(p) === "project",
              ) ??
              state?.projects.find((p) => spaceKind(p) === "project") ??
              personalSpace("desk"));
  // Association scopes the next input, not the shared conversation or its
  // in-flight activations. An open object wins; otherwise use the visible space.
  const project =
    state?.projects.find(
      (p) =>
        p.id ===
        state.artifacts.find((a) => a.id === prefs.artifactId)?.projectId,
    ) ?? navigationProject;
  const sharedDefault = !client.boot!.capabilities.teamAuthentication;
  const defaultConversation = sharedDefault
    ? personalSpace("dialogue")?.id
    : navigationProject?.id;
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
  const immersiveApplication = !!(
    state &&
    activeInstance &&
    applicationFor(
      state,
      activeInstance.applicationId,
      activeInstance.applicationVersion,
    ).ui.presentation === "immersive"
  );
  const artifact = state?.artifacts.find(
    (a) =>
      a.projectId === project?.id &&
      a.id ===
        (restoredPlace
          ? restoredPlace.artifactId
          : (prefs.artifactId ??
            (prefs.view !== "inbox" &&
            activeInstance?.applicationId === objectsApplication.id
              ? activeInstance.state.artifactId
              : null))),
  );
  const selectedConversation =
    state?.conversations.find(
      (c) =>
        prefs.view === "projects" &&
        prefs.projectOpen &&
        c.projectId === navigationProject?.id &&
        c.id === prefs.selectedConversations?.[navigationProject?.id ?? ""] &&
        (!sharedDefault || c.id !== navigationProject?.id),
    ) ?? state?.conversations.find((c) => c.id === defaultConversation);
  const pendingConversation =
    prefs.view === "projects" && prefs.projectOpen
      ? conversationDrafts[navigationProject?.id ?? ""]
      : undefined;
  const selectedDraft =
    pendingConversation?.id ===
    prefs.selectedConversations?.[navigationProject?.id ?? ""]
      ? pendingConversation
      : undefined;
  const conversationId =
    selectedDraft?.id ?? selectedConversation?.id ?? project?.id ?? "";
  const conversationProjectId =
    selectedDraft?.projectId ??
    selectedConversation?.projectId ??
    project?.id ??
    "";
  function conversationKey(workspaceId: string) {
    return workspaceId === project?.id
      ? conversationId
      : (prefs.selectedConversations?.[workspaceId] ??
          defaultConversation ??
          workspaceId);
  }
  const contextKey =
    conversationId +
    ":" +
    (artifact?.id ??
      activeInstance?.id ??
      (navigationProject?.id ?? "") + ":" + prefs.view);
  const exchangeKey =
    conversationId === defaultConversation
      ? prefs.view === "content"
        ? `${navigationProject?.id ?? conversationId}:content`
        : (navigationProject?.id ?? conversationId)
      : conversationId;
  const dialogueCanvas = prefs.view === "dialogue" && !artifact;
  const interaction = prefs.interactions?.[exchangeKey] ?? "input";
  const inputVisible = dialogueCanvas || interaction !== "hidden";
  const conversationVisible =
    dialogueCanvas ||
    !!selectedConversation?.archivedAt ||
    interaction === "recent" ||
    interaction === "history";
  const historyVisible = dialogueCanvas || interaction === "history";
  const inputPinned = !!prefs.pinnedInputs?.[exchangeKey];
  const keepExchangeOpen = useExchangeFocus({
    root: exchange,
    scope: exchangeKey,
    visible: inputVisible,
    pinned: inputPinned,
    suspended:
      dialogueCanvas ||
      !!speech ||
      !!capture ||
      searchOpen ||
      !!creating ||
      !!executions ||
      !!uploadingDrafts[contextKey],
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
  const inputs =
    state?.inputs.filter((i) =>
      inConversation(state!, conversationId, i, sharedDefault),
    ) ?? [];
  const replies = client.boot!.runtime.messages.filter((m) =>
    inConversation(state!, conversationId, m, sharedDefault),
  );
  const replyVersion = [
    ...replies.map((m) => m.id + ":" + m.text.length),
    ...(client.boot?.outputs ?? [])
      .filter((o) => inputs.some((i) => i.id === o.inputId))
      .map((o) => o.commandId),
  ].join("|");
  const unseenReply =
    !!replyVersion && replyVersion !== seenReplies[conversationId];
  useEffect(() => {
    if (conversationVisible && project)
      setSeenReplies((old) => ({ ...old, [conversationId]: replyVersion }));
  }, [conversationVisible, conversationId, replyVersion]);
  useLayoutEffect(() => {
    const element =
      main.current?.querySelector<HTMLElement>(
        ".object-surface > .library-collection .library-results, .application-pane:not([hidden]) .library-results, .application-pane:not([hidden]):not(:has(.library-results))",
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
  const place: NavigationPlace = {
    view: prefs.view,
    projectId: navigationProject?.id ?? prefs.projectId,
    projectOpen: prefs.projectOpen,
    artifactId: artifact?.id ?? null,
    artifactRevision: prefs.artifactRevision,
    artifactPage: prefs.artifactPage,
    applications: prefs.applications,
  };
  const placeKey = JSON.stringify(place);
  useLayoutEffect(() => {
    if (openingObject) return;
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    const current = trail.current;
    if (JSON.stringify(current.places[current.index]) === placeKey) return;
    current.places = [
      ...current.places.slice(0, current.index + 1),
      place,
    ].slice(-100);
    current.index = current.places.length - 1;
    setTrailVersion((v) => v + 1);
  }, [placeKey, openingObject]);
  function travel(direction: number) {
    const current = trail.current,
      index = current.index + direction,
      next = current.places[index];
    if (!next) return;
    if (
      !state?.projects.some((p) => p.id === next.projectId) ||
      (next.artifactId &&
        !state.artifacts.some((a) => a.id === next.artifactId))
    ) {
      setNotice("原位置已不可用或无访问权限。");
      return;
    }
    navigationGeneration.current++;
    setOpeningObject(false);
    setCreating(null);
    setWebsiteIntent(null);
    if (!prefs.executionPinned) setExecutions(null);
    current.index = index;
    restoring.current = true;
    setRestoredPlace(next);
    setPrefs((previous) => ({ ...previous, ...next }));
    setTrailVersion((v) => v + 1);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest(
          "input, textarea, [contenteditable=true], dialog[open]",
        )
      )
        return;
      const direction =
        (e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "[")
          ? -1
          : (e.altKey && e.key === "ArrowRight") || (e.metaKey && e.key === "]")
            ? 1
            : 0;
      if (direction) {
        e.preventDefault();
        travel(direction);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [trailVersion, placeKey]);
  const navigationGeneration = useRef(0);
  const requestedConversationFocus = useRef<{
    id: string;
    generation: number;
  } | null>(null);
  useLayoutEffect(() => {
    const request = requestedConversationFocus.current;
    if (!request) return;
    if (request.generation !== navigationGeneration.current) {
      requestedConversationFocus.current = null;
      return;
    }
    if (request.id === conversationId && inputVisible && input.current) {
      requestedConversationFocus.current = null;
      keepExchangeOpen();
      input.current.focus();
    }
    // Reusing the current draft keeps its IDs unchanged. Honor a fresh request
    // on that render as well, rather than waiting for navigation to change.
  });
  const sentInputFocus = useRef<{
    key: string;
    generation: number;
  } | null>(null);
  useLayoutEffect(() => {
    const request = sentInputFocus.current;
    if (!request || sending) return;
    sentInputFocus.current = null;
    if (
      request.key === contextKey &&
      request.generation === navigationGeneration.current &&
      inputVisible &&
      input.current
    ) {
      keepExchangeOpen();
      input.current.focus();
    }
  }, [sending, contextKey, inputVisible]);
  const collaborationVisible =
    !executions &&
    !understandingOpen &&
    !!artifact &&
    (compact ? mobileCollaboration : prefs.collaboration);
  const { ref: inspectorWorkspace, layout: rightInspector } =
    useInspectorLayout(prefs.inspectorWidth ?? prefs.executionWidth ?? 340);
  const inspectorOpen =
    !!executions || understandingOpen || collaborationVisible;
  const resizeInspector = (inspectorWidth: number) =>
    prefer({ inspectorWidth });
  const lastInspector = useRef<{
    kind: "execution" | "understanding" | "collaboration";
    context: string;
    scope?: ExecutionScope;
  } | null>(null);
  function closeInspector() {
    lastInspector.current = {
      kind: executions
        ? "execution"
        : understandingOpen
          ? "understanding"
          : "collaboration",
      context: contextKey,
      scope: executions ?? undefined,
    };
    setExecutions(null);
    setUnderstandingOpen(false);
    setMobileCollaboration(false);
    prefer({ collaboration: false, executionPinned: false });
    requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>(".inspector-toggle");
      if (trigger?.getClientRects().length) trigger.focus();
      else (input.current ?? toggle.current)?.focus();
    });
  }
  const legacyContextKey =
    (navigationProject?.id ?? "") +
    ":" +
    (artifact?.id ?? activeInstance?.id ?? prefs.view);
  const draft =
    drafts[contextKey] ??
    (conversationId === defaultConversation
      ? drafts[legacyContextKey]
      : undefined) ??
    emptyDraft;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform),
    shortcut = mac ? "⌘J" : "Ctrl+J";
  function prefer(change: Partial<Preferences>) {
    if (
      "view" in change ||
      "projectId" in change ||
      "artifactId" in change ||
      "applications" in change ||
      "selectedConversations" in change
    ) {
      navigationGeneration.current++;
      setUnderstandingOpen(false);
      setRestoredPlace(null);
      setOpeningObject(false);
    }
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
  function setInteraction(mode: InteractionMode, id = navigationProject?.id) {
    if (id)
      prefer({
        interactions: {
          [id === navigationProject?.id ? exchangeKey : id]: mode,
        },
      });
  }
  function setDraft(key: string, value: InputDraft) {
    updateDraft(key, () => value);
  }
  function updateDraft(key: string, update: (value: InputDraft) => InputDraft) {
    setDrafts((previous) => {
      const next = { ...previous, [key]: update(previous[key] ?? emptyDraft) };
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
    setWebsiteIntent(null);
    if (a) void openObject(a.projectId, id, revision, page);
  }
  // Only first-party, explicit user navigation opens a network page. Application
  // bridge requests and restored views do not grant that browser intent.
  async function openUser(id: string, revision?: number, page?: number) {
    const generation = ++navigationGeneration.current;
    const a =
      state?.artifacts.find((x) => x.id === id) ??
      (await client.resolveArtifact(id));
    if (generation !== navigationGeneration.current) return;
    if (!a) {
      setNotice("对象暂时无法读取，请检查连接或访问权限后重试。");
      return;
    }
    setWebsiteIntent(a?.content.kind === "website" ? a.id : null);
    void openObject(a.projectId, id, revision, page);
  }
  async function openObject(
    workspaceId: string,
    id: string,
    revision?: number,
    page?: number,
  ) {
    const generation = ++navigationGeneration.current;
    setOpeningObject(true);
    try {
      // Catalog and task navigation are views, not application launches.
      // Keep the workspace's current application intact when reading from them.
      const result = applicationWorkspaceOpen
        ? await client.execute({
            type: "launch-application",
            workspaceId,
            applicationId: objectsApplication.id,
            applicationVersion: objectsApplication.version,
            artifactId: id,
          })
        : null;
      // A slow open must not undo a later navigation or object selection.
      if (generation !== navigationGeneration.current) return;
      setCreating(null);
      prefer({
        artifactId: id,
        artifactRevision: revision ?? null,
        artifactPage: page ?? null,
        ...(prefs.interactions?.[exchangeKey] === "history"
          ? {
              interactions: {
                [exchangeKey]: "recent" as const,
              },
            }
          : {}),
        ...(result
          ? {
              applications: {
                ...prefs.applications,
                [workspaceId]: result.entityId,
              },
            }
          : {}),
      });
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      if (generation === navigationGeneration.current) setOpeningObject(false);
    }
  }
  function activateApplication(id: string | null) {
    if (!project) return;
    setWebsiteIntent(null);
    setCreating(null);
    prefer({
      applications: { ...prefs.applications, [project.id]: id },
      artifactId: null,
      ...(historyVisible
        ? { interactions: { [exchangeKey]: "recent" as const } }
        : {}),
    });
  }
  function navigate(view: View) {
    setWebsiteIntent(null);
    setCreating(null);
    if (!prefs.executionPinned) setExecutions(null);
    prefer({ view, artifactId: null, projectOpen: false });
  }
  function selectConversation(workspaceId: string, id: string, focus = false) {
    setWebsiteIntent(null);
    const sameProject =
      prefs.view === "projects" &&
      prefs.projectOpen &&
      navigationProject?.id === workspaceId;
    const selectedExchange =
      id === (sharedDefault ? defaultConversation : workspaceId)
        ? workspaceId
        : id;
    setCreating(null);
    if (!prefs.executionPinned) setExecutions(null);
    prefer({
      view: "projects",
      projectId: workspaceId,
      projectOpen: true,
      ...(!sameProject ? { artifactId: null } : {}),
      selectedConversations: {
        [workspaceId]: id,
      },
      interactions: {
        [selectedExchange]:
          prefs.interactions?.[selectedExchange] === "history"
            ? "history"
            : "recent",
      },
    });
    if (focus) {
      keepExchangeOpen();
      requestedConversationFocus.current = {
        id,
        generation: navigationGeneration.current,
      };
    }
  }
  async function createProjectConversation(workspaceId: string, title: string) {
    // Starting to type is local navigation, not a server-side conversation.
    // Repeated clicks reuse the unfinished draft; the first input commits both.
    let pending = conversationDraftsRef.current[workspaceId];
    if (!pending) {
      pending = {
        id: crypto.randomUUID(),
        projectId: workspaceId,
        title,
        inputId: crypto.randomUUID(),
      };
      const next = { ...conversationDraftsRef.current, [workspaceId]: pending };
      writeLocal(draftKey("conversations"), next);
      conversationDraftsRef.current = next;
      setConversationDrafts(next);
    }
    selectConversation(workspaceId, pending.id, true);
  }
  function openProject(id: string) {
    // An explicit project click means its default conversation, not whichever
    // named Session happened to be used last. Reuse the same switching path so
    // drafts, the current application/object and in-flight work stay intact.
    selectConversation(
      id,
      sharedDefault ? (personalSpace("dialogue")?.id ?? id) : id,
    );
  }
  function showInput() {
    keepExchangeOpen();
    setMobileCollaboration(false);
    previousFocus.current = document.activeElement as HTMLElement;
    setInteraction(revealInput(interaction));
    requestAnimationFrame(() => input.current?.focus());
  }
  function composeIntent(intent: InputIntent) {
    if (intent === "website") {
      void openBrowser();
      return;
    }
    // Preserve the exact workspace, object reference, selection and unfinished text.
    // Clicking a shortcut neither submits a request nor creates an empty object.
    setDraft(contextKey, {
      ...draft,
      intent,
      annotation: false,
      taskResult: undefined,
    });
    showInput();
  }
  async function openBrowser() {
    if (!project) return;
    const generation = ++navigationGeneration.current;
    try {
      const result = await client.execute({
        type: "launch-application",
        workspaceId: project.id,
        applicationId: browserApplication.id,
        applicationVersion: browserApplication.version,
      });
      if (generation !== navigationGeneration.current) return;
      prefer({
        view: spaceKind(project) === "project" ? "projects" : "desk",
        projectId: project.id,
        projectOpen: true,
        artifactId: null,
        applications: { ...prefs.applications, [project.id]: result.entityId },
      });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "浏览器未能打开。");
    }
  }
  function hideInput() {
    if (dialogueCanvas) {
      input.current?.blur();
      return;
    }
    setInteraction("hidden");
    if (document.activeElement?.closest("#global-composer")) {
      requestAnimationFrame(() => {
        if (previousFocus.current?.isConnected) previousFocus.current.focus();
        else toggle.current?.focus();
      });
    }
  }
  function closeSpeech() {
    if (speech && !speech.modal && speech.key === currentContext.current) {
      // Restore a stable control before the inline close button unmounts.
      // Closing dictation is not leaving the surrounding composer.
      keepExchangeOpen();
      exchange.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]')
        ?.focus();
    }
    setSpeech(null);
  }
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      // Native dialogs own Escape/focus while modal. Global composer shortcuts
      // must not consume their cancel event or open a second modal behind them.
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape" && speech && !speech.modal) {
        e.preventDefault();
        closeSpeech();
        return;
      }
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
          if (inputVisible && !dialogueCanvas) hideInput();
          else showInput();
        }
      } else if (e.key === "Escape") {
        if (creating) return;
        if (themeOpen) {
          e.preventDefault();
          setThemeOpen(false);
          theme.current?.querySelector<HTMLButtonElement>("button")?.focus();
        } else if (
          inspectorOpen &&
          !input.current?.contains(document.activeElement)
        ) {
          e.preventDefault();
          closeInspector();
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
    dialogueCanvas,
    contextKey,
    creating,
    themeOpen,
    mobileCollaboration,
    executions,
    understandingOpen,
    collaborationVisible,
    speech,
  ]);
  useEffect(() => {
    function outside(e: PointerEvent) {
      if (!theme.current?.contains(e.target as Node)) setThemeOpen(false);
    }
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, []);
  useDesktopAppearance(prefs.appearance);
  async function send(asAnnotation = draft.annotation === true) {
    if (
      !project ||
      selectedConversation?.archivedAt ||
      (!draft.body.trim() && !draft.attachments?.length) ||
      sending ||
      sendPending.current ||
      uploadingDrafts[contextKey]
    )
      return;
    const key = contextKey,
      captured = { ...draft };
    const firstConversation = selectedDraft;
    sendPending.current = true;
    setSending(true);
    setInputErrors((old) => ({ ...old, [key]: "" }));
    try {
      if (
        asAnnotation &&
        (!artifact || !captured.selection || !captured.revision)
      )
        throw new Error(
          "选区已失效，请重新选择文字后保存批注；不会发送给 Agent。",
        );
      if ((asAnnotation || captured.taskResult) && captured.attachments?.length)
        throw new Error(
          "批注与事项结果暂不支持附件，请移除附件或改为发送消息；草稿已保留。",
        );
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
        if (
          firstConversation &&
          !client.boot?.capabilities.conversationOnFirstInput
        )
          throw new Error(
            "工作中心需要更新后才能开始新会话；草稿已保留，现有会话仍可使用。",
          );
        const receipt = await client.execute(
          {
            type: "record-input",
            ...(captured.model ? { model: captured.model } : {}),
            ...(captured.reasoningEffort
              ? { reasoningEffort: captured.reasoningEffort }
              : {}),
            projectId: project.id,
            conversationId,
            ...(firstConversation
              ? { newConversation: { title: firstConversation.title } }
              : {}),
            ...(activeInstance
              ? { applicationInstanceId: activeInstance.id }
              : {}),
            artifactId: artifact?.id ?? null,
            artifactRevision: artifact
              ? (captured.revision ?? artifact.revision)
              : null,
            selection: captured.selection,
            body: captured.body,
            ...(captured.attachments?.length
              ? { attachments: captured.attachments }
              : {}),
            ...(browserPage &&
            activeInstance?.applicationId === "morphz.browser"
              ? {
                  browser: {
                    pageId: browserPage.pageId,
                    epoch: browserPage.epoch,
                    url: browserPage.url,
                    title: browserPage.title,
                  },
                }
              : {}),
            ...(captured.intent ? { intent: captured.intent } : {}),
            targetActantId: "morphz-agent",
          },
          !!client.boot?.runtime.configured,
          undefined,
          firstConversation?.inputId,
        );
        if (
          firstConversation &&
          conversationDraftsRef.current[project.id]?.id === firstConversation.id
        ) {
          const next = { ...conversationDraftsRef.current };
          delete next[project.id];
          conversationDraftsRef.current = next;
          setConversationDrafts(next);
          writeLocal(draftKey("conversations"), next);
        }
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
          if (latestInteraction.current !== "hidden")
            sentInputFocus.current = {
              key,
              generation: navigationGeneration.current,
            };
        } else if (!captured.taskResult) {
          setMobileCollaboration(false);
          setInteraction(afterSend(latestInteraction.current));
          if (latestInteraction.current !== "hidden")
            // Focus only after React removes the sending-disabled state.
            sentInputFocus.current = {
              key,
              generation: navigationGeneration.current,
            };
        }
      }
    } catch (e) {
      setInputErrors((old) => ({
        ...old,
        [key]: e instanceof Error ? e.message : "保存失败，草稿已保留。",
      }));
    } finally {
      sendPending.current = false;
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
  const tasks = inboxFor(state, client.boot!.principalId);
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
  const annotations = artifact
    ? state.annotations.filter((a) => a.artifactId === artifact.id)
    : [];
  const contextTitle =
    artifact?.title ??
    (activeInstance?.applicationId === browserApplication.id
      ? browserPage?.title || "浏览器"
      : project.title);
  const openExecutions = () => {
    keepExchangeOpen();
    setUnderstandingOpen(false);
    setMobileCollaboration(false);
    prefer({ collaboration: false });
    setExecutions({
      projectId: conversationProjectId,
      conversationId,
      artifactId: null,
    });
  };
  const inspectExecution = (id: string) => {
    const source = state.inputs.find((i) => i.id === id);
    if (!source) return;
    keepExchangeOpen();
    setUnderstandingOpen(false);
    setMobileCollaboration(false);
    prefer({ collaboration: false });
    setExecutions({
      projectId: source.projectId,
      conversationId: source.conversationId ?? source.projectId,
      artifactId: source.artifactId,
      inputId: source.id,
    });
  };
  const showInspector = () => {
    const previous = lastInspector.current;
    if (previous?.context === contextKey) {
      keepExchangeOpen();
      if (previous.kind === "understanding") setUnderstandingOpen(true);
      else if (previous.kind === "collaboration" && artifact) {
        compact
          ? setMobileCollaboration(true)
          : prefer({ collaboration: true });
      } else if (previous.scope) setExecutions(previous.scope);
      else openExecutions();
    } else openExecutions();
  };
  const activeExecutionCount = new Set([
    ...client
      .boot!.runtime.deliveries.filter(
        (d) =>
          state.inputs.some((i) => i.id === d.inputId) &&
          ["queued", "sending", "running"].includes(d.state),
      )
      .map((d) => d.inputId),
    ...(client.boot!.runtime.activity?.threads ?? []).map(
      (t) => t.inputId ?? t.rootId,
    ),
  ]).size;
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
        (!prefs.sidebar ? " sidebar-hidden" : "") +
        (immersiveApplication ? " application-immersive" : "") +
        (applicationWorkspaceOpen &&
        activeInstance?.applicationId === browserApplication.id
          ? " application-browser-workspace"
          : "")
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
            <Notifications client={client} onOpen={openUser} />
          </div>
        </div>
        <div className="space-label">{state.name}</div>
        <button
          className="sidebar-search"
          onClick={() => setSearchOpen(true)}
          aria-label="搜索资料"
        >
          <Search />
          <span>搜索</span>
          <kbd>{mac ? "⌘K" : "Ctrl+K"}</kbd>
        </button>
        <nav aria-label="主导航">
          {(["dialogue", "inbox", "content", "desk", "projects"] as View[]).map(
            (view) => {
              const Icon = {
                dialogue: MessageCircle,
                inbox: Inbox,
                content: Library,
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
            },
          )}
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
              <ProjectConversations
                key={p.id}
                client={client}
                projectId={p.id}
                title={p.title}
                active={
                  prefs.view === "projects" &&
                  prefs.projectOpen &&
                  navigationProject?.id === p.id
                }
                selectedId={conversationId}
                startedIds={startedConversations}
                drafts={[
                  ...state.conversations.filter(
                    (c) =>
                      c.projectId === p.id &&
                      c.id !== p.id &&
                      !startedConversations.has(c.id) &&
                      hasConversationDraft(c.id),
                  ),
                  ...Object.values(conversationDrafts).filter(
                    (c) =>
                      c.projectId === p.id &&
                      !startedConversations.has(c.id) &&
                      hasConversationDraft(c.id),
                  ),
                ]}
                defaultConversationId={
                  sharedDefault ? defaultConversation! : p.id
                }
                onOpen={() => openProject(p.id)}
                onSelect={(id) => selectConversation(p.id, id)}
                onCreate={(title) => createProjectConversation(p.id, title)}
              />
            ))}
        </div>
        <div className="sidebar-bottom">
          <span className="avatar">我</span>
          <div>
            {actorName(state, client.boot!.actantId)}
            <small>
              <span className="presence-dot" data-online={client.online} />
              <button
                className="connection-summary"
                aria-label="连接详情"
                onClick={() => setConnectionOpen(true)}
              >
                {client.online ? "工作中心已连接" : "工作中心已断开"}
              </button>
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
      <div
        className="workspace"
        ref={inspectorWorkspace}
        data-inspector-mode={inspectorOpen ? rightInspector.mode : undefined}
        data-inspector-width={inspectorOpen ? rightInspector.width : undefined}
        style={
          { "--inspector-width": `${rightInspector.width}px` } as CSSProperties
        }
      >
        {applicationWorkspaceOpen &&
          activeInstance?.applicationId === browserApplication.id && (
            <SidebarToggle
              className="browser-sidebar-toggle"
              side="left"
              expanded={prefs.sidebar}
              controls="workspace-sidebar"
              onClick={() => {
                setThemeOpen(false);
                prefer({ sidebar: !prefs.sidebar });
              }}
            />
          )}
        <header
          className="topbar"
          aria-label={`${applicationWorkspaceOpen ? project.title : labels[prefs.view]}工具栏`}
        >
          <SidebarToggle
            className="sidebar-toggle"
            side="left"
            expanded={prefs.sidebar}
            controls="workspace-sidebar"
            onClick={() => {
              setThemeOpen(false);
              prefer({ sidebar: !prefs.sidebar });
            }}
          />
          <div
            className="navigation-history"
            role="group"
            aria-label="浏览位置"
          >
            <button
              className="icon-button"
              aria-label="返回上一位置"
              title="后退 · ⌘[ / Alt+←"
              disabled={trail.current.index <= 0}
              onClick={() => travel(-1)}
            >
              <ArrowLeft />
            </button>
            <button
              className="icon-button"
              aria-label="前往下一位置"
              title="前进 · ⌘] / Alt+→"
              disabled={trail.current.index >= trail.current.places.length - 1}
              onClick={() => travel(1)}
            >
              <ArrowRight />
            </button>
          </div>
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
                  className="secondary-action"
                  aria-label="新建事项"
                  title="新建事项"
                  onClick={() => composeIntent("task")}
                >
                  <Plus />
                  <span className="toolbar-action-label">新建</span>
                </button>
              </>
            )}
          </div>
          <div
            className="detail-toolbar-slot"
            ref={setDetailToolbarTarget}
            hidden={openingObject || (!artifact && creating !== "document")}
          />
          <div className="top-actions">
            <div ref={spaceOptions} className="workspace-options">
              <ComposerOptions
                key={`${project.id}:${prefs.view}:${activeId}`}
                label="工作空间选项"
                menuLabel="工作空间操作"
                below
                options={[
                  ...(prefs.view === "content" && !artifact
                    ? [
                        {
                          label: "制作表格或报告",
                          icon: <Layers2 />,
                          onSelect: () => composeIntent("interactive"),
                        },
                        {
                          label: "打开浏览器",
                          icon: <PanelsTopLeft />,
                          onSelect: () => composeIntent("website"),
                        },
                        {
                          label: "手动写文档",
                          icon: <Plus />,
                          onSelect: () => setCreating("document"),
                        },
                      ]
                    : []),
                  {
                    label: "执行记录",
                    icon: <ListChecks />,
                    onSelect: openExecutions,
                  },
                  {
                    label: "当前理解",
                    icon: <Brain />,
                    onSelect: () => {
                      setExecutions(null);
                      setMobileCollaboration(false);
                      prefer({ collaboration: false, executionPinned: false });
                      setUnderstandingOpen(true);
                    },
                  },
                  {
                    label: "资料导入与来源",
                    icon: <FileUp />,
                    onSelect: () => setImportOpen(true),
                  },
                ]}
              />
            </div>
            {artifact && (
              <button
                className="icon-button collaboration-panel-toggle"
                aria-label={collaborationVisible ? "收起批注栏" : "展开批注栏"}
                title={artifact ? "对象批注" : "打开对象后查看批注"}
                disabled={!artifact}
                aria-pressed={collaborationVisible}
                onClick={() => {
                  setUnderstandingOpen(false);
                  setExecutions(null);
                  prefer({ executionPinned: false });
                  compact
                    ? setMobileCollaboration(!mobileCollaboration)
                    : prefer({ collaboration: !prefs.collaboration });
                }}
              >
                <MessageSquareText />
              </button>
            )}
            {!inspectorOpen && (
              <SidebarToggle
                className="inspector-toggle execution-panel-toggle"
                side="right"
                expanded={false}
                controls="workspace-inspector"
                title={
                  activeExecutionCount > 0
                    ? `显示右侧栏 · ${activeExecutionCount} 项执行中`
                    : undefined
                }
                onClick={showInspector}
              />
            )}
          </div>
        </header>
        <div
          className="workspace-body"
          data-execution-open={!!executions || undefined}
          data-understanding-open={understandingOpen || undefined}
        >
          <div
            className="primary-panel"
            data-interaction={historyVisible ? "history" : interaction}
            data-input-pinned={inputPinned || undefined}
            data-dialogue-canvas={dialogueCanvas || undefined}
          >
            <main
              ref={main}
              className={
                (applicationWorkspaceOpen ||
                  (prefs.view === "content" && !artifact)) &&
                creating !== "document"
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
                  onInput={showInput}
                  onBrowserPage={setBrowserPage}
                  onConnectFolder={() => {
                    setImportMode("linked");
                    setImportOpen(true);
                  }}
                  toolbarTarget={toolbarTarget}
                  client={client}
                  foreground={!historyVisible && creating !== "document"}
                  workspaceId={project.id}
                  activeId={activeId}
                  enabled={applicationWorkspaceOpen}
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
                      autoOpenWebsite={websiteIntent === artifact.id}
                      titleInToolbar={
                        artifact.content.kind === "pdf" ||
                        (!applicationWorkspaceOpen &&
                          artifact.content.kind === "task")
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
                      onOpen={openUser}
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
                      onSelect={(quote, revision, page, annotation) => {
                        setDraft(contextKey, {
                          ...draft,
                          selection: quote,
                          revision,
                          page,
                          annotation,
                          taskResult: undefined,
                          intent: undefined,
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
                            onOpen={openUser}
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
                      key={
                        prefs.view === "content"
                          ? "content-catalog"
                          : project.id
                      }
                      project={project}
                      projects={state.projects}
                      objects={state.artifacts}
                      catalog={prefs.view === "content"}
                      toolbarTarget={
                        prefs.view === "content" ? pageToolbarTarget : null
                      }
                      onOpen={openUser}
                      onCreate={composeIntent}
                      onWrite={() => setCreating("document")}
                      onImport={() => {
                        setImportMode("copy");
                        setImportOpen(true);
                      }}
                      importing={importing}
                    />
                  )}
                </ApplicationHost>
              </div>
            </main>
            <div className="exchange-surface" ref={exchange}>
              {conversationVisible && (
                <Conversation
                  focusedApplicationId={
                    !historyVisible &&
                    activeInstance?.applicationId === browserApplication.id
                      ? activeInstance.id
                      : undefined
                  }
                  focusedArtifactId={!historyVisible ? artifact?.id : undefined}
                  key={conversationId}
                  inputs={inputs}
                  positions={exchangePositions.current}
                  revealInputId={revealedInputs[conversationId] ?? null}
                  onInspect={inspectExecution}
                  state={state}
                  runtime={client.boot!.runtime}
                  projectId={conversationProjectId}
                  conversationId={conversationId}
                  client={client}
                  onOpen={openUser}
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
                    <div ref={setAttachmentSlot} />
                    <div ref={setDictationSlot} />
                    {draft.selection && (
                      <div className="selection-quote">
                        <blockquote>{draft.selection}</blockquote>
                        <button
                          aria-label="移除引用"
                          onClick={() =>
                            setDraft(contextKey, {
                              ...draft,
                              selection: "",
                              annotation: false,
                            })
                          }
                        >
                          <X />
                        </button>
                      </div>
                    )}
                    {draft.annotation && (
                      <div className="annotation-mode">
                        <span>保存为批注 · 不发送给 Agent</span>
                        <button
                          onClick={() =>
                            setDraft(contextKey, {
                              ...draft,
                              annotation: false,
                            })
                          }
                        >
                          改为提问
                        </button>
                      </div>
                    )}
                    <div className="composer-writing">
                      <textarea
                        ref={input}
                        aria-label="AI 输入内容"
                        placeholder={
                          draft.annotation
                            ? "写下批注，保存到当前选区；不会发送给 Agent…"
                            : draft.taskResult
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
                    {(!client.online ||
                      draft.taskResult ||
                      (!draft.annotation &&
                        !client.boot!.runtime.connected)) && (
                      <small className="model-status">
                        {!client.online
                          ? "工作中心已断开 · 草稿保留在本机"
                          : draft.taskResult
                            ? `${actorName(state, client.boot!.actantId)} · 提交到工作中心`
                            : client.boot!.runtime.configured
                              ? "连接中 · 消息将保留并排队"
                              : "Agent 未连接 · 仅保存，不会回复"}
                        {(!client.online || !draft.taskResult) && (
                          <button
                            className="text-button"
                            onClick={() => setConnectionOpen(true)}
                          >
                            连接详情
                          </button>
                        )}
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
                      {!draft.annotation && !draft.taskResult && (
                        <div className="composer-preferences">
                          <ModelPicker
                            compact
                            current={client.boot!.runtime.model}
                            value={draft.model}
                            reasoning={{
                              value: draft.reasoningEffort,
                              onChange: (reasoningEffort) =>
                                setDraft(contextKey, {
                                  ...draft,
                                  reasoningEffort,
                                }),
                            }}
                            disabled={
                              sending ||
                              !client.online ||
                              !client.boot!.runtime.connected
                            }
                            onChange={(model) =>
                              setDraft(contextKey, {
                                ...draft,
                                model: model || undefined,
                              })
                            }
                          />
                        </div>
                      )}
                      <div
                        className="composer-floating-tools"
                        role="group"
                        aria-label="输入工具"
                      >
                        {((!draft.annotation && !draft.taskResult) ||
                          !!draft.attachments?.length) && (
                          <MessageAttachments
                            key={`attachments:${contextKey}`}
                            previewTarget={attachmentSlot}
                            client={client}
                            attachments={draft.attachments ?? []}
                            allowAdd={!draft.annotation && !draft.taskResult}
                            disabled={sending || !!uploadingDrafts[contextKey]}
                            onBusy={(busy) =>
                              setUploadingDrafts((old) => ({
                                ...old,
                                [contextKey]: busy,
                              }))
                            }
                            onChange={(update) =>
                              updateDraft(contextKey, (old) => ({
                                ...old,
                                attachments: update(old.attachments ?? []),
                              }))
                            }
                            onError={(message) =>
                              setInputErrors((old) => ({
                                ...old,
                                [contextKey]: message,
                              }))
                            }
                          />
                        )}
                        {!draft.annotation && !draft.taskResult && (
                          <button
                            className="icon-button"
                            aria-label="截图输入"
                            title="截图输入"
                            disabled={
                              sending ||
                              !!uploadingDrafts[contextKey] ||
                              !client.online ||
                              (draft.attachments?.length ?? 0) >= 8
                            }
                            onClick={() =>
                              setCapture({
                                key: contextKey,
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
                        )}
                        <button
                          className="icon-button"
                          aria-label="语音输入"
                          title="短句听写 · 识别文字放入输入框"
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
                        <ComposerToolButtons
                          key={`options:${contextKey}`}
                          unread={!conversationVisible && unseenReply}
                          options={[
                            {
                              label: "长录音转写",
                              title: "长录音转写 · 录音结束后确认文字",
                              icon: <AudioLines />,
                              onSelect: () =>
                                setSpeech({
                                  modal: true,
                                  key: contextKey,
                                  title: contextTitle,
                                  draft: { ...draft },
                                  scope: {
                                    projectId: project.id,
                                    ...(artifact
                                      ? {
                                          artifactId: artifact.id,
                                          revision:
                                            draft.revision ?? artifact.revision,
                                        }
                                      : {}),
                                  },
                                }),
                              disabled: !client.online,
                            },
                            {
                              label: "执行记录与审批",
                              groupStart: true,
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
                                    id: "history-visibility",
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
                                  {
                                    id: "history-size",
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
                                        historyVisible ? "recent" : "history",
                                      ),
                                  },
                                ]
                              : []),
                            ...(!dialogueCanvas
                              ? [
                                  {
                                    id: "pin",
                                    label: inputPinned
                                      ? "取消固定输入框"
                                      : "固定输入框",
                                    icon: <Pin />,
                                    pressed: inputPinned,
                                    onSelect: () => {
                                      keepExchangeOpen();
                                      if (inputPinned) input.current?.focus();
                                      prefer({
                                        pinnedInputs: {
                                          [exchangeKey]: !inputPinned,
                                        },
                                      });
                                    },
                                  },
                                ]
                              : []),
                            ...(artifact
                              ? [
                                  {
                                    label: "保存为批注",
                                    reserveOnly: !draft.selection,
                                    icon: <MessageSquarePlus />,
                                    disabled:
                                      !draft.body.trim() ||
                                      sending ||
                                      !client.online,
                                    onSelect: () => {
                                      // Saving clears the selection and removes this
                                      // tool. Leave focus on the persistent input.
                                      input.current?.focus();
                                      void send(true);
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                        {!dialogueCanvas && (
                          <button
                            className="icon-button"
                            aria-label="收起 AI 输入框"
                            title="收起 AI 输入框"
                            onClick={hideInput}
                          >
                            <ChevronDown />
                          </button>
                        )}
                      </div>
                      <div className="inline composer-input-tools">
                        <button
                          className="send"
                          aria-label={
                            draft.annotation
                              ? "保存批注"
                              : draft.taskResult
                                ? "提交结果并完成事项"
                                : client.boot!.runtime.configured
                                  ? "发送消息"
                                  : "保存输入"
                          }
                          disabled={
                            (!draft.body.trim() &&
                              !draft.attachments?.length) ||
                            sending ||
                            !!uploadingDrafts[contextKey] ||
                            !client.online
                          }
                          onClick={() => void send()}
                        >
                          {draft.annotation ? (
                            <MessageSquarePlus />
                          ) : (
                            <ArrowUp />
                          )}
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
        </div>
        {executions && (
          <ExecutionSidebar
            key={executions.threadId ?? executions.inputId ?? "overview"}
            client={client}
            scope={executions}
            pinned={!!prefs.executionPinned}
            layout={rightInspector}
            onResize={resizeInspector}
            onPin={() => prefer({ executionPinned: !prefs.executionPinned })}
            onClose={closeInspector}
            onSelect={setExecutions}
            onOpen={openUser}
          />
        )}
        {understandingOpen && (
          <UnderstandingPanel
            client={client}
            layout={rightInspector}
            onResize={resizeInspector}
            projectId={project.id}
            onOpen={openUser}
            onCompose={(body) => {
              setDraft(contextKey, {
                ...draft,
                body: [draft.body.trimEnd(), body].filter(Boolean).join("\n\n"),
                annotation: false,
                taskResult: undefined,
                intent: undefined,
              });
              if (rightInspector.mode === "overlay")
                setUnderstandingOpen(false);
              showInput();
            }}
            onClose={closeInspector}
          />
        )}
        {collaborationVisible && (
          <InspectorPanel
            className="collaboration"
            label="对象批注"
            title="批注"
            context={contextTitle}
            resizeLabel="调整批注栏宽度"
            // Showing a saved annotation must not steal focus from continued input.
            focusOnMount={!sentInputFocus.current}
            layout={rightInspector}
            onResize={resizeInspector}
            onClose={closeInspector}
          >
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
          </InspectorPanel>
        )}
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
      {connectionOpen && (
        <ConnectionDetails
          client={client}
          onClose={() => setConnectionOpen(false)}
        />
      )}
      {importOpen && (
        <ImportDocuments
          initialMode={importMode}
          client={client}
          project={project}
          onClose={() => setImportOpen(false)}
          onOpen={openUser}
        />
      )}
      {speech &&
        (speech.modal || dictationSlot) &&
        speech.key === contextKey && (
          <SpeechDialog
            inlineTarget={speech.modal ? undefined : dictationSlot!}
            onTranscript={
              speech.modal
                ? undefined
                : (text) =>
                    updateDraft(speech.key, (saved) => ({
                      ...saved,
                      body: [saved.body, text].filter(Boolean).join("\n"),
                      revision: speech.scope.revision ?? null,
                    }))
            }
            client={client}
            scope={speech.scope}
            title={speech.title}
            onClose={closeSpeech}
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
      {capture && (
        <CaptureDialog
          client={client}
          {...capture}
          onClose={() => setCapture(null)}
          onAttach={(attachment) => {
            const key = capture.key;
            updateDraft(key, (old) => ({
              ...old,
              attachments: [...(old.attachments ?? []), attachment],
            }));
            setCapture(null);
            if (currentContext.current === key) showInput();
          }}
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
          onOpen={openUser}
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
              setInteraction("recent");
              requestAnimationFrame(() => {
                if (!exchange.current?.contains(document.activeElement))
                  input.current?.focus();
              });
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
        {kind === "save-project"
          ? "为当前工作命名"
          : "新建" +
            {
              document: "文档",
              project: "项目",
              "save-project": "",
            }[kind]}
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
      {kind === "save-project" && (
        <p className="muted">
          保留当前应用、内容和工作记录。保存后可以继续这个项目，工作台会准备一处新的空白空间。
        </p>
      )}
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
          {busy ? "保存中…" : kind === "save-project" ? "保存为项目" : "创建"}
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
