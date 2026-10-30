import { z } from "zod";
import type { ExecutionThread } from "../../core/src/execution.js";
import type { RuntimeRequest } from "./execution.js";
import {
  executionRecordThread,
  type RuntimeExecutionRecords,
} from "./execution-thread-tree.js";
import { objectiveWaitKinds } from "./objective-wait-projection.js";
import { threadWaitProjection } from "./thread-wait-projection.js";
import { pendingUserInputRequestSchema } from "../../core/src/user-input.js";

const schedulerThreadSchema = z.object({
  user_input_request: pendingUserInputRequestSchema.nullish(),
  thread: z.object({
    id: z.string(),
    kind: z.string().optional(),
    session_id: z.string(),
    context_id: z.string(),
    root_turn_id: z.string(),
    generation: z.number().int().nonnegative().safe(),
    revision: z.number().int().positive().safe(),
    lifecycle: z.string(),
    control_state: z.string(),
    supervision: z
      .object({
        supervisor_kind: z.string(),
        supervisor_id: z.string().nullable(),
        generation: z.number().int().positive().safe(),
        origin_evaluation_id: z.string().nullable(),
        parent_thread_id: z.string().nullable(),
      })
      .optional(),
  }),
  phase: z.string(),
  schedules: z
    .array(
      z.object({
        thread_id: z.string(),
        status: z.string(),
        not_before: z.string().nullable().optional(),
      }),
    )
    .optional(),
  activations: z
    .array(
      z.object({
        jobs: z.array(
          z.object({
            job: z.object({
              thread_id: z.string(),
              session_id: z.string(),
              context_id: z.string(),
              status: z.string(),
            }),
          }),
        ),
      }),
    )
    .optional(),
});
const schedulerObjectiveSchema = z.object({
  objective: z.object({
    id: z.string(),
    context_id: z.string(),
    coordinator_session_id: z.string(),
    generation: z.number().int().positive().safe(),
  }),
  readiness: z.object({
    state: z.string(),
    dependency_ids: z.array(z.string()).optional(),
  }),
  dependencies: z
    .array(
      z.object({
        id: z.string(),
        owner_kind: z.string(),
        owner_id: z.string(),
        owner_generation: z.number(),
        dependency_kind: z.string(),
        dependency_id: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        required: z.boolean(),
        status: z.string(),
      }),
    )
    .optional(),
});
const schedulerSchema = z.object({
  context_id: z.string(),
  threads: z.array(z.unknown()).max(200),
  objectives: z.array(z.unknown()).max(200).optional(),
});
const threadIdentity = z.object({ thread: z.object({ id: z.string() }) });
const objectiveIdentity = z.object({ objective: z.object({ id: z.string() }) });

/** Enrich an already authorized family with current structured wait facts.
 * A scheduler read is display evidence, never a new family/permission grant.
 * Missing bounded rows or changed executions remain unknown, not inferred. */
export async function executionThreadsWithWait(
  request: RuntimeRequest,
  records: RuntimeExecutionRecords,
): Promise<ExecutionThread[]> {
  const threads = records.threads.map(executionRecordThread);
  const waiting = records.threads.filter(
    (t) =>
      t.lifecycle === "open" &&
      t.control_state !== "paused" &&
      ["idle", "waiting"].includes(t.phase),
  );
  if (!waiting.length) return threads;
  // One bounded, fresh read for the family, not one request per child and not
  // cached overview state. Read errors (including revoked access) propagate.
  const parsed = schedulerSchema.safeParse(
    await request(
      `/api/contexts/${encodeURIComponent(records.context_id)}/scheduler?include_terminal=false&limit=200`,
    ),
  );
  if (!parsed.success || parsed.data.context_id !== records.context_id)
    return threads;
  const scheduler = parsed.data;
  return threads.map((thread, index) => {
    const record = records.threads[index]!;
    if (!waiting.includes(record)) return thread;
    const matches = scheduler.threads.filter((value) => {
      const identity = threadIdentity.safeParse(value);
      return identity.success && identity.data.thread.id === record.id;
    });
    if (matches.length !== 1) return thread;
    const candidate = schedulerThreadSchema.safeParse(matches[0]);
    if (!candidate.success) return thread;
    const current = candidate.data;
    if (!(
      current.thread.session_id === record.session_id &&
      current.thread.context_id === record.context_id &&
      current.thread.root_turn_id === record.root_turn_id &&
      current.thread.generation === record.generation &&
      current.thread.revision === record.revision &&
      current.thread.lifecycle === record.lifecycle &&
      current.thread.control_state === record.control_state &&
      current.phase === record.phase
    ))
      return thread;
    const own = threadWaitProjection(current);
    if (own.waitKinds?.length) return { ...thread, ...own };
    const supervision = current.thread.supervision;
    // An ordinary child can share its parent's Objective and even have no
    // originating Evaluation. Only the parent-less primary owns this wait.
    if (
      current.thread.kind !== "execution" ||
      record.parent_thread_id !== null ||
      supervision?.parent_thread_id !== null ||
      supervision.supervisor_kind !== "objective" ||
      supervision.origin_evaluation_id !== null
    )
      return thread;
    const objectives = (scheduler.objectives ?? []).filter((value) => {
      const identity = objectiveIdentity.safeParse(value);
      return (
        identity.success &&
        identity.data.objective.id === supervision.supervisor_id
      );
    });
    if (objectives.length !== 1) return thread;
    const objective = schedulerObjectiveSchema.safeParse(objectives[0]);
    if (
      !objective.success ||
      objective.data.objective.generation !== supervision.generation ||
      objective.data.objective.context_id !== record.context_id ||
      objective.data.objective.coordinator_session_id !== record.session_id
    )
      return thread;
    const kinds = objectiveWaitKinds(objective.data);
    return kinds?.length ? { ...thread, waitKinds: kinds } : thread;
  });
}
