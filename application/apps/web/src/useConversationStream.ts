import { useEffect, useState } from "react";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import {
  applicationIdentity,
  subscribeConversation,
} from "./application-transport.js";

const empty: ConversationStream = { connected: false, messages: [] };
type Subscription = {
  close: () => void;
  value: ConversationStream;
  listeners: Set<(value: ConversationStream) => void>;
};
// Main exchange and inspector share the already received streaming prefix.
const subscriptions = new Map<string, Subscription>();

export function useConversationStream(
  projectId: string,
  conversationId: string,
  enabled: boolean,
) {
  const [stream, setStream] = useState<ConversationStream>({
    connected: false,
    messages: [],
  });
  const identity = applicationIdentity();
  useEffect(() => {
    setStream(empty);
    if (!enabled) return;
    const key = JSON.stringify([identity, projectId, conversationId]);
    let entry = subscriptions.get(key);
    if (!entry) {
      entry = { close: () => {}, value: empty, listeners: new Set() };
      subscriptions.set(key, entry);
      const update = (value: ConversationStream) => {
        entry!.value = value;
        for (const listener of entry!.listeners) listener(value);
      };
      entry.close = subscribeConversation(
        { projectId, conversationId },
        update,
      );
    }
    entry.listeners.add(setStream);
    setStream(entry.value);
    return () => {
      entry!.listeners.delete(setStream);
      if (!entry!.listeners.size) {
        entry!.close();
        subscriptions.delete(key);
      }
    };
  }, [identity, projectId, conversationId, enabled]);
  return stream;
}
