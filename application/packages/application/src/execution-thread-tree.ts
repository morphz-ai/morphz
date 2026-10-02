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

  // Reuse the Runtime's existing bounded open/history inventory. A full page
  // is not proof of complete historical descendants; never synthesize missing
  // branches from tool text or require a second persistent index.
  const inventory = z.object({
    threads: z.array(z.unknown()),
    detail_bounds: z
      .object({
        limit: z.number(),
        has_more_threads: z.boolean(),
      })
      .optional(),
  });
  const views = await Promise.all(
    [false, true].map(async (terminal) =>
      inventory.parse(
        await request(
          `/api/contexts/${encodeURIComponent(binding.contextId)}/scheduler?include_terminal=${terminal}&limit=200`,
        ),
      ),
    ),
  );
  const known = new Map<string, RuntimeThreadSnapshot>();
  for (const view of views)
    for (const raw of view.threads) {
      const parsed = runtimeThreadSnapshot.safeParse(raw);
      if (!parsed.success) continue;
      const value = parsed.data,
        t = value.thread;
      if (
        t.session_id !== binding.sessionId ||
        t.context_id !== binding.contextId
      )
        continue;
      const previous = known.get(t.id);
      if (
        !previous ||
        t.revision > previous.thread.revision ||
        (t.revision === previous.thread.revision &&
          t.updated_at > previous.thread.updated_at)
      )
        known.set(t.id, value);
    }
  // The exact endpoint is the newest selected-Thread proof, including when its
  // historical position lies outside the bounded scheduler page.
  known.set(selected.thread.id, selected);
  const threads = [selected];
  const descendants = new Set([selected.thread.id]);
  let changed = true;
  let truncated = views.some(
    (view, i) =>
      view.detail_bounds?.has_more_threads !== false ||
      (i === 1 && view.threads.length >= (view.detail_bounds?.limit ?? 200)),
  );
  while (changed) {
    changed = false;
    for (const value of known.values()) {
      if (
        descendants.has(value.thread.id) ||
        !value.thread.supervision?.parent_thread_id ||
        !descendants.has(value.thread.supervision.parent_thread_id)
      )
        continue;
      if (threads.length >= runtimeThreadAncestryLimit) {
        truncated = true;
        continue;
      }
      descendants.add(value.thread.id);
      threads.push(value);
      changed = true;
    }
  }
  return {
    selected: project(selected),
    threads: threads.map(project),
    truncated,
  };
}
