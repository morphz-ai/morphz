import { useCallback, useEffect, useState } from "react";
import type { Boot } from "../../apps/web/src/client.js";
import {
  acknowledgeReplies,
  focusedInputs,
  hasUnreadReplies,
  readReplyReceipts,
  reconcileReplyReceipts,
  replyReceipts,
  type ConversationFocus,
  type ReadReplies,
  type ReplyReceipt,
} from "../../apps/web/src/conversation-read.js";
import {
  conversationGroups,
  conversationTimeline,
} from "../../packages/core/src/conversation.js";
import type { LiveMessage } from "../../packages/core/src/live-conversation.js";
import type { Workspace } from "../../packages/core/src/model.js";

type ReadClient = { boot: Pick<Boot, "outputs" | "scriptOutputs" | "runtime"> };
export type FixedReadSource = {
  inputs: Workspace["inputs"];
  replies: LiveMessage[];
  client: ReadClient;
  conversationFocus: ConversationFocus;
  seenReplies: ReadReplies;
};

/** Fixed Git 4ce98b64 App and Conversation read recipes. The two original
 * receipt orders are deliberately separate; neither calls a new projector. */
export function fixedAppRead({
  inputs,
  replies,
  client,
  conversationFocus,
  seenReplies,
}: FixedReadSource) {
  const badgeInputs = focusedInputs(
    inputs,
    client.boot!.outputs,
    conversationFocus,
  );
  const badgeInputIds = new Set(badgeInputs.map((i) => i.id));
  const conversationInputIds = new Set(inputs.map((i) => i.id));
  const badgeReplies =
    conversationFocus.artifactId || conversationFocus.applicationId
      ? replies.filter((m) => !!m.inputId && badgeInputIds.has(m.inputId))
      : replies;
  const receipts = replyReceipts(
    replies,
    client.boot!.outputs.filter((o) => conversationInputIds.has(o.inputId)),
    client.boot!.scriptOutputs.filter((o) =>
      conversationInputIds.has(o.inputId),
    ),
  );
  const receiptVersion = JSON.stringify(receipts);
  const unseenReply = hasUnreadReplies(
    seenReplies,
    replyReceipts(
      badgeReplies,
      client.boot!.outputs.filter((o) => badgeInputIds.has(o.inputId)),
      client.boot!.scriptOutputs.filter((o) => badgeInputIds.has(o.inputId)),
    ),
  );
  return { badgeInputs, badgeReplies, receipts, receiptVersion, unseenReply };
}

export function fixedHistoryRead({
  inputs: allInputs,
  replies: messages,
  client,
  conversationFocus: {
    artifactId: focusedArtifactId,
    applicationId: focusedApplicationId,
  },
  seenReplies,
  allHistory,
  onInspect,
}: FixedReadSource & {
  allHistory: boolean;
  onInspect?: (id: string) => void;
}) {
  const focused = !!(focusedArtifactId || focusedApplicationId) && !allHistory;
  const inputs = focusedInputs(
    allInputs,
    client.boot!.outputs,
    focused
      ? { artifactId: focusedArtifactId, applicationId: focusedApplicationId }
      : {},
  );
  const inputById = new Map(inputs.map((input) => [input.id, input]));
  const groups = conversationGroups(
    inputs,
    messages.filter(
      (m) => !focused || (!!m.inputId && inputById.has(m.inputId)),
    ),
  );
  const items = conversationTimeline(
    groups.flatMap((group) => [
      ...(group.inputId && inputById.has(group.inputId)
        ? [inputById.get(group.inputId)!]
        : []
      ).map((input) => ({
        id: input.id,
        createdAt: input.createdAt,
        input,
        reply: null,
      })),
      ...group.messages
        .filter((m) => !onInspect || m.kind === "reply" || m.kind === "error")
        .filter(
          (m) => (m.kind !== "reply" && m.kind !== "error") || m.text.trim(),
        )
        .map((reply) => ({
          id: reply.id,
          createdAt: reply.createdAt,
          input: null,
          reply,
        })),
    ]),
  );
  const outputs = (client.boot?.outputs ?? []).filter((o) =>
    inputById.has(o.inputId),
  );
  const scriptOutputs = (client.boot?.scriptOutputs ?? []).filter((o) =>
    inputById.has(o.inputId),
  );
  const receipts = replyReceipts(
    items.flatMap((item) => (item.reply ? [item.reply] : [])),
    outputs,
    scriptOutputs,
  );
  const readVersion = JSON.stringify(receipts);
  const unread = hasUnreadReplies(seenReplies, receipts);
  return {
    inputs,
    groups,
    items,
    outputs,
    scriptOutputs,
    receipts,
    readVersion,
    unread,
  };
}

export type FixedReceiptState = ReturnType<typeof useFixedReceiptState>;
export function useFixedReceiptState({
  readLocal,
  client,
}: {
  readLocal<T>(key: string, fallback: T): T;
  client: ReadClient;
}) {
  const [seenReplies, setSeenReplies] = useState(
    () =>
      readReplyReceipts(
        readLocal<unknown>("conversation-read-receipts", null),
      ) ??
      acknowledgeReplies(
        {},
        replyReceipts(
          client.boot!.runtime.messages,
          client.boot!.outputs,
          client.boot!.scriptOutputs,
        ),
      ),
  );
  return { seenReplies, setSeenReplies };
}

export function useFixedReceiptAcknowledgement({
  setSeenReplies,
}: FixedReceiptState) {
  const readReplies = useCallback((receipts: ReplyReceipt[]) => {
    setSeenReplies((old) => acknowledgeReplies(old, receipts));
  }, []);
  return readReplies;
}

export function useFixedReceiptCommit({
  seenReplies,
  setSeenReplies,
  receipts,
  receiptVersion,
  writeLocal,
  setNotice,
}: FixedReceiptState & {
  receipts: ReplyReceipt[];
  receiptVersion: string;
  writeLocal(key: string, seen: ReadReplies): void;
  setNotice(message: string): void;
}) {
  useEffect(() => {
    setSeenReplies((old) => reconcileReplyReceipts(old, receipts));
  }, [receiptVersion]);
  useEffect(() => {
    try {
      writeLocal("conversation-read-receipts", seenReplies);
    } catch {
      setNotice("已读状态暂时无法保存，重开后可能再次提示。");
    }
  }, [seenReplies]);
}
