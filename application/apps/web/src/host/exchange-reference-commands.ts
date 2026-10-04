import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Workspace } from "../../../../packages/core/src/model.js";
import type { InputIntent } from "../../../../packages/core/src/input-intent.js";
import type { ReadingReference } from "../../../../packages/core/src/reader.js";
import type { TextQuote } from "../../../../packages/core/src/text-quotes.js";
import type { WorkspaceClient } from "../client.js";
import type { InputDraft } from "./exchange-drafts.js";
import type { useExchangeController } from "./use-exchange-controller.js";
import type {
  createWorkspaceNavigationCommands,
  NavigationOwner,
} from "./use-workspace-navigation.js";
import type { WorkspaceNavigationOrigin } from "./use-workspace-navigation-host.js";

type NavigationCommands = ReturnType<typeof createWorkspaceNavigationCommands>;
type ExchangeController = ReturnType<typeof useExchangeController>;
export type ReadingComposeCommand = (
  id: string,
  revision: number,
  reference: ReadingReference,
  question: string,
) => { ok: boolean; error?: string };

export type QuoteReveal = { quote: TextQuote; token: string } | null;

// Separate original registration seams retain the Host's hook/effect order.
export function useExchangeQuoteRevealState() {
  const [quoteReveal, setQuoteReveal] = useState<{
    quote: TextQuote;
    token: string;
  } | null>(null);
  return { quoteReveal, setQuoteReveal };
}

export function useExchangeQuoteRevealCommit(
  conversationId: string,
  setQuoteReveal: Dispatch<SetStateAction<QuoteReveal>>,
) {
  useEffect(() => setQuoteReveal(null), [conversationId]);
}

export type ExchangeReferenceOptions = {
  render: {
    conversationId: string;
    contextKey: string;
    workspace: Pick<Workspace, "artifacts"> | undefined;
    drafts: Record<string, InputDraft>;
    draft: InputDraft;
    sending: boolean;
    emptyDraft: InputDraft;
  };
  scope: { conversationKey(workspaceId: string): string };
  origin: Pick<WorkspaceNavigationOrigin, "isActive">;
  navigation: Pick<
    NavigationOwner,
    "navigationGeneration" | "isCurrent" | "setExplicitWebsiteIntent"
  > &
    Pick<
      NavigationCommands,
      | "openObject"
      | "openScriptLocation"
      | "openBrowser"
      | "activateApplication"
    > & {
      selectConversation(
        workspaceId: string,
        id: string,
        focus?: boolean,
      ): void;
    };
  client: Pick<WorkspaceClient, "resolveArtifact">;
  drafts: {
    replace(key: string, value: InputDraft): void;
    update(key: string, update: (value: InputDraft) => InputDraft): void;
  };
  exchange: Pick<
    ExchangeController,
    "showInput" | "setInteraction" | "requestConversationFocus"
  > & {
    keepOpen(): void;
    scheduleSearchQuoteFocus(): void;
    scheduleCommentComposerFocus(): void;
  };
  quotes: {
    clearSelection(): void;
    reveal(quote: TextQuote): boolean;
    setReveal(value: { quote: TextQuote; token: string }): void;
  };
  onNotice(message: string): void;
};

/** Distinct, render-captured preparation/revisit commands. Construction
 * borrows facts and ports only: no ref/DOM read, query, token or lifecycle.
 * Authority, draft persistence and actual focus remain with the original Host.
 */
export function createExchangeReferenceCommands({
  render,
  scope,
  origin,
  navigation,
  client,
  drafts: draftPorts,
  exchange,
  quotes,
  onNotice: setNotice,
}: ExchangeReferenceOptions) {
  const {
    conversationId,
    contextKey,
    workspace: state,
    drafts,
    draft,
    sending,
    emptyDraft,
  } = render;
  const { conversationKey } = scope;
  const {
    navigationGeneration,
    openObject,
    openScriptLocation,
    openBrowser,
    activateApplication,
    selectConversation,
    setExplicitWebsiteIntent: setWebsiteIntent,
  } = navigation;
  const { replace: setDraft, update: updateDraft } = draftPorts;
  const {
    keepOpen: keepExchangeOpen,
    showInput,
    setInteraction,
    requestConversationFocus,
    scheduleSearchQuoteFocus,
    scheduleCommentComposerFocus,
  } = exchange;
  const { reveal: revealTextQuote, setReveal: setQuoteReveal } = quotes;

  async function openTextQuote(quote: TextQuote) {
    if (!origin.isActive()) return;
    quotes.clearSelection();
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
  const composeReading: ReadingComposeCommand = (
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
  function prepareSearchQuote(
    id: string,
    projectId: string,
    revision: number,
    quote: string,
    page?: number,
  ) {
    void openObject(
      projectId,
      id,
      revision,
      page,
      false,
      undefined,
      quote,
    ).then((generation) => {
      if (
        generation === undefined ||
        generation !== navigationGeneration.current
      )
        return;
      const key = conversationKey(projectId) + ":" + id;
      setDraft(key, {
        ...(drafts[key] ?? emptyDraft),
        selection: quote,
        revision,
        page,
      });
      setInteraction("recent");
      scheduleSearchQuoteFocus();
    });
  }
  function selectArtifactQuote(
    quote: string,
    revision: number,
    page?: number,
    annotation?: boolean,
  ) {
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
  }
  const changeTextQuotes = (textQuotes: TextQuote[]) =>
    updateDraft(contextKey, (old) => ({ ...old, textQuotes }));
  function focusCommentComposer() {
    showInput();
    scheduleCommentComposerFocus();
  }
  return {
    openTextQuote,
    composeContent,
    composeReading,
    composeIntent,
    prepareSearchQuote,
    selectArtifactQuote,
    changeTextQuotes,
    focusCommentComposer,
  };
}
