// Fixed 85a50934 oracle: the old App bodies/expressions, not the new owner.
// Binding adaptations are limited to the former render/ref/setter dependencies.
import {
  useState,
  useRef,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Workspace } from "../../packages/core/src/model.js";
import type { ExecutionScope } from "../../packages/core/src/execution.js";
import type { SubjectView } from "../../apps/web/src/subject-sidebar-model.js";

export type FixedInspectorSelection =
  | { view: "execution"; scope: ExecutionScope }
  | { view: "understanding" | "collaboration" };
export type FixedInspectorPreferences = {
  subjectTab?: SubjectView;
  subjectOpen: boolean;
  collaboration: boolean;
  inspectorWidth?: number;
};
export type FixedInspectorFacts = {
  prefs: FixedInspectorPreferences;
  executions: ExecutionScope | null;
  understandingOpen: boolean;
  mobileCollaboration: boolean;
  compact: boolean;
  artifact: Workspace["artifacts"][number] | undefined;
  conversationProjectId: string;
  conversationId: string;
};
export type FixedInspectorBindings = FixedInspectorFacts & {
  state: Pick<Workspace, "projects" | "inputs">;
  contextKey: string;
  inspectorSelections: { current: Map<string, FixedInspectorSelection> };
  client: {
    loadHistoryUntil(id: string): Promise<boolean>;
    getSnapshot(): { workspace: Pick<Workspace, "inputs"> } | null | undefined;
  };
  setExecutions: Dispatch<SetStateAction<ExecutionScope | null>>;
  setUnderstandingOpen(value: boolean): void;
  setMobileCollaboration(value: boolean): void;
  setAllActivity(value: boolean): void;
  setNotice(value: string): void;
  prefer(value: Partial<FixedInspectorPreferences>): void;
  keepExchangeOpen(): void;
  input: { current: HTMLTextAreaElement | null };
  toggle: { current: HTMLButtonElement | null };
  document: Pick<Document, "querySelector">;
  requestAnimationFrame: typeof requestAnimationFrame;
};

// Old useState/useRef initializers and the old effect/dependency tuple live
// here solely to mount the independent baseline with real React lifecycles.
export function useFixedSubjectInspectorState() {
  const [allActivity, setAllActivity] = useState(false);
  const [executions, setExecutions] = useState<ExecutionScope | null>(null);
  const [understandingOpen, setUnderstandingOpen] = useState(false);
  const [mobileCollaboration, setMobileCollaboration] = useState(false);
  const inspectorSelections = useRef(
    new Map<string, FixedInspectorSelection>(),
  );
  return {
    allActivity,
    setAllActivity,
    executions,
    setExecutions,
    understandingOpen,
    setUnderstandingOpen,
    mobileCollaboration,
    setMobileCollaboration,
    inspectorSelections,
  };
}
export function useFixedSubjectInspectorCommit(
  inspectorSelections: FixedInspectorBindings["inspectorSelections"],
  {
    contextKey,
    executions,
    understandingOpen,
    collaborationVisible,
  }: Pick<
    FixedInspectorBindings,
    "contextKey" | "executions" | "understandingOpen"
  > & { collaborationVisible: boolean },
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

export function deriveFixedSubjectInspector({
  prefs,
  executions,
  understandingOpen,
  mobileCollaboration,
  compact,
  artifact,
  conversationProjectId,
  conversationId,
}: FixedInspectorFacts) {
  const subjectView = prefs.subjectOpen
    ? (prefs.subjectTab ?? "activity")
    : null;
  const collaborationVisible =
    !executions &&
    !subjectView &&
    !understandingOpen &&
    !!artifact &&
    (compact ? mobileCollaboration : prefs.collaboration);
  const inspectorOpen =
    !!executions || !!subjectView || understandingOpen || collaborationVisible;
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
  return {
    subjectView,
    collaborationVisible,
    inspectorOpen,
    inspectorTitle,
    activityScope,
  };
}

export function createFixedSubjectInspector({
  prefs,
  executions,
  understandingOpen,
  mobileCollaboration,
  compact,
  artifact,
  conversationProjectId,
  conversationId,
  state,
  contextKey,
  inspectorSelections,
  client,
  setExecutions,
  setUnderstandingOpen,
  setMobileCollaboration,
  setAllActivity,
  setNotice,
  prefer,
  keepExchangeOpen,
  input,
  toggle,
  document,
  requestAnimationFrame,
}: FixedInspectorBindings) {
  const { collaborationVisible } = deriveFixedSubjectInspector({
    prefs,
    executions,
    understandingOpen,
    mobileCollaboration,
    compact,
    artifact,
    conversationProjectId,
    conversationId,
  });
  function rememberInspector() {
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
  }
  function closeInspector() {
    setExecutions(null);
    setUnderstandingOpen(false);
    setMobileCollaboration(false);
    prefer({ collaboration: false, subjectOpen: false });
    requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>(".inspector-toggle");
      if (trigger?.getClientRects().length) trigger.focus();
      else (input.current ?? toggle.current)?.focus();
    });
  }
  const resizeInspector = (inspectorWidth: number) =>
    prefer({ inspectorWidth });
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
  const rememberedInspector = inspectorSelections.current.get(contextKey);
  const showInspector = () => {
    if (prefs.subjectTab && prefs.subjectTab !== "activity") {
      selectSubjectView(prefs.subjectTab);
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
      selectSubjectView(prefs.subjectTab ?? "activity");
    }
  };
  function selectSubjectView(view: SubjectView) {
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
  function openSubjectFromLogo(view: SubjectView) {
    selectSubjectView(view);
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
  const onBack = () =>
    setExecutions({
      projectId: executions?.projectId ?? conversationProjectId,
      conversationId: executions?.conversationId ?? conversationId,
      artifactId: null,
    });
  const onInspect = (scope: ExecutionScope) => {
    selectSubjectView("activity");
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
    rememberInspector,
    closeInspector,
    resizeInspector,
    openExecutions,
    openCollaboration,
    showInspector,
    selectSubjectView,
    openSubjectFromLogo,
    inspectExecution,
    onBack,
    onInspect,
    toggleCollaboration,
  };
}
