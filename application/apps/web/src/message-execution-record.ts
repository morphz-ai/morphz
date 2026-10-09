import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";
import type { RecordedInput } from "../../../packages/core/src/model.js";
import {
  executionActivityStatus,
  type ActivityThread,
  type ActivityStatus,
} from "./execution-activity.js";

/** A read-only link to known authorized execution history, not a claim of live
 * work. Never infer a task from delivery state, prose, or a shared Session. */
export function inputExecutionRecordStatus(
  runtime: ConversationRuntime,
  input:
    | Pick<RecordedInput, "id" | "projectId" | "conversationId">
    | null
    | undefined,
  online: boolean,
): ActivityStatus | undefined {
  if (!input) return undefined;
  const byId = new Map<string, ActivityThread>();
  for (const thread of runtime.activity?.threads ?? []) {
    if (
      thread.inputId !== input.id ||
      thread.projectId !== input.projectId ||
      thread.conversationId !== (input.conversationId ?? input.projectId)
    )
      continue;
    const previous = byId.get(thread.id);
    if (
      !previous ||
      thread.revision > previous.revision ||
      (thread.revision === previous.revision &&
        Date.parse(thread.updatedAt) > Date.parse(previous.updatedAt))
    )
      byId.set(thread.id, thread);
  }
  const threads = [...byId.values()].filter(
    (thread) => thread.kind === "execution",
  );
  const open = threads.filter((thread) => thread.lifecycle === "open");
  const statuses = (open.length ? open : threads).map((thread) =>
    executionActivityStatus(
      thread,
      online && runtime.connected && !!runtime.activity?.available,
    ),
  );
  return (
    statuses.find((status) => status.kind === "running") ??
    statuses.find((status) => status.kind === "unknown") ??
    statuses.find((status) => status.kind === "failed") ??
    statuses.find((status) => status.kind === "cancelled") ??
    statuses.find((status) => status.kind === "paused") ??
    statuses[0]
  );
}
