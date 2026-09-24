import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  type FormEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { replaceDictationTail } from "./live-dictation.js";
import {
  ArrowUp,
  AudioLines,
  ArrowLeft,
  ArrowRight,
  Inbox,
  Layers2,
  Library,
  MessageCircle,
  MessageSquareText,
  PanelsTopLeft,
  Plus,
  X,
  Link2,
  MessageSquarePlus,
  RefreshCw,
  ChevronRight,
  Search,
  Mic,
  Square,
  SquareBottomDashedScissors,
  Brain,
  ListChecks,
} from "lucide-react";
import {
  inboxFor,
  spaceKind,
  inConversation,
  discussionId,
  applicationFor,
  isContentArtifact,
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
import { SettingsDialog, type SettingsSection } from "./SettingsDialog.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { AppearanceMenu } from "./AppearanceControls.js";
import {
  interfacePreferences,
  shouldSubmitInput,
  type InterfacePreferences,
} from "./interface-preferences.js";
import {
  inputIntents,
  type InputIntent,
} from "../../../packages/core/src/input-intent.js";
import { Conversation, type ExchangePosition } from "./Conversation.js";
import { TextQuoteDrafts, TextQuoteProvider } from "./TextQuotes.js";
import {
  replaceComposerSurface,
  updateComposerDraft,
} from "./composer-drafts.js";
import { quoteSource, revealTextQuote } from "./text-quote-dom.js";
import {
  quotedInputText,
  type TextQuote,
} from "../../../packages/core/src/text-quotes.js";
import { ExecutionSidebar } from "./ExecutionSidebar.js";
import "./execution.css";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import { ProjectConversations } from "./ProjectConversations.js";
import {
  ProjectMenu,
  ProjectActionDialog,
  type ProjectAction,
} from "./ProjectManagement.js";
import {
  projectActivity,
  projectStatus,
  type Project,
} from "../../../packages/core/src/projects.js";
import { ComposerOptions, type ComposerOption } from "./ComposerOptions.js";
import { ComposerToolButtons } from "./ComposerToolButtons.js";
import { ExchangePanel, ExchangeControls } from "./ExchangePanel.js";
import { BrandMark } from "./BrandMark.js";
import { ProductBridge } from "./ProductBridge.js";
import { ObjectCollection } from "./ObjectCollection.js";
import { ProjectDirectory } from "./WorkspaceViews.js";
import { TaskList } from "./TaskList.js";
import { taskListOptions, type TaskListOptions } from "./task-list.js";
import { ApplicationHost } from "./ApplicationHost.js";
import { AgentDirectories, type DirectoryState } from "./AgentDirectories.js";
import {
  objectsApplication,
  scriptStudioApplication,
  browserApplication,
  readerApplication,
} from "../../../packages/core/src/applications.js";
import { Reader, type ReadingCompose } from "./Reader.js";
import {
  ReadingContext,
  type ReadingSurface,
  type ReadingContextChange,
} from "./ReadingContext.js";
import type {
  ReadingInput,
  ReaderTarget,
  ReadingLocation,
} from "../../../packages/core/src/reader.js";
import { SearchDocuments } from "./LibraryDialogs.js";
import type { LocalFileView } from "../../../packages/core/src/local-files.js";
import { UnderstandingPanel } from "./UnderstandingPanel.js";
import { SpeechDialog } from "./SpeechDialog.js";
import type { SpeechScope } from "./client.js";
import { CaptureDialog } from "./CaptureDialog.js";
import { MessageAttachments } from "./MessageAttachments.js";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import type { Operation } from "../../../packages/core/src/model.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";
import { RequestError } from "./application-transport.js";
import type { BrowserView } from "./desktop.js";
import { Notifications } from "./Notifications.js";
import { afterSend, revealInput, type InteractionMode } from "./interaction.js";
import { useModal } from "./useModal.js";
import { useExchangeFocus } from "./useExchangeFocus.js";
import { useDesktopAppearance } from "./useDesktopAppearance.js";
import { InspectorPanel, useInspectorLayout } from "./InspectorPanel.js";
import { SidebarToggle } from "./SidebarToggle.js";
import { activeExecutionThreads } from "../../../packages/core/src/conversation.js";
import { contentVisits, visitContent } from "./recent-content.js";
import { useConversationStream } from "./useConversationStream.js";
import {
  acknowledgeReplies,
  conversationMessages,
  focusedInputs,
  hasUnreadReplies,
  readReplyReceipts,
  reconcileReplyReceipts,
  replyReceipts,
  type ReplyReceipt,
} from "./conversation-read.js";

type View = "dialogue" | "inbox" | "content" | "desk" | "projects";
type InspectorSelection =
  | { view: "execution"; scope: ExecutionScope }
  | { view: "understanding" | "collaboration" };
type Preferences = InterfacePreferences & {
  taskList?: TaskListOptions;
  executionPinned?: boolean;
  executionWidth?: number;
  inspectorWidth?: number;
  view: View;
  projectId: string;
  artifactId: string | null;
  artifactRevision: number | null;
  artifactPage?: number | null;
  readerMode?: boolean;
  readingTarget?: ReaderTarget | null;
  collaboration: boolean;
  composer: boolean;
  conversation: boolean | null;
  sidebar: boolean;
  projectOpen: boolean;
  applications?: Record<string, string | null>;
  scriptLocation?:
    | (ScriptLocation & { requestId: string; view?: "library" | "editor" })
    | null;
  interactions?: Record<string, InteractionMode>;
  exchangeHeights?: Record<string, number>;
  pinnedInputs?: Record<string, boolean>;
  selectedConversations?: Record<string, string>;
  localFile?: { projectId: string; reference: LocalFileView["reference"] };
};
import type { ScriptGeneration } from "../../../packages/core/src/script-studio.js";
import {
  resolveScriptLocation,
  scriptOutputLocation,
  type ScriptLocation,
  type ScriptOutput,
} from "../../../packages/core/src/script-delivery.js";

type InputDraft = {
  textQuotes?: TextQuote[];
  reading?: ReadingInput;
  skipReading?: boolean;
  scriptGeneration?: ScriptGeneration;
  continuation?: InputContinuation;
  continuationLabel?: string;
  continuationFailure?: "closed" | "changed" | "unknown";
  pendingSupplement?: { commandId: string; operation: Operation };
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
  | "readerMode"
  | "applications"
  | "scriptLocation"
>;
const defaultPrefs: Preferences = {
  ...interfacePreferences({}),
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
export function App() {
  const client = useWorkspace();
  if (client.authenticationRequired) return <WorkspaceLogin client={client} />;
  if (!client.boot)
    return (
      <main className="connection-screen">
        <BrandMark />
        <h1>Morphz</h1>
        <p>{client.error || "正在打开工作空间…"}</p>
        <button onClick={() => void client.refresh()}>重试</button>
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
function WorkspaceLogin({
  client,
}: {
  client: ReturnType<typeof useWorkspace>;
}) {
  const [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="connection-screen">
      <BrandMark />
      <h1>登录 Morphz</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await client.login(token.trim());
            setToken("");
          } catch (e) {
            setError(e instanceof Error ? e.message : "登录失败，请重试。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          登录凭据
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
        <p>使用管理员提供的登录凭据，不是模型 API Key。</p>
        {error && <p role="alert">{error}</p>}
        <button className="button primary" disabled={busy || !token.trim()}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
function WorkspaceApp({ client }: { client: ReturnType<typeof useWorkspace> }) {
  const state = client.boot?.workspace;
  const { readLocal, writeLocal } = useState(() => scopedStorage())[0];
  const [recentContentVisits, setRecentContentVisits] = useState(() =>
    contentVisits(readLocal<unknown>("recent-content", [])),
  );
  // The catalog and its composer share a destination. Keep the existing
  // catalog preference key so returning/reloading restores the same scope.
  const [contentScope, setContentScope] = useState(
    () =>
      readLocal<{ scope?: string }>("library-view:all-content", {}).scope ??
      "all",
  );
  const [prefs, setPrefs] = useState<Preferences>(() => {
    const p = readLocal<Partial<Preferences>>("preferences", {});
    return {
      ...defaultPrefs,
      ...p,
      ...interfacePreferences(p),
      projectOpen: p.projectOpen ?? p.view === "projects",
      view: ["dialogue", "inbox", "content", "desk", "projects"].includes(
        p.view ?? "",
      )
        ? p.view!
        : defaultPrefs.view,
    };
  });
  const dictationControls = useRef<{
    toggle(): void;
    interrupt(): void;
  } | null>(null);
  const [speechRecording, setSpeechRecording] = useState(false);
  const [notice, setNotice] = useState(""),
    [connectionOpen, setConnectionOpen] = useState(false),
    [settingsSection, setSettingsSection] = useState<SettingsSection | null>(
      null,
    ),
    [inputErrors, setInputErrors] = useState<Record<string, string>>({}),
    [uploadingDrafts, setUploadingDrafts] = useState<Record<string, boolean>>(
      {},
    ),
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
      hideWindow: boolean;
      artifactId?: string;
      artifactRevision?: number;
    } | null>(null),
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
    [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null),
    [detailToolbarTarget, setDetailToolbarTarget] =
      useState<HTMLDivElement | null>(null),
    [pageToolbarTarget, setPageToolbarTarget] = useState<HTMLDivElement | null>(
      null,
    ),
    [creating, setCreating] = useState<"document" | "project" | null>(null),
    [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, InputDraft>>(() =>
    readLocal(draftKey("inputs"), {}),
  );
  const [conversationDrafts, setConversationDrafts] = useState<
    Record<string, ConversationDraft>
  >(() => readLocal(draftKey("conversations"), {}));
  const conversationDraftsRef = useRef(conversationDrafts);
  conversationDraftsRef.current = conversationDrafts;
  const [projectAction, setProjectAction] = useState<{
    project: Project;
    action: ProjectAction;
  } | null>(null);
  const [projectDirectoryVersion, setProjectDirectoryVersion] = useState(0);
  const [discardedDrafts, setDiscardedDrafts] = useState<
    Record<
      string,
      { conversation: ConversationDraft; drafts: Record<string, InputDraft> }
    >
  >(() => readLocal(draftKey("discarded-conversations"), {}));
  const manageProject = (project: Project, action: ProjectAction) =>
    setProjectAction({ project, action });
  const sendPending = useRef(false);
  const [quoteReveal, setQuoteReveal] = useState<{
    quote: TextQuote;
    token: string;
  } | null>(null);
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
          value.textQuotes?.length ||
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
  const input = useRef<HTMLTextAreaElement>(null),
    exchange = useRef<HTMLDivElement>(null),
    main = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    file = useRef<HTMLInputElement>(null),
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
    prefs.view === "dialogue"
      ? personalSpace("dialogue")
      : prefs.view === "content"
        ? (state?.projects.find((p) => p.id === contentScope) ??
          personalSpace("desk"))
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
  // Association scopes the next input, not the shared conversation or its
  // in-flight activations. An open object wins; otherwise use the visible space.
  const deliveredScript =
    state && prefs.scriptLocation
      ? resolveScriptLocation(state, prefs.scriptLocation)
      : null;
  const project =
    state?.projects.find(
      (p) => p.id === deliveredScript?.production.projectId,
    ) ??
    state?.projects.find(
      (p) =>
        p.id ===
        state.artifacts.find((a) => a.id === prefs.artifactId)?.projectId,
    ) ??
    (navigationProject &&
    ["dialogue", "inbox"].includes(navigationProject.kind ?? "")
      ? personalSpace("desk")
      : navigationProject);
  const sharedDefault = !client.boot!.capabilities.teamAuthentication;
  const defaultConversation = sharedDefault
    ? personalSpace("dialogue")?.id
    : navigationProject?.id;
  const applicationWorkspaceOpen =
    (!!deliveredScript ||
      prefs.view === "desk" ||
      (prefs.view === "projects" && prefs.projectOpen)) &&
    !!project &&
    projectStatus(project) === "active";
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
      activeInstance?.applicationId !== "morphz.script-studio" &&
      a.projectId === project?.id &&
      a.id ===
        (activeInstance?.applicationId === readerApplication.id
          ? activeInstance.state.artifactId
          : restoredPlace
            ? restoredPlace.artifactId
            : (prefs.artifactId ??
              (prefs.view !== "inbox" &&
              activeInstance?.applicationId === objectsApplication.id
                ? activeInstance.state.artifactId
                : null))),
  );
  const [readingSurface, setReadingSurface] = useState<ReadingSurface | null>(
    null,
  );
  const readingContextChanged = useCallback<ReadingContextChange>(
    (key, next) => {
      setReadingSurface((old) => next ?? (old?.key === key ? null : old));
    },
    [],
  );
  const readingExpected =
    !!artifact &&
    (activeInstance?.applicationId === readerApplication.id ||
      (!applicationWorkspaceOpen &&
        (prefs.readerMode || artifact.content.kind === "publication")));
  const currentReading =
    readingExpected &&
    artifact &&
    readingSurface?.artifactId === artifact.id &&
    readingSurface.revision === (prefs.artifactRevision ?? artifact.revision)
      ? readingSurface
      : null;
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
  const directoryScope = `${project?.id}:${conversationId}`;
  const canAuthorizeDirectories =
    !!client.boot?.capabilities.agentDirectories &&
    !!window.morphzDesktop?.directories;
  const [directoryState, setDirectoryState] = useState<DirectoryState>({
    scope: "",
    ready: false,
    grants: [],
  });
  const [directoryPickerScope, setDirectoryPickerScope] = useState<
    string | null
  >(null);
  const [nativeExportDialog, setNativeExportDialog] = useState(false);
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
  useEffect(() => setQuoteReveal(null), [conversationId]);
  const exchangeKey =
    conversationId === defaultConversation
      ? prefs.view === "content"
        ? `${navigationProject?.id ?? conversationId}:content`
        : (navigationProject?.id ?? conversationId)
      : conversationId;
  const dialogueCanvas =
    prefs.view === "dialogue" && !artifact && !applicationWorkspaceOpen;
  const [conversationToolbarTarget, setConversationToolbarTarget] =
    useState<HTMLDivElement | null>(null);
  const [exchangeResizePreview, setExchangeResizePreview] = useState<{
    scope: string;
    mode: "recent";
  } | null>(null);
  const interaction =
    (exchangeResizePreview?.scope === exchangeKey
      ? exchangeResizePreview.mode
      : undefined) ??
    prefs.interactions?.[exchangeKey] ??
    "input";
  const inputVisible = dialogueCanvas || interaction !== "hidden";
  const conversationVisible =
    dialogueCanvas ||
    !!selectedConversation?.archivedAt ||
    interaction === "recent" ||
    interaction === "history";
  const historyVisible = dialogueCanvas || interaction === "history";
  function recordContentVisit(id: string) {
    setRecentContentVisits((previous) => {
      const next = visitContent(previous, id);
      try {
        writeLocal("recent-content", next);
      } catch {
        setNotice("最近打开记录暂时无法保存，内容不受影响。");
      }
      return next;
    });
  }
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
      connectionOpen ||
      settingsSection !== null ||
      !!creating ||
      !!executions ||
      nativeExportDialog ||
      directoryPickerScope === directoryScope ||
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
  const [seenReplies, setSeenReplies] = useState(
    () =>
      readReplyReceipts(
        readLocal<unknown>("conversation-read-receipts", null),
      ) ??
      acknowledgeReplies(
        {},
        replyReceipts(
          client.boot!.runtime.messages,
          client.boot!.outputs,
          client.boot!.scriptOutputs,
        ),
      ),
  );
  const inputs =
    state?.inputs.filter((i) =>
      inConversation(state!, conversationId, i, sharedDefault),
    ) ?? [];
  const stream = useConversationStream(
    conversationProjectId,
    conversationId,
    client.boot!.runtime.configured &&
      !!state?.conversations.some((c) => c.id === conversationId),
  );
  const replies = conversationMessages(
    state!,
    conversationId,
    client.boot!.runtime,
    stream.messages,
    sharedDefault,
  );
  const conversationFocus = {
    artifactId: !historyVisible ? artifact?.id : undefined,
    applicationId:
      !historyVisible && activeInstance?.applicationId === browserApplication.id
        ? activeInstance.id
        : undefined,
  };
  const badgeInputs = focusedInputs(
    inputs,
    client.boot!.outputs,
    conversationFocus,
  );
  const badgeInputIds = new Set(badgeInputs.map((i) => i.id));
  const badgeReplies =
    conversationFocus.artifactId || conversationFocus.applicationId
      ? replies.filter((m) => !!m.inputId && badgeInputIds.has(m.inputId))
      : replies;
  const receipts = replyReceipts(
    replies,
    client.boot!.outputs.filter((o) => inputs.some((i) => i.id === o.inputId)),
    client.boot!.scriptOutputs.filter((o) =>
      inputs.some((i) => i.id === o.inputId),
    ),
  );
  const receiptVersion = JSON.stringify(receipts);
  const unseenReply = hasUnreadReplies(
    seenReplies,
    replyReceipts(
      badgeReplies,
      client.boot!.outputs.filter((o) => badgeInputIds.has(o.inputId)),
      client.boot!.scriptOutputs.filter((o) => badgeInputIds.has(o.inputId)),
    ),
  );
  const readReplies = useCallback((receipts: ReplyReceipt[]) => {
    setSeenReplies((old) => acknowledgeReplies(old, receipts));
  }, []);
  useEffect(() => {
    setSeenReplies((old) => reconcileReplyReceipts(old, receipts));
  }, [receiptVersion]);
  useEffect(() => {
    try {
      writeLocal("conversation-read-receipts", seenReplies);
    } catch {
      setNotice("已读状态暂时无法保存，重开后可能再次提示。");
    }
  }, [seenReplies]);
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
    readerMode: prefs.readerMode,
    applications: prefs.applications,
    scriptLocation: prefs.scriptLocation ?? null,
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
        !state.artifacts.some((a) => a.id === next.artifactId)) ||
      (next.scriptLocation &&
        !resolveScriptLocation(state!, next.scriptLocation))
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
    setPrefs((previous) => {
      const restored = { ...previous, ...next };
      try {
        writeLocal("preferences", restored);
      } catch {
        setNotice("当前位置暂时无法持久保存。");
      }
      return restored;
    });
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
  const requestedComposerFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const generation = requestedComposerFocus.current;
    if (generation === null) return;
    requestedComposerFocus.current = null;
    // Guest IPC can reach an animation frame before React mounts the revealed
    // input. Honor the explicit request after commit, never on newer navigation.
    if (
      generation === navigationGeneration.current &&
      inputVisible &&
      input.current
    ) {
      keepExchangeOpen();
      input.current.focus({ preventScroll: true });
    }
  });
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
  useEffect(() => {
    // Do not retain a hidden recorder that could restart when returning here.
    setSpeech((current) =>
      current &&
      (current.key !== contextKey || (!current.modal && !inputVisible))
        ? null
        : current,
    );
  }, [contextKey, inputVisible]);
  const collaborationVisible =
    !executions &&
    !understandingOpen &&
    !!artifact &&
    (compact ? mobileCollaboration : prefs.collaboration);
  const { ref: inspectorWorkspace, layout: rightInspector } =
    useInspectorLayout(prefs.inspectorWidth ?? prefs.executionWidth ?? 340);
  const inspectorOpen =
    !!executions || understandingOpen || collaborationVisible;
  const inspectorSelections = useRef(new Map<string, InspectorSelection>());
  useLayoutEffect(() => {
    // Visibility never chooses a feature. Remember the last explicit view in
    // each work surface, including the exact execution provenance being read.
    if (executions)
      inspectorSelections.current.set(contextKey, {
        view: "execution",
        scope: executions,
      });
    else if (understandingOpen)
      inspectorSelections.current.set(contextKey, { view: "understanding" });
    else if (collaborationVisible)
      inspectorSelections.current.set(contextKey, { view: "collaboration" });
  }, [contextKey, executions, understandingOpen, collaborationVisible]);
  const resizeInspector = (inspectorWidth: number) =>
    prefer({ inspectorWidth });
  function closeInspector() {
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
  const surfaceDraft =
    drafts[contextKey] ??
    (conversationId === defaultConversation
      ? drafts[legacyContextKey]
      : undefined) ??
    emptyDraft;
  // Selections follow this conversation across work surfaces. Body, execution
  // bindings and attachments remain in their existing surface-scoped drafts.
  const draft = {
    ...surfaceDraft,
    textQuotes: drafts[conversationId + ":quotes"]?.textQuotes ?? [],
  };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform),
    shortcut = mac ? "⌘J" : "Ctrl+J";
  function prefer(change: Partial<Preferences>) {
    if (
      "view" in change ||
      "projectId" in change ||
      "artifactId" in change ||
      "applications" in change ||
      "scriptLocation" in change ||
      "selectedConversations" in change
    ) {
      navigationGeneration.current++;
      setUnderstandingOpen(false);
      setRestoredPlace(null);
      setOpeningObject(false);
      setExchangeResizePreview(null);
    }
    setPrefs((previous) => {
      const next = {
        ...previous,
        ...("view" in change ||
        "projectId" in change ||
        "selectedConversations" in change ||
        typeof change.artifactId === "string"
          ? { scriptLocation: null }
          : {}),
        ...("view" in change ||
        "projectId" in change ||
        "artifactId" in change ||
        "applications" in change ||
        "selectedConversations" in change
          ? { localFile: undefined }
          : {}),
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
        ...(change.exchangeHeights
          ? {
              exchangeHeights: {
                ...previous.exchangeHeights,
                ...change.exchangeHeights,
              },
            }
          : {}),
      };
      try {
        writeLocal("preferences", next);
      } catch {
        setNotice("设置暂时无法持久保存。");
      }
      return next;
    });
  }
  function setInteraction(mode: InteractionMode, id = navigationProject?.id) {
    setExchangeResizePreview(null);
    if (id)
      prefer({
        interactions: {
          [id === navigationProject?.id ? exchangeKey : id]: mode,
        },
      });
  }
  function setDraft(key: string, value: InputDraft) {
    if (key === currentContext.current && value.body !== drafts[key]?.body)
      dictationControls.current?.interrupt();
    writeDrafts((previous) =>
      replaceComposerSurface(previous, key, emptyDraft, value),
    );
  }
  function updateDraft(key: string, update: (value: InputDraft) => InputDraft) {
    writeDrafts((previous) =>
      updateComposerDraft(previous, key, emptyDraft, update),
    );
  }
  function writeDrafts(
    update: (
      previous: Record<string, InputDraft>,
    ) => Record<string, InputDraft>,
  ) {
    setDrafts((previous) => {
      const next = update(previous);
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
  async function openTextQuote(quote: TextQuote) {
    window.getSelection()?.removeAllRanges();
    const source = quote.source;
    if (source.kind !== "message" && revealTextQuote(quote)) {
      return;
    }
    if (source.kind === "message") {
      if (source.conversationId !== conversationId) {
        selectConversation(source.projectId, source.conversationId);
      }
      keepExchangeOpen();
      setInteraction("recent");
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.kind === "artifact" || source.kind === "reading") {
      await openObject(
        source.projectId,
        source.artifactId,
        source.revision,
        source.kind === "artifact" ? source.page : undefined,
        source.kind === "reading",
        source.kind === "reading" ? source.location : undefined,
      );
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.kind === "script") {
      await openScriptLocation({
        productionId: source.productionId,
        itemId: source.entryId,
        revision: source.revision,
        candidateId: source.candidateId,
      });
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.kind === "web") {
      await openBrowser(source.url);
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.applicationInstanceId) {
      activateApplication(source.applicationInstanceId);
    } else setNotice("已保留所选原文；这个界面没有固定的内容位置。");
  }
  async function composeContent(id: string) {
    const target = state?.artifacts.find((a) => a.id === id);
    if (!target) return;
    // Opening a result changes the object reference, never the current Session.
    const key = conversationId + ":" + id;
    const revision = drafts[key]?.revision ?? target.revision;
    updateDraft(key, (old) => ({ ...old, revision: old.revision ?? revision }));
    setWebsiteIntent(null);
    keepExchangeOpen();
    // A current result is a live document, not an implicit history selection.
    // Keep an older unsent draft anchored to its original reference, however.
    const generation = await openObject(
      target.projectId,
      id,
      revision === target.revision ? undefined : revision,
    );
    if (generation !== undefined) {
      if (navigationGeneration.current !== generation) return;
      requestedConversationFocus.current = { id: conversationId, generation };
      keepExchangeOpen();
      setInteraction("recent");
    }
  }
  // Only first-party, explicit user navigation opens a network page. Application
  // bridge requests and restored views do not grant that browser intent.
  async function openUser(
    id: string,
    revision?: number,
    page?: number,
    reading?: ReadingLocation,
  ) {
    if (state?.scriptProductions.some((p) => p.id === id))
      return openScriptLocation({ productionId: id });
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
    void openObject(a.projectId, id, revision, page, !!reading, reading);
  }
  async function openReading(id: string) {
    const generation = ++navigationGeneration.current;
    const a =
      state?.artifacts.find((a) => a.id === id) ??
      (await client.resolveArtifact(id));
    if (generation !== navigationGeneration.current) return;
    if (a) await openObject(a.projectId, id, undefined, undefined, true);
  }
  async function readingLibrary() {
    if (
      !activeInstance ||
      activeInstance.applicationId !== readerApplication.id
    ) {
      prefer({ artifactId: null, readerMode: false, readingTarget: null });
      return;
    }
    try {
      await client.execute({
        type: "set-application-state",
        instanceId: activeInstance.id,
        expectedRevision: activeInstance.revision,
        state: { ...activeInstance.state, artifactId: "" },
      });
      activateApplication(activeInstance.id);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function readingTargetConsumed(requestId: string) {
    if (prefs.readingTarget?.requestId === requestId)
      prefer({ readingTarget: null });
  }
  const composeReading: ReadingCompose = (
    id,
    revision,
    reference,
    question,
  ) => {
    const key = conversationId + ":" + id,
      old = drafts[key] ?? emptyDraft;
    if (
      old.body.trim() ||
      old.selection ||
      old.attachments?.length ||
      old.continuation ||
      old.taskResult ||
      old.scriptGeneration
    )
      return {
        ok: false,
        error: "输入框中有未发送内容，请先处理原草稿；这次选文仍保留。",
      };
    setDraft(key, {
      ...old,
      reading: structuredClone(reference),
      skipReading: false,
      revision,
      selection: reference.quote,
      body: question,
      annotation: false,
      intent: undefined,
    });
    showInput();
    return { ok: true };
  };
  async function openScript(output: ScriptOutput) {
    return openScriptLocation(scriptOutputLocation(output));
  }
  async function openScriptLibrary() {
    const owner = personalSpace("desk");
    if (!owner) return;
    const generation = ++navigationGeneration.current;
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: owner.id,
        applicationId: scriptStudioApplication.id,
        applicationVersion: scriptStudioApplication.version,
        scriptTarget: null,
      });
      if (generation !== navigationGeneration.current) return;
      prefer({
        view: "desk",
        scriptLocation: null,
        artifactId: null,
        applications: { ...prefs.applications, [owner.id]: receipt.entityId },
      });
    } catch (e) {
      if (generation === navigationGeneration.current)
        setNotice((e as Error).message);
    }
  }
  async function openScriptLocation(target: ScriptLocation) {
    const generation = ++navigationGeneration.current;
    const snapshot = client.getSnapshot();
    const resolved =
      snapshot && resolveScriptLocation(snapshot.workspace, target);
    if (!resolved) {
      setNotice("剧本结果已不可用或无访问权限。");
      return;
    }
    setOpeningObject(true);
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: resolved.production.projectId,
        applicationId: scriptStudioApplication.id,
        applicationVersion: scriptStudioApplication.version,
        scriptTarget: target,
      });
      if (generation !== navigationGeneration.current) return;
      setCreating(null);
      recordContentVisit(resolved.production.id);
      prefer({
        artifactId: null,
        scriptLocation: { ...target, requestId: receipt.commandId },
        applications: {
          ...prefs.applications,
          [resolved.production.projectId]: receipt.entityId,
        },
        interactions: { [exchangeKey]: "hidden" },
      });
    } catch (error) {
      if (generation === navigationGeneration.current)
        setNotice((error as Error).message);
    } finally {
      if (generation === navigationGeneration.current) setOpeningObject(false);
    }
  }
  async function openObject(
    workspaceId: string,
    id: string,
    revision?: number,
    page?: number,
    readerMode = false,
    reading?: ReadingLocation,
  ) {
    const generation = ++navigationGeneration.current;
    setOpeningObject(true);
    try {
      const opened = await client.resolveArtifact(id);
      if (generation !== navigationGeneration.current) return;
      if (!opened || opened.projectId !== workspaceId)
        throw new Error("内容暂时无法读取，请检查连接或访问权限后重试。");
      // Catalog and task navigation are views, not application launches.
      // Keep the workspace's current application intact when reading from them.
      const readingView =
        readerMode ||
        opened.content.kind === "publication" ||
        opened.content.kind === "pdf";
      const application = readingView ? readerApplication : objectsApplication;
      const result = applicationWorkspaceOpen
        ? await client.execute({
            type: "launch-application",
            workspaceId,
            applicationId: application.id,
            applicationVersion: application.version,
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
        readerMode: readingView,
        readingTarget: reading
          ? {
              artifactId: id,
              revision: revision ?? opened.revision,
              location: reading,
              requestId: crypto.randomUUID(),
            }
          : null,
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
      // Only successful explicit opens affect recency. Restoring an old
      // application when returning to its workspace is not a new file open.
      if (isContentArtifact(opened)) recordContentVisit(id);
      return navigationGeneration.current;
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      if (generation === navigationGeneration.current) setOpeningObject(false);
    }
  }
  async function openWorkspaceContents() {
    if (project && spaceKind(project) !== "project") {
      setContentScope("all");
      navigate("content");
      return;
    }
    if (!project) return;
    const generation = ++navigationGeneration.current;
    setOpeningObject(true);
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: project.id,
        applicationId: objectsApplication.id,
        applicationVersion: objectsApplication.version,
        artifactId: null,
      });
      if (generation !== navigationGeneration.current) return;
      activateApplication(receipt.entityId);
    } catch (error) {
      if (generation === navigationGeneration.current)
        setNotice((error as Error).message);
    } finally {
      if (generation === navigationGeneration.current) setOpeningObject(false);
    }
  }
  function activateApplication(
    id: string | null,
    expectedNavigation = navigationGeneration.current,
  ) {
    if (expectedNavigation !== navigationGeneration.current) return;
    if (!project) return;
    setWebsiteIntent(null);
    setCreating(null);
    prefer({
      applications: { ...prefs.applications, [project.id]: id },
      readerMode:
        state?.applicationInstances.find((i) => i.id === id)?.applicationId ===
        readerApplication.id,
      artifactId: null,
      artifactRevision: null,
      readingTarget: null,
      ...(id === null ? { scriptLocation: null } : {}),
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
  function selectContentScope(scope: string) {
    setContentScope(scope);
    // Treat a destination change as navigation: stale open/picker callbacks
    // must not restore the previous scope or focus. Drafts and grants remain
    // keyed by their original workspace, not copied into the new destination.
    prefer({ artifactId: null, scriptLocation: null });
  }
  function selectConversation(workspaceId: string, id: string, focus = false) {
    setWebsiteIntent(null);
    const sameProject =
      prefs.view === "projects" &&
      prefs.projectOpen &&
      navigationProject?.id === workspaceId &&
      // Search can open another space's object without changing the navigation
      // entry. Preserve an object only when it actually belongs to this project.
      project?.id === workspaceId;
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
  function discardConversationDraft(id: string) {
    if (sendPending.current) {
      setNotice("消息正在提交，请等待结果后整理草稿。");
      return;
    }
    const conversation =
      Object.values(conversationDrafts).find((c) => c.id === id) ??
      state?.conversations.find((c) => c.id === id);
    if (!conversation) return;
    const discarded = {
      ...discardedDrafts,
      [id]: {
        conversation: {
          ...conversation,
          inputId:
            "inputId" in conversation
              ? conversation.inputId
              : crypto.randomUUID(),
        },
        drafts: Object.fromEntries(
          Object.entries(drafts).filter(([key]) => key.startsWith(id + ":")),
        ),
      },
    };
    const remaining = { ...conversationDrafts };
    if (remaining[conversation.projectId]?.id === id)
      delete remaining[conversation.projectId];
    const remainingInputs = Object.fromEntries(
      Object.entries(drafts).filter(([key]) => !key.startsWith(id + ":")),
    );
    try {
      writeLocal(draftKey("discarded-conversations"), discarded);
      writeLocal(draftKey("inputs"), remainingInputs);
      writeLocal(draftKey("conversations"), remaining);
      setDiscardedDrafts(discarded);
      setDrafts(remainingInputs);
      setConversationDrafts(remaining);
      conversationDraftsRef.current = remaining;
      if (conversationId === id) openProject(conversation.projectId);
    } catch {
      setNotice("草稿整理未完成，原文仍保留，请重试。");
    }
  }
  function restoreConversationDraft(id: string) {
    const saved = discardedDrafts[id];
    if (!saved) return;
    const pending = conversationDrafts[saved.conversation.projectId];
    if (pending && pending.id !== id && hasConversationDraft(pending.id)) {
      setNotice("请先发送或丢弃当前项目的新草稿，再恢复这份草稿。");
      return;
    }
    const inputs = { ...drafts, ...saved.drafts },
      next = {
        ...conversationDrafts,
        [saved.conversation.projectId]: saved.conversation,
      },
      trash = { ...discardedDrafts };
    delete trash[id];
    try {
      writeLocal(draftKey("inputs"), inputs);
      writeLocal(draftKey("conversations"), next);
      writeLocal(draftKey("discarded-conversations"), trash);
      setDrafts(inputs);
      setConversationDrafts(next);
      conversationDraftsRef.current = next;
      setDiscardedDrafts(trash);
      selectConversation(saved.conversation.projectId, id, true);
    } catch {
      setNotice("草稿恢复失败，保存的原文仍在，请重试。");
    }
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
    requestedComposerFocus.current = navigationGeneration.current;
    setInteraction(revealInput(interaction));
  }
  function composeIntent(intent: InputIntent) {
    if (
      intent === "script" &&
      (sending ||
        draft.pendingSupplement ||
        draft.continuation ||
        draft.annotation ||
        draft.taskResult ||
        draft.scriptGeneration)
    ) {
      setNotice(
        "输入中已有另一份请求，请先完成或明确移除原请求，再构思新剧。原草稿保留。",
      );
      showInput();
      return;
    }
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
  async function openBrowser(url?: string) {
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
      if (url) {
        const instance = client.boot?.workspace.applicationInstances.find(
          (i) => i.id === result.entityId,
        );
        if (instance)
          await client.execute({
            type: "set-application-state",
            instanceId: instance.id,
            expectedRevision: instance.revision,
            state: { ...instance.state, url },
          });
      }
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
      const origin = document.activeElement;
      const restore = previousFocus.current;
      const generation = navigationGeneration.current;
      requestAnimationFrame(() => {
        // A newer keyboard focus or reopen must win over this delayed hide.
        // Otherwise Enter can land in the guest instead of the reopen button.
        if (generation !== navigationGeneration.current || input.current)
          return;
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          active !== origin &&
          active.isConnected
        )
          return;
        if (restore?.isConnected) restore.focus();
        else toggle.current?.focus();
      });
    }
  }
  function closeSpeech() {
    dictationControls.current?.interrupt();
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
          if (inputVisible && !dialogueCanvas) hideInput();
          else showInput();
        }
      } else if (e.key === "Escape") {
        if (creating) return;
        if (inspectorOpen && !input.current?.contains(document.activeElement)) {
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
    mobileCollaboration,
    executions,
    understandingOpen,
    collaborationVisible,
    speech,
  ]);
  useDesktopAppearance(prefs.appearance);
  useLayoutEffect(() => {
    document.documentElement.dataset.appMotion = prefs.motion;
    window.dispatchEvent(new Event("morphz:motion-preference-changed"));
    return () => {
      delete document.documentElement.dataset.appMotion;
    };
  }, [prefs.motion]);
  async function send(asAnnotation = draft.annotation === true) {
    if (
      !project ||
      selectedConversation?.archivedAt ||
      (!draft.body.trim() &&
        !draft.attachments?.length &&
        !draft.textQuotes?.length) ||
      sending ||
      sendPending.current ||
      uploadingDrafts[contextKey]
    )
      return;
    dictationControls.current?.interrupt();
    const key = contextKey,
      captured = { ...draft };
    const firstConversation = captured.continuation ? undefined : selectedDraft;
    if (captured.continuation) asAnnotation = false;
    sendPending.current = true;
    setSending(true);
    setInputErrors((old) => ({ ...old, [key]: "" }));
    try {
      if (
        !asAnnotation &&
        !captured.continuation &&
        !captured.taskResult &&
        !captured.scriptGeneration &&
        !captured.reading &&
        !captured.selection &&
        !captured.textQuotes?.length &&
        !captured.skipReading &&
        readingExpected
      ) {
        const focus = currentReading?.capture();
        if (!focus)
          throw new Error(
            "当前阅读内容仍在加载或无法读取，请稍后发送；草稿已保留。",
          );
        captured.reading = structuredClone(focus.reference);
        captured.revision = currentReading!.revision;
        captured.selection = focus.selected ? focus.reference.quote : "";
      }
      if (
        !captured.continuation &&
        canAuthorizeDirectories &&
        (directoryState.scope !== directoryScope || !directoryState.ready)
      )
        throw new Error("目录授权尚未确认，请稍后发送；草稿已保留。");
      if (
        asAnnotation &&
        (!artifact || !captured.selection || !captured.revision)
      )
        throw new Error("选区已失效，请重新选择文字。");
      if (
        !captured.continuation &&
        (asAnnotation || captured.taskResult) &&
        captured.attachments?.length
      )
        throw new Error(
          "批注与事项结果暂不支持附件，请移除附件或改为发送消息；草稿已保留。",
        );
      if (captured.continuation) {
        const original = state!.inputs.find(
          (i) => i.id === captured.continuation!.inputId,
        );
        if (!original) throw new Error("原请求已不可用，草稿已保留。");
        if (
          !client.boot?.capabilities.directedInput ||
          !client.boot.runtime.configured
        )
          throw new Error("当前连接不支持定向补充，草稿已保留。");
        const command = captured.pendingSupplement ?? {
          commandId: crypto.randomUUID(),
          operation: {
            type: "record-input" as const,
            continuation: captured.continuation,
            projectId: original.projectId,
            conversationId: discussionId(original),
            artifactId: original.artifactId,
            artifactRevision: original.artifactRevision,
            selection: "",
            body: captured.body,
            ...(captured.textQuotes?.length
              ? { textQuotes: captured.textQuotes }
              : {}),
            targetActantId: original.targetActantId,
            ...(captured.attachments?.length
              ? { attachments: captured.attachments }
              : {}),
          },
        };
        // Persist the immutable retry payload before IPC/HTTP can lose a receipt.
        updateDraft(key, (old) => ({
          ...old,
          pendingSupplement: command,
          continuationFailure: undefined,
        }));
        const receipt = await client.execute(
          command.operation,
          true,
          undefined,
          command.commandId,
        );
        setRevealedInputs((old) => ({
          ...old,
          [conversationId]: receipt.entityId,
        }));
      } else if (captured.taskResult && !asAnnotation) {
        if (captured.taskResult.taskId !== artifact?.id)
          throw new Error("请回到这件事项后提交结果，草稿已保留。");
        await client.execute({
          type: "respond-task",
          taskId: captured.taskResult.taskId,
          expectedRevision: captured.taskResult.revision,
          body: quotedInputText(captured.body, captured.textQuotes),
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
          body: quotedInputText(captured.body, captured.textQuotes),
        });
      else {
        if (
          firstConversation &&
          !client.boot?.capabilities.conversationOnFirstInput
        )
          throw new Error(
            "当前版本不支持新建会话，请更新应用；草稿已保留，现有会话仍可使用。",
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
            ...(captured.reading ? { reading: captured.reading } : {}),
            body: captured.body,
            ...(captured.textQuotes?.length
              ? { textQuotes: captured.textQuotes }
              : {}),
            ...(captured.scriptGeneration
              ? { scriptGeneration: captured.scriptGeneration }
              : {}),
            ...(canAuthorizeDirectories && directoryState.grants.length
              ? { directories: directoryState.grants }
              : {}),
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
      // The acknowledged input consumed this conversation's references.
      updateDraft(key, () => ({ ...emptyDraft, textQuotes: [] }));
      if (currentContext.current === key) {
        if (asAnnotation) {
          if (compact) setMobileCollaboration(true);
          else prefer({ collaboration: true });
          if (latestInteraction.current !== "hidden")
            sentInputFocus.current = {
              key,
              generation: navigationGeneration.current,
            };
        } else if (captured.continuation || !captured.taskResult) {
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
      if (captured.continuation) {
        const reason =
          e instanceof RequestError && e.code === "work_closed"
            ? "closed"
            : e instanceof RequestError && e.status < 500 && e.status !== 408
              ? "changed"
              : "unknown";
        updateDraft(key, (old) => ({
          ...old,
          continuationFailure: reason,
          ...(reason !== "unknown" ? { pendingSupplement: undefined } : {}),
        }));
      }
      setInputErrors((old) => ({
        ...old,
        [key]: e instanceof Error ? e.message : "保存失败，草稿已保留。",
      }));
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }
  function supplement(target: InputContinuation) {
    if (sending || draft.pendingSupplement) {
      setNotice("请先核对当前补充的送达结果，再切换目标。");
      return;
    }
    const original = state?.inputs.find((i) => i.id === target.inputId);
    if (
      !original ||
      original.author.principalId !== client.boot?.principalId ||
      original.author.actantId !== client.boot.actantId
    )
      return;
    dictationControls.current?.interrupt();
    const branch = client.boot!.runtime.activity?.threads.find(
      (t) => t.id === target.threadId,
    );
    const label =
      branch?.kind === "execution" && branch.title !== original.body
        ? `${original.body.slice(0, 60)} · ${branch.title}`
        : original.body;
    setDraft(contextKey, {
      ...draft,
      continuation: target,
      continuationLabel: label,
      continuationFailure: undefined,
    });
    setInputErrors((old) => ({ ...old, [contextKey]: "" }));
    if (rightInspector.mode === "overlay") closeInspector();
    showInput();
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
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
        <p>
          {client.error
            ? "暂时无法打开工作空间，请重试。"
            : "正在打开工作空间…"}
        </p>
        {client.error && (
          <>
            <button onClick={() => void client.refresh()}>
              <RefreshCw />
              重新连接
            </button>
          </>
        )}
      </div>
    );
  const tasks = inboxFor(state, client.boot!.principalId);
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
  const openUnderstanding = () => {
    setExecutions(null);
    setMobileCollaboration(false);
    prefer({ collaboration: false, executionPinned: false });
    setUnderstandingOpen(true);
  };
  const openCollaboration = () => {
    setExecutions(null);
    setUnderstandingOpen(false);
    setMobileCollaboration(true);
    prefer({ collaboration: true, executionPinned: false });
  };
  const rememberedInspector = inspectorSelections.current.get(contextKey);
  const showInspector = () => {
    if (
      rememberedInspector?.view === "execution" &&
      state.projects.some(
        (p) => p.id === rememberedInspector.scope.projectId,
      ) &&
      (!rememberedInspector.scope.inputId ||
        state.inputs.some((i) => i.id === rememberedInspector.scope.inputId))
    ) {
      keepExchangeOpen();
      setUnderstandingOpen(false);
      setMobileCollaboration(false);
      prefer({ collaboration: false });
      setExecutions(rememberedInspector.scope);
    } else if (rememberedInspector?.view === "understanding" || !artifact) {
      openUnderstanding();
    } else {
      openCollaboration();
    }
  };
  const inspectorViewOptions: ComposerOption[] = [
    {
      label: "执行记录",
      icon: <ListChecks />,
      onSelect: openExecutions,
      pressed: !!executions,
    },
    {
      label: "当前理解",
      icon: <Brain />,
      onSelect: openUnderstanding,
      pressed: understandingOpen,
    },
    ...(artifact
      ? [
          {
            label: "对象批注",
            icon: <MessageSquareText />,
            onSelect: openCollaboration,
            pressed: collaborationVisible,
          },
        ]
      : []),
  ];
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
  const activeExecutionCount = new Set([
    ...(client.online ? activeExecutionThreads(client.boot!.runtime) : []).map(
      (t) => t.inputId ?? t.rootId,
    ),
    ...(client.online && client.boot!.runtime.connected
      ? client
          .boot!.runtime.deliveries.filter(
            (d) =>
              state.inputs.some((input) => input.id === d.inputId) &&
              ["queued", "sending", "running"].includes(d.state),
          )
          .map((d) => d.inputId)
      : []),
  ]).size;
  const approvalCount = client.boot!.runtime.attention?.approvals.length ?? 0;
  const attentionAvailable =
    client.online &&
    client.boot!.runtime.connected &&
    client.boot!.runtime.attention?.available;
  const inspectorTitle = executions
    ? "执行记录"
    : understandingOpen
      ? "当前理解"
      : collaborationVisible
        ? "对象批注"
        : rememberedInspector?.view === "execution"
          ? "执行记录"
          : rememberedInspector?.view === "understanding" || !artifact
            ? "当前理解"
            : "对象批注";
  const inspectorControls = (
    <div className="workspace-inspector-controls">
      {(approvalCount > 0 || activeExecutionCount > 0) && (
        <button
          className="execution-status-control"
          aria-label="执行记录与审批"
          aria-controls="workspace-inspector"
          aria-describedby="workspace-execution-status"
          data-attention={approvalCount > 0 || undefined}
          title="查看执行记录与审批"
          onClick={openExecutions}
        >
          {approvalCount > 0 ? (
            <span
              id="workspace-execution-status"
              aria-label={
                attentionAvailable
                  ? `${approvalCount} 项待审批`
                  : "审批状态待确认"
              }
            >
              {attentionAvailable ? `${approvalCount} 待审批` : "待确认"}
            </span>
          ) : (
            <span
              id="workspace-execution-status"
              aria-label={`${activeExecutionCount} 项进行中`}
            >
              {activeExecutionCount} 进行中
            </span>
          )}
        </button>
      )}
      <SidebarToggle
        className="inspector-toggle"
        side="right"
        expanded={inspectorOpen}
        controls="workspace-inspector"
        title={`${inspectorOpen ? "隐藏" : "显示"}右侧栏 · ${inspectorTitle}`}
        onClick={inspectorOpen ? closeInspector : showInspector}
      />
    </div>
  );
  const connectionLabel = !client.online
    ? "应用连接中断"
    : client.boot!.runtime.connected
      ? "智能体已连接"
      : client.boot!.runtime.configured
        ? "智能体连接异常"
        : "智能体未连接";
  const identityLabel = actorName(state, client.boot!.actantId);
  const connected = client.online && client.boot!.runtime.connected;
  const profileMenu = {
    name: identityLabel,
    status: connectionLabel,
    connected,
    onSettings: () =>
      setSettingsSection(
        client.boot!.capabilities.modelSettings ? "models" : "appearance",
      ),
    onLogout: client.boot!.capabilities.teamAuthentication
      ? () => void client.logout().catch((e) => setNotice(e.message))
      : undefined,
  };
  return createElement(
    TextQuoteProvider,
    {
      quotes: draft.textQuotes,
      scope: conversationId,
      reveal: quoteReveal,
      disabled:
        sending ||
        !!draft.pendingSupplement ||
        !!selectedConversation?.archivedAt,
      onChange: (textQuotes) =>
        updateDraft(contextKey, (old) => ({ ...old, textQuotes })),
      onEngage: keepExchangeOpen,
      onFocusComposer: () => {
        showInput();
        requestAnimationFrame(() =>
          input.current?.focus({ preventScroll: true }),
        );
      },
      onOpen: (quote) => void openTextQuote(quote),
      onNotice: setNotice,
    },
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
      data-text-size={prefs.textSize}
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
            <AppearanceMenu
              prefs={prefs}
              onPreference={prefer}
              onSettings={() => setSettingsSection("appearance")}
            />
            <Notifications
              client={client}
              onOpen={openUser}
              onSettings={() => setSettingsSection("notifications")}
            />
            <ProfileMenu {...profileMenu} compact />
          </div>
        </div>
        <div className="sidebar-navigation">
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
            {(
              ["dialogue", "inbox", "content", "desk", "projects"] as View[]
            ).map((view) => {
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
            <div className="sidebar-project-list">
              {state.projects
                .filter(
                  (p) =>
                    spaceKind(p) === "project" && projectStatus(p) === "active",
                )
                .sort(
                  (a, b) =>
                    projectActivity(
                      state,
                      b,
                      client.boot!.runtime.messages,
                    ).localeCompare(
                      projectActivity(state, a, client.boot!.runtime.messages),
                    ) || a.title.localeCompare(b.title, "zh-CN"),
                )
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
                    onManage={manageProject}
                    onDiscardDraft={discardConversationDraft}
                    discardedDrafts={Object.values(discardedDrafts)
                      .filter((d) => d.conversation.projectId === p.id)
                      .map((d) => d.conversation)}
                    onRestoreDraft={restoreConversationDraft}
                  />
                ))}
              {state.projects.some((p) => p.deletedAt || p.archivedAt) && (
                <button
                  className="project-archive-directory"
                  onClick={() => {
                    writeLocal("project-directory", {
                      query: "",
                      sort: "recent",
                      status: state.projects.some(
                        (p) => p.archivedAt && !p.deletedAt,
                      )
                        ? "archived"
                        : "deleted",
                    });
                    setProjectDirectoryVersion((v) => v + 1);
                    navigate("projects");
                  }}
                >
                  已归档 / 已删除
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="sidebar-bottom">
          {!window.morphzDesktop && (
            <ProductBridge
              productHomeUrl={import.meta.env.VITE_MORPHZ_PRODUCT_HUB_URL}
              officialUrl={import.meta.env.VITE_MORPHZ_OFFICIAL_PERSONA_URL}
            />
          )}
          <ProfileMenu {...profileMenu} />
        </div>
      </aside>
      <div
        className="workspace"
        ref={inspectorWorkspace}
        data-inspector-mode={inspectorOpen ? rightInspector.mode : undefined}
        data-inspector-width={inspectorOpen ? rightInspector.width : undefined}
        style={
          {
            "--inspector-width": `${rightInspector.width}px`,
          } as CSSProperties
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
                    <ProjectMenu project={project} onAction={manageProject} />
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
          ></div>
          <div
            className="detail-toolbar-slot"
            ref={setDetailToolbarTarget}
            hidden={openingObject || (!artifact && creating !== "document")}
          />
          <div className="top-actions">
            {!(prefs.view === "content" && !artifact) && (
              <div ref={spaceOptions} className="workspace-options">
                <ComposerOptions
                  key={`${project.id}:${prefs.view}:${activeId}`}
                  label="工作空间选项"
                  menuLabel="工作空间操作"
                  below
                  options={[
                    {
                      label: "执行记录",
                      icon: <ListChecks />,
                      onSelect: openExecutions,
                    },
                    {
                      label: "当前理解",
                      icon: <Brain />,
                      onSelect: openUnderstanding,
                    },
                    {
                      label: "录音转文字",
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
                                  revision: draft.revision ?? artifact.revision,
                                }
                              : {}),
                          },
                        }),
                      disabled: !client.online,
                    },
                  ]}
                />
              </div>
            )}
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
          </div>
        </header>
        {inspectorControls}
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
              {...quoteSource({
                kind: "surface",
                projectId: project.id,
                title: activeInstance
                  ? applicationFor(
                      state,
                      activeInstance.applicationId,
                      activeInstance.applicationVersion,
                    ).title
                  : labels[prefs.view],
                ...(activeInstance
                  ? { applicationInstanceId: activeInstance.id }
                  : {}),
              })}
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
                  onNativeDialog={setNativeExportDialog}
                  onInput={showInput}
                  onBrowserPage={setBrowserPage}
                  toolbarTarget={toolbarTarget}
                  projectControls={
                    spaceKind(project) === "project" ? (
                      <ProjectMenu project={project} onAction={manageProject} />
                    ) : undefined
                  }
                  client={client}
                  foreground={!historyVisible && creating !== "document"}
                  workspaceId={project.id}
                  activeId={activeId}
                  scriptLocation={
                    deliveredScript
                      ? (prefs.scriptLocation ?? undefined)
                      : undefined
                  }
                  globalLibrary={prefs.view !== "projects"}
                  onOpenScript={(id) =>
                    void openScriptLocation({ productionId: id })
                  }
                  onContentVisit={recordContentVisit}
                  onScriptLibrary={() => void openScriptLibrary()}
                  onScriptNavigate={(productionId, itemId, view) => {
                    if (prefs.scriptLocation)
                      prefer({
                        scriptLocation: {
                          productionId,
                          ...(itemId ? { itemId } : {}),
                          view,
                          requestId: crypto.randomUUID(),
                        },
                      });
                  }}
                  recentContentVisits={recentContentVisits}
                  enabled={applicationWorkspaceOpen}
                  navigationId={navigationGeneration.current}
                  onActivate={activateApplication}
                  onOpen={open}
                  readingTarget={prefs.readingTarget}
                  readingRevision={prefs.artifactRevision}
                  onReadingOpen={openReading}
                  onReadingCompose={composeReading}
                  onReadingContext={readingContextChanged}
                  onReadingLibrary={() => void readingLibrary()}
                  onReadingJump={(target) =>
                    void openUser(
                      target.artifactId,
                      target.revision,
                      undefined,
                      target.location,
                    )
                  }
                  onReadingTargetConsumed={readingTargetConsumed}
                  onOpenContents={openWorkspaceContents}
                  onNotice={setNotice}
                  onComposeIntent={composeIntent}
                  onCompose={(text, artifactId, scriptGeneration) => {
                    if (scriptGeneration) {
                      const production = state.scriptProductions.find(
                        (p) =>
                          p.id === scriptGeneration.productionId &&
                          p.projectId === project.id,
                      );
                      const target = production?.items.find(
                        (i) => i.id === scriptGeneration.targetId,
                      );
                      if (
                        !production ||
                        !target ||
                        target.revision !== scriptGeneration.baseRevision ||
                        production.revision !== scriptGeneration.contextRevision
                      ) {
                        return {
                          ok: false,
                          error:
                            "剧本引用已有变化，请关闭后重新准备请求；原草稿保留。",
                        };
                      }
                      if (
                        sending ||
                        draft.pendingSupplement ||
                        draft.continuation ||
                        draft.annotation ||
                        draft.taskResult ||
                        draft.body.trim() ||
                        draft.attachments?.length ||
                        draft.textQuotes?.length ||
                        (draft.intent && draft.intent !== "script") ||
                        draft.scriptGeneration
                      ) {
                        return {
                          ok: false,
                          error:
                            "输入框中已有未发送的内容或请求。请先处理原输入，再准备本次请求；这里填写的要求已保留。",
                        };
                      }
                      setDraft(contextKey, {
                        ...draft,
                        intent: undefined,
                        revision: null,
                        selection: "",
                        scriptGeneration: structuredClone(scriptGeneration),
                        body: text,
                      });
                    } else if (artifactId) {
                      const target = state.artifacts.find(
                        (a) =>
                          a.id === artifactId && a.projectId === project.id,
                      );
                      if (!target)
                        return { ok: false, error: "引用的内容已不可用。" };
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
                    return { ok: true };
                  }}
                >
                  {artifact &&
                  (prefs.readerMode ||
                    artifact.content.kind === "publication") ? (
                    <Reader
                      client={client}
                      projectId={project.id}
                      artifactId={artifact.id}
                      revision={prefs.artifactRevision}
                      target={prefs.readingTarget}
                      active={true}
                      onOpen={openReading}
                      onLibrary={() => void readingLibrary()}
                      onJump={(target) =>
                        void openUser(
                          target.artifactId,
                          target.revision,
                          undefined,
                          target.location,
                        )
                      }
                      onTargetConsumed={readingTargetConsumed}
                      onCompose={composeReading}
                      onContext={readingContextChanged}
                      onNotice={setNotice}
                      onNativeDialog={setNativeExportDialog}
                    />
                  ) : artifact ? (
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
                    <TaskList
                      state={state}
                      client={client}
                      options={taskListOptions(prefs.taskList)}
                      onOptions={(taskList) => prefer({ taskList })}
                      onOpen={openUser}
                      onCreate={() => composeIntent("task")}
                      toolbarTarget={pageToolbarTarget}
                    />
                  ) : prefs.view === "projects" && !prefs.projectOpen ? (
                    <ProjectDirectory
                      key={projectDirectoryVersion}
                      toolbarTarget={pageToolbarTarget}
                      state={state}
                      onOpen={openProject}
                      onCreate={() => setCreating("project")}
                      onManage={manageProject}
                      messages={client.boot!.runtime.messages}
                    />
                  ) : projectStatus(project) !== "active" ? (
                    <section className="retired-project">
                      <h2>{project.deletedAt ? "已删除项目" : "已归档项目"}</h2>
                      <p>会话、内容和事项仍保留。恢复项目后可以继续工作。</p>
                      <button
                        className="secondary-action"
                        onClick={() => manageProject(project, "restore")}
                      >
                        恢复项目
                      </button>
                      {state.conversations
                        .filter(
                          (c) =>
                            c.projectId === project.id &&
                            c.id !== project.id &&
                            startedConversations.has(c.id),
                        )
                        .map((c) => (
                          <button
                            key={c.id}
                            onClick={() => selectConversation(project.id, c.id)}
                          >
                            {c.title}
                          </button>
                        ))}
                    </section>
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
                      state={state}
                      client={client}
                      catalog={prefs.view === "content"}
                      catalogScope={contentScope}
                      onScopeChange={selectContentScope}
                      toolbarTarget={
                        prefs.view === "content" ? pageToolbarTarget : null
                      }
                      onOpen={openUser}
                      onCompose={composeContent}
                      onCreate={composeIntent}
                      onWrite={() => setCreating("document")}
                    />
                  )}
                </ApplicationHost>
              </div>
            </main>
            <div className="exchange-surface" ref={exchange}>
              <ExchangePanel
                open={inputVisible || conversationVisible}
                scopeRef={setConversationToolbarTarget}
                resize={
                  !dialogueCanvas &&
                  inputVisible &&
                  projectStatus(project) === "active" &&
                  !selectedConversation?.archivedAt
                    ? {
                        scope: exchangeKey,
                        mode: interaction,
                        height: prefs.exchangeHeights?.[exchangeKey],
                        onStart: keepExchangeOpen,
                        onPreview: (mode) =>
                          setExchangeResizePreview((previous) =>
                            mode
                              ? { scope: exchangeKey, mode }
                              : previous?.scope === exchangeKey
                                ? null
                                : previous,
                          ),
                        onCommit: ({ mode, height }) => {
                          keepExchangeOpen();
                          setExchangeResizePreview(null);
                          prefer({
                            interactions: { [exchangeKey]: mode },
                            ...(mode === "recent"
                              ? { exchangeHeights: { [exchangeKey]: height } }
                              : {}),
                          });
                        },
                      }
                    : undefined
                }
              >
                {conversationVisible && (
                  <Conversation
                    onOpenQuote={(quote) => void openTextQuote(quote)}
                    quoteReveal={
                      quoteReveal?.quote.source.kind === "message" &&
                      quoteReveal.quote.source.conversationId === conversationId
                        ? quoteReveal
                        : null
                    }
                    onQuoteUnavailable={() =>
                      setNotice(
                        "原消息暂时不在已加载的记录中，引用内容仍保留。",
                      )
                    }
                    toolbarTarget={conversationToolbarTarget}
                    onFocusComposer={() =>
                      input.current?.focus({ preventScroll: true })
                    }
                    focusedApplicationId={conversationFocus.applicationId}
                    focusedArtifactId={conversationFocus.artifactId}
                    key={conversationId}
                    inputs={inputs}
                    messages={replies}
                    streamConnected={stream.connected}
                    seenReplies={seenReplies}
                    onRead={readReplies}
                    positions={exchangePositions.current}
                    revealInputId={revealedInputs[conversationId] ?? null}
                    onInspect={inspectExecution}
                    onSupplement={
                      client.boot!.capabilities.directedInput
                        ? supplement
                        : undefined
                    }
                    state={state}
                    runtime={client.boot!.runtime}
                    conversationId={conversationId}
                    client={client}
                    onOpen={openUser}
                    onOpenScript={openScript}
                    onRetry={async (id) => {
                      // Retrying removes this focused button once the outbox
                      // advances. Hand focus to a stable control before that
                      // update, not after a reply that may outlive navigation.
                      input.current?.focus({ preventScroll: true });
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
                  {projectStatus(project) !== "active" ? (
                    <div className="archived-conversation-note">
                      <span>
                        项目{project.deletedAt ? "已删除" : "已归档"}
                        ，原数据与草稿仍保留。
                      </span>
                      <button onClick={() => manageProject(project, "restore")}>
                        恢复项目
                      </button>
                    </div>
                  ) : selectedConversation?.archivedAt ? (
                    <div className="archived-conversation-note">
                      <span>对话已归档，历史和后台工作仍保留。</span>
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
                      {!!draft.textQuotes?.length && (
                        <TextQuoteDrafts
                          quotes={draft.textQuotes}
                          disabled={sending || !!draft.pendingSupplement}
                        />
                      )}
                      {draft.continuation && (
                        <div
                          className="composer-continuation"
                          role="group"
                          aria-label="补充目标"
                        >
                          <span
                            title={
                              draft.continuationLabel ||
                              state.inputs.find(
                                (i) => i.id === draft.continuation!.inputId,
                              )?.body
                            }
                          >
                            {draft.continuation.mode === "follow-up"
                              ? "接着处理："
                              : "补充给："}
                            {draft.continuationLabel ||
                              state.inputs.find(
                                (i) => i.id === draft.continuation!.inputId,
                              )?.body ||
                              "原工作已不可用"}
                          </span>
                          <button
                            className="icon-button"
                            aria-label="取消补充，改为普通输入"
                            disabled={sending || !!draft.pendingSupplement}
                            onClick={() => {
                              setDraft(contextKey, {
                                ...draft,
                                continuation: undefined,
                                continuationFailure: undefined,
                              });
                              setInputErrors((old) => ({
                                ...old,
                                [contextKey]: "",
                              }));
                              input.current?.focus();
                            }}
                          >
                            <X />
                          </button>
                        </div>
                      )}
                      {draft.selection && !draft.continuation && (
                        <div className="selection-quote">
                          {draft.reading && (
                            <small>
                              {draft.reading.book.title} ·{" "}
                              {draft.reading.chapter}
                            </small>
                          )}
                          <blockquote>{draft.selection}</blockquote>
                          <button
                            aria-label="移除引用"
                            onClick={() =>
                              setDraft(contextKey, {
                                ...draft,
                                selection: "",
                                reading: undefined,
                                skipReading: true,
                                annotation: false,
                              })
                            }
                          >
                            <X />
                          </button>
                        </div>
                      )}
                      {!draft.selection &&
                        !draft.reading &&
                        !draft.continuation &&
                        !draft.taskResult &&
                        !draft.scriptGeneration &&
                        readingExpected &&
                        (draft.skipReading ? (
                          <button
                            type="button"
                            className="reading-context-restore"
                            onClick={() => {
                              input.current?.focus({ preventScroll: true });
                              setDraft(contextKey, {
                                ...draft,
                                skipReading: false,
                              });
                            }}
                          >
                            附带当前阅读位置
                          </button>
                        ) : (
                          <ReadingContext
                            focus={currentReading?.focus ?? null}
                            onRemove={() => {
                              input.current?.focus({ preventScroll: true });
                              setDraft(contextKey, {
                                ...draft,
                                skipReading: true,
                              });
                            }}
                          />
                        ))}
                      {draft.annotation && !draft.continuation && (
                        <div className="annotation-mode">
                          <span>保存为批注</span>
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
                            draft.continuation
                              ? "补充这项工作的要求…"
                              : draft.annotation
                                ? "写下批注…"
                                : draft.taskResult
                                  ? "写下结果；提交后将以你的身份完成这件事项…"
                                  : draft.intent
                                    ? inputIntents[draft.intent].placeholder
                                    : "提出想法，或让工作继续…"
                          }
                          rows={2}
                          maxLength={30000}
                          value={draft.body}
                          disabled={sending || !!draft.pendingSupplement}
                          onFocus={() => {
                            if (!conversationVisible) setInteraction("recent");
                          }}
                          onChange={(e) => {
                            setDraft(contextKey, {
                              ...draft,
                              body: e.target.value,
                              revision: artifact
                                ? (draft.revision ?? artifact.revision)
                                : null,
                            });
                          }}
                          onKeyDown={(event) => {
                            if (
                              shouldSubmitInput(
                                event.nativeEvent,
                                prefs.sendShortcut,
                              )
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
                      {draft.continuationFailure === "closed" &&
                        draft.continuation && (
                          <div className="continuation-follow-up">
                            {!inputErrors[contextKey] && (
                              <small>原工作已结束，补充未送达。 </small>
                            )}
                            <button
                              className="text-button"
                              onClick={() => {
                                setDraft(contextKey, {
                                  ...draft,
                                  continuation: {
                                    ...draft.continuation!,
                                    mode: "follow-up",
                                  },
                                  continuationFailure: undefined,
                                  pendingSupplement: undefined,
                                });
                                setInputErrors((old) => ({
                                  ...old,
                                  [contextKey]: "",
                                }));
                                input.current?.focus();
                              }}
                            >
                              作为后续请求继续
                            </button>
                          </div>
                        )}
                      {draft.pendingSupplement && !sending && (
                        <small className="continuation-pending" role="status">
                          正在核对原投递；确认前保留这份草稿，请勿另发一遍。
                        </small>
                      )}
                      <div className="composer-actions">
                        <div className="composer-footer-info">
                          {(!client.online ||
                            (draft.taskResult && !draft.continuation) ||
                            (!draft.annotation &&
                              !client.boot!.runtime.connected)) && (
                            <small className="model-status">
                              {!client.online
                                ? "应用连接中断"
                                : draft.taskResult && !draft.continuation
                                  ? `${actorName(state, client.boot!.actantId)} · 提交事项结果`
                                  : client.boot!.runtime.configured
                                    ? client.boot!.runtime.error
                                      ? "智能体连接异常 · 消息已保留"
                                      : "正在连接智能体"
                                    : "尚未连接智能体 · 输入只会保存"}
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
                          <div className="composer-meta">
                            {draft.scriptGeneration && (
                              <span
                                className="composer-intent"
                                data-testid="script-input-reference"
                              >
                                剧本请求 ·{" "}
                                {state.scriptProductions
                                  .find(
                                    (p) =>
                                      p.id ===
                                      draft.scriptGeneration!.productionId,
                                  )
                                  ?.items.find(
                                    (i) =>
                                      i.id === draft.scriptGeneration!.targetId,
                                  )
                                  ?.versions.find(
                                    (v) =>
                                      v.revision ===
                                      draft.scriptGeneration!.baseRevision,
                                  )?.draft.title ??
                                  draft.scriptGeneration.targetId}{" "}
                                · v{draft.scriptGeneration.baseRevision}
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label="移除剧本请求引用"
                                  disabled={sending}
                                  onClick={() => {
                                    const { scriptGeneration: _, ...rest } =
                                      draft;
                                    setDraft(contextKey, rest);
                                  }}
                                >
                                  <X />
                                </button>
                              </span>
                            )}
                            {!draft.continuation && (
                              <span
                                className="context-chip"
                                title={
                                  contextTitle +
                                  (draft.revision
                                    ? " · v" + draft.revision
                                    : "")
                                }
                              >
                                <Link2 />
                                {contextTitle}
                                {draft.revision ? " · v" + draft.revision : ""}
                              </span>
                            )}
                            {!draft.continuation &&
                              (draft.taskResult || draft.intent) && (
                                <div
                                  className={
                                    "composer-intent" +
                                    (draft.taskResult
                                      ? " task-result-intent"
                                      : "")
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
                        <div className="composer-floating-tools">
                          <div
                            className="composer-media-tools"
                            role="group"
                            aria-label="输入工具"
                          >
                            {((!draft.annotation && !draft.taskResult) ||
                              !!draft.continuation ||
                              !!draft.attachments?.length) && (
                              <MessageAttachments
                                key={`attachments:${contextKey}`}
                                inputRef={input}
                                previewTarget={attachmentSlot}
                                client={client}
                                attachments={draft.attachments ?? []}
                                allowAdd={
                                  !!draft.continuation ||
                                  (!draft.annotation && !draft.taskResult)
                                }
                                disabled={
                                  sending ||
                                  !!draft.pendingSupplement ||
                                  !!uploadingDrafts[contextKey]
                                }
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
                            {canAuthorizeDirectories && (
                              <AgentDirectories
                                key={`${client.boot!.csrfToken}:${directoryScope}`}
                                projectId={project.id}
                                conversationId={conversationId}
                                identity={client.boot!.csrfToken}
                                previewTarget={
                                  draft.continuation ? null : attachmentSlot
                                }
                                disabled={
                                  sending ||
                                  !client.online ||
                                  !!draft.continuation
                                }
                                onSelecting={(selecting) =>
                                  setDirectoryPickerScope((current) =>
                                    selecting
                                      ? directoryScope
                                      : current === directoryScope
                                        ? null
                                        : current,
                                  )
                                }
                                onState={setDirectoryState}
                                onError={(message) =>
                                  setInputErrors((old) => ({
                                    ...old,
                                    [contextKey]: message,
                                  }))
                                }
                              />
                            )}
                            {((!draft.annotation && !draft.taskResult) ||
                              !!draft.continuation) && (
                              <button
                                className="icon-button"
                                aria-label="截图输入"
                                title={`截图输入（按住 ${/Mac/.test(navigator.platform) ? "Option" : "Alt"} 点击隐藏 Morphz）`}
                                disabled={
                                  sending ||
                                  !!draft.pendingSupplement ||
                                  !!uploadingDrafts[contextKey] ||
                                  !client.online ||
                                  (draft.attachments?.length ?? 0) >= 8
                                }
                                onClick={(event) =>
                                  setCapture({
                                    key: contextKey,
                                    projectId: project.id,
                                    hideWindow: event.altKey,
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
                              aria-pressed={speechRecording}
                              data-recording={speechRecording || undefined}
                              title={speechRecording ? "停止听写" : "开始听写"}
                              disabled={
                                (sending ||
                                  !!draft.pendingSupplement ||
                                  !client.online) &&
                                !speechRecording
                              }
                              onClick={() => {
                                if (speech?.key === contextKey && !speech.modal)
                                  dictationControls.current?.toggle();
                                else
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
                                  });
                              }}
                            >
                              {speechRecording ? <Square /> : <Mic />}
                            </button>
                            <ComposerToolButtons
                              key={`options:${contextKey}`}
                              options={[
                                ...(artifact
                                  ? [
                                      {
                                        label: "保存为批注",
                                        reserveOnly: !draft.selection,
                                        icon: <MessageSquarePlus />,
                                        disabled:
                                          !!draft.continuation ||
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
                          </div>
                          {!dialogueCanvas && (
                            <div
                              className="exchange-view-tools"
                              role="group"
                              aria-label="交流面板操作"
                            >
                              <ExchangeControls
                                conversationVisible={conversationVisible}
                                historyVisible={historyVisible}
                                pinned={inputPinned}
                                unread={!conversationVisible && unseenReply}
                                onInteraction={setInteraction}
                                onPin={() => {
                                  keepExchangeOpen();
                                  if (inputPinned) input.current?.focus();
                                  prefer({
                                    pinnedInputs: {
                                      [exchangeKey]: !inputPinned,
                                    },
                                  });
                                }}
                                onHide={hideInput}
                              />
                            </div>
                          )}
                        </div>
                        {draft.continuation ? (
                          <small className="composer-preferences continuation-model">
                            沿用原工作设置
                          </small>
                        ) : (
                          !draft.annotation &&
                          !draft.taskResult && (
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
                          )
                        )}
                        <div className="inline composer-input-tools">
                          <button
                            className="send"
                            aria-label={
                              draft.continuation
                                ? draft.pendingSupplement
                                  ? "核对补充送达"
                                  : draft.continuation.mode === "follow-up"
                                    ? "发送后续请求"
                                    : "发送补充"
                                : draft.annotation
                                  ? "保存批注"
                                  : draft.taskResult
                                    ? "提交结果并完成事项"
                                    : client.boot!.runtime.configured
                                      ? "发送消息"
                                      : "保存输入"
                            }
                            disabled={
                              (!draft.body.trim() &&
                                !draft.attachments?.length &&
                                !draft.textQuotes?.length) ||
                              sending ||
                              !!uploadingDrafts[contextKey] ||
                              (!draft.continuation &&
                                canAuthorizeDirectories &&
                                (directoryState.scope !== directoryScope ||
                                  !directoryState.ready)) ||
                              !client.online
                            }
                            onClick={() => void send()}
                          >
                            {draft.annotation && !draft.continuation ? (
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
              </ExchangePanel>
            </div>
          </div>
        </div>
        {executions && (
          <ExecutionSidebar
            key={executions.threadId ?? executions.inputId ?? "overview"}
            client={client}
            scope={executions}
            viewOptions={inspectorViewOptions}
            pinned={!!prefs.executionPinned}
            layout={rightInspector}
            onResize={resizeInspector}
            onPin={() => prefer({ executionPinned: !prefs.executionPinned })}
            onClose={closeInspector}
            onSelect={setExecutions}
            onSupplement={
              client.boot!.capabilities.directedInput ? supplement : undefined
            }
            onOpen={openUser}
            onOpenScript={openScript}
          />
        )}
        {understandingOpen && (
          <UnderstandingPanel
            client={client}
            viewOptions={inspectorViewOptions}
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
            viewOptions={inspectorViewOptions}
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
                  <p>暂无批注</p>
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
            if (kind === "project") openProject(id);
            else void openObject(project.id, id);
          }}
        />
      )}
      {projectAction && (
        <ProjectActionDialog
          key={`${projectAction.project.id}:${projectAction.action}`}
          {...projectAction}
          client={client}
          onClose={() => setProjectAction(null)}
          onSaved={(id, action) => {
            setProjectAction(null);
            if (
              (action === "archive" || action === "delete") &&
              project.id === id
            )
              navigate("projects");
          }}
        />
      )}
      {connectionOpen && (
        <ConnectionDetails
          client={client}
          onClose={() => setConnectionOpen(false)}
        />
      )}
      {settingsSection !== null && (
        <SettingsDialog
          client={client}
          initialSection={settingsSection}
          prefs={prefs}
          onPreference={prefer}
          onClose={() => setSettingsSection(null)}
        />
      )}
      {speech &&
        (speech.modal || dictationSlot) &&
        speech.key === contextKey && (
          <SpeechDialog
            key={`${speech.key}:${speech.modal ? "transcription" : "dictation"}`}
            controls={speech.modal ? undefined : dictationControls}
            onRecording={speech.modal ? undefined : setSpeechRecording}
            inlineTarget={speech.modal ? undefined : dictationSlot!}
            transcriptLimit={30000 - draft.body.length - (draft.body ? 1 : 0)}
            onTranscript={
              speech.modal
                ? undefined
                : (text, previous) =>
                    updateDraft(speech.key, (saved) => ({
                      ...saved,
                      body: replaceDictationTail(saved.body, text, previous),
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
    </div>,
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
  kind: "document" | "project";
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
        kind === "project"
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
      <h2 id="create-title">{kind === "project" ? "新建项目" : "新建文档"}</h2>
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
      {kind === "document" ? (
        <div>
          <label className="field">
            标题
            <input
              autoFocus
              aria-label="新对象标题"
              maxLength={180}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
        </div>
      ) : (
        <div className="dialog-input-row">
          <input
            aria-label="项目名称"
            placeholder="项目名称"
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "创建"}
          </button>
        </div>
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
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      {kind === "document" && (
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "创建"}
          </button>
        </footer>
      )}
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
      className="create-dialog project-dialog"
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
