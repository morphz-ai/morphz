import {
  applicationFor,
  spaceKind,
  type Workspace,
} from "../../../../packages/core/src/model.js";
import {
  objectsApplication,
  readerApplication,
} from "../../../../packages/core/src/applications.js";
import { projectStatus } from "../../../../packages/core/src/projects.js";
import type { TextQuote } from "../../../../packages/core/src/text-quotes.js";

export type WorkSurfaceView =
  "dialogue" | "inbox" | "content" | "desk" | "projects";

export type WorkSurfacePreferences = {
  view: WorkSurfaceView;
  projectId: string;
  projectOpen: boolean;
  artifactId: string | null;
  applications?: Record<string, string | null>;
  selectedConversations?: Record<string, string>;
  scriptLocation?: { productionId: string } | null;
};

type ConversationDraft = { id: string; projectId: string };
type ScriptEntry = { id: string; projectId: string; title: string };

export type WorkSurfaceInput<
  Draft extends ConversationDraft,
  Script extends ScriptEntry,
> = {
  state: Workspace | undefined;
  prefs: WorkSurfacePreferences;
  principalId: string;
  teamAuthentication: boolean;
  scriptLibrary: readonly Script[];
  contentScope: string;
  conversationDrafts: Readonly<Record<string, Draft>>;
  restoredPlace: { artifactId: string | null } | null;
};

/** Derive the visible work surface without changing its objects or routing.
 * The work owner, conversation, and local view keys are distinct identities. */
export function deriveWorkSurface<
  Draft extends ConversationDraft,
  Script extends ScriptEntry,
>({
  state,
  prefs,
  principalId,
  teamAuthentication,
  scriptLibrary,
  contentScope,
  conversationDrafts,
  restoredPlace,
}: WorkSurfaceInput<Draft, Script>) {
  const personalSpace = (kind: "desk" | "inbox" | "dialogue") =>
    state?.projects.find(
      (p) => p.kind === kind && p.ownerPrincipalId === principalId,
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
  // An open object owns the next input; it does not retarget the shared
  // conversation or any already admitted activation.
  const deliveredProduction = prefs.scriptLocation
    ? scriptLibrary.find(
        (entry) => entry.id === prefs.scriptLocation!.productionId,
      )
    : undefined;
  const deliveredScript = deliveredProduction
    ? { production: deliveredProduction }
    : null;
  const project =
    state?.projects.find(
      (p) => p.id === deliveredScript?.production?.projectId,
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
  const sharedDefault = !teamAuthentication;
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
        : (state?.applicationInstances.find(
            (i) =>
              i.id === prefs.applications?.[project.id] &&
              i.workspaceId === project.id &&
              i.status === "open",
          )?.id ??
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
  const legacyContextKey =
    (navigationProject?.id ?? "") +
    ":" +
    (artifact?.id ?? activeInstance?.id ?? prefs.view);
  const quoteKey = conversationId + ":quotes";
  const dialogueCanvas =
    prefs.view === "dialogue" && !artifact && !applicationWorkspaceOpen;

  return {
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
    exchangeKey,
    legacyContextKey,
    quoteKey,
    dialogueCanvas,
  };
}

/** Default conversation drafts alone can read their old surface key. */
export function readWorkSurfaceDraft<T extends { textQuotes?: TextQuote[] }>(
  surface: {
    contextKey: string;
    legacyContextKey: string;
    quoteKey: string;
    conversationId: string;
    defaultConversation: string | undefined;
  },
  drafts: Readonly<Record<string, T>>,
  empty: T,
) {
  const surfaceDraft =
    drafts[surface.contextKey] ??
    (surface.conversationId === surface.defaultConversation
      ? drafts[surface.legacyContextKey]
      : undefined) ??
    empty;
  return {
    surfaceDraft,
    // Only selections cross surfaces within the same conversation.
    draft: {
      ...surfaceDraft,
      textQuotes: drafts[surface.quoteKey]?.textQuotes ?? [],
    },
  };
}

export function workSurfaceConversationId(
  surface: {
    project: { id: string } | undefined;
    conversationId: string;
    defaultConversation: string | undefined;
  },
  selectedConversations: Readonly<Record<string, string>> | undefined,
  workspaceId: string,
) {
  return workspaceId === surface.project?.id
    ? surface.conversationId
    : (selectedConversations?.[workspaceId] ??
        surface.defaultConversation ??
        workspaceId);
}
