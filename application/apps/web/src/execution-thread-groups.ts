import type {
  ExecutionSnapshot,
  ExecutionThread,
} from "../../../packages/core/src/execution.js";
import { executionJobsInReadingOrder } from "./execution-presentation.js";

export type ExecutionThreadGroup = {
  id: string;
  thread?: ExecutionThread;
  depth: number;
  jobs: ExecutionSnapshot["jobs"];
};

/** Preserve exact Thread identities and parent links supplied by the authorized
 * Host projection. Same input/root never creates an invented parent relation. */
export function executionThreadGroups(
  snapshot: ExecutionSnapshot | null,
): ExecutionThreadGroup[] {
  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);
  if (!snapshot?.threads?.length) return [{ id: "legacy", depth: 0, jobs }];
  const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  const parent = (thread: ExecutionThread) => {
    const candidate = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : undefined;
    return candidate &&
      candidate.sessionId === thread.sessionId &&
      candidate.contextId === thread.contextId
      ? candidate
      : undefined;
  };
  const visited = new Set<string>(),
    result: ExecutionThreadGroup[] = [];
  const visit = (thread: ExecutionThread, depth: number) => {
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    result.push({
      id: thread.id,
      thread,
      depth,
      jobs: jobs.filter(
        (job) =>
          job.thread_id === thread.id &&
          job.session_id === thread.sessionId &&
          job.context_id === thread.contextId,
      ),
    });
    snapshot
      .threads!.filter((child) => parent(child)?.id === thread.id)
      .sort(
        (a, b) =>
          (a.createdAt ?? a.updatedAt).localeCompare(
            b.createdAt ?? b.updatedAt,
          ) || a.id.localeCompare(b.id),
      )
      .forEach((child) => visit(child, depth + 1));
  };
  snapshot.threads
    .filter((thread) => !parent(thread))
    .forEach((thread) => visit(thread, 0));
  // Malformed/cyclic optional display metadata must not hide actual Job facts.
  snapshot.threads.forEach((thread) => visit(thread, 0));
  const shown = new Set(
    result.flatMap((group) => group.jobs.map((job) => job.id)),
  );
  const rest = jobs.filter((job) => !shown.has(job.id));
  if (rest.length) result.push({ id: "ungrouped", depth: 0, jobs: rest });
  return result;
}
