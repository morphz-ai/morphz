import { z } from "zod";
import type { PendingUserInputRequest } from "../../core/src/user-input.js";

/** Native Scheduler edges, not Agent prose or event-history guesses. */
export const threadWaitDependenciesSchema = z
  .array(
    z.object({
      owner_kind: z.string(),
      owner_id: z.string(),
      owner_generation: z.number().int().positive().safe(),
      dependency_kind: z.string(),
      dependency_id: z.string(),
      required: z.boolean(),
      status: z.string(),
    }),
  )
  .optional();

export const threadWaitHeadSchema = z
  .object({
    thread_id: z.string(),
    generation: z.number().int().nonnegative().safe(),
    revision: z.number().int().positive().safe(),
    kinds: z.array(z.string()).max(12),
    resources: z.array(z.string().max(512)).max(32),
    resources_truncated: z.boolean(),
    until: z.string().nullish(),
  })
  .nullish();
export const dependencyHeadSchema = z
  .object({
    owner_kind: z.string(),
    owner_id: z.string(),
    generation: z.number().int().positive().safe(),
    revision: z.number().int().positive().safe(),
    pending: z.boolean(),
    kinds: z.array(z.string()).max(10),
    resources: z.array(z.string().max(512)).max(32),
    resources_truncated: z.boolean(),
    question: z
      .object({
        request_id: z.string().max(512),
        thread_id: z.string().max(512),
        thread_generation: z.number().int().positive().safe(),
      })
      .nullish(),
  })
  .nullish();

/** Thread-local Scheduler facts, independent of source attribution and its
 * supervising Objective's own dependencies. Never parse intent/diagnostics. */
export function threadWaitProjection(value: {
  thread: {
    id: string;
    session_id: string;
    context_id: string;
    lifecycle: string;
    generation?: unknown;
    revision?: number;
    control_state?: string;
  };
  user_input_request?: PendingUserInputRequest | null;
  wait_head?: z.infer<typeof threadWaitHeadSchema>;
  phase: string;
  dependencies?: z.infer<typeof threadWaitDependenciesSchema>;
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
  const question = value.user_input_request;
  if (
    question &&
    value.thread.lifecycle === "open" &&
    question.thread_id === value.thread.id &&
    question.thread_generation === value.thread.generation &&
    question.session_id === value.thread.session_id &&
    question.context_id === value.thread.context_id
  )
    return { waitKinds: ["user_input"] };
  if (
    value.thread.lifecycle !== "open" ||
    !["waiting", "idle"].includes(value.phase)
  )
    return {};
  const head = value.wait_head;
  if (
    head &&
    head.thread_id === value.thread.id &&
    head.generation === value.thread.generation &&
    head.revision === value.thread.revision &&
    value.thread.control_state === "active"
  )
    return {
      waitKinds: head.kinds,
      ...(head.resources.length ? { waitResources: head.resources } : {}),
      ...(head.until ? { waitUntil: head.until } : {}),
    };
  const kinds = new Set<string>();
  const resources = new Set<string>();
  for (const edge of value.dependencies ?? []) {
    if (
      edge.owner_kind !== "thread" ||
      edge.owner_id !== value.thread.id ||
      edge.owner_generation !== value.thread.generation ||
      !edge.required ||
      edge.status !== "pending"
    )
      continue;
    kinds.add(edge.dependency_kind);
    if (edge.dependency_kind === "resource") resources.add(edge.dependency_id);
  }
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
    ...(resources.size ? { waitResources: [...resources] } : {}),
    ...(dates[0] ? { waitUntil: dates[0] } : {}),
  };
}
