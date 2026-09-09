import { useEffect, useState } from "react";
import {
  conversationFrameSchema,
  type ConversationStream,
} from "../../../packages/core/src/live-conversation.js";

const empty: ConversationStream = { connected: false, messages: [] };
type Subscription = {
  source: EventSource;
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
  useEffect(() => {
    setStream(empty);
    if (!enabled) return;
    const key = JSON.stringify([projectId, conversationId]);
    let entry = subscriptions.get(key);
    if (!entry) {
      const source = new EventSource(
        `/api/conversation/stream?${new URLSearchParams({ projectId, conversationId })}`,
      );
      entry = { source, value: empty, listeners: new Set() };
      subscriptions.set(key, entry);
      const update = (value: ConversationStream) => {
        entry!.value = value;
        for (const listener of entry!.listeners) listener(value);
      };
      source.onmessage = (event) => {
        try {
          const value = conversationFrameSchema.parse(JSON.parse(event.data));
          const messages = new Map(
            (value.reset ? [] : entry!.value.messages).map((m) => [m.id, m]),
          );
          for (const id of value.removed) messages.delete(id);
          for (const m of value.messages) messages.set(m.id, m);
          update({
            connected: value.connected,
            messages: [...messages.values()],
          });
        } catch {
          update({ ...entry!.value, connected: false });
        }
      };
      source.onerror = () => {
        // A suffix after reconnect must not retain a stale streamed prefix.
        update({
          connected: false,
          messages: entry!.value.messages.filter(
            (m) => !m.id.startsWith("stream:") && !m.streaming,
          ),
        });
      };
    }
    entry.listeners.add(setStream);
    setStream(entry.value);
    return () => {
      entry!.listeners.delete(setStream);
      if (!entry!.listeners.size) {
        entry!.source.close();
        subscriptions.delete(key);
      }
    };
  }, [projectId, conversationId, enabled]);
  return stream;
}
