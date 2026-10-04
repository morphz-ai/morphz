import { useCallback, useEffect, useState } from "react";
import {
  acknowledgeReplies,
  readReplyReceipts,
  reconcileReplyReceipts,
  replyReceipts,
  type ReplyReceipt,
} from "../conversation-read.js";

/** Registrations stay at the original host seams. Storage scope and the actual
 * preference writer belong to the host, not a second store or subscription. */
export function useExchangeReadReceiptState({
  readStored,
  readBootstrap,
}: {
  readStored(): unknown;
  readBootstrap(): {
    messages: Parameters<typeof replyReceipts>[0];
    outputs: Parameters<typeof replyReceipts>[1];
    scriptOutputs: Parameters<typeof replyReceipts>[2];
  };
}) {
  const [seenReplies, setSeenReplies] = useState(() => {
    const restored = readReplyReceipts(readStored());
    if (restored !== null) return restored;
    const bootstrap = readBootstrap();
    return acknowledgeReplies(
      {},
      replyReceipts(
        bootstrap.messages,
        bootstrap.outputs,
        bootstrap.scriptOutputs,
      ),
    );
  });
  return { seenReplies, setSeenReplies };
}

type ReceiptState = ReturnType<typeof useExchangeReadReceiptState>;

export function useExchangeReadAcknowledgement({
  setSeenReplies,
}: ReceiptState) {
  return useCallback((receipts: ReplyReceipt[]) => {
    setSeenReplies((old) => acknowledgeReplies(old, receipts));
  }, []);
}

export function useExchangeReadReceiptCommit(
  { seenReplies, setSeenReplies }: ReceiptState,
  {
    receipts,
    version,
    persist,
    onNotice,
  }: {
    receipts: ReplyReceipt[];
    version: string;
    persist(seen: ReceiptState["seenReplies"]): void;
    onNotice(message: string): void;
  },
) {
  useEffect(() => {
    setSeenReplies((old) => reconcileReplyReceipts(old, receipts));
  }, [version]);
  useEffect(() => {
    try {
      persist(seenReplies);
    } catch {
      onNotice("已读状态暂时无法保存，重开后可能再次提示。");
    }
  }, [seenReplies]);
}
