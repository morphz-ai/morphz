/** Runtime-owned provenance, not a guess based on JSON/text or ID prefixes.
 * A Plan infer is an evaluation-result message, never an ordinary reply. */
export function internalModelOutput(
  event: { topic: string; payload: Record<string, unknown> },
  root?: { topic: string; type?: string } | null,
) {
  return (
    event.payload.model_output_visibility === "internal" ||
    event.payload.model_output_visibility === "evaluation" ||
    event.payload.disposition === "complete_internal_evaluation" ||
    root?.type === "infer_request" ||
    root?.topic === "chat/infer_request" ||
    root?.topic === "runtime/infer_request"
  );
}
