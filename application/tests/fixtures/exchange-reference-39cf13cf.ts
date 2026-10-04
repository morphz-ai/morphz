import type { Workspace } from "../../packages/core/src/model.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type { InputIntent } from "../../packages/core/src/input-intent.js";
import type { ReadingReference } from "../../packages/core/src/reader.js";
import type { TextQuote } from "../../packages/core/src/text-quotes.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type {
  createWorkspaceNavigationCommands,
  NavigationOwner,
} from "../../apps/web/src/host/use-workspace-navigation.js";

type NavigationCommands = ReturnType<typeof createWorkspaceNavigationCommands>;
type ReadingCompose = (
  id: string,
  revision: number,
  reference: ReadingReference,
  question: string,
) => { ok: boolean; error?: string };
export type FixedReferenceBindings = {
  conversationId: string;
  contextKey: string;
  state: Pick<Workspace, "artifacts"> | undefined;
  drafts: Record<string, InputDraft>;
  draft: InputDraft;
  sending: boolean;
  emptyDraft: InputDraft;
  origin: { isActive(): boolean };
  navigation: Pick<NavigationOwner, "isCurrent">;
  navigationGeneration: NavigationOwner["navigationGeneration"];
  client: Pick<WorkspaceClient, "resolveArtifact">;
  openObject: NavigationCommands["openObject"];
  openScriptLocation: NavigationCommands["openScriptLocation"];
  openBrowser: NavigationCommands["openBrowser"];
  activateApplication: NavigationCommands["activateApplication"];
  selectConversation(workspaceId: string, id: string, focus?: boolean): void;
  setWebsiteIntent(value: null): void;
  setDraft(key: string, value: InputDraft): void;
  updateDraft(key: string, update: (value: InputDraft) => InputDraft): void;
  keepExchangeOpen(): void;
  showInput(): void;
  setInteraction(mode: "recent"): void;
  requestConversationFocus(id: string, generation: number): void;
  revealTextQuote(quote: TextQuote): boolean;
  setQuoteReveal(value: { quote: TextQuote; token: string }): void;
  setNotice(message: string): void;
  window: { getSelection(): { removeAllRanges(): void } | null };
};

// Independently copied from Git 39cf13cf App.tsx. The four original declarations
// below retain their complete algorithms; only free variables are supplied here.
// No import, call or derived implementation from the new reference owner.
export function createFixedReferenceCommands(bindings: FixedReferenceBindings) {
  const {
    conversationId,
    contextKey,
    state,
    drafts,
    draft,
    sending,
    emptyDraft,
    origin,
    navigation,
    navigationGeneration,
    client,
    openObject,
    openScriptLocation,
    openBrowser,
    activateApplication,
    selectConversation,
    setWebsiteIntent,
    setDraft,
    updateDraft,
    keepExchangeOpen,
    showInput,
    setInteraction,
    requestConversationFocus,
    revealTextQuote,
    setQuoteReveal,
    setNotice,
    window,
  } = bindings;
  async function openTextQuote(quote: TextQuote) {
    if (!origin.isActive()) return;
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
      const generation = await openObject(
        source.projectId,
        source.artifactId,
        source.revision,
        source.kind === "artifact" ? source.page : undefined,
        source.kind === "reading",
        source.kind === "reading" ? source.location : undefined,
      );
      if (
        !origin.isActive() ||
        generation === undefined ||
        !navigation.isCurrent(generation)
      )
        return;
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.kind === "script") {
      const generation = await openScriptLocation({
        productionId: source.productionId,
        itemId: source.entryId,
        revision: source.revision,
        candidateId: source.candidateId,
      });
      if (
        !origin.isActive() ||
        generation === undefined ||
        !navigation.isCurrent(generation)
      )
        return;
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.kind === "web") {
      const generation = await openBrowser(source.url);
      if (
        !origin.isActive() ||
        generation === undefined ||
        !navigation.isCurrent(generation)
      )
        return;
      setQuoteReveal({ quote, token: crypto.randomUUID() });
    } else if (source.applicationInstanceId) {
      activateApplication(source.applicationInstanceId);
    } else setNotice("已保留所选原文；这个界面没有固定的内容位置。");
  }
  async function composeContent(id: string) {
    if (!origin.isActive()) return;
    const expectedNavigation = navigationGeneration.current;
    const target =
      state?.artifacts.find((a) => a.id === id) ??
      (await client.resolveArtifact(id));
    if (
      !origin.isActive() ||
      !navigation.isCurrent(expectedNavigation) ||
      !target
    )
      return;
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
      if (!origin.isActive() || !navigation.isCurrent(generation)) return;
      requestConversationFocus(conversationId, generation);
      keepExchangeOpen();
      setInteraction("recent");
    }
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
  return { openTextQuote, composeContent, composeReading, composeIntent };
}
