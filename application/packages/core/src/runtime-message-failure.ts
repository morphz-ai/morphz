import { z } from "zod";

/** Display metadata from an actual Runtime event, not a guess from prose. */
export const runtimeMessageFailureSchema = z.object({
  kind: z.literal("response_protocol"),
  phase: z.enum(["diagnostic", "terminal"]),
  attemptId: z.string().optional(),
  state: z.string().optional(),
});

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
