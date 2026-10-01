import type {
  ExecutionActivity,
  RuntimeSchedule,
} from "../../../packages/core/src/conversation.js";

/** A timer waiting to fire is not an executing Agent. Only Runtime's exact
 * schedule state determines whether it belongs in the future-work inventory. */
export function runtimeArrangements(
  activity: ExecutionActivity | undefined,
  connected: boolean,
  coveredScheduleIds: ReadonlySet<string>,
) {
  if (!connected || !activity?.available || !activity.schedulesAvailable)
    return [];
  const rows = new Map<string, RuntimeSchedule>();
  for (const row of activity.schedules ?? []) {
    if (
      coveredScheduleIds.has(row.scheduleId) ||
      !(
        ["queued", "paused"].includes(row.status) ||
        (row.status === "dispatched" && row.intervalSeconds !== null)
      )
    )
      continue;
    const previous = rows.get(row.scheduleId);
    if (!previous || row.revision >= previous.revision)
      rows.set(row.scheduleId, row);
  }
  return [...rows.values()].sort(
    (left, right) =>
      (left.notBefore ?? "\uffff").localeCompare(right.notBefore ?? "\uffff") ||
      left.scheduleId.localeCompare(right.scheduleId),
  );
}

export function arrangementTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间待核对"
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

export function arrangementInterval(seconds: number | null | undefined) {
  if (!seconds) return "";
  return seconds % 3600 === 0
    ? `每 ${seconds / 3600} 小时`
    : seconds % 60 === 0
      ? `每 ${seconds / 60} 分钟`
      : `每 ${seconds} 秒`;
}

export function runtimeArrangementLabel(row: RuntimeSchedule) {
  const time = arrangementTime(row.notBefore);
  return [
    row.status === "paused"
      ? "已暂停"
      : row.dependencyThreadIds.length
        ? "等待前置工作"
        : "等待触发",
    time,
    arrangementInterval(row.intervalSeconds),
  ]
    .filter(Boolean)
    .join(" · ");
}
