import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowUp,
  MessageCircle,
  MessageSquareText,
  Plus,
  X,
  Link2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Mic,
  Square,
  SlidersHorizontal,
  ListChecks,
} from "lucide-react";
import {
  spaceKind,
  inConversation,
  applicationFor,
} from "../../../packages/core/src/model.js";
import { actorName, useWorkspace, storageScope } from "./client.js";
import { CreateDialog } from "./features/creation/CreateDialog.js";
import {
  useObjectAnnotations,
  objectAnnotationItems,
  ObjectAnnotationsPanel,
} from "./features/content/ObjectAnnotations.js";
import { ArtifactEditor } from "./ArtifactEditor.js";
import { ComposerActionBar } from "./ComposerActionBar.js";
import { ComposerStatus } from "./ComposerStatus.js";
import { ComposerScope } from "./ComposerScope.js";
import { ComposerExecutionSettings } from "./ComposerExecutionSettings.js";
import { ConnectionDetails } from "./ConnectionDetails.js";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { useProfile } from "./useProfile.js";
import { AppearanceMenu } from "./AppearanceControls.js";
import { inputDispatchMode } from "./interface-preferences.js";
import {
  draftOwner,
  requirePersistentDraftOwner,
} from "./local-preferences.js";
import { inputIntents } from "../../../packages/core/src/input-intent.js";
import { Conversation, type ExchangePosition } from "./Conversation.js";
import { WorkspaceNotice } from "./WorkspaceNotice.js";
import { TextQuoteDrafts, TextQuoteProvider } from "./TextQuotes.js";
import {
  replaceComposerSurface,
  updateComposerDraft,
} from "./composer-drafts.js";
import { quoteSource, revealTextQuote } from "./text-quote-dom.js";
import { ExecutionSidebar } from "./ExecutionSidebar.js";
import { SubjectSidebar } from "./SubjectSidebar.js";
import { SubjectObjectives } from "./SubjectObjectives.js";
import { subjectLogoState } from "./subject-sidebar-model.js";
import { SubjectLogo } from "./SubjectLogo.js";
import { ApplicationDock } from "./ApplicationDock.js";
import { WorkspaceTopbar } from "./shell/WorkspaceTopbar.js";
import {
  cognitiveApplicationTargets,
  projectApplicationPresentation,
  type CognitiveApplicationEntry,
} from "./application-presentation.js";
import { CognitiveApplicationPicker } from "./features/applications/CognitiveApplicationChoices.js";
import { chooseCognitiveApplication } from "./host/cognitive-application-choice.js";
import {
  guardCognitiveAppApplicationCommand,
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
  type CognitiveAppApplicationTarget,
} from "../../../packages/core/src/cognitive-app-application-target.js";
import "./execution.css";
import { ProjectConversations } from "./ProjectConversations.js";
import {
  ProjectMenu,
  ProjectActionDialog,
  type ProjectAction,
} from "./ProjectManagement.js";
import {
  projectDirectoryMetrics,
  projectStatus,
  type Project,
} from "../../../packages/core/src/projects.js";
import { type ComposerOption } from "./ComposerOptions.js";
import { ExchangePanel, ExchangeControls } from "./ExchangePanel.js";
import { BrandMark } from "./BrandMark.js";
import { NavigationIcon } from "./NavigationIcon.js";
import { ProductBridge } from "./ProductBridge.js";
import { ObjectCollection } from "./ObjectCollection.js";
import { ProjectDirectory } from "./WorkspaceViews.js";
import { TaskList } from "./TaskList.js";
import { taskListOptions } from "./task-list.js";
import { ApplicationHost } from "./ApplicationHost.js";
import { CognitiveOriginalView } from "./CognitiveOriginalView.js";
import { useCognitiveOriginal } from "./host/use-cognitive-original.js";
import { createCognitiveDraftWriter } from "./host/cognitive-draft-writer.js";
import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../../../packages/core/src/cognitive-app-object-locator.js";
import { createApplicationComposePreparation } from "./host/application-compose-preparation.js";
import { createBuiltinApplicationAdapters } from "./host/builtin-application-adapters.js";
import { AgentDirectories, type DirectoryState } from "./AgentDirectories.js";
import {
  browserApplication,
  readerApplication,
} from "../../../packages/core/src/applications.js";
import { Reader } from "./Reader.js";
import {
  ReadingContext,
  type ReadingSurface,
  type ReadingContextChange,
} from "./ReadingContext.js";
import { SearchDocuments } from "./LibraryDialogs.js";
import { UnderstandingPanel } from "./UnderstandingPanel.js";
import { SpeechDialog } from "./SpeechDialog.js";
import { CaptureDialog } from "./CaptureDialog.js";
import { MessageAttachments } from "./MessageAttachments.js";
import type { BrowserView } from "./desktop.js";
import { Notifications } from "./Notifications.js";
import { useDesktopAppearance } from "./useDesktopAppearance.js";
import { useInspectorLayout } from "./InspectorPanel.js";
import { SidebarToggle } from "./SidebarToggle.js";
import {
  SidebarResizeHandle,
  useSidebarLayout,
} from "./SidebarResizeHandle.js";
import { sidebarPreference } from "./sidebar-layout.js";
import { useConversationStream } from "./useConversationStream.js";
import {
  deriveWorkSurface,
  readWorkSurfaceDraft,
  workSurfaceConversationId,
  type WorkSurfaceView,
} from "./host/work-surface.js";
import {
  useExchangeController,
  useExchangeControllerFocus,
} from "./host/use-exchange-controller.js";
import {
  createExchangeDraftCommands,
  useExchangeInputDraftState,
  useExchangeConversationDraftState,
  useExchangeDiscardedDraftState,
  type InputDraft,
} from "./host/exchange-drafts.js";
import { createExchangeSubmissionCommands } from "./host/exchange-submission-commands.js";
import {
  createWorkspaceNavigationCommands,
  isNavigationPreferenceChange,
  mergeNavigationPreferences,
  useWorkspaceNavigationCommit,
  type NavigationPlace,
  type PreferenceWriter,
  type NavigationIntent,
} from "./host/use-workspace-navigation.js";
import {
  useWorkspaceNavigationHost,
  useWorkspaceNavigationOrigin,
  NavigationHostLifetime,
  NavigationOriginLifetime,
  type CurrentDestination,
  type NavigationIdentity,
  type Preferences,
  type WorkspaceNavigationHost as NavigationHost,
  type WorkspaceNavigationOrigin as NavigationOrigin,
} from "./host/use-workspace-navigation-host.js";
import {
  createSubjectInspectorCloseCommand,
  createSubjectInspectorCommands,
  subjectCollaborationVisible,
  subjectInspectorOpen,
  subjectInspectorPresentation,
  subjectInspectorView,
  useSubjectActivityState,
  useSubjectCollaborationState,
  useSubjectInspectionState,
  useSubjectInspectorCommit,
  useSubjectInspectorMemory,
} from "./host/use-subject-inspector.js";
import {
  conversationMessages,
  hasUnreadReplies,
  projectConversationReadScope,
  replyReceipts,
} from "./conversation-read.js";
import {
  useExchangeReadAcknowledgement,
  useExchangeReadReceiptCommit,
  useExchangeReadReceiptState,
} from "./host/use-exchange-read-receipts.js";
import {
  createExchangeInputToolCloseCommand,
  createExchangeInputToolCommands,
  useExchangeDictationState,
  useExchangeInputMediaState,
  useExchangeInputToolCommit,
  useExchangeNativeInputState,
} from "./host/use-exchange-input-tools.js";
import {
  createExchangeReferenceCommands,
  useExchangeQuoteRevealState,
  useExchangeQuoteRevealCommit,
} from "./host/exchange-reference-commands.js";
import {
  createPrivateProjectConversationScope,
  projectConversationDraftPresence,
  startedProjectConversationIds,
  useCommittedConversationDraftRetirement,
  usePrivateConversationHistorySelection,
  usePrivateProjectContentScope,
} from "./host/private-project-conversation-scope.js";

type View = WorkSurfaceView;
import {
  scriptOutputLocation,
  type ScriptOutput,
} from "../../../packages/core/src/script-delivery.js";

const emptyDraft: InputDraft = { body: "", selection: "", revision: null };
const labels: Record<View, string> = {
  dialogue: "对话",
  inbox: "事项",
  content: "内容库",
  desk: "工作台",
  projects: "项目",
};
export function App() {
  const client = useWorkspace();
  // Retain identity metadata only. Permission refresh still immediately removes
  // the protected Boot and unmounts the complete private WorkspaceApp tree.
  const currentIdentity = client.boot
    ? {
        centerId: client.boot.centerId,
        principalId: client.boot.principalId,
        csrfToken: client.boot.csrfToken,
      }
    : null;
  const [identity, setIdentity] = useState<NavigationIdentity | null>(
    currentIdentity,
  );
  const nextIdentity = client.authenticationRequired
    ? null
    : (currentIdentity ?? identity);
  if (
    identity?.centerId !== nextIdentity?.centerId ||
    identity?.principalId !== nextIdentity?.principalId ||
    identity?.csrfToken !== nextIdentity?.csrfToken
  )
    setIdentity(nextIdentity);
  if (client.authenticationRequired) {
    return <WorkspaceLogin client={client} />;
  }
  if (client.boot) {
    storageScope(client.boot.centerId, client.boot.principalId);
  }
  if (!nextIdentity) return <WorkspaceConnection client={client} />;
  return (
    <WorkspaceNavigationHost
      key={JSON.stringify(nextIdentity)}
      client={client}
      identity={nextIdentity}
    />
  );
}
function WorkspaceConnection({
  client,
}: {
  client: ReturnType<typeof useWorkspace>;
}) {
  return (
    <main className="connection-screen">
      <BrandMark />
      <h1>Morphz</h1>
      <p>{client.error || "正在打开工作空间…"}</p>
      <button onClick={() => void client.refresh()}>重试</button>
    </main>
  );
}
function WorkspaceNavigationHost({
  client,
  identity,
}: {
  client: ReturnType<typeof useWorkspace>;
  identity: NavigationIdentity;
}) {
  const host = useWorkspaceNavigationHost({
    identity,
    getSnapshot: client.getSnapshot,
  });
  return (
    <>
      <NavigationHostLifetime host={host} />
      {client.boot ? (
        <PrivateNavigationBoundary client={client} host={host} />
      ) : (
        <WorkspaceConnection client={client} />
      )}
    </>
  );
}
function PrivateNavigationBoundary({
  client,
  host,
}: {
  client: ReturnType<typeof useWorkspace>;
  host: NavigationHost;
}) {
  const origin = useWorkspaceNavigationOrigin(host);
  return (
    <>
      <NavigationOriginLifetime origin={origin} />
      <WorkspaceApp client={client} host={host} origin={origin} />
    </>
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
function WorkspaceApp({
  client,
  host,
  origin,
}: {
  client: ReturnType<typeof useWorkspace>;
  host: NavigationHost;
  origin: NavigationOrigin;
}) {
  const profile = useProfile(client);
  const state = client.boot?.workspace;
  const { readLocal, writeLocal } = host.storage;
  const { prefs, recentContentVisits, navigation } = host;
  const { contentScope, setContentScope } = usePrivateProjectContentScope({
    readLocal,
  });
  const leftSidebarPreference = sidebarPreference(
    prefs.sidebarWidth,
    prefs.sidebarCompact,
  );
  const leftSidebar = useSidebarLayout(leftSidebarPreference);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const subjectView = subjectInspectorView(prefs);
  const subjectActivity = useSubjectActivityState();
  const { allActivity } = subjectActivity;
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const inputDictation = useExchangeDictationState();
  const { dictationControls, speechRecording, setSpeechRecording } =
    inputDictation;
  const [privateNotice, setPrivateNotice] = useState(""),
    [connectionOpen, setConnectionOpen] = useState(false),
    [settingsSection, setSettingsSection] = useState<SettingsSection | null>(
      null,
    ),
    [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const inputMedia = useExchangeInputMediaState();
  const { uploadingDrafts, speech, capture } = inputMedia;
  const subjectInspection = useSubjectInspectionState(),
    { executions, setExecutions, understandingOpen, setUnderstandingOpen } =
      subjectInspection,
    [searchOpen, setSearchOpen] = useState(false),
    [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null),
    [detailToolbarTarget, setDetailToolbarTarget] =
      useState<HTMLDivElement | null>(null),
    [pageToolbarTarget, setPageToolbarTarget] = useState<HTMLDivElement | null>(
      null,
    ),
    [creating, setCreating] = useState<"document" | "project" | null>(null),
    [sending, setSending] = useState(false);
  const notice = host.persistenceNotice || privateNotice;
  function setNotice(message: string) {
    if (!origin.isActive()) return;
    host.dismissPersistenceNotice();
    setPrivateNotice(message);
  }
  const inputDraftState = useExchangeInputDraftState({ readLocal, writeLocal });
  const drafts = inputDraftState.value;
  const conversationDraftState = useExchangeConversationDraftState({
    readLocal,
    writeLocal,
  });
  const conversationDrafts = conversationDraftState.value;
  const [projectAction, setProjectAction] = useState<{
    project: Project;
    action: ProjectAction;
  } | null>(null);
  const [projectDirectoryVersion, setProjectDirectoryVersion] = useState(0);
  const discardedDraftState = useExchangeDiscardedDraftState({
    readLocal,
    writeLocal,
  });
  const discardedDrafts = discardedDraftState.value;
  const manageProject = (project: Project, action: ProjectAction) =>
    setProjectAction({ project, action });
  const sendPending = useRef(false);
  const { quoteReveal, setQuoteReveal } = useExchangeQuoteRevealState();
  const draftCommands = createExchangeDraftCommands({
    inputs: inputDraftState,
    conversations: conversationDraftState,
    discarded: discardedDraftState,
    storage: { readLocal, writeLocal },
    onNotice: setNotice,
  });
  const writeDrafts = createCognitiveDraftWriter({
    writeInputs: draftCommands.writeInputs,
    captureScope: () =>
      cognitiveSurface ? { key: contextKey, surface: cognitiveSurface } : null,
    onError: setNotice,
  });
  const startedConversations = startedProjectConversationIds({ state, client });
  useCommittedConversationDraftRetirement(draftCommands, state);
  const projectMetrics = useMemo(() => {
    const metrics = projectDirectoryMetrics(
      state!,
      client.boot!.runtime.messages,
    );
    for (const count of client.taskCounts) {
      const project = metrics.get(count.projectId);
      if (project) {
        project.pendingTasks = count.pending;
        if (count.latestActivityAt > project.activityAt)
          project.activityAt = count.latestActivityAt;
      }
    }
    for (const count of client.contentCounts) {
      const project = metrics.get(count.projectId);
      if (project && count.latestActivityAt > project.activityAt)
        project.activityAt = count.latestActivityAt;
    }
    return metrics;
  }, [
    state,
    client.boot?.runtime.messages,
    client.taskCounts,
    client.contentCounts,
  ]);
  const projectActivityAt = (project: Project) => {
    const local =
      projectMetrics.get(project.id)?.activityAt ??
      project.updatedAt ??
      project.createdAt;
    const runtime = client.boot!.activityByProject[project.id] ?? "";
    return local > runtime ? local : runtime;
  };
  const hasConversationDraft = projectConversationDraftPresence({
    state,
    client,
    drafts,
  });
  const {
    openingObject,
    restoredPlace,
    trail,
    websiteIntent,
    navigationGeneration,
    setExplicitWebsiteIntent: setWebsiteIntent,
  } = navigation;
  const renderNavigation = navigationGeneration.current;
  // An explicit open reserves a navigation intent before its authorized read.
  // Keep the current page's read witness until a location is actually committed;
  // otherwise beginOpen would re-read that page and temporarily retarget drafts.
  const cognitiveLocationKey = JSON.stringify(prefs.cognitiveLocation ?? null);
  const cognitiveReadNavigation = useRef({
    key: cognitiveLocationKey,
    epoch: renderNavigation,
  });
  if (cognitiveReadNavigation.current.key !== cognitiveLocationKey)
    cognitiveReadNavigation.current = {
      key: cognitiveLocationKey,
      epoch: renderNavigation,
    };
  const cognitive = useCognitiveOriginal({
    location: prefs.cognitiveLocation,
    identity: {
      centerId: client.boot!.centerId,
      principalId: client.boot!.principalId,
      csrfToken: client.boot!.csrfToken,
    },
    navigationEpoch: cognitiveReadNavigation.current.epoch,
    isCurrent: () => origin.isActive() && !!host.currentProjection(),
  });
  const cognitiveSurface = cognitive.value
    ? { kind: "original" as const, locator: cognitive.value.locator }
    : null;
  const cognitiveOpen = useRef<{
    abort: AbortController;
    generation: number;
  } | null>(null);
  useEffect(() => {
    const pending = cognitiveOpen.current;
    if (pending && !navigation.isCurrent(pending.generation))
      pending.abort.abort();
  }, [renderNavigation]);
  useEffect(() => () => cognitiveOpen.current?.abort.abort(), []);
  const cognitiveInputBlocked =
    cognitive.blocked ||
    (!!cognitiveOpen.current &&
      navigation.isCurrent(cognitiveOpen.current.generation));
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
    file = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [compact, setCompact] = useState(
      () => matchMedia("(max-width:850px)").matches,
    ),
    subjectCollaboration = useSubjectCollaborationState();
  const { mobileCollaboration, setMobileCollaboration } = subjectCollaboration;
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
  const workSurface = deriveWorkSurface({
    state,
    prefs,
    principalId: client.boot!.principalId,
    teamAuthentication: client.boot!.capabilities.teamAuthentication,
    scriptLibrary: client.boot!.scriptLibrary,
    contentScope,
    conversationDrafts,
    restoredPlace,
    cognitiveSurface,
  });
  const {
    navigationProject,
    deliveredScript,
    project,
    sharedDefault,
    defaultConversation,
    applicationWorkspaceOpen,
    activeId,
    activeInstance,
    immersiveApplication,
    artifact,
    selectedConversation,
    selectedDraft,
    conversationId,
    conversationProjectId,
    directoryScope,
    contextKey,
    dialogueCanvas,
  } = workSurface;
  const applicationDirectory =
    state && project
      ? projectApplicationPresentation({
          workspace: state,
          principalId: client.boot!.principalId,
          workspaceId: project.id,
          cognitiveCatalog: client.cognitiveAppCatalog,
        })
      : { entries: [], quickEntries: [] };
  const cognitiveApplications = applicationDirectory.entries.filter(
    (entry) => entry.kind === "cognitive",
  );
  const cognitiveChoiceScopeKey = JSON.stringify([
    client.boot!.centerId,
    client.boot!.principalId,
    client.boot!.csrfToken,
    draftOwner,
    contextKey,
  ]);
  const [cognitiveChoice, setCognitiveChoice] = useState<{
    scopeKey: string;
    contextKey: string;
    entryKey?: string;
  } | null>(null);
  const cognitiveChoiceOwner = useRef({
    scopeKey: cognitiveChoiceScopeKey,
    contextKey,
    project,
    artifact,
    cognitiveSurface,
    directory: applicationDirectory,
  });
  cognitiveChoiceOwner.current = {
    scopeKey: cognitiveChoiceScopeKey,
    contextKey,
    project,
    artifact,
    cognitiveSurface,
    directory: applicationDirectory,
  };
  const scopeMenuOrigin = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (cognitiveChoice && cognitiveChoice.scopeKey !== cognitiveChoiceScopeKey)
      setCognitiveChoice(null);
  }, [cognitiveChoice, cognitiveChoiceScopeKey]);
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
  usePrivateConversationHistorySelection({
    client,
    selectedDraft,
    conversationProjectId,
    conversationId,
  });
  useEffect(() => {
    // The shared default Session does not change when entering the task list.
    // Fetch that view now instead of waiting for the next background poll.
    if (prefs.view === "inbox") void client.refreshView();
  }, [prefs.view]);
  const canAuthorizeDirectories =
    // The reserved ID of an unsent conversation is only a local draft. Its
    // first input creates the authorized conversation atomically; there are
    // no directory grants to read or inherit until that commit succeeds.
    !selectedDraft &&
    !!client.boot?.capabilities.agentDirectories &&
    !!window.morphzDesktop?.directories;
  const [directoryState, setDirectoryState] = useState<DirectoryState>({
    scope: "",
    ready: false,
    grants: [],
  });
  const nativeInput = useExchangeNativeInputState();
  const { directoryPickerScope, nativeExportDialog, setNativeExportDialog } =
    nativeInput;
  function conversationKey(workspaceId: string) {
    return workSurfaceConversationId(
      workSurface,
      prefs.selectedConversations,
      workspaceId,
    );
  }
  useExchangeQuoteRevealCommit(conversationId, setQuoteReveal);
  const [conversationToolbarTarget, setConversationToolbarTarget] =
    useState<HTMLDivElement | null>(null);
  const exchangeController = useExchangeController({
    surface: workSurface,
    preferences: prefs,
    input,
    exchange,
    toggle,
    navigationGeneration,
    sending,
    suspended:
      dialogueCanvas ||
      !!speech ||
      !!capture ||
      searchOpen ||
      connectionOpen ||
      settingsSection !== null ||
      !!creating ||
      !!executions ||
      !!cognitiveChoice ||
      nativeExportDialog ||
      directoryPickerScope === directoryScope ||
      !!uploadingDrafts[contextKey],
    prefer,
    onShowInput: () => setMobileCollaboration(false),
  });
  const {
    interaction,
    inputVisible,
    conversationVisible,
    historyVisible,
    inputPinned,
    keepExchangeOpen,
    clearResizePreview,
    setInteraction,
    showInput,
    hideInput,
    requestConversationFocus,
    requestSentInputFocus,
    showSentInput,
    toggleInputPin,
    resize: exchangeResize,
    sentInputFocusPending,
  } = exchangeController;
  const {
    travel,
    openObject,
    openUser,
    openReading,
    openScriptLocation,
    launchDockApplication,
    readingLibrary,
    openScriptLibrary,
    activateApplication,
    navigate,
    openBrowser,
    applicationActions,
  } = createWorkspaceNavigationCommands({
    owner: navigation,
    client,
    workspace: state,
    surface: workSurface,
    preferences: prefs,
    prefer,
    shell: {
      finishCreation: () => setCreating(null),
      dismissExecutionInspector: () => setExecutions(null),
    },
    onNotice: setNotice,
    continuation: {
      isActive: origin.isActive,
      currentProjection: host.currentProjection,
      captureCommit: host.captureCommit,
      prefer: continueNavigation,
      writePreferences: host.writePreferences,
      recordContentVisit: host.recordContentVisit,
    },
    application: {
      historyVisible,
      personalDesk: () => personalSpace("desk"),
      readCapturedInstance: (id) =>
        client.boot?.workspace.applicationInstances.find((i) => i.id === id),
      selectAllContent: () => setContentScope("all"),
    },
  });
  const positions = useRef(new Map<string, number>());
  const exchangePositions = useRef(new Map<string, ExchangePosition>());
  const [revealedInputs, setRevealedInputs] = useState<Record<string, string>>(
    {},
  );
  const readReceiptState = useExchangeReadReceiptState({
    readStored: () => readLocal<unknown>("conversation-read-receipts", null),
    readBootstrap: () => ({
      messages: client.boot!.runtime.messages,
      outputs: client.boot!.outputs,
      scriptOutputs: client.boot!.scriptOutputs,
    }),
  });
  const { seenReplies } = readReceiptState;
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
    cognitiveObject: !historyVisible ? cognitive.value?.locator : undefined,
    artifactId: !historyVisible ? artifact?.id : undefined,
    applicationId:
      !historyVisible && activeInstance?.applicationId === browserApplication.id
        ? activeInstance.id
        : undefined,
  };
  const badgeRead = projectConversationReadScope({
    inputs,
    messages: replies,
    outputs: client.boot!.outputs,
    scriptOutputs: client.boot!.scriptOutputs,
    scope: { focus: conversationFocus, messageArray: "preserve-unfocused" },
  });
  const conversationRead = projectConversationReadScope({
    inputs,
    messages: replies,
    outputs: client.boot!.outputs,
    scriptOutputs: client.boot!.scriptOutputs,
    scope: { focus: {}, messageArray: "preserve-unfocused" },
  });
  const receipts = replyReceipts(
    conversationRead.messages,
    conversationRead.outputs,
    conversationRead.scriptOutputs,
  );
  const receiptVersion = JSON.stringify(receipts);
  const unseenReply = hasUnreadReplies(
    seenReplies,
    replyReceipts(
      badgeRead.messages,
      badgeRead.outputs,
      badgeRead.scriptOutputs,
    ),
  );
  const readReplies = useExchangeReadAcknowledgement(readReceiptState);
  useExchangeReadReceiptCommit(readReceiptState, {
    receipts,
    version: receiptVersion,
    persist: (seen) => writeLocal("conversation-read-receipts", seen),
    onNotice: setNotice,
  });
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
    document.title = `${cognitive.value?.original.title ?? artifact?.title ?? (prefs.view === "projects" && prefs.projectOpen ? project?.title : labels[prefs.view])} — Morphz`;
  }, [
    cognitive.value?.original.title,
    artifact?.title,
    project?.title,
    prefs.view,
    prefs.projectOpen,
  ]);
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
    cognitiveLocation: prefs.cognitiveLocation,
  };
  useWorkspaceNavigationCommit(navigation, { place, travel });
  useExchangeControllerFocus(exchangeController);
  useExchangeInputToolCommit(inputMedia, { contextKey, inputVisible });
  // Keep the original artifact-existence witness for annotation JSX narrowing.
  const collaborationVisible =
    !!artifact &&
    subjectCollaborationVisible({
      executions,
      subjectView,
      understandingOpen,
      artifact,
      compact,
      mobileCollaboration,
      preferences: prefs,
    });
  const { annotationResult, setAnnotationRefresh } = useObjectAnnotations({
    artifact,
    collaborationVisible,
    client,
  });
  const { ref: inspectorWorkspace, layout: rightInspector } =
    useInspectorLayout(prefs.inspectorWidth ?? prefs.executionWidth ?? 340);
  const inspectorOpen = subjectInspectorOpen({
    executions,
    subjectView,
    understandingOpen,
    collaborationVisible,
  });
  const inspectorSelections = useSubjectInspectorMemory();
  useSubjectInspectorCommit(inspectorSelections, {
    contextKey,
    executions,
    understandingOpen,
    collaborationVisible,
  });
  const resizeInspector = (inspectorWidth: number) =>
    prefer({ inspectorWidth });
  const closeInspector = createSubjectInspectorCloseCommand({
    inspection: subjectInspection,
    collaboration: subjectCollaboration,
    prefer,
    onClosedFocus: () => {
      requestAnimationFrame(() => {
        const trigger =
          document.querySelector<HTMLElement>(".inspector-toggle");
        if (trigger?.getClientRects().length) trigger.focus();
        else (input.current ?? toggle.current)?.focus();
      });
    },
  });
  const { surfaceDraft, draft } = readWorkSurfaceDraft(
    workSurface,
    drafts,
    emptyDraft,
  );
  const mac = /Mac|iPhone|iPad/.test(navigator.platform),
    shortcut = mac ? "⌘J" : "Ctrl+J";
  function prefer(change: Partial<Preferences>) {
    if (!origin.isActive()) return;
    if (isNavigationPreferenceChange(change)) {
      navigation.beginIntent();
      setUnderstandingOpen(false);
      navigation.resetPreferenceNavigation();
      clearResizePreview();
    }
    writePreferences(
      (previous) => mergeNavigationPreferences(previous, change),
      "settings",
    );
  }
  function writePreferences(
    update: Parameters<PreferenceWriter<Preferences>>[0],
    failure: Parameters<PreferenceWriter<Preferences>>[1],
  ) {
    if (!origin.isActive()) return;
    host.writePreferences(update, failure, origin.capturePrivateCommit());
  }
  function continueNavigation(
    change: Partial<Preferences>,
    intent: NavigationIntent,
    destination: CurrentDestination,
  ) {
    const current = host.currentProjection();
    if (
      !navigation.isCurrent(intent.generation) ||
      !current ||
      !destination(current)
    )
      return;
    if (isNavigationPreferenceChange(change)) {
      intent.generation = navigation.beginIntent();
      // Old private setters/DOM refs are never rebound to the new private tree.
      if (origin.isActive()) {
        setUnderstandingOpen(false);
        navigation.resetPreferenceNavigation();
        clearResizePreview();
      } else navigation.resetPreferenceNavigation();
    }
    host.writePreferences(
      (previous) => mergeNavigationPreferences(previous, change),
      "settings",
      destination,
    );
  }
  function setDraft(key: string, value: InputDraft) {
    if (!origin.isActive()) return;
    if (key === currentContext.current && value.body !== drafts[key]?.body)
      dictationControls.current?.interrupt();
    writeDrafts((previous) =>
      replaceComposerSurface(previous, key, emptyDraft, value),
    );
  }
  function updateDraft(
    key: string,
    update: (value: InputDraft) => InputDraft,
    initial: InputDraft = emptyDraft,
  ) {
    if (!origin.isActive()) return;
    writeDrafts((previous) =>
      updateComposerDraft(previous, key, emptyDraft, update, initial),
    );
  }
  function requestCognitiveApplicationChoice(
    entry?: CognitiveApplicationEntry,
    expectedScopeKey = cognitiveChoiceScopeKey,
  ) {
    if (
      !currentCognitiveChoiceWindow() ||
      !origin.isActive() ||
      !host.currentProjection() ||
      expectedScopeKey !== cognitiveChoiceOwner.current.scopeKey ||
      currentContext.current !== contextKey
    ) {
      setNotice("输入工作范围已有变化，原草稿已保留。");
      return;
    }
    setCognitiveChoice({
      scopeKey: expectedScopeKey,
      contextKey,
      ...(entry ? { entryKey: entry.key } : {}),
    });
  }
  function chooseInputApplication(
    target: CognitiveAppApplicationTarget | null,
    expectedScopeKey: string,
    expectedContextKey: string,
  ) {
    let selected: CognitiveAppApplicationTarget | null;
    try {
      selected =
        target === null ? null : parseCognitiveAppApplicationTarget(target);
    } catch {
      setNotice("应用目标无效，原草稿已保留。");
      return;
    }
    const current = cognitiveChoiceOwner.current;
    if (
      !currentCognitiveChoiceWindow() ||
      !origin.isActive() ||
      !host.currentProjection() ||
      current.scopeKey !== expectedScopeKey ||
      currentContext.current !== expectedContextKey
    ) {
      setNotice("输入工作范围已有变化，原草稿已保留。");
      return;
    }
    writeDrafts((previous) => {
      const live = cognitiveChoiceOwner.current;
      if (
        !currentCognitiveChoiceWindow() ||
        !origin.isActive() ||
        !host.currentProjection() ||
        live.scopeKey !== expectedScopeKey ||
        currentContext.current !== expectedContextKey ||
        !live.project
      )
        return previous;
      if (
        selected &&
        !live.directory.quickEntries.some(
          (entry) =>
            entry.kind === "cognitive" &&
            cognitiveApplicationTargets(entry).some((candidate) =>
              sameCognitiveAppApplicationTarget(candidate, selected),
            ),
        )
      ) {
        setNotice("应用或数据连接当前不可用，原草稿已保留。");
        return previous;
      }
      // Prepare the same latest surface/quote carrier as the original composer
      // helper, but reject before invoking it. Its accepted legacy behavior
      // creates the quote bucket even when a surface callback is a no-op.
      const quotesKey = expectedContextKey.split(":")[0] + ":quotes";
      const latest = {
        ...(previous[expectedContextKey] ?? emptyDraft),
        textQuotes: previous[quotesKey]?.textQuotes ?? [],
      };
      const result = chooseCognitiveApplication(latest, selected, {
        projectId: live.project.id,
        expectedContextKey,
        currentContextKey: currentContext.current,
        artifactId: live.artifact?.id ?? null,
        cognitiveSurface: live.cognitiveSurface ?? null,
      });
      if (!result.ok) {
        setNotice(result.error);
        return previous;
      }
      return updateComposerDraft(
        previous,
        expectedContextKey,
        emptyDraft,
        () => result.draft,
      );
    });
    setCognitiveChoice(null);
  }
  /** Choosing a new input target uses this same persisted draft owner. Only
   * these new mutations fail closed; existing no-target input behavior stays
   * with its original owner and lenient presentation preferences. */
  function currentCognitiveChoiceWindow() {
    try {
      return requirePersistentDraftOwner() === draftOwner;
    } catch {
      return false;
    }
  }
  function open(id: string, revision?: number, page?: number) {
    if (!origin.isActive()) return;
    setWebsiteIntent(null);
    void openUser(id, revision, page);
  }
  async function openCognitiveOriginal(raw: CognitiveAppObjectLocator) {
    if (!origin.isActive()) return;
    let locator: CognitiveAppObjectLocator;
    try {
      locator = parseCognitiveAppObjectLocator(raw);
    } catch {
      setNotice("原件引用无效，当前位置未改变。");
      return;
    }
    cognitiveOpen.current?.abort.abort();
    const generation = navigation.beginOpen();
    const pending = { generation, abort: new AbortController() };
    cognitiveOpen.current = pending;
    const privateCommit = origin.capturePrivateCommit();
    const intent = { generation };
    const destination: CurrentDestination = (current) =>
      privateCommit(current) &&
      navigation.isCurrent(intent.generation) &&
      current.workspace.projects.some((p) => p.id === locator.projectId);
    const deadline = setTimeout(() => pending.abort.abort(), 30_000);
    try {
      const value = await cognitive.readOriginal(locator, pending.abort.signal);
      const current = host.currentProjection();
      if (pending.abort.signal.aborted || !current || !destination(current))
        return;
      setCreating(null);
      setExecutions(null);
      setWebsiteIntent(null);
      const targetConversation = conversationKey(locator.projectId);
      const targetExchangeKey =
        targetConversation === defaultConversation
          ? locator.projectId
          : targetConversation;
      const location = { kind: "original" as const, locator: value.locator };
      continueNavigation(
        {
          view: "projects",
          projectId: locator.projectId,
          projectOpen: true,
          artifactId: null,
          artifactRevision: null,
          cognitiveLocation: location,
          ...(prefs.interactions?.[targetExchangeKey] === "history"
            ? { interactions: { [targetExchangeKey]: "recent" as const } }
            : {}),
        },
        intent,
        destination,
      );
      cognitive.adopt(
        value,
        cognitiveReadNavigation.current.key === JSON.stringify(location)
          ? cognitiveReadNavigation.current.epoch
          : intent.generation,
      );
      host.recordContentVisit(value.entry.id, destination);
    } catch (error) {
      if (navigation.isCurrent(generation) && origin.isActive())
        setNotice(
          pending.abort.signal.aborted
            ? "原件读取已取消或超时，当前位置未改变。"
            : error instanceof Error
              ? error.message
              : "原件暂时无法读取。",
        );
    } finally {
      clearTimeout(deadline);
      pending.abort.abort();
      if (cognitiveOpen.current === pending) cognitiveOpen.current = null;
      navigation.finishOpen(intent.generation);
    }
  }
  const {
    selectContentScope,
    selectConversation,
    createProjectConversation,
    discardConversationDraft,
    restoreConversationDraft,
    openProject,
    prepareCreatedProject,
  } = createPrivateProjectConversationScope({
    render: {
      state,
      prefs,
      navigationProject,
      project,
      sharedDefault,
      defaultConversation,
      conversationId,
      hasConversationDraft,
      personalSpace,
    },
    origin,
    draftCommands,
    sendPending,
    navigation: {
      navigationGeneration,
      isCurrent: navigation.isCurrent,
      setWebsiteIntent,
      prefer,
      continueNavigation,
    },
    host,
    privateUi: { setContentScope, setCreating, setExecutions },
    exchange: { keepExchangeOpen, requestConversationFocus },
    onNotice: setNotice,
  });
  const {
    openTextQuote,
    composeContent,
    composeReading,
    composeIntent,
    prepareSearchQuote,
    selectArtifactQuote,
    changeTextQuotes,
    focusCommentComposer,
  } = createExchangeReferenceCommands({
    render: {
      conversationId,
      contextKey,
      workspace: state,
      drafts,
      draft,
      sending,
      emptyDraft,
    },
    scope: { conversationKey },
    origin,
    navigation: {
      navigationGeneration,
      isCurrent: navigation.isCurrent,
      setExplicitWebsiteIntent: setWebsiteIntent,
      openObject,
      openScriptLocation,
      openBrowser,
      activateApplication,
      selectConversation,
    },
    client,
    drafts: { replace: setDraft, update: updateDraft },
    exchange: {
      keepOpen: keepExchangeOpen,
      showInput,
      setInteraction,
      requestConversationFocus,
      scheduleSearchQuoteFocus: () =>
        requestAnimationFrame(() => {
          if (!exchange.current?.contains(document.activeElement))
            input.current?.focus();
        }),
      scheduleCommentComposerFocus: () =>
        requestAnimationFrame(() =>
          input.current?.focus({ preventScroll: true }),
        ),
    },
    quotes: {
      clearSelection: () => window.getSelection()?.removeAllRanges(),
      reveal: revealTextQuote,
      setReveal: setQuoteReveal,
    },
    onNotice: setNotice,
  });
  function readingTargetConsumed(requestId: string) {
    if (prefs.readingTarget?.requestId === requestId)
      prefer({ readingTarget: null });
  }
  async function openScript(output: ScriptOutput) {
    return openScriptLocation(scriptOutputLocation(output));
  }
  const closeSpeech = createExchangeInputToolCloseCommand({
    dictation: inputDictation,
    media: inputMedia,
    currentContext,
    keepExchangeOpen,
    focusMicrophone: () =>
      exchange.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]')
        ?.focus(),
  });
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
  async function importImage(image: File | undefined) {
    if (!origin.isActive()) return;
    const expectedNavigation = navigationGeneration.current;
    if (!image || !project || importing) return;
    setImporting(true);
    try {
      const { assetId } = await client.upload(image);
      if (!origin.isActive()) return;
      const receipt = await client.execute({
        type: "create-artifact",
        projectId: project.id,
        title: image.name.replace(/\.[^.]+$/, "").slice(0, 180) || "导入的图片",
        content: { kind: "image", assetId, alt: "" },
      });
      if (!origin.isActive() || !navigation.isCurrent(expectedNavigation))
        return;
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
  const inboxCount = client.taskCounts.reduce(
    (total, count) => total + count.mineOpen,
    0,
  );
  const annotations = objectAnnotationItems(artifact, annotationResult);
  const contextTitle =
    cognitive.value?.original.title ??
    artifact?.title ??
    (activeInstance?.applicationId === browserApplication.id
      ? browserPage?.title || "浏览器"
      : project.title);
  const inputTools = createExchangeInputToolCommands({
    closeSpeech,
    dictation: inputDictation,
    media: inputMedia,
    native: nativeInput,
    render: {
      contextKey,
      directoryScope,
      contextTitle,
      draft,
      project,
      artifact,
      preferences: prefs,
    },
    drafts: { replace: setDraft, update: updateDraft },
    currentContext,
    exchange: { showInput, setInteraction },
    focus: {
      scheduleInput: () => requestAnimationFrame(() => input.current?.focus()),
    },
    openSavedCapture: (projectId, id) => void openObject(projectId, id),
    reportInputError: (key, message) =>
      setInputErrors((old) => ({ ...old, [key]: message })),
  });
  // A personal desk remains the real input owner, but is not an explicit
  // project association. Named conversations already belong to a project.
  const showPlainComposerScope = !!(
    draft.cognitiveApplication ||
    cognitive.requested ||
    draft.continuation ||
    artifact ||
    deliveredScript ||
    activeInstance?.applicationId === browserApplication.id ||
    spaceKind(project) === "project"
  );
  const composerScopeTitle =
    (cognitive.requested
      ? (cognitive.value?.original.title ?? "原件")
      : undefined) ??
    artifact?.title ??
    deliveredScript?.production.title ??
    (activeInstance?.applicationId === browserApplication.id
      ? browserPage?.title || "浏览器"
      : spaceKind(project) === "project"
        ? project.title
        : "无项目");
  let cognitiveInputTarget: CognitiveAppApplicationTarget | undefined;
  try {
    guardCognitiveAppApplicationCommand({ operation: draft });
    if (draft.cognitiveApplication !== undefined)
      cognitiveInputTarget = parseCognitiveAppApplicationTarget(
        draft.cognitiveApplication,
      );
  } catch {
    /* Invalid restored facts stay in the original draft; no fallback selection. */
  }
  const cognitiveInputEntry =
    cognitiveInputTarget &&
    cognitiveApplications.find(
      (entry) =>
        entry.metadata.appId === cognitiveInputTarget.authority.appId &&
        entry.metadata.version === cognitiveInputTarget.authority.version &&
        entry.metadata.definitionHash ===
          cognitiveInputTarget.authority.definitionHash,
    );
  const cognitiveInputLabel = cognitiveInputTarget
    ? cognitiveInputEntry
      ? `${cognitiveInputEntry.metadata.title} · ${cognitiveInputEntry.metadata.version}`
      : "应用目标"
    : undefined;
  const cognitiveInputUnavailable =
    cognitiveInputTarget &&
    (!cognitiveInputEntry ||
      !cognitiveApplicationTargets(cognitiveInputEntry).some((target) =>
        sameCognitiveAppApplicationTarget(target, cognitiveInputTarget),
      ));
  const cognitiveChoiceBlocked =
    artifact ||
    draft.continuation ||
    draft.pendingSupplement ||
    draft.continuationFailure ||
    draft.annotation ||
    draft.taskResult ||
    draft.reading ||
    draft.scriptGeneration ||
    draft.selection ||
    draft.revision != null ||
    draft.page !== undefined
      ? "原输入中已有来源或专用请求，请先处理原请求；原草稿已保留。"
      : undefined;
  const rememberedInspector = inspectorSelections.current.get(contextKey);
  const subjectInspector = createSubjectInspectorCommands({
    activity: subjectActivity,
    inspection: subjectInspection,
    collaboration: subjectCollaboration,
    rememberedInspector,
    workspace: state,
    historyClient: client,
    preferences: prefs,
    conversationProjectId,
    conversationId,
    compact,
    prefer,
    keepExchangeOpen,
    onNotice: setNotice,
    close: closeInspector,
  });
  const {
    openExecutions,
    openCollaboration,
    show: showInspector,
    selectSubject: selectSubjectView,
    openFromLogo: openSubjectFromLogo,
    inspectExecution,
  } = subjectInspector;
  const { send, supplement } = createExchangeSubmissionCommands({
    render: {
      project,
      selectedConversation,
      selectedDraft,
      draft,
      sending,
      uploadingDrafts,
      contextKey,
      conversationId,
      workspace: state,
      emptyDraft,
      artifact,
      activeInstance,
      browserPage,
      readingExpected,
      currentReading,
      cognitiveSurface,
      canAuthorizeDirectories,
      directoryScope,
      directoryState,
      rightInspector,
    },
    client,
    profile,
    feedback: {
      sendPending,
      currentContext,
      setSending,
      setInputErrors,
      setRevealedInputs,
      setAnnotationRefresh,
    },
    dictationControls,
    drafts: { replace: setDraft, update: updateDraft },
    exchange: {
      setMobileCollaboration,
      showSentInput,
      requestSentInputFocus,
      showInput,
    },
    inspector: { openCollaboration, closeInspector },
    onNotice: setNotice,
    focusAfterSupplement: () =>
      requestAnimationFrame(() =>
        input.current?.focus({ preventScroll: true }),
      ),
  });
  const agentName =
    (profile.snapshot?.agent.available && profile.snapshot.agent.enabled
      ? profile.snapshot.agent.data.name
      : undefined) ??
    client.boot!.workspace.actants.find((actor) => actor.kind === "agent")
      ?.name ??
    "Morphz";
  const presence = subjectLogoState(
    client.boot!.runtime,
    client.online,
    stream,
    [
      ...client.boot!.outputs.map((output) => output.inputId),
      ...client.boot!.scriptOutputs.map((output) => output.inputId),
    ],
  );
  const inspectorViewOptions: ComposerOption[] = [
    {
      label: "执行记录",
      icon: <ListChecks />,
      onSelect: openExecutions,
      pressed: !!executions,
    },
    {
      label: `${agentName} 设定`,
      icon: <SlidersHorizontal />,
      onSelect: () => selectSubjectView("settings"),
      pressed: subjectView === "settings",
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
  const { inspectorTitle, activityScope } = subjectInspectorPresentation({
    executions,
    understandingOpen,
    collaborationVisible,
    conversationProjectId,
    conversationId,
  });
  const inspectorControls = (
    <div className="workspace-inspector-controls">
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
  const identityLabel =
    (profile.snapshot?.human.available && profile.snapshot.human.enabled
      ? profile.snapshot.human.data.name
      : undefined) ?? actorName(state, client.boot!.actantId);
  const connected = client.online && client.boot!.runtime.connected;
  const profileMenu = {
    name: identityLabel,
    avatarSrc: profile.media.human?.original,
    avatarPosterSrc: profile.media.human?.poster,
    avatarAnimated: (profile.snapshot?.human.avatar.media?.frames ?? 1) > 1,
    allowMotion: prefs.motion !== "reduce",
    onProfile: () => setSettingsSection("profile"),
    status: connectionLabel,
    connected,
    unreadNotifications,
    onSearch: () => setSearchOpen(true),
    onAppearance: () => setSettingsSection("appearance"),
    onNotifications: () => setNotificationsOpen(true),
    onSettings: () =>
      setSettingsSection(
        client.boot!.capabilities.modelSettings ? "models" : "appearance",
      ),
    onLogout: client.boot!.capabilities.teamAuthentication
      ? () => void client.logout().catch((e) => setNotice(e.message))
      : undefined,
  };
  const applicationCompose = createApplicationComposePreparation({
    render: {
      state,
      project,
      draft,
      contextKey,
      conversationId,
      defaultConversation,
      sending,
      emptyDraft,
    },
    client,
    setDraft,
    writeDrafts,
    flushSync,
    currentContext,
    dictationControls,
    prefer,
    showInput,
  });
  const builtinApplications = createBuiltinApplicationAdapters({
    client,
    onNativeDialog: setNativeExportDialog,
    onInput: showInput,
    onBrowserPage: setBrowserPage,
    scriptLocation: deliveredScript
      ? (prefs.scriptLocation ?? undefined)
      : undefined,
    globalLibrary: prefs.view !== "projects",
    onOpenScript: (id, itemId) =>
      void openScriptLocation(
        {
          productionId: id,
          ...(itemId ? { itemId } : {}),
        },
        renderNavigation,
      ),
    onScriptLibrary: () => void openScriptLibrary(),
    onScriptNavigate: (productionId, itemId, view) => {
      if (prefs.scriptLocation)
        prefer({
          scriptLocation: {
            productionId,
            ...(itemId ? { itemId } : {}),
            view,
            requestId: crypto.randomUUID(),
          },
        });
    },
    readingTarget: prefs.readingTarget,
    readingRevision: prefs.artifactRevision,
    onReadingOpen: openReading,
    onReadingCompose: composeReading,
    onReadingContext: readingContextChanged,
    onReadingLibrary: () => void readingLibrary(),
    onReadingJump: (target) =>
      void openUser(
        target.artifactId,
        target.revision,
        undefined,
        target.location,
      ),
    onReadingTargetConsumed: readingTargetConsumed,
    onComposeIntent: composeIntent,
    onCompose: applicationCompose,
    onOpen: open,
    onNotice: setNotice,
  });
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
      onChange: changeTextQuotes,
      onEngage: keepExchangeOpen,
      onFocusComposer: focusCommentComposer,
      onOpen: (quote) => void openTextQuote(quote),
      onNotice: setNotice,
    },
    <div
      className={
        "app " +
        (!collaborationVisible ? "without-collaboration" : "") +
        (compact && mobileCollaboration ? " mobile-collaboration" : "") +
        (!prefs.sidebar ? " sidebar-hidden" : "") +
        (prefs.sidebar && leftSidebar.compact ? " sidebar-compact" : "") +
        (immersiveApplication ? " application-immersive" : "") +
        (applicationWorkspaceOpen &&
        activeInstance?.applicationId === browserApplication.id
          ? " application-browser-workspace"
          : "")
      }
      data-accent={prefs.accent}
      style={{ "--sidebar-width": `${leftSidebar.width}px` } as CSSProperties}
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
          <SubjectLogo
            presence={presence}
            name={agentName}
            avatarSrc={profile.media.agent?.original}
            avatarPosterSrc={profile.media.agent?.poster}
            avatarAnimated={
              (profile.snapshot?.agent.avatar.media?.frames ?? 1) > 1
            }
            allowMotion={prefs.motion !== "reduce"}
            onOpen={openSubjectFromLogo}
          />
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
              open={notificationsOpen}
              onOpenChange={setNotificationsOpen}
              onUnreadChange={setUnreadNotifications}
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
              return (
                <button
                  key={view}
                  aria-current={prefs.view === view ? "page" : undefined}
                  aria-label={
                    labels[view] + (view === "inbox" ? ` ${inboxCount}` : "")
                  }
                  title={labels[view]}
                  onClick={() => navigate(view)}
                >
                  <NavigationIcon kind={view} />
                  <span className="sidebar-nav-label">{labels[view]}</span>
                  {view === "inbox" && <small>{inboxCount}</small>}
                </button>
              );
            })}
          </nav>
          <div className="sidebar-section">
            <div className="section-label">
              <span>项目</span>
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
                    projectActivityAt(b).localeCompare(projectActivityAt(a)) ||
                    a.title.localeCompare(b.title, "zh-CN"),
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
          <ProfileMenu
            {...profileMenu}
            placement={leftSidebar.compact ? "right" : "vertical"}
          />
        </div>
      </aside>
      {prefs.sidebar && !leftSidebar.mobile && !immersiveApplication && (
        <SidebarResizeHandle
          preference={leftSidebarPreference}
          scope={navigationProject?.id ?? prefs.view}
          onCommit={prefer}
        />
      )}
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
        <WorkspaceTopbar
          view={{
            applicationWorkspaceOpen,
            view: prefs.view,
            viewLabel: labels[prefs.view],
            projectTitle: project.title,
            projectOpen: prefs.projectOpen,
            artifact: artifact
              ? { title: artifact.title, kind: artifact.content.kind }
              : null,
            cognitiveTitle: cognitive.requested
              ? (cognitive.value?.original.title ?? "原件")
              : undefined,
            openingObject,
            creating,
            collaborationVisible,
          }}
          history={{
            index: trail.current.index,
            length: trail.current.places.length,
          }}
          sidebarExpanded={prefs.sidebar}
          slots={{
            application: setToolbarTarget,
            page: setPageToolbarTarget,
            detail: setDetailToolbarTarget,
          }}
          projectControls={
            <ProjectMenu project={project} onAction={manageProject} />
          }
          onToggleSidebar={() => prefer({ sidebar: !prefs.sidebar })}
          onTravel={travel}
          onNavigateView={() => navigate(prefs.view)}
          onOpenProject={() => openProject(project.id)}
          onToggleCollaboration={subjectInspector.toggleCollaboration}
        />
        {inspectorControls}
        <div
          className="workspace-body"
          data-execution-open={!!executions || !!subjectView || undefined}
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
              {...(!cognitive.requested
                ? quoteSource({
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
                  })
                : {})}
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
                  projectControls={
                    spaceKind(project) === "project" ? (
                      <ProjectMenu project={project} onAction={manageProject} />
                    ) : undefined
                  }
                  client={client}
                  foreground={!historyVisible && creating !== "document"}
                  workspaceId={project.id}
                  activeId={activeId}
                  recentContentVisits={recentContentVisits}
                  enabled={applicationWorkspaceOpen && !cognitive.requested}
                  navigationId={navigationGeneration.current}
                  applicationActions={applicationActions}
                  onOpen={open}
                  onNotice={setNotice}
                  onCompose={applicationCompose}
                  renderBuiltin={builtinApplications.renderBuiltin}
                  onOpenRecent={builtinApplications.openRecentContent}
                  applicationDirectory={applicationDirectory}
                  cognitiveChoiceScopeKey={cognitiveChoiceScopeKey}
                  onChooseCognitiveApplication={
                    requestCognitiveApplicationChoice
                  }
                >
                  {cognitive.requested ? (
                    <CognitiveOriginalView
                      original={cognitive.value}
                      message={cognitive.message}
                      onRetry={cognitive.reload}
                      toolbarTarget={detailToolbarTarget}
                      state={state}
                      onOpen={openUser}
                    />
                  ) : artifact &&
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
                      onSelect={selectArtifactQuote}
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
                      contentCounts={client.contentCounts}
                      onOpen={openProject}
                      onCreate={() => setCreating("project")}
                      onManage={manageProject}
                      metrics={projectMetrics}
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
                conversationVisible={conversationVisible}
                scopeRef={setConversationToolbarTarget}
                controls={
                  !dialogueCanvas && inputVisible ? (
                    <ExchangeControls
                      conversationVisible={conversationVisible}
                      historyVisible={historyVisible}
                      pinned={inputPinned}
                      unread={!conversationVisible && unseenReply}
                      onInteraction={setInteraction}
                      onPin={toggleInputPin}
                      onHide={hideInput}
                    />
                  ) : undefined
                }
                resize={
                  !dialogueCanvas &&
                  inputVisible &&
                  projectStatus(project) === "active" &&
                  !selectedConversation?.archivedAt
                    ? exchangeResize
                    : undefined
                }
              >
                {conversationVisible && (
                  <Conversation
                    notice={
                      notice ? (
                        <WorkspaceNotice
                          message={notice}
                          scrollable
                          onDismiss={() => {
                            // Removing the focused close button must not look
                            // like leaving this still-open reading surface.
                            keepExchangeOpen();
                            (input.current && !input.current.disabled
                              ? input.current
                              : exchange.current?.querySelector<HTMLElement>(
                                  ".exchange-view-tools > button, .conversation",
                                )
                            )?.focus({ preventScroll: true });
                            setNotice("");
                          }}
                        />
                      ) : undefined
                    }
                    hasEarlierHistory={!!client.olderHistoryCursor}
                    onLoadEarlierHistory={client.loadEarlierHistory}
                    onOpenQuote={(quote) => void openTextQuote(quote)}
                    quoteReveal={
                      quoteReveal?.quote.source.kind === "message" &&
                      quoteReveal.quote.source.conversationId === conversationId
                        ? quoteReveal
                        : null
                    }
                    onQuoteUnavailable={(reason) =>
                      setNotice(
                        reason ??
                          "原消息暂时不在已加载的记录中，引用内容仍保留。",
                      )
                    }
                    toolbarTarget={conversationToolbarTarget}
                    onFocusComposer={() =>
                      input.current?.focus({ preventScroll: true })
                    }
                    focusedApplicationId={conversationFocus.applicationId}
                    focusedArtifactId={conversationFocus.artifactId}
                    focusedCognitiveObject={conversationFocus.cognitiveObject}
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
                    onOpenCognitiveObject={openCognitiveOriginal}
                    onOpenScript={openScript}
                    onRetry={async (id) => {
                      // Retrying removes this focused button once the outbox
                      // advances. Hand focus to a stable control before that
                      // update, not after a reply that may outlive navigation.
                      input.current?.focus({ preventScroll: true });
                      try {
                        await client.dispatchInput(id);
                      } catch (error) {
                        if (!client.boot?.localSavedInputIds.includes(id))
                          setNotice(
                            error instanceof Error
                              ? error.message
                              : "发送失败。",
                          );
                      }
                    }}
                  />
                )}
                <div className="composer-dock">
                  {projectStatus(project) === "active" &&
                    !selectedConversation?.archivedAt && (
                      <div
                        className="application-dock-slot"
                        data-expanded={inputVisible || undefined}
                      >
                        <ApplicationDock
                          compactWithExchange={!dialogueCanvas && inputVisible}
                          applications={applicationDirectory.quickEntries}
                          cognitiveChoice={{
                            scopeKey: cognitiveChoiceScopeKey,
                            selectedKey: cognitiveInputEntry?.key,
                            onChoose: requestCognitiveApplicationChoice,
                          }}
                          pinned={prefs.dockApplications}
                          activeKey={
                            activeInstance
                              ? `${activeInstance.applicationId}@${activeInstance.applicationVersion}`
                              : undefined
                          }
                          onPinned={(dockApplications) =>
                            prefer({ dockApplications })
                          }
                          onManage={() => {
                            const owner = personalSpace("desk");
                            navigate("desk");
                            if (owner)
                              prefer({
                                applications: {
                                  ...prefs.applications,
                                  [owner.id]: null,
                                },
                              });
                          }}
                          onLaunch={launchDockApplication}
                        />
                      </div>
                    )}
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
                          disabled={
                            sending ||
                            !!draft.pendingSupplement ||
                            cognitiveInputBlocked
                          }
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
                            补充给：
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
                                continuationLabel: undefined,
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
                          disabled={
                            sending ||
                            !!draft.pendingSupplement ||
                            cognitiveInputBlocked
                          }
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
                            const mode = inputDispatchMode(
                              event.nativeEvent,
                              prefs.sendShortcut,
                            );
                            if (mode) {
                              event.preventDefault();
                              if (client.online && !cognitiveInputBlocked)
                                void send(draft.annotation === true, mode);
                            }
                          }}
                        />
                      </div>
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
                                  continuation: undefined,
                                  continuationLabel: undefined,
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
                              改为普通消息发送
                            </button>
                          </div>
                        )}
                      {draft.pendingSupplement && !sending && (
                        <small className="continuation-pending" role="status">
                          正在核对原投递；确认前保留这份草稿，请勿另发一遍。
                        </small>
                      )}
                      <ComposerActionBar
                        status={
                          <ComposerStatus error={inputErrors[contextKey]}>
                            {(!client.online ||
                              (draft.taskResult && !draft.continuation) ||
                              (!draft.annotation &&
                                !client.boot!.runtime.connected)) && (
                              <small className="model-status">
                                <span className="model-status-label">
                                  {!client.online
                                    ? "应用连接中断"
                                    : draft.taskResult && !draft.continuation
                                      ? `${actorName(state, client.boot!.actantId)} · 提交事项结果`
                                      : client.boot!.runtime.configured
                                        ? client.boot!.runtime.error
                                          ? "智能体连接异常 · 消息已保留"
                                          : "正在连接智能体"
                                        : "尚未连接智能体 · 输入只会保存"}
                                </span>
                                {(!client.online || !draft.taskResult) && (
                                  <button
                                    className="text-button"
                                    aria-label="连接详情"
                                    onClick={() => setConnectionOpen(true)}
                                  >
                                    <Link2 aria-hidden="true" />
                                    <span>连接详情</span>
                                  </button>
                                )}
                              </small>
                            )}
                          </ComposerStatus>
                        }
                        scope={
                          <ComposerScope
                            showPlainScope={showPlainComposerScope}
                            expandable={
                              !!(
                                cognitiveInputTarget ||
                                (showPlainComposerScope &&
                                  cognitiveApplications.length > 0) ||
                                draft.scriptGeneration ||
                                (!draft.continuation &&
                                  (draft.taskResult ||
                                    draft.intent ||
                                    (artifact && draft.selection)))
                              )
                            }
                            label={
                              draft.continuation
                                ? "补充原工作"
                                : draft.taskResult
                                  ? "提交事项结果"
                                  : (cognitiveInputLabel ?? composerScopeTitle)
                            }
                            description={
                              (cognitiveInputLabel ?? composerScopeTitle) +
                              (draft.revision ? " · v" + draft.revision : "")
                            }
                            onOpenChange={(open) => {
                              if (!open) scopeMenuOrigin.current = undefined;
                              else if (scopeMenuOrigin.current === undefined)
                                scopeMenuOrigin.current =
                                  cognitiveChoiceScopeKey;
                            }}
                          >
                            <div className="composer-meta">
                              {(cognitiveInputTarget ||
                                cognitiveApplications.length > 0) && (
                                <div className="cognitive-application-scope">
                                  <strong>本次输入使用的应用</strong>
                                  {cognitiveInputTarget && (
                                    <>
                                      <small>{cognitiveInputLabel}</small>
                                      <small>
                                        {
                                          cognitiveInputTarget.authority
                                            .serviceId
                                        }{" "}
                                        ·{" "}
                                        {
                                          cognitiveInputTarget.authority
                                            .dataAuthorityId
                                        }{" "}
                                        · 数据连接{" "}
                                        {cognitiveInputTarget.connectionId}
                                      </small>
                                      {cognitiveInputUnavailable && (
                                        <small role="status">
                                          应用或数据连接当前不可用，目标和原草稿仍保留。
                                        </small>
                                      )}
                                    </>
                                  )}
                                  <div className="cognitive-application-scope-actions">
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={!!cognitiveChoiceBlocked}
                                      onClick={() =>
                                        requestCognitiveApplicationChoice(
                                          undefined,
                                          scopeMenuOrigin.current ?? "",
                                        )
                                      }
                                    >
                                      {cognitiveInputTarget
                                        ? "更改本次输入应用"
                                        : "选择本次输入应用"}
                                    </button>
                                    {cognitiveInputTarget && (
                                      <button
                                        type="button"
                                        className="text-button"
                                        disabled={!!cognitiveChoiceBlocked}
                                        onClick={() =>
                                          chooseInputApplication(
                                            null,
                                            scopeMenuOrigin.current ?? "",
                                            contextKey,
                                          )
                                        }
                                      >
                                        移除本次输入应用
                                      </button>
                                    )}
                                  </div>
                                  {cognitiveChoiceBlocked && (
                                    <small>{cognitiveChoiceBlocked}</small>
                                  )}
                                </div>
                              )}
                              {draft.scriptGeneration && (
                                <span
                                  className="composer-intent"
                                  data-testid="script-input-reference"
                                >
                                  剧本请求 ·{" "}
                                  {client.scriptVersionTitle(
                                    draft.scriptGeneration.productionId,
                                    draft.scriptGeneration.targetId,
                                    draft.scriptGeneration.baseRevision,
                                  ) ?? draft.scriptGeneration.targetId}{" "}
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
                                    composerScopeTitle +
                                    (draft.revision
                                      ? " · v" + draft.revision
                                      : "")
                                  }
                                >
                                  <Link2 />
                                  {composerScopeTitle}
                                  {draft.revision
                                    ? " · v" + draft.revision
                                    : ""}
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
                              {artifact && draft.selection && (
                                <button
                                  type="button"
                                  disabled={
                                    !!draft.continuation ||
                                    !draft.body.trim() ||
                                    sending ||
                                    !client.online
                                  }
                                  onClick={() => {
                                    input.current?.focus();
                                    void send(true);
                                  }}
                                >
                                  保存为批注
                                </button>
                              )}
                            </div>
                          </ComposerScope>
                        }
                        media={
                          <>
                            <MessageAttachments
                              variant="menu"
                              capture={{
                                title: `截图输入（按住 ${/Mac/.test(navigator.platform) ? "Option" : "Alt"} 点击隐藏 Morphz）`,
                                disabled:
                                  cognitiveInputBlocked ||
                                  sending ||
                                  !!draft.pendingSupplement ||
                                  !!uploadingDrafts[contextKey] ||
                                  !client.online ||
                                  (draft.attachments?.length ?? 0) >= 8,
                                onSelect: inputTools.openCapture,
                              }}
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
                                cognitiveInputBlocked ||
                                sending ||
                                !!draft.pendingSupplement ||
                                !!uploadingDrafts[contextKey] ||
                                !client.online
                              }
                              onBusy={inputTools.attachmentsBusyChanged}
                              onChange={inputTools.attachmentsChanged}
                              onError={inputTools.attachmentError}
                            />
                          </>
                        }
                        microphone={
                          <button
                            className="icon-button"
                            aria-label="语音输入"
                            aria-pressed={speechRecording}
                            data-recording={speechRecording || undefined}
                            title={speechRecording ? "停止听写" : "开始听写"}
                            disabled={
                              (cognitiveInputBlocked ||
                                sending ||
                                !!draft.pendingSupplement ||
                                !client.online) &&
                              !speechRecording
                            }
                            onClick={inputTools.toggleDictation}
                          >
                            {speechRecording ? <Square /> : <Mic />}
                          </button>
                        }
                        settings={
                          <ComposerExecutionSettings
                            sessionIdentity={client.boot!.csrfToken}
                            current={client.boot!.runtime.model}
                            model={draft.model}
                            reasoning={draft.reasoningEffort}
                            continuation={!!draft.continuation}
                            sessionScope={
                              selectedDraft
                                ? undefined
                                : {
                                    projectId: project.id,
                                    conversationId,
                                  }
                            }
                            directoryCount={
                              directoryState.scope === directoryScope
                                ? directoryState.grants.length
                                : 0
                            }
                            directoryReady={
                              !canAuthorizeDirectories ||
                              (directoryState.scope === directoryScope &&
                                directoryState.ready)
                            }
                            disabled={
                              cognitiveInputBlocked ||
                              sending ||
                              !client.online ||
                              !client.boot!.runtime.connected ||
                              !!draft.annotation ||
                              !!draft.taskResult
                            }
                            onModelChange={(model) =>
                              updateDraft(
                                contextKey,
                                (current) => ({
                                  ...current,
                                  model: model || undefined,
                                }),
                                surfaceDraft,
                              )
                            }
                            onReasoningChange={(reasoningEffort) =>
                              updateDraft(
                                contextKey,
                                (current) => ({
                                  ...current,
                                  reasoningEffort,
                                }),
                                surfaceDraft,
                              )
                            }
                            permissionControls={
                              canAuthorizeDirectories ? (
                                <AgentDirectories
                                  variant="settings"
                                  key={`${client.boot!.csrfToken}:${directoryScope}`}
                                  projectId={project.id}
                                  conversationId={conversationId}
                                  identity={client.boot!.csrfToken}
                                  previewTarget={null}
                                  disabled={
                                    sending ||
                                    !client.online ||
                                    !!draft.continuation
                                  }
                                  onSelecting={
                                    inputTools.directorySelectingChanged
                                  }
                                  onState={setDirectoryState}
                                  onError={inputTools.attachmentError}
                                />
                              ) : undefined
                            }
                          />
                        }
                        send={
                          <button
                            className="send"
                            title={
                              draft.continuation ||
                              draft.annotation ||
                              draft.taskResult
                                ? undefined
                                : `默认打断当前会话思考中的回复；${/Mac/.test(navigator.platform) ? "Option" : "Alt"}+Enter 或按住该键点击并发发送；工具执行不取消`
                            }
                            aria-label={
                              draft.continuation
                                ? draft.pendingSupplement
                                  ? "核对补充送达"
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
                              cognitiveInputBlocked ||
                              (selectedDraft &&
                                client.boot?.localSavedInputIds.includes(
                                  selectedDraft.inputId,
                                )) ||
                              !!uploadingDrafts[contextKey] ||
                              (!draft.continuation &&
                                canAuthorizeDirectories &&
                                (directoryState.scope !== directoryScope ||
                                  !directoryState.ready)) ||
                              !client.online
                            }
                            onClick={(event) =>
                              !cognitiveInputBlocked &&
                              void send(
                                draft.annotation === true,
                                event.altKey ? "parallel" : "interrupt",
                              )
                            }
                          >
                            {draft.annotation && !draft.continuation ? (
                              <MessageSquarePlus />
                            ) : (
                              <ArrowUp />
                            )}
                          </button>
                        }
                      />
                    </section>
                  ) : (
                    <button
                      ref={toggle}
                      className="composer-reopen"
                      aria-controls="global-composer"
                      aria-expanded={false}
                      onClick={showInput}
                    >
                      <MessageCircle />向 {agentName} 输入<kbd>{shortcut}</kbd>
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
        {(executions || subjectView) &&
          !understandingOpen &&
          !collaborationVisible && (
            <SubjectSidebar
              client={client}
              profile={profile}
              presence={presence}
              allowMotion={prefs.motion !== "reduce"}
              view={subjectView ?? "activity"}
              onView={selectSubjectView}
              layout={rightInspector}
              onResize={resizeInspector}
              onClose={closeInspector}
              detail={!!(executions?.inputId || executions?.threadId)}
              onBack={subjectInspector.back}
              onInspect={subjectInspector.selectScope}
              onOpen={openUser}
              onModels={
                client.boot!.capabilities.modelSettings
                  ? () => setSettingsSection("models")
                  : undefined
              }
              onConnection={() => setConnectionOpen(true)}
              directories={directoryState}
              directoryScope={directoryScope}
              directoryAvailable={canAuthorizeDirectories}
              onDirectories={() => {
                showInput();
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLButtonElement>(
                      ".composer-settings-trigger",
                    )
                    ?.click(),
                );
              }}
              activity={
                <ExecutionSidebar
                  embedded
                  key={
                    activityScope.threadId ??
                    activityScope.inputId ??
                    "overview"
                  }
                  client={client}
                  scope={activityScope}
                  allWork={allActivity}
                  onAllWorkChange={subjectInspector.setAllActivity}
                  viewOptions={inspectorViewOptions}
                  layout={rightInspector}
                  onResize={resizeInspector}
                  onClose={closeInspector}
                  onSelect={subjectInspector.selectExecution}
                  onSupplement={
                    client.boot!.capabilities.directedInput
                      ? supplement
                      : undefined
                  }
                  onOpen={openUser}
                  onOpenScript={openScript}
                  onRefresh={async () => {
                    await client.refresh();
                  }}
                  overviewLeading={(allWork) => (
                    <SubjectObjectives
                      client={client}
                      scope={activityScope}
                      allWork={allWork}
                      onSelect={subjectInspector.selectExecution}
                    />
                  )}
                />
              }
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
          <ObjectAnnotationsPanel
            artifact={artifact}
            annotationResult={annotationResult}
            annotations={annotations}
            authorName={(actantId) => actorName(state, actantId)}
            viewOptions={inspectorViewOptions}
            context={contextTitle}
            focusOnMount={!sentInputFocusPending}
            layout={rightInspector}
            onResize={resizeInspector}
            onClose={closeInspector}
          />
        )}
        {notice && !conversationVisible && (
          <WorkspaceNotice message={notice} onDismiss={() => setNotice("")} />
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
          prepareCreated={
            creating === "project" ? prepareCreatedProject : undefined
          }
          onCreated={(id, kind) => {
            setCreating(null);
            if (kind !== "project") void openObject(project.id, id);
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
      {cognitiveChoice &&
        cognitiveChoice.scopeKey === cognitiveChoiceScopeKey && (
          <CognitiveApplicationPicker
            entries={cognitiveApplications.filter(
              (entry) =>
                !cognitiveChoice.entryKey ||
                entry.key === cognitiveChoice.entryKey,
            )}
            current={cognitiveInputTarget}
            disabledReason={cognitiveChoiceBlocked}
            onChoose={(target) =>
              chooseInputApplication(
                target,
                cognitiveChoice.scopeKey,
                cognitiveChoice.contextKey,
              )
            }
            onClose={() => setCognitiveChoice(null)}
          />
        )}
      {settingsSection !== null && (
        <SettingsDialog
          client={client}
          profile={profile}
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
              speech.modal ? undefined : inputTools.transcriptChanged
            }
            client={client}
            scope={speech.scope}
            title={speech.title}
            onClose={closeSpeech}
            onInsert={inputTools.transcriptInserted}
          />
        )}
      {capture && (
        <CaptureDialog
          client={client}
          {...capture}
          onClose={inputTools.closeCapture}
          onAttach={inputTools.captureAttached}
          onSaved={inputTools.captureSaved}
        />
      )}
      {searchOpen && (
        <SearchDocuments
          client={client}
          onClose={() => setSearchOpen(false)}
          onOpen={openUser}
          onQuote={prepareSearchQuote}
        />
      )}
    </div>,
  );
}
