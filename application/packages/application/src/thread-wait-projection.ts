/** Thread-local Scheduler facts, independent of source attribution and its
 * supervising Objective's own dependencies. Never parse intent/diagnostics. */
export function threadWaitProjection(value: {
  thread: {
    id: string;
    session_id: string;
    context_id: string;
    lifecycle: string;
  };
  phase: string;
  schedules?: {
    thread_id: string;
    status?: string;
    not_before?: string | null;
    dependency_thread_ids?: string[];
  }[];
  activations?: {
    jobs: {
      job: {
        thread_id: string;
        session_id: string;
        context_id: string;
        status: string;
      };
    }[];
  }[];
}) {
  if (
    value.thread.lifecycle !== "open" ||
    !["waiting", "idle"].includes(value.phase)
  )
    return {};
  const kinds = new Set<string>();
  if (
    value.activations?.some((activation) =>
      activation.jobs.some(
        ({ job }) =>
          job.thread_id === value.thread.id &&
          job.session_id === value.thread.session_id &&
          job.context_id === value.thread.context_id &&
          job.status === "waiting_approval",
      ),
    )
  )
    kinds.add("permission");
  const schedules = (value.schedules ?? []).filter(
    (schedule) =>
      schedule.thread_id === value.thread.id &&
      ["queued", "paused"].includes(schedule.status ?? ""),
  );
  const queued = schedules.filter((schedule) => schedule.status === "queued");
  const dates = queued
    .map((schedule) => schedule.not_before)
    .filter(
      (date): date is string => !!date && Number.isFinite(Date.parse(date)),
    )
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  if (dates.length) kinds.add("timer");
  // A paused Schedule is not a pending Human reply or a future firing time.
  if (schedules.length && !queued.length) kinds.add("schedule_resume");
  return {
    ...(kinds.size ? { waitKinds: [...kinds] } : {}),
    ...(dates[0] ? { waitUntil: dates[0] } : {}),
  };
}
