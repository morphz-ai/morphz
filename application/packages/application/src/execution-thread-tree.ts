import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import type { ExecutionThread } from "../../core/src/execution.js";
import type { RuntimeRequest } from "./execution.js";
import { activityAnnotationFields } from "./response-annotations.js";
import {
  runtimeThreadAncestryLimit,
  runtimeThreadSupervisionSchema,
} from "./runtime-thread-provenance.js";

const runtimeThreadSnapshot = z.object({
  intent: z.string().nullable().optional(),
  phase: z.string().default("unknown"),
  response_annotations: z.unknown().optional(),
  thread: z.object({
    id: z.string(),
    session_id: z.string(),
    context_id: z.string(),
    root_turn_id: z.string(),
    generation: z.unknown().optional(),
    lifecycle: z.string(),
    control_state: z.string().optional(),
    revision: z.number(),
    created_at: z.string().optional(),
    updated_at: z.string(),
    supervision: runtimeThreadSupervisionSchema.optional(),
  }),
});
type RuntimeThreadSnapshot = z.infer<typeof runtimeThreadSnapshot>;
export type AuthorizedThreadTree = {
  selected: ExecutionThread;
  threads: ExecutionThread[];
  truncated: boolean;
};

function project(value: RuntimeThreadSnapshot): ExecutionThread {
  const t = value.thread;
  const annotation = activityAnnotationFields(value.response_annotations, t);
  return {
    id: t.id,
    sessionId: t.session_id,
    contextId: t.context_id,
    rootId: t.root_turn_id,
    parentThreadId: t.supervision?.parent_thread_id ?? null,
    title: annotation?.title ?? value.intent?.trim() ?? "",
    ...(annotation?.summary ? { summary: annotation.summary } : {}),
    phase: value.phase,
    lifecycle: t.lifecycle,
    controlState: t.control_state,
    revision: t.revision,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/** A selected child is authorized through a freshly read real parent chain,
 * anchored to this reader's persisted original input. Neither shared input IDs,
 * root prefixes, cached bindings nor a scheduler-wide inventory grant access.
 * Cross-Session delegation is deliberately outside this read boundary. */
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
  const read = async (id: string) => {
    const value = z
      .object({ snapshot: runtimeThreadSnapshot })
      .parse(
        await request(
          `/api/contexts/${encodeURIComponent(binding.contextId)}/threads/${encodeURIComponent(id)}`,
        ),
      ).snapshot;
    if (
      value.thread.id !== id ||
      value.thread.session_id !== binding.sessionId ||
      value.thread.context_id !== binding.contextId
    )
      throw new DomainError("forbidden", "执行不属于当前工作对话。");
    return value;
  };
  const selected = await read(binding.threadId);
  let ancestor = selected;
  const visited = new Set<string>();
  for (;;) {
    if (
      visited.has(ancestor.thread.id) ||
      visited.size >= runtimeThreadAncestryLimit
    )
      throw new DomainError("forbidden", "无法核验执行的原始工作来源。");
    visited.add(ancestor.thread.id);
    if (ancestor.thread.root_turn_id === binding.inputRootId) break;
    const parentId = ancestor.thread.supervision?.parent_thread_id;
    if (!parentId)
      throw new DomainError("forbidden", "执行不属于选中的原始工作。");
    ancestor = await read(parentId);
  }
  if (!includeDescendants)
    return {
      selected: project(selected),
      threads: [project(selected)],
      truncated: false,
    };

  // Membership is proven independently from the Context's recent-history
  // window. The Runtime reads only this selected Thread's indexed parent
  // closure; a large unrelated history cannot make a two-node family partial.
  const family = z
    .object({
      session_id: z.literal(binding.sessionId),
      context_id: z.literal(binding.contextId),
      selected_thread_id: z.literal(binding.threadId),
      limit: z.literal(runtimeThreadAncestryLimit),
      has_more: z.boolean(),
      threads: z
        .array(
          z.object({
            id: z.string().min(1),
            session_id: z.literal(binding.sessionId),
            context_id: z.literal(binding.contextId),
            root_turn_id: z.string().min(1),
            parent_thread_id: z.string().min(1).nullable(),
            revision: z.number().int().positive().safe(),
            generation: z.number().int().nonnegative().safe(),
          }),
        )
        .min(1)
        .max(runtimeThreadAncestryLimit),
    })
    .parse(
      await request(
        `/api/sessions/${encodeURIComponent(binding.sessionId)}/threads/${encodeURIComponent(binding.threadId)}/family?limit=${runtimeThreadAncestryLimit}`,
      ),
    );
  const members = new Set<string>();
  for (const [index, member] of family.threads.entries()) {
    if (
      members.has(member.id) ||
      (index === 0
        ? member.id !== binding.threadId
        : !member.parent_thread_id || !members.has(member.parent_thread_id))
    )
      throw new DomainError("forbidden", "无法核验执行的子任务归属。");
    members.add(member.id);
  }
  const threads: RuntimeThreadSnapshot[] = [];
  for (let offset = 0; offset < family.threads.length; offset += 4)
    threads.push(
      ...(await Promise.all(
        family.threads.slice(offset, offset + 4).map(async (member) => {
          const value = await read(member.id);
          const t = value.thread;
          if (
            t.root_turn_id !== member.root_turn_id ||
            (t.supervision?.parent_thread_id ?? null) !==
              member.parent_thread_id ||
            t.revision < member.revision
          )
            throw new DomainError(
              "conflict",
              "执行的子任务来源已变化，请刷新后查看。",
            );
          return value;
        }),
      )),
    );
  const currentSelected = threads[0]!;
  if (
    currentSelected.thread.root_turn_id !== selected.thread.root_turn_id ||
    (currentSelected.thread.supervision?.parent_thread_id ?? null) !==
      (selected.thread.supervision?.parent_thread_id ?? null)
  )
    throw new DomainError(
      "conflict",
      "执行的原始工作来源已变化，请刷新后查看。",
    );
  return {
    selected: project(currentSelected),
    threads: threads.map(project),
    truncated: family.has_more,
  };
}
