/** Display-only state carried by the authorized discussion stream. */
const phases = [
  "waiting",
  "queued",
  "model",
  "reasoning",
  "final_output",
  "generating",
  "tool_call",
  "tool",
  "settling",
  "provider_wait",
  "settled",
] as const;

export type DiscussionResponse = {
  inputId: string;
  rootId: string;
  createdAt: string;
  phase: (typeof phases)[number];
};

export type DiscussionActivity = {
  id: string;
  responses: DiscussionResponse[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseDiscussionActivity(
  raw: unknown,
): DiscussionActivity | undefined {
  const value = record(raw);
  const validId = (id: unknown): id is string =>
    typeof id === "string" && id.length > 0 && id.length <= 512;
  if (
    !value ||
    !validId(value.id) ||
    !Array.isArray(value.responses) ||
    value.responses.length > 128
  )
    return;
  const responses: DiscussionResponse[] = [];
  for (const rawResponse of value.responses) {
    const response = record(rawResponse);
    if (!response) return;
    const { inputId, rootId, createdAt, phase } = response;
    if (
      !validId(inputId) ||
      !validId(rootId) ||
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt)) ||
      typeof phase !== "string" ||
      !phases.some((known) => known === phase)
    )
      return;
    responses.push({
      inputId,
      rootId,
      createdAt,
      phase: phase as DiscussionResponse["phase"],
    });
  }
  return { id: value.id, responses };
}
