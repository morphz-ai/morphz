import { z } from "zod";
import type { ExecutionActivity } from "../../core/src/conversation.js";
import type { ExecutionSnapshot } from "../../core/src/execution.js";

const displayText = (maximum: number) =>
  z
    .string()
    .trim()
    .refine((value) => {
      const length = [...value].length;
      return length > 0 && length <= maximum;
    });

/** This is the Runtime's verified projection, NOT the model's raw bundle.
 * It contains no state mutations, percentages, authorizations or raw output. */
export const runtimeResponseAnnotationsSchema = z.object({
  protocol: z.enum(["v1", "v2"]),
  scope: z.object({
    execution_id: z.string().min(1),
    generation: z.number().int().nonnegative().safe(),
  }),
  title: displayText(256).optional(),
  progress: displayText(256).optional(),
  result: displayText(512).optional(),
  steps: z.array(
    z.object({
      job_id: z.string().min(1),
      intent: displayText(256).optional(),
      result: displayText(512).optional(),
    }),
  ),
  source_count: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
});
export type RuntimeResponseAnnotations = z.infer<
  typeof runtimeResponseAnnotationsSchema
>;
type ThreadScope = { threadId: string; generation?: unknown };

/** Optional metadata must fail closed without breaking actual execution reads.
 * The generation comes from the same fresh Thread snapshot, not the bundle. */
export function scopedRuntimeResponseAnnotations(
  raw: unknown,
  scope: ThreadScope,
): RuntimeResponseAnnotations | null {
  const parsed = runtimeResponseAnnotationsSchema.safeParse(raw);
  if (
    !parsed.success ||
    scope.generation === undefined ||
    parsed.data.scope.execution_id !== scope.threadId ||
    parsed.data.scope.generation !== scope.generation ||
    new Set(parsed.data.steps.map((step) => step.job_id)).size !==
      parsed.data.steps.length
  )
    return null;
  return parsed.data;
}

export function activityAnnotationFields(
  raw: unknown,
  thread: { id: string; generation?: unknown; lifecycle: string },
): Partial<
  Pick<
    ExecutionActivity["threads"][number],
    "title" | "summary" | "annotationProtocol" | "annotationsTruncated"
  >
> | null {
  const annotations = scopedRuntimeResponseAnnotations(raw, {
    threadId: thread.id,
    generation: thread.generation,
  });
  if (!annotations) return null;
  const summary =
    thread.lifecycle === "open"
      ? annotations.progress
      : ["completed", "failed"].includes(thread.lifecycle)
        ? annotations.result
        : undefined;
  return {
    // A bounded/truncated read cannot prove the whole-title first-wins rule.
    // Keep the existing factual fallback instead of guessing from a tail.
    ...(annotations.title && !annotations.truncated
      ? { title: annotations.title }
      : {}),
    ...(summary ? { summary } : {}),
    annotationProtocol: annotations.protocol,
    annotationsTruncated: annotations.truncated,
  };
}

/** Runtime has proved producer/call and exact receipt provenance. Platform
 * still limits its presentation to authorized, actually returned Job IDs. */
export function jobsWithRuntimeAnnotations(
  jobs: ExecutionSnapshot["jobs"],
  raw: unknown,
  scope: ThreadScope & { sessionId: string; contextId: string },
): ExecutionSnapshot["jobs"] {
  const annotations = scopedRuntimeResponseAnnotations(raw, scope);
  const steps = new Map(
    (annotations?.steps ?? []).map((step) => [step.job_id, step]),
  );
  return jobs.map((job) => {
    const { annotation: _unverified, ...facts } = job;
    if (
      job.thread_id !== scope.threadId ||
      job.session_id !== scope.sessionId ||
      job.context_id !== scope.contextId
    )
      return facts;
    const step = steps.get(job.id);
    const annotation = step
      ? {
          ...(step.intent ? { intent: step.intent } : {}),
          ...(step.result && job.result_event_id
            ? { result: step.result }
            : {}),
        }
      : undefined;
    return annotation && Object.keys(annotation).length
      ? { ...facts, annotation }
      : facts;
  });
}
