import { z } from "zod";
import { executionModelSchema } from "../../core/src/inference.js";
import { DomainError } from "../../core/src/model.js";
import { jobSchema, type ExecutionThread } from "../../core/src/execution.js";
import type { RuntimeRequest } from "./execution.js";
import { activityAnnotationFields } from "./response-annotations.js";
import { pendingUserInputRequestSchema } from "../../core/src/user-input.js";

export const runtimeExecutionRecordsSchema = z.object({
  session_id: z.string().min(1),
  context_id: z.string().min(1),
  selected_thread_id: z.string().nullable(),
  source_root_id: z.string().nullable(),
  limit: z.number().int().min(1).max(100),
  has_more_jobs: z.boolean(),
  threads_truncated: z.boolean(),
  jobs: z.array(jobSchema.omit({ annotation: true })).max(100),
  threads: z
    .array(
      z.object({
        id: z.string().min(1),
        session_id: z.string().min(1),
        context_id: z.string().min(1),
        root_turn_id: z.string().min(1),
        initiating_principal_id: z.string().nullable().optional(),
        parent_thread_id: z.string().nullable(),
        generation: z.number().int().nonnegative().safe(),
        revision: z.number().int().positive().safe(),
        lifecycle: z.string(),
        control_state: z.string(),
        phase: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        intent: z.string().nullable(),
        response_annotations: z.unknown().optional(),
        user_input_request: pendingUserInputRequestSchema.nullish(),
        execution_model: executionModelSchema.nullish(),
      }),
    )
    .max(100),
});
export type RuntimeExecutionRecords = z.infer<
  typeof runtimeExecutionRecordsSchema
>;

export function executionRecordThread(
  t: RuntimeExecutionRecords["threads"][number],
): ExecutionThread {
  const annotation = activityAnnotationFields(t.response_annotations, t);
  return {
    id: t.id,
    sessionId: t.session_id,
    contextId: t.context_id,
    rootId: t.root_turn_id,
    parentThreadId: t.parent_thread_id,
    title: annotation?.title ?? t.intent?.trim() ?? "",
    ...(t.execution_model ? { executionModel: t.execution_model } : {}),
    ...(t.user_input_request &&
    t.user_input_request.thread_id === t.id &&
    t.user_input_request.thread_generation === t.generation &&
    t.user_input_request.session_id === t.session_id &&
    t.user_input_request.context_id === t.context_id
      ? { userInputRequest: t.user_input_request, waitKinds: ["user_input"] }
      : {}),
    ...(annotation?.summary ? { summary: annotation.summary } : {}),
    phase: t.phase,
    lifecycle: t.lifecycle,
    controlState: t.control_state,
    revision: t.revision,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/** One bounded owner-side projection, not a client ancestry algorithm. */
export async function readExecutionRecords(
  request: RuntimeRequest,
  binding: {
    sessionId: string;
    contextId: string;
    threadId?: string;
    rootIds?: string[];
    threadIds?: string[];
    includeDescendants?: boolean;
    metadataOnly?: boolean;
  },
): Promise<RuntimeExecutionRecords> {
  const query = new URLSearchParams({ limit: "100" });
  if (binding.threadId) query.set("thread_id", binding.threadId);
  if (binding.rootIds?.length)
    query.set("root_turn_ids", JSON.stringify(binding.rootIds));
  if (binding.threadIds?.length)
    query.set("thread_ids", JSON.stringify(binding.threadIds));
  if (binding.includeDescendants) query.set("include_descendants", "true");
  if (binding.metadataOnly) query.set("metadata_only", "true");
  const parsed = runtimeExecutionRecordsSchema.safeParse(
    await request(
      `/api/sessions/${encodeURIComponent(binding.sessionId)}/execution-records?${query}`,
    ),
  );
  if (!parsed.success)
    throw new DomainError(
      "forbidden",
      "无法核验执行记录；数据不属于有效的当前读取范围。",
    );
  const records = parsed.data;
  if (
    records.session_id !== binding.sessionId ||
    records.context_id !== binding.contextId ||
    records.selected_thread_id !== (binding.threadId ?? null) ||
    records.jobs.length > records.limit ||
    (binding.threadId &&
      records.threads.length > (binding.includeDescendants ? 64 : 1)) ||
    (binding.metadataOnly && records.jobs.length > 0)
  )
    throw new DomainError("forbidden", "执行不属于当前工作对话。");
  const ids = new Set<string>();
  for (const [index, thread] of records.threads.entries()) {
    if (
      ids.has(thread.id) ||
      thread.session_id !== binding.sessionId ||
      thread.context_id !== binding.contextId ||
      (binding.threadId &&
        (index === 0
          ? thread.id !== binding.threadId
          : !thread.parent_thread_id || !ids.has(thread.parent_thread_id)))
    )
      throw new DomainError("forbidden", "无法核验执行的子任务归属。");
    if (binding.threadIds && !binding.threadIds.includes(thread.id))
      throw new DomainError("forbidden", "执行不属于选中的工作。");
    ids.add(thread.id);
  }
  if (
    binding.threadId &&
    (!ids.has(binding.threadId) ||
      (binding.rootIds?.length &&
        (!records.source_root_id ||
          !binding.rootIds.includes(records.source_root_id))))
  )
    throw new DomainError("forbidden", "无法核验执行的原始工作来源。");
  for (const job of records.jobs)
    if (
      job.session_id !== binding.sessionId ||
      job.context_id !== binding.contextId ||
      !ids.has(job.thread_id)
    )
      throw new DomainError("forbidden", "执行不属于选中的工作。");
  return records;
}

export type AuthorizedThreadTree = {
  selected: ExecutionThread;
  threads: ExecutionThread[];
  truncated: boolean;
  records: RuntimeExecutionRecords;
};
export async function authorizedExecutionThreadTree(
  request: RuntimeRequest,
  binding: {
    sessionId: string;
    contextId: string;
    inputRootId: string;
    threadId: string;
  },
  includeDescendants: boolean,
): Promise<AuthorizedThreadTree> {
  const records = await readExecutionRecords(request, {
    ...binding,
    rootIds: [binding.inputRootId],
    includeDescendants,
    metadataOnly: !includeDescendants,
  });
  const threads = records.threads.map(executionRecordThread);
  return {
    selected: threads[0]!,
    threads,
    truncated: records.threads_truncated,
    records,
  };
}
