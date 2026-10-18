import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";

/** Group only the diagnostic and terminal rejection of one physical attempt.
 * Separate attempts, threads, unknown identities and their raw text survive. */
export function presentRuntimeErrors(messages: LiveMessage[]) {
  const key = (m: LiveMessage) =>
    m.failure?.attemptId && m.threadId
      ? `${m.threadId}:${m.failure.attemptId}`
      : null;
  const terminals = new Map(
    messages
      .filter((m) => m.failure?.phase === "terminal" && key(m))
      .map((m) => [key(m)!, m]),
  );
  const details = new Map<string, string[]>();
  const represented = new Map<string, LiveMessage[]>();
  for (const message of messages) {
    const id = key(message);
    if (id && message.failure && terminals.has(id)) {
      const values = details.get(id) ?? [];
      if (!values.includes(message.text)) values.push(message.text);
      details.set(id, values);
      represented.set(id, [...(represented.get(id) ?? []), message]);
    }
  }
  return messages.flatMap((message) => {
    const id = key(message);
    if (id && message.failure?.phase === "diagnostic" && terminals.has(id))
      return [];
    return [
      {
        ...message,
        ...(message.failure && id && details.has(id)
          ? {
              errorDetails: details.get(id)!.join("\n\n"),
              representedMessages: represented.get(id)!,
            }
          : {}),
      },
    ];
  });
}
