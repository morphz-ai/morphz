import { z } from "zod";

/** Display metadata from an actual Runtime event, not a guess from prose. */
export const runtimeMessageFailureSchema = z.object({
  kind: z.literal("response_protocol"),
  phase: z.enum(["diagnostic", "terminal"]),
  attemptId: z.string().optional(),
  state: z.string().optional(),
  /** Exact persisted rejection reasons, not model captures or invented copy. */
  diagnostics: z
    .array(z.object({ eventId: z.string(), reason: z.string() }))
    .max(16)
    .optional(),
});

/** A rejected intermediate boundary is execution evidence, not a failed reply. */
export function isRuntimeMessageDiagnostic(message: {
  failure?: { phase: "diagnostic" | "terminal" };
}) {
  return message.failure?.phase === "diagnostic";
}

type FailureEvent = {
  id: string;
  sequence?: number;
  topic: string;
  actor?: string;
  payload: Record<string, unknown>;
};

/** Read-model join only. Never expose response_capture, arguments, or reasoning.
 * Exact indexed root/attempt reads are still checked at the product boundary. */
export function runtimeFailureDiagnostics(
  terminal: FailureEvent,
  events: FailureEvent[],
) {
  const failure = runtimeMessageFailureFromEvent(terminal);
  const route = ["session_id", "context_id", "root_turn_id", "thread_id"];
  if (
    failure?.phase !== "terminal" ||
    !failure.attemptId ||
    !terminal.sequence ||
    route.some(
      (key) =>
        typeof terminal.payload[key] !== "string" || !terminal.payload[key],
    )
  )
    return [];
  return events
    .filter(
      (event) =>
        event.topic === "runtime/response_protocol_error" &&
        event.actor === "Runtime-Orchestrator" &&
        !!event.sequence &&
        event.sequence < terminal.sequence! &&
        event.payload.attempt_id === failure.attemptId &&
        route.every((key) => event.payload[key] === terminal.payload[key]) &&
        event.payload.principal_id === terminal.payload.principal_id &&
        event.payload.model_output_visibility !== "internal" &&
        event.payload.model_output_visibility !== "evaluation" &&
        typeof event.payload.reason === "string" &&
        !!event.payload.reason.trim(),
    )
    .slice(-16)
    .map((event) => ({
      eventId: event.id,
      reason: event.payload.reason as string,
    }));
}

/** One fact-based classifier for both live deltas and reloaded history. */
export function runtimeMessageFailureFromEvent(event: {
  topic: string;
  payload: Record<string, unknown>;
}): z.infer<typeof runtimeMessageFailureSchema> | undefined {
  const payload = event.payload;
  const terminal =
    event.topic === "session/io_state" &&
    [
      "response_annotations_protocol",
      "response_protocol",
      "objective_finalization_protocol",
    ].includes(String(payload.runtime_failure_kind ?? ""));
  if (
    !terminal &&
    ![
      "runtime/response_protocol_error",
      "runtime/response_protocol_fused",
    ].includes(event.topic)
  )
    return undefined;
  return {
    kind: "response_protocol",
    phase:
      terminal || event.topic === "runtime/response_protocol_fused"
        ? "terminal"
        : "diagnostic",
    ...(typeof payload.attempt_id === "string"
      ? { attemptId: payload.attempt_id }
      : {}),
    ...(payload.runtime_failure_kind === "response_annotations_protocol"
      ? { state: "response_annotations" }
      : typeof payload.response_state === "string"
        ? { state: payload.response_state }
        : {}),
  };
}
