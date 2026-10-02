import type { ExecutionActivity } from "../../../packages/core/src/conversation.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import {
  inConversation,
  type Workspace,
} from "../../../packages/core/src/model.js";

export type ActivityThread = ExecutionActivity["threads"][number];
export type ActivityStatus = {
  kind:
    | "running"
    | "waiting"
    | "paused"
    | "ended"
    | "failed"
    | "cancelled"
    | "unknown";
  label: string;
};

/** Annotation prose describes the work; Runtime lifecycle remains authoritative.
 * Terminal summaries stay readable offline, but a cached open-work progress
 * must not look current after its execution snapshot becomes unavailable. */
export function executionActivitySummary(
  thread: ActivityThread,
  available: boolean,
): string {
  if (thread.lifecycle === "open" && !available) return "";
  return thread.summary?.trim() ?? "";
}

/** Lifecycle is authoritative. A completed Thread is not proof that its task succeeded. */
export function executionActivityStatus(
  thread: ActivityThread,
  available: boolean,
): ActivityStatus {
  if (thread.lifecycle === "failed")
    return { kind: "failed", label: "执行失败" };
  if (thread.lifecycle === "cancelled")
    return { kind: "cancelled", label: "已取消" };
  if (thread.lifecycle === "completed")
    return { kind: "ended", label: "已结束" };
  if (thread.lifecycle !== "open" || !available)
    return { kind: "unknown", label: "状态待核对" };
  if (thread.controlState === "paused")
    return { kind: "paused", label: "已暂停" };
  if (thread.phase === "running") return { kind: "running", label: "执行中" };
  if (thread.phase === "runnable") return { kind: "waiting", label: "待执行" };
  if (thread.phase === "waiting") return { kind: "waiting", label: "等待中" };
  if (thread.phase === "idle") return { kind: "waiting", label: "等待唤醒" };
  return { kind: "unknown", label: "状态待核对" };
}

export function executionActivityTime(thread: ActivityThread): string {
  return thread.outcome?.terminalKind === thread.lifecycle
    ? thread.outcome.createdAt
    : thread.updatedAt;
}

function timestampRank(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Keep real Thread identities: two branches of one input are still two executions. */
export function executionActivityThreads(
  state: Workspace,
  threads: readonly ActivityThread[],
  scope: ExecutionScope,
  allWork: boolean,
  sharedDefault: boolean,
): ActivityThread[] {
  const byId = new Map<string, ActivityThread>();
  for (const thread of threads) {
    if (thread.kind !== "execution") continue;
    if (!allWork) {
      if (scope.artifactId) {
        const source = state.inputs.find(
          (input) => input.id === thread.inputId,
        );
        if (
          !source ||
          source.projectId !== thread.projectId ||
          source.artifactId !== scope.artifactId
        )
          continue;
      } else if (
        !inConversation(
          state,
          scope.conversationId ?? scope.projectId,
          thread,
          sharedDefault,
        )
      )
        continue;
    }
    const previous = byId.get(thread.id);
    if (
      !previous ||
      thread.revision > previous.revision ||
      (thread.revision === previous.revision &&
        timestampRank(thread.updatedAt) > timestampRank(previous.updatedAt))
    )
      byId.set(thread.id, thread);
  }
  return [...byId.values()].sort((a, b) => {
    const open =
      Number(b.lifecycle === "open") - Number(a.lifecycle === "open");
    return (
      open ||
      timestampRank(executionActivityTime(b)) -
        timestampRank(executionActivityTime(a)) ||
      a.id.localeCompare(b.id)
    );
  });
}

export function executionActivityScope(
  thread: ActivityThread,
  state: Workspace,
): ExecutionScope {
  const source = state.inputs.find(
    (input) =>
      input.id === thread.inputId && input.projectId === thread.projectId,
  );
  return {
    projectId: thread.projectId,
    conversationId: thread.conversationId,
    artifactId: source?.artifactId ?? null,
    ...(thread.inputId ? { inputId: thread.inputId } : {}),
    threadId: thread.id,
  };
}

export function executionActivityDateGroups(
  threads: readonly ActivityThread[],
  now = new Date(),
) {
  const dateKey = (date: Date) =>
    `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<
    string,
    { key: string; label: string; threads: ActivityThread[] }
  >();
  for (const thread of threads) {
    const date = new Date(executionActivityTime(thread));
    const valid = Number.isFinite(date.getTime());
    const key = valid ? dateKey(date) : "unknown";
    const label = !valid
      ? "时间待核对"
      : key === dateKey(now)
        ? "今天"
        : key === dateKey(yesterday)
          ? "昨天"
          : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    const group = groups.get(key) ?? { key, label, threads: [] };
    group.threads.push(thread);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function executionActivityClock(thread: ActivityThread): string {
  const date = new Date(executionActivityTime(thread));
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "时间待核对";
}
