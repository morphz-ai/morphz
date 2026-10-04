import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  Workspace,
  InputDispatchMode,
} from "../../packages/core/src/model.js";
import type { Project } from "../../packages/core/src/projects.js";
import type { InputContinuation } from "../../packages/core/src/continuation.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type { useProfile } from "../../apps/web/src/useProfile.js";
import type {
  ConversationDraft,
  InputDraft,
} from "../../apps/web/src/host/exchange-drafts.js";
import type { ExchangeSubmissionContext } from "../../apps/web/src/host/submit-exchange-draft.js";
import { consumeComposerDraft } from "../../apps/web/src/composer-drafts.js";
import { RequestError } from "../../apps/web/src/application-transport.js";
import { submitExchangeDraft } from "../../apps/web/src/host/submit-exchange-draft.js";

type RecordSetter<T> = Dispatch<SetStateAction<Record<string, T>>>;
export type FixedSubmissionBindings = {
  project: Project | undefined;
  selectedConversation: Workspace["conversations"][number] | undefined;
  selectedDraft: ConversationDraft | undefined;
  draft: InputDraft;
  sending: boolean;
  uploadingDrafts: Record<string, boolean>;
  contextKey: string;
  conversationId: string;
  state: Pick<Workspace, "inputs"> | undefined;
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
  client: Pick<WorkspaceClient, "boot" | "execute">;
  profile: Pick<ReturnType<typeof useProfile>, "flush" | "assertCurrentScope">;
  sendPending: RefObject<boolean>;
  currentContext: RefObject<string>;
  setSending: Dispatch<SetStateAction<boolean>>;
  setInputErrors: RecordSetter<string>;
  setRevealedInputs: RecordSetter<string>;
  setAnnotationRefresh: Dispatch<SetStateAction<number>>;
  dictationControls: RefObject<{ interrupt(): void } | null>;
  setDraft(key: string, value: InputDraft): void;
  updateDraft(key: string, update: (value: InputDraft) => InputDraft): void;
  setMobileCollaboration: Dispatch<SetStateAction<boolean>>;
  showSentInput(key: string): void;
  requestSentInputFocus(key: string): void;
  showInput(): void;
  openCollaboration(): void;
  closeInspector(): void;
  setNotice(message: string): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  input: RefObject<{ focus(options: { preventScroll: true }): void } | null>;
};
// Independently fixed from Git 9122ad28; both full original algorithms below
// are unchanged. Only their lexical free variables are supplied by this adapter.
// The old commands still use the existing protocol owner, not the new Host owner.
export const fixedSubmissionHashes = {
  app: "c56d4c9784fe65fd086e06083d53ec9142d1897bc9f9d39af1c738287f949be3",
  send: "6592e8afaccce903d2c7b345898206e6d1bef9e0b9d187861e1d309faebb4b3e",
  supplement:
    "78d54af809c9f20000ced822a4259b754ad187a9db8b1fbd29d26333ebb3602c",
} as const;
export function createFixedSubmissionCommands({
  project,
  selectedConversation,
  selectedDraft,
  draft,
  sending,
  uploadingDrafts,
  contextKey,
  conversationId,
  state,
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
  client,
  profile,
  sendPending,
  currentContext,
  setSending,
  setInputErrors,
  setRevealedInputs,
  setAnnotationRefresh,
  dictationControls,
  setDraft,
  updateDraft,
  setMobileCollaboration,
  showSentInput,
  requestSentInputFocus,
  showInput,
  openCollaboration,
  closeInspector,
  setNotice,
  requestAnimationFrame,
  input,
}: FixedSubmissionBindings) {
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
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  }
  return { send, supplement };
}
