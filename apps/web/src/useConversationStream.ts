import { useEffect, useState } from "react";
import {
  conversationFrameSchema,
  type ConversationStream,
} from "../../../packages/core/src/live-conversation.js";

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
    setStream({ connected: false, messages: [] });
    if (!enabled) return;
    let disposed = false;
    const source = new EventSource(
      `/api/conversation/stream?${new URLSearchParams({ projectId, conversationId })}`,
    );
    source.onmessage = (event) => {
      if (disposed) return;
      try {
        const value = conversationFrameSchema.parse(JSON.parse(event.data));
        setStream((previous) => {
          const messages = new Map(
            (value.reset ? [] : previous.messages).map((m) => [m.id, m]),
          );
          for (const id of value.removed) messages.delete(id);
          for (const m of value.messages) messages.set(m.id, m);
          return {
            connected: value.connected,
            messages: [...messages.values()],
          };
        });
      } catch {
        setStream((s) => ({ ...s, connected: false }));
      }
    };
    source.onerror = () => {
      // A suffix after reconnect must not retain a stale streamed prefix.
      if (!disposed)
        setStream((s) => ({
          connected: false,
          messages: s.messages.filter(
            (m) => !m.id.startsWith("stream:") && !m.streaming,
          ),
        }));
    };
    return () => {
      disposed = true;
      source.close();
    };
  }, [projectId, conversationId, enabled]);
  return stream;
}
