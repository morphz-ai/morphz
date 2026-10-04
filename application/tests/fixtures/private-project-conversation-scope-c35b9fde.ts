// Fixed algorithms independently extracted from actual Git c35b9fde581e06a9ef1800103438b9b25cc3cdd6.
// Runtime tests use this fixture and frozen raw hashes, not Git history or shell.
import { useEffect, useState } from "react";
import {
  discussionId,
  spaceKind,
  type Workspace,
} from "../../packages/core/src/model.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type { scopedStorage } from "../../apps/web/src/local-preferences.js";
import type { createExchangeDraftCommands } from "../../apps/web/src/host/exchange-drafts.js";
import type { CurrentDestination } from "../../apps/web/src/host/use-workspace-navigation.js";
import type {
  PrivateProjectConversationPorts,
  ProjectConversationRead,
} from "../../apps/web/src/host/private-project-conversation-scope.js";

export const fixedProjectConversationRevision =
  "c35b9fde581e06a9ef1800103438b9b25cc3cdd6";
export const fixedProjectConversationAppSha =
  "22188005fd1074e58486c9976c1e1d2f0230c0cca53e6903a32c89b79a6ff941";
export const fixedProjectConversationHashes = {
  selectContentScope:
    "6056651b2a27cb4489d61630f791e1c82da43e4604da17b2fb29978fee55154f",
  selectConversation:
    "ab04e8d7b137702ea0b687a1878ad3239b12ae97c96a1308a0e774671a9b9b91",
  createProjectConversation:
    "bcaafcd0f6c6bfd4c84bd662a23628948c65771593d6282ffbe5f32a952b8c6a",
  discardConversationDraft:
    "7308b6d2527bd11a4df330f286fedbe3738000064bb78a1071a6d118a2964662",
  restoreConversationDraft:
    "e1c01e2e22fae1f9a887784f4cff3c391ee4cb332eceda3802fa0225679f3a23",
  openProject:
    "2573417b162f26113ee413f40deec6406959b8334a99784cef09a780362608e4",
  prepareCreatedProject:
    "5896067cac96b2d75e68df84c592826834152323d30af08a25159d1b3b0b9ad6",
  startedConversations:
    "7d4cb6ba7d4cb1aca36deb486339eeff1f9c5639dce2662d93bc99cae392db57",
  hasConversationDraft:
    "c5818dd46f8193f9aab1ec512244b60cca9b96331e5cefab73d27d2aeab0690b",
  contentScope:
    "10149c6bce929f655ab29898c90047051a368e9bfb7caf799ccda16617dc80ee",
  retirement:
    "bd25799deb01c8161fb32cfe3711f21530f205326227c6c985f066051c431f56",
  history: "78e3f53d6e4fd305a54f52aa95e3e4bdfa1ff7d24d82425dedfc35eea226be71",
} as const;

export function createFixedPrivateProjectConversationScope({
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
  const { navigationGeneration, setWebsiteIntent, prefer, continueNavigation } =
    navigation;
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
        navigation.isCurrent(intent.generation) &&
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

export function fixedStartedProjectConversationIds({
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
export function fixedProjectConversationDraftPresence({
  state,
  client,
  drafts,
}: ProjectConversationRead & {
  drafts: Record<
    string,
    import("../../apps/web/src/host/exchange-drafts.js").InputDraft
  >;
}) {
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
export function useFixedPrivateProjectContentScope({
  readLocal,
}: Pick<ReturnType<typeof scopedStorage>, "readLocal">) {
  const [contentScope, setContentScope] = useState(
    () =>
      readLocal<{ scope?: string }>("library-view:all-content", {}).scope ??
      "all",
  );
  return { contentScope, setContentScope };
}
export function useFixedCommittedConversationDraftRetirement(
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
export function useFixedPrivateConversationHistorySelection({
  client,
  selectedDraft,
  conversationProjectId,
  conversationId,
}: {
  client: Pick<WorkspaceClient, "selectHistoryScope">;
  selectedDraft: { id: string } | undefined;
  conversationProjectId: string | undefined;
  conversationId: string | undefined;
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
