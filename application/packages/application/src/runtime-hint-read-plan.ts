/** Committed hints invalidate only the native read models whose facts changed.
 * A transport gap is an explicit current-state read, not history demand. */
export function runtimeHintReadPlan(topic?: string) {
  const gap = topic === undefined;
  const history =
    gap ||
    topic!.startsWith("objective/") ||
    [
      "chat/reply",
      "chat/no_reply",
      "chat/cancelled",
      "chat/runtime_error",
      "runtime/thread_cancelled",
      "runtime/thread_completed",
      "runtime/thread_failed",
      "runtime/delegation_result",
      "runtime/delegation_failed",
    ].includes(topic!);
  const activity =
    history ||
    topic!.startsWith("runtime/thread") ||
    topic!.startsWith("runtime/execution") ||
    topic!.startsWith("runtime/approval") ||
    topic!.startsWith("runtime/schedule") ||
    topic!.startsWith("runtime/delegation") ||
    [
      "runtime/user_input_requested",
      "chat/progress",
      "chat/user_message",
      "chat/steering",
      "chat/tool_output",
      "chat/delegate",
      "runtime/session_restored",
      "runtime/model_attempt_state",
    ].includes(topic!);
  const attention =
    gap ||
    topic!.startsWith("runtime/approval") ||
    topic!.startsWith("runtime/execution") ||
    topic === "runtime/session_restored";
  return { history, activity, attention };
}
