import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  Workspace,
  InputDispatchMode,
} from "../../../../packages/core/src/model.js";
import type { Project } from "../../../../packages/core/src/projects.js";
import type { InputContinuation } from "../../../../packages/core/src/continuation.js";
import type { WorkspaceClient } from "../client.js";
import type { useProfile } from "../useProfile.js";
import type { ConversationDraft, InputDraft } from "./exchange-drafts.js";
import type { ExchangeSubmissionContext } from "./submit-exchange-draft.js";
import { consumeComposerDraft } from "../composer-drafts.js";
import { RequestError } from "../application-transport.js";
import { submitExchangeDraft } from "./submit-exchange-draft.js";

type RecordSetter<T> = Dispatch<SetStateAction<Record<string, T>>>;
export type ExchangeSubmissionCommandOptions = {
  render: {
    project: Project | undefined;
    selectedConversation: Workspace["conversations"][number] | undefined;
    selectedDraft: ConversationDraft | undefined;
    draft: InputDraft;
    sending: boolean;
    uploadingDrafts: Record<string, boolean>;
    contextKey: string;
    conversationId: string;
    workspace: Pick<Workspace, "inputs"> | undefined;
    emptyDraft: InputDraft;
    artifact: ExchangeSubmissionContext["artifact"];
    activeInstance: ExchangeSubmissionContext["activeInstance"];
    browserPage: ExchangeSubmissionContext["browserPage"];
    readingExpected: boolean;
    currentReading: ExchangeSubmissionContext["currentReading"];
    canAuthorizeDirectories: boolean;
    directoryScope: string;
    directoryState: ExchangeSubmissionContext["directoryState"];
    rightInspector: { mode: "docked" | "overlay" };
  };
  client: Pick<WorkspaceClient, "boot" | "execute">;
  profile: Pick<ReturnType<typeof useProfile>, "flush" | "assertCurrentScope">;
  feedback: {
    sendPending: RefObject<boolean>;
    currentContext: RefObject<string>;
    setSending: Dispatch<SetStateAction<boolean>>;
    setInputErrors: RecordSetter<string>;
    setRevealedInputs: RecordSetter<string>;
    setAnnotationRefresh: Dispatch<SetStateAction<number>>;
  };
  dictationControls: RefObject<{ interrupt(): void } | null>;
  drafts: {
    replace(key: string, value: InputDraft): void;
    update(key: string, update: (value: InputDraft) => InputDraft): void;
  };
  exchange: {
    setMobileCollaboration: Dispatch<SetStateAction<boolean>>;
    showSentInput(key: string): void;
    requestSentInputFocus(key: string): void;
    showInput(): void;
  };
  inspector: { openCollaboration(): void; closeInspector(): void };
  onNotice(message: string): void;
  focusAfterSupplement(): void;
};

/** Render-local admission, preparation lock and feedback for the two existing
 * exchange commands. Construction only borrows captured facts and original
 * refs/setters. Submission protocol, persistence, authority and DOM focus retain
 * their existing owners; staged delivery never consumes a newer composer. */
export function createExchangeSubmissionCommands({
  render,
  client,
  profile,
  feedback,
  dictationControls,
  drafts: draftPorts,
  exchange,
  inspector,
  onNotice: setNotice,
  focusAfterSupplement,
}: ExchangeSubmissionCommandOptions) {
  const {
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
    canAuthorizeDirectories,
    directoryScope,
    directoryState,
    rightInspector,
  } = render;
  const {
    sendPending,
    currentContext,
    setSending,
    setInputErrors,
    setRevealedInputs,
    setAnnotationRefresh,
  } = feedback;
  const { replace: setDraft, update: updateDraft } = draftPorts;
  const {
    setMobileCollaboration,
    showSentInput,
    requestSentInputFocus,
    showInput,
  } = exchange;
  const { openCollaboration, closeInspector } = inspector;
  async function send(
    asAnnotation = draft.annotation === true,
    dispatchMode: InputDispatchMode = "interrupt",
  ) {
    if (
      !project ||
      selectedConversation?.archivedAt ||
      (!draft.body.trim() &&
        !draft.attachments?.length &&
        !draft.textQuotes?.length) ||
      sending ||
      sendPending.current ||
      (selectedDraft &&
        client.boot?.localSavedInputIds.includes(selectedDraft.inputId)) ||
      uploadingDrafts[contextKey]
    )
      return;
    dictationControls.current?.interrupt();
    const key = contextKey,
      captured =
        draft.continuation?.mode === "follow-up"
          ? {
              ...draft,
              continuation: undefined,
              continuationLabel: undefined,
              continuationFailure: undefined,
              pendingSupplement: undefined,
            }
          : { ...draft };
    if (draft.continuation?.mode === "follow-up") setDraft(key, captured);
    const firstConversation = captured.continuation ? undefined : selectedDraft;
    if (captured.continuation) asAnnotation = false;
    sendPending.current = true;
    setSending(true);
    setInputErrors((old) => ({ ...old, [key]: "" }));
    let staged = false;
    const onInputStaged = (inputId: string) => {
      staged = true;
      updateDraft(key, (current) => consumeComposerDraft(current, emptyDraft));
      setRevealedInputs((old) => ({ ...old, [conversationId]: inputId }));
      if (currentContext.current === key) {
        setMobileCollaboration(false);
        showSentInput(key);
      }
      // Only preparation locks the editor. Delivery owns its immutable payload;
      // later receipts must never erase or disable the next draft.
      sendPending.current = false;
      setSending(false);
    };
    await submitExchangeDraft(
      captured,
      asAnnotation,
      dispatchMode,
      {
        projectId: project.id,
        conversationId,
        firstConversation,
        artifact,
        activeInstance,
        browserPage,
        readingExpected,
        currentReading,
        canAuthorizeDirectories,
        directoryScope,
        directoryState,
        capabilities: {
          directedInput: client.boot?.capabilities.directedInput,
          conversationOnFirstInput:
            client.boot?.capabilities.conversationOnFirstInput,
          runtimeConfigured: client.boot?.runtime.configured,
        },
      },
      {
        execute: client.execute,
        profile: {
          flush: profile.flush,
          assertCurrentScope: profile.assertCurrentScope,
        },
        isCurrentSurface: () => currentContext.current === key,
        originalInput: (id) => state!.inputs.find((input) => input.id === id),
        persistSupplement: (command) =>
          updateDraft(key, (old) => ({
            ...old,
            pendingSupplement: command,
            continuationFailure: undefined,
          })),
        onInputStaged,
        onResolved: (result) => {
          if (result.kind === "supplement")
            setRevealedInputs((old) => ({
              ...old,
              [conversationId]: result.receipt.entityId,
            }));
          else if (result.kind === "annotation")
            setAnnotationRefresh((value) => value + 1);
          // The acknowledged input consumed this conversation's references.
          if (!staged)
            updateDraft(key, (current) =>
              consumeComposerDraft(current, emptyDraft),
            );
          if (!staged && currentContext.current === key) {
            if (asAnnotation) {
              openCollaboration();
              requestSentInputFocus(key);
            } else if (captured.continuation || !captured.taskResult) {
              setMobileCollaboration(false);
              // Focus only after React removes the sending-disabled state.
              showSentInput(key);
            }
          }
        },
        onRejected: (e) => {
          // A staged input owns its failure/retry control. Do not attach an older
          // submission error to the user's new composer contents.
          if (staged) return;
          if (captured.continuation) {
            const reason =
              e instanceof RequestError && e.code === "work_closed"
                ? "closed"
                : e instanceof RequestError &&
                    e.status < 500 &&
                    e.status !== 408
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
        },
        onSettled: () => {
          if (!staged) {
            sendPending.current = false;
            setSending(false);
          }
        },
      },
    );
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
    focusAfterSupplement();
  }
  return { send, supplement };
}
