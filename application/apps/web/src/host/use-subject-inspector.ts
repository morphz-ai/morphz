import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ExecutionScope } from "../../../../packages/core/src/execution.js";
import type { Workspace } from "../../../../packages/core/src/model.js";
import type { WorkspaceClient } from "../client.js";
import type { SubjectView } from "../subject-sidebar-model.js";

type InspectorSelection =
  | { view: "execution"; scope: ExecutionScope }
  | { view: "understanding" | "collaboration" };
type SubjectPreferences = {
  subjectTab?: SubjectView;
  subjectOpen: boolean;
  collaboration: boolean;
};
type InspectorMemory = RefObject<Map<string, InspectorSelection>>;

/** These registrations stay at their original host seams. Grouping the owner
 * must not move a state or layout effect across unrelated host lifecycles. */
export function useSubjectActivityState() {
  const [allActivity, setAllActivity] = useState(false);
  return { allActivity, setAllActivity };
}

export function useSubjectInspectionState() {
  const [executions, setExecutions] = useState<ExecutionScope | null>(null);
  const [understandingOpen, setUnderstandingOpen] = useState(false);
  return { executions, setExecutions, understandingOpen, setUnderstandingOpen };
}

export function useSubjectCollaborationState() {
  const [mobileCollaboration, setMobileCollaboration] = useState(false);
  return { mobileCollaboration, setMobileCollaboration };
}

export function useSubjectInspectorMemory(): InspectorMemory {
  return useRef(new Map<string, InspectorSelection>());
}

// Persist only the subject's presentation, never a concrete execution scope.
export function subjectInspectorView(preferences: SubjectPreferences) {
  return preferences.subjectOpen
    ? (preferences.subjectTab ?? "activity")
    : null;
}

export function subjectCollaborationVisible({
  executions,
  subjectView,
  understandingOpen,
  artifact,
  compact,
  mobileCollaboration,
  preferences,
}: {
  executions: ExecutionScope | null;
  subjectView: SubjectView | null;
  understandingOpen: boolean;
  artifact: unknown;
  compact: boolean;
  mobileCollaboration: boolean;
  preferences: SubjectPreferences;
}) {
  return (
    !executions &&
    !subjectView &&
    !understandingOpen &&
    !!artifact &&
    (compact ? mobileCollaboration : preferences.collaboration)
  );
}

export function subjectInspectorOpen({
  executions,
  subjectView,
  understandingOpen,
  collaborationVisible,
}: {
  executions: ExecutionScope | null;
  subjectView: SubjectView | null;
  understandingOpen: boolean;
  collaborationVisible: boolean;
}) {
  return (
    !!executions || !!subjectView || understandingOpen || collaborationVisible
  );
}

export function subjectInspectorPresentation({
  executions,
  understandingOpen,
  collaborationVisible,
  conversationProjectId,
  conversationId,
}: {
  executions: ExecutionScope | null;
  understandingOpen: boolean;
  collaborationVisible: boolean;
  conversationProjectId: string;
  conversationId: string;
}) {
  const inspectorTitle = understandingOpen
    ? "已发布摘要"
    : collaborationVisible
      ? "对象批注"
      : "Morphz 信息";
  const activityScope = executions ?? {
    projectId: conversationProjectId,
    conversationId,
    artifactId: null,
  };
  return { inspectorTitle, activityScope };
}

export function useSubjectInspectorCommit(
  inspectorSelections: InspectorMemory,
  {
    contextKey,
    executions,
    understandingOpen,
    collaborationVisible,
  }: {
    contextKey: string;
    executions: ExecutionScope | null;
    understandingOpen: boolean;
    collaborationVisible: boolean;
  },
) {
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
}

type InspectionState = ReturnType<typeof useSubjectInspectionState>;
type CollaborationState = ReturnType<typeof useSubjectCollaborationState>;
type Prefer = (change: Partial<SubjectPreferences>) => void;

/** Available before the host's startup return. Focus scheduling and DOM
 * ownership stay with the host; this callback is synchronous and last. */
export function createSubjectInspectorCloseCommand({
  inspection: { setExecutions, setUnderstandingOpen },
  collaboration: { setMobileCollaboration },
  prefer,
  onClosedFocus,
}: {
  inspection: InspectionState;
  collaboration: CollaborationState;
  prefer: Prefer;
  onClosedFocus(): void;
}) {
  return function closeInspector() {
    setExecutions(null);
    setUnderstandingOpen(false);
    setMobileCollaboration(false);
    prefer({ collaboration: false, subjectOpen: false });
    onClosedFocus();
  };
}

/** Commands capture this render's preferences, provenance and history Client.
 * Construction performs no reads/writes. No latest-state/epoch policy is added
 * to the original history lookup or its late completion behavior. */
export function createSubjectInspectorCommands({
  activity: { setAllActivity },
  inspection: { executions, setExecutions, setUnderstandingOpen },
  collaboration: { mobileCollaboration, setMobileCollaboration },
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
  close,
}: {
  activity: ReturnType<typeof useSubjectActivityState>;
  inspection: InspectionState;
  collaboration: CollaborationState;
  rememberedInspector: InspectorSelection | undefined;
  workspace: Pick<Workspace, "projects" | "inputs">;
  historyClient: Pick<WorkspaceClient, "loadHistoryUntil" | "getSnapshot">;
  preferences: SubjectPreferences;
  conversationProjectId: string;
  conversationId: string;
  compact: boolean;
  prefer: Prefer;
  keepExchangeOpen(): void;
  onNotice(message: string): void;
  close(): void;
}) {
  const openExecutions = () => {
    prefer({ subjectTab: "activity", subjectOpen: true });
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
  const openCollaboration = () => {
    setExecutions(null);
    setUnderstandingOpen(false);
    setMobileCollaboration(true);
    prefer({ collaboration: true, subjectOpen: false });
  };
  const show = () => {
    if (prefs.subjectTab && prefs.subjectTab !== "activity") {
      selectSubject(prefs.subjectTab);
      return;
    }
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
      prefer({
        collaboration: false,
        subjectTab: "activity",
        subjectOpen: true,
      });
      setExecutions(rememberedInspector.scope);
    } else {
      selectSubject(prefs.subjectTab ?? "activity");
    }
  };
  function selectSubject(view: SubjectView) {
    setUnderstandingOpen(false);
    setMobileCollaboration(false);
    prefer({ collaboration: false, subjectTab: view, subjectOpen: true });
    if (view === "activity")
      setExecutions(
        (current) =>
          current ?? {
            projectId: conversationProjectId,
            conversationId,
            artifactId: null,
          },
      );
  }
  function openFromLogo(view: SubjectView) {
    selectSubject(view);
    if (view === "activity") {
      // The mark represents the one subject, not the selected project or an
      // old message detail. Use the existing authorized all-work projection.
      setAllActivity(true);
      setExecutions({
        projectId: conversationProjectId,
        conversationId,
        artifactId: null,
      });
    }
  }
  const inspectExecution = async (id: string) => {
    let source = state.inputs.find((i) => i.id === id);
    if (!source) {
      try {
        if (await client.loadHistoryUntil(id))
          source = client
            .getSnapshot()
            ?.workspace.inputs.find((i) => i.id === id);
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : "原消息暂时无法读取。",
        );
        return;
      }
    }
    if (!source) {
      setNotice("原消息暂时不在已加载的记录中。");
      return;
    }
    keepExchangeOpen();
    prefer({ subjectTab: "activity", subjectOpen: true });
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
  const back = () =>
    setExecutions({
      projectId: executions?.projectId ?? conversationProjectId,
      conversationId: executions?.conversationId ?? conversationId,
      artifactId: null,
    });
  const selectScope = (scope: ExecutionScope) => {
    selectSubject("activity");
    setExecutions(scope);
  };
  const toggleCollaboration = () => {
    setUnderstandingOpen(false);
    setExecutions(null);
    prefer({ subjectOpen: false });
    compact
      ? setMobileCollaboration(!mobileCollaboration)
      : prefer({ collaboration: !prefs.collaboration });
  };
  return {
    close,
    openExecutions,
    openCollaboration,
    show,
    selectSubject,
    openFromLogo,
    inspectExecution,
    back,
    selectScope,
    toggleCollaboration,
    // These child callbacks intentionally remain the original setter identity
    // and do not acquire selectSubject/preference/keep-open semantics.
    selectExecution: setExecutions,
    setAllActivity,
  };
}
