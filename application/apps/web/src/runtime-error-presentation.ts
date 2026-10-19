import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";

// These are Runtime-owned terminal notices, not causes. Preserve raw history,
// but do not make an expandable "detail" out of a second generic status line.
const terminalNotices = new Set([
  "本次回复未能正确交付；已保留此前完成的工作。",
  "本次回复的交付格式不正确，目标尚未完成；已保留此前完成的工作。",
]);
export function runtimeErrorDetails(
  message: LiveMessage & { errorDetails?: string },
) {
  const text = message.errorDetails ?? message.text;
  return text.trim() && !terminalNotices.has(text.trim()) ? text.trim() : "";
}

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
      for (const text of [
        ...(message.failure.diagnostics ?? []).map((item) => item.reason),
        message.text,
      ]) {
        const detail = runtimeErrorDetails({ ...message, text });
        if (detail && !values.includes(detail)) values.push(detail);
      }
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
