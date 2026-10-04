import { useEffect, useState } from "react";
import type { scopedStorage } from "../local-preferences.js";
import {
  discussionId,
  spaceKind,
  type Workspace,
} from "../../../../packages/core/src/model.js";
import type { Project } from "../../../../packages/core/src/projects.js";
import type { WorkspaceClient } from "../client.js";
import type {
  InputDraft,
  createExchangeDraftCommands,
} from "./exchange-drafts.js";
import type {
  CurrentDestination,
  NavigationIntent,
} from "./use-workspace-navigation.js";
import type { Preferences } from "./use-workspace-navigation-host.js";

type ScopeWorkspace = Pick<Workspace, "conversations" | "inputs">;
type CapturedConversationClient = Pick<WorkspaceClient, "boot">;
export type ProjectConversationRead = {
  state: ScopeWorkspace | undefined;
  client: CapturedConversationClient;
};

type ScopeStorage = Pick<ReturnType<typeof scopedStorage>, "readLocal">;

// These three registrations replace the original App seams independently.
// They preserve private-tree lifetime and hook/effect order, not another store.
export function usePrivateProjectContentScope({ readLocal }: ScopeStorage) {
  // The catalog and its composer share a destination. Keep the existing
  // catalog preference key so returning/reloading restores the same scope.
  const [contentScope, setContentScope] = useState(
    () =>
      readLocal<{ scope?: string }>("library-view:all-content", {}).scope ??
      "all",
  );
  return { contentScope, setContentScope };
}
export function useCommittedConversationDraftRetirement(
  draftCommands: Pick<
    ReturnType<typeof createExchangeDraftCommands>,
    "retireCommittedConversations"
  >,
  state: Pick<Workspace, "conversations"> | undefined,
) {
  useEffect(() => {
    draftCommands.retireCommittedConversations(state?.conversations);
  }, [state?.conversations]);
}
export function usePrivateConversationHistorySelection({
  client,
  selectedDraft,
  conversationProjectId,
  conversationId,
}: {
  client: Pick<WorkspaceClient, "selectHistoryScope">;
  selectedDraft: { id: string } | undefined;
  conversationProjectId: string;
  conversationId: string;
}) {
  useEffect(() => {
    // An unsent draft has no Platform conversation or Runtime Session yet.
    // Keep the last authorized history scope until its first send commits;
    // reading the reserved draft ID would make normal refresh fail with 404.
    if (!selectedDraft && conversationProjectId && conversationId)
      void client.selectHistoryScope({
        projectId: conversationProjectId,
        conversationId,
      });
  }, [conversationProjectId, conversationId, selectedDraft?.id]);
}

// Only the two existing projection recipes. In particular, a locally saved
// input is not evidence that a named conversation has started on Platform.
export function startedProjectConversationIds({
  state,
  client,
}: ProjectConversationRead) {
  return new Set([
    ...(state?.conversations
      .filter((c) => c.id !== c.projectId)
      .map((c) => c.id) ?? []),
    ...(state?.inputs
      .filter((input) => !client.boot?.localSavedInputIds.includes(input.id))
      .map(discussionId) ?? []),
    ...(client.boot?.runtime.messages.map(discussionId) ?? []),
  ]);
}

// Preserve the old render-local predicate, including lazy reads when queried.
// No extra draft flag is stored, and no trimming of attachments/quotes occurs.
export function projectConversationDraftPresence({
  state,
  client,
  drafts,
}: ProjectConversationRead & { drafts: Record<string, InputDraft> }) {
  return (id: string) =>
    state?.inputs.some(
      (input) =>
        discussionId(input) === id &&
        client.boot?.localSavedInputIds.includes(input.id),
    ) ||
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
}

type DraftCommands = Pick<
  ReturnType<typeof createExchangeDraftCommands>,
  "createConversation" | "discardConversation" | "restoreConversation"
>;
type Projection = NonNullable<ReturnType<WorkspaceClient["getSnapshot"]>>;
export type PrivateProjectConversationPorts = {
  // Original objects/scalars from this WorkspaceApp render, never a new latest
  // mirror. Only prepareCreatedProject's returned continuation reads authority.
  render: {
    state: Pick<Workspace, "conversations"> | undefined;
    prefs: Pick<Preferences, "view" | "projectOpen" | "interactions">;
    navigationProject: Pick<Project, "id"> | undefined;
    project: Pick<Project, "id"> | undefined;
    sharedDefault: boolean;
    defaultConversation: string | undefined;
    conversationId: string | undefined;
    hasConversationDraft(id: string): boolean | undefined;
    personalSpace(kind: "dialogue"): Project | undefined;
  };
  origin: { isActive(): boolean };
  draftCommands: DraftCommands;
  sendPending: { readonly current: boolean };
  navigation: {
    navigationGeneration: { readonly current: number };
    isCurrent(generation: number): boolean;
    setWebsiteIntent(value: null): void;
    prefer(change: Partial<Preferences>): void;
    continueNavigation(
      change: Partial<Preferences>,
      intent: NavigationIntent,
      destination: CurrentDestination,
    ): void;
  };
  host: {
    captureCommit(): CurrentDestination;
    currentProjection(): Projection | null;
  };
  privateUi: {
    setContentScope(scope: string): void;
    setCreating(value: null): void;
    setExecutions(value: null): void;
  };
  exchange: {
    keepExchangeOpen(): void;
    requestConversationFocus(id: string, generation: number): void;
  };
  onNotice(message: string): void;
};

// One coherent private scope controller. Construction only borrows values and
// functions; it reads no authority, requests, storage, ref.current or DOM.
export function createPrivateProjectConversationScope({
  render,
  origin,
  draftCommands,
  sendPending,
  navigation,
  host,
  privateUi,
  exchange,
  onNotice: setNotice,
}: PrivateProjectConversationPorts) {
  const {
    state,
    prefs,
    navigationProject,
    project,
    sharedDefault,
    defaultConversation,
    conversationId,
    hasConversationDraft,
    personalSpace,
  } = render;
  const {
    navigationGeneration,
    isCurrent,
    setWebsiteIntent,
    prefer,
    continueNavigation,
  } = navigation;
  const { setContentScope, setCreating, setExecutions } = privateUi;
  const { keepExchangeOpen, requestConversationFocus } = exchange;

  function selectContentScope(scope: string) {
    if (!origin.isActive()) return;
    setContentScope(scope);
    // Treat a destination change as navigation: stale open/picker callbacks
    // must not restore the previous scope or focus. Drafts and grants remain
    // keyed by their original workspace, not copied into the new destination.
    prefer({ artifactId: null, scriptLocation: null });
  }
  function selectConversation(workspaceId: string, id: string, focus = false) {
    if (!origin.isActive()) return;
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
    setExecutions(null);
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
      requestConversationFocus(id, navigationGeneration.current);
    }
  }
  async function createProjectConversation(workspaceId: string, title: string) {
    // Starting to type is local navigation, not a server-side conversation.
    // Repeated clicks reuse the unfinished draft; the first input commits both.
    const pending = draftCommands.createConversation(workspaceId, title);
    selectConversation(workspaceId, pending.id, true);
  }
  function discardConversationDraft(id: string) {
    if (sendPending.current) {
      setNotice("消息正在提交，请等待结果后整理草稿。");
      return;
    }
    draftCommands.discardConversation(
      id,
      () => state?.conversations.find((c) => c.id === id),
      (conversation) => {
        if (conversationId === id) openProject(conversation.projectId);
      },
    );
  }
  function restoreConversationDraft(id: string) {
    draftCommands.restoreConversation(
      id,
      hasConversationDraft,
      (conversation) => {
        selectConversation(conversation.projectId, id, true);
      },
    );
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
  function prepareCreatedProject() {
    const intent = { generation: navigationGeneration.current };
    const lifetime = host.captureCommit();
    const active = origin.isActive();
    return (id: string, kind: string) => {
      if (!active || kind !== "project") return;
      const destination: CurrentDestination = (current) =>
        lifetime(current) &&
        isCurrent(intent.generation) &&
        current.workspace.projects.some(
          (value) =>
            value.id === id &&
            spaceKind(value) === "project" &&
            !value.deletedAt,
        );
      const current = host.currentProjection();
      if (!current || !destination(current)) return;
      const conversation = current.capabilities.teamAuthentication
        ? id
        : (current.workspace.projects.find(
            (value) =>
              value.kind === "dialogue" &&
              value.ownerPrincipalId === current.principalId,
          )?.id ?? id);
      // This is the original default-conversation route only. No old child
      // draft, focus, notice or creation setter is transferred to the new tree.
      continueNavigation(
        {
          view: "projects",
          projectId: id,
          projectOpen: true,
          artifactId: null,
          selectedConversations: { [id]: conversation },
          interactions: {
            [id]: prefs.interactions?.[id] === "history" ? "history" : "recent",
          },
        },
        intent,
        destination,
      );
    };
  }
  return {
    selectContentScope,
    selectConversation,
    createProjectConversation,
    discardConversationDraft,
    restoreConversationDraft,
    openProject,
    prepareCreatedProject,
  };
}
