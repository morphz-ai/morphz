import { useRef, useState } from "react";
import type {
  Discussion,
  InputAttachment,
  Operation,
} from "../../../../packages/core/src/model.js";
import type { InputContinuation } from "../../../../packages/core/src/continuation.js";
import type { InputIntent } from "../../../../packages/core/src/input-intent.js";
import type { ReasoningEffort } from "../../../../packages/core/src/inference.js";
import type { ReadingInput } from "../../../../packages/core/src/reader.js";
import type { ScriptGeneration } from "../../../../packages/core/src/script-studio.js";
import type { TextQuote } from "../../../../packages/core/src/text-quotes.js";
import { draftKey, type scopedStorage } from "../local-preferences.js";

export type InputDraft = {
  textQuotes?: TextQuote[];
  reading?: ReadingInput;
  skipReading?: boolean;
  scriptGeneration?: ScriptGeneration;
  continuation?: InputContinuation;
  continuationLabel?: string;
  continuationFailure?: "closed" | "changed" | "unknown";
  pendingSupplement?: { commandId: string; operation: Operation };
  attachments?: InputAttachment[];
  annotation?: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  body: string;
  intent?: InputIntent;
  taskResult?: { taskId: string; revision: number };
  selection: string;
  revision: number | null;
  page?: number;
};
export type ConversationDraft = {
  id: string;
  projectId: string;
  title: string;
  inputId: string;
};
type Inputs = Record<string, InputDraft>;
type Conversations = Record<string, ConversationDraft>;
type Discarded = Record<
  string,
  { conversation: ConversationDraft; drafts: Inputs }
>;
type Storage = Pick<
  ReturnType<typeof scopedStorage>,
  "readLocal" | "writeLocal"
>;

// Separate hooks retain the original Host initialization order. These are the
// three existing local records, not a new store, snapshot or server authority.
export function useExchangeInputDraftState(storage: Storage) {
  const [value, set] = useState<Inputs>(() =>
    storage.readLocal(draftKey("inputs"), {}),
  );
  return { value, set };
}
export function useExchangeConversationDraftState(storage: Storage) {
  const [value, set] = useState<Conversations>(() =>
    storage.readLocal(draftKey("conversations"), {}),
  );
  const ref = useRef(value);
  ref.current = value;
  return { value, set, ref };
}
export function useExchangeDiscardedDraftState(storage: Storage) {
  const [value, set] = useState<Discarded>(() =>
    storage.readLocal(draftKey("discarded-conversations"), {}),
  );
  return { value, set };
}

/** Render-local commands for local draft lifecycle only. The Host still owns
 * send guards, authoritative conversation reads and navigation. Preserve the
 * old write/publication order and partial-write failure behavior; localStorage
 * is not an atomic transaction, and no new key or migration is introduced. */
export function createExchangeDraftCommands({
  inputs,
  conversations,
  discarded,
  storage,
  onNotice,
}: {
  inputs: ReturnType<typeof useExchangeInputDraftState>;
  conversations: ReturnType<typeof useExchangeConversationDraftState>;
  discarded: ReturnType<typeof useExchangeDiscardedDraftState>;
  storage: Storage;
  onNotice(message: string): void;
}) {
  function writeInputs(update: (previous: Inputs) => Inputs) {
    inputs.set((previous) => {
      const next = update(previous);
      try {
        storage.writeLocal(draftKey("inputs"), next);
      } catch {
        onNotice("本地草稿保存失败，请不要刷新页面。");
      }
      return next;
    });
  }
  function createConversation(projectId: string, title: string) {
    let pending = conversations.ref.current[projectId];
    if (!pending) {
      pending = {
        id: crypto.randomUUID(),
        projectId,
        title,
        inputId: crypto.randomUUID(),
      };
      const next = { ...conversations.ref.current, [projectId]: pending };
      storage.writeLocal(draftKey("conversations"), next);
      conversations.ref.current = next;
      conversations.set(next);
    }
    return pending;
  }
  function retireCommittedConversations(persisted?: readonly Discussion[]) {
    // A local bubble is not a Session. Only the authoritative conversation
    // collection retires its corresponding unfinished named draft.
    const next = { ...conversations.ref.current };
    let changed = false;
    for (const [projectId, entry] of Object.entries(next)) {
      if (persisted?.some((conversation) => conversation.id === entry.id)) {
        delete next[projectId];
        changed = true;
      }
    }
    if (changed) {
      conversations.ref.current = next;
      conversations.set(next);
      storage.writeLocal(draftKey("conversations"), next);
    }
  }
  function discardConversation(
    id: string,
    readPersisted: () => Discussion | undefined,
    onDiscarded: (conversation: ConversationDraft | Discussion) => void,
  ) {
    const conversation =
      Object.values(conversations.value).find((entry) => entry.id === id) ??
      readPersisted();
    if (!conversation) return;
    const trash = {
      ...discarded.value,
      [id]: {
        conversation: {
          ...conversation,
          inputId:
            "inputId" in conversation
              ? conversation.inputId
              : crypto.randomUUID(),
        },
        drafts: Object.fromEntries(
          Object.entries(inputs.value).filter(([key]) =>
            key.startsWith(id + ":"),
          ),
        ),
      },
    };
    const remaining = { ...conversations.value };
    if (remaining[conversation.projectId]?.id === id)
      delete remaining[conversation.projectId];
    const remainingInputs = Object.fromEntries(
      Object.entries(inputs.value).filter(([key]) => !key.startsWith(id + ":")),
    );
    try {
      storage.writeLocal(draftKey("discarded-conversations"), trash);
      storage.writeLocal(draftKey("inputs"), remainingInputs);
      storage.writeLocal(draftKey("conversations"), remaining);
      discarded.set(trash);
      inputs.set(remainingInputs);
      conversations.set(remaining);
      conversations.ref.current = remaining;
      onDiscarded(conversation);
    } catch {
      onNotice("草稿整理未完成，原文仍保留，请重试。");
    }
  }
  function restoreConversation(
    id: string,
    hasConversationDraft: (id: string) => boolean | undefined,
    onRestored: (conversation: ConversationDraft) => void,
  ) {
    const saved = discarded.value[id];
    if (!saved) return;
    const pending = conversations.value[saved.conversation.projectId];
    if (pending && pending.id !== id && hasConversationDraft(pending.id)) {
      onNotice("请先发送或丢弃当前项目的新草稿，再恢复这份草稿。");
      return;
    }
    const nextInputs = { ...inputs.value, ...saved.drafts },
      next = {
        ...conversations.value,
        [saved.conversation.projectId]: saved.conversation,
      },
      trash = { ...discarded.value };
    delete trash[id];
    try {
      storage.writeLocal(draftKey("inputs"), nextInputs);
      storage.writeLocal(draftKey("conversations"), next);
      storage.writeLocal(draftKey("discarded-conversations"), trash);
      inputs.set(nextInputs);
      conversations.set(next);
      conversations.ref.current = next;
      discarded.set(trash);
      onRestored(saved.conversation);
    } catch {
      onNotice("草稿恢复失败，保存的原文仍在，请重试。");
    }
  }
  return {
    writeInputs,
    createConversation,
    retireCommittedConversations,
    discardConversation,
    restoreConversation,
  };
}
