/** Controlled Runtime HTTP evidence, captured from actual Host requests.
 * Only used by protocol tests; this does not execute a model or fabricate
 * Platform/App authorization. Runtime stores JSON leaves as tagged Data. */
type HttpEvent = {
  id: string;
  sequence: number;
  timestamp: string;
  topic: string;
  payload: Record<string, unknown>;
};
type InputRequest = {
  client_message_id: string;
  client_metadata: unknown;
  message: { content: { encoding: string; value: unknown } };
};
function data(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", value: value.map(data) };
  switch (typeof value) {
    case "boolean":
      return { type: "boolean", value };
    case "string":
      return { type: "string", value };
    case "number":
      if (!Number.isFinite(value)) throw new Error("Invalid fixture number");
      return { type: "number", value: String(value) };
    case "object":
      return {
        type: "object",
        value: Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, data(child)]),
        ),
      };
    default:
      throw new Error("Invalid fixture Data leaf");
  }
}
export function acceptedRuntimeInput(
  request: InputRequest,
  sessionId: string,
  rootId: string,
  sequence = 1,
): HttpEvent {
  return {
    id: rootId,
    sequence,
    timestamp: new Date().toISOString(),
    topic: "chat/user_message",
    payload: {
      session_id: sessionId,
      client_message_id: request.client_message_id,
      session_io: {
        request: {
          ...request,
          client_metadata: data(request.client_metadata),
          message: {
            ...request.message,
            content: {
              ...request.message.content,
              value: data(request.message.content.value),
            },
          },
        },
      },
    },
  };
}
export function runtimeTimeline(root: HttpEvent, replies: HttpEvent[]) {
  return [
    {
      entry_id: root.payload.client_message_id,
      visible_at: root.timestamp,
      visible_at_micros: Date.parse(root.timestamp) * 1000,
      root_turn_id: root.id,
      attempt_id: null,
      display_kind: "input",
      final_event: false,
      event: root,
      root_event: null,
    },
    ...replies.map((event) => {
      if (event.payload.root_turn_id !== root.id)
        throw new Error("Mismatched fixture root");
      return {
        entry_id: event.id,
        visible_at: event.timestamp,
        visible_at_micros: Date.parse(event.timestamp) * 1000,
        root_turn_id: root.id,
        attempt_id: null,
        display_kind: "reply",
        final_event: true,
        event,
        root_event: root,
      };
    }),
  ];
}
