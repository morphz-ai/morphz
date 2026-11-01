import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../core/src/model.js";

export type ActivityReadBounds = {
  has_more_threads: boolean;
  has_more_objectives?: boolean;
  has_more_schedules?: boolean;
  next_thread_cursor?: string | null;
  next_objective_cursor?: string | null;
  next_schedule_cursor?: string | null;
  next_history_cursor?: string | null;
};
export type ActivityReadDemand = {
  current: boolean;
  history: boolean;
  append: boolean;
  limit: number;
  cursors?: Partial<
    Record<
      | "thread_cursor"
      | "objective_cursor"
      | "schedule_cursor"
      | "history_cursor",
      string
    >
  >;
  observed?(value: {
    currentAvailable: boolean;
    historyAvailable: boolean;
    current?: ActivityReadBounds;
    history?: ActivityReadBounds;
  }): void;
};
type Stage =
  | "head"
  | "threads"
  | "objectives"
  | "schedules"
  | "history"
  | "history-objectives";
type Pending = Partial<Record<Exclude<Stage, "head">, string>>;
type Coordinate = {
  owner: string;
  contextId: string;
  stage: Stage;
  pending: Pending;
};
const order: Exclude<Stage, "head">[] = [
  "threads",
  "objectives",
  "schedules",
  "history",
  "history-objectives",
];
export type ActivityReadPage = {
  hasMore: boolean;
  nextCursor: string | null;
  retry?: boolean;
};

/** Bounded, ephemeral read coordinates. Each caller receives its own immutable
 * continuation; none is a shared UI cursor or a grant. Tokens retain no rows,
 * bodies, credentials, persisted authority or task state. */
export class ActivityReadPages {
  private coordinates = new Map<string, Coordinate>();
  private save(value: Coordinate) {
    const token = randomUUID();
    this.coordinates.set(token, structuredClone(value));
    while (this.coordinates.size > 128)
      this.coordinates.delete(this.coordinates.keys().next().value!);
    return token;
  }
  async read(options: {
    owner(): readonly unknown[];
    contexts: readonly string[];
    cursor?: string;
    read(contextId: string, demand: ActivityReadDemand): Promise<void>;
  }): Promise<ActivityReadPage> {
    const identity = () =>
      createHash("sha256")
        .update(JSON.stringify(options.owner()))
        .digest("hex");
    const owner = identity();
    const contexts = [...new Set(options.contexts)];
    const saved = options.cursor
      ? this.coordinates.get(options.cursor)
      : undefined;
    if (
      options.cursor &&
      (!saved || saved.owner !== owner || !contexts.includes(saved.contextId))
    )
      throw new DomainError(
        "conflict",
        "活动读取范围已变化，请重新载入当前页。",
      );
    if (!contexts.length) return { hasMore: false, nextCursor: null };
    const coordinate: Coordinate = saved
      ? structuredClone(saved)
      : { owner, contextId: contexts[0]!, stage: "head", pending: {} };
    let observed:
      Parameters<NonNullable<ActivityReadDemand["observed"]>>[0] | undefined;
    const { stage, pending } = coordinate;
    const history = ["head", "history", "history-objectives"].includes(stage);
    const current = !["history", "history-objectives"].includes(stage);
    const field =
      stage === "threads"
        ? "thread_cursor"
        : stage === "objectives" || stage === "history-objectives"
          ? "objective_cursor"
          : stage === "schedules"
            ? "schedule_cursor"
            : stage === "history"
              ? "history_cursor"
              : undefined;
    await options.read(coordinate.contextId, {
      current,
      history,
      append: stage !== "head",
      limit: 50,
      ...(field
        ? { cursors: { [field]: pending[stage as Exclude<Stage, "head">]! } }
        : {}),
      observed: (value) => {
        observed = value;
      },
    });
    if (identity() !== owner)
      throw new DomainError(
        "conflict",
        "活动读取身份已变化，请重新载入当前页。",
      );
    if (
      !observed ||
      (current && !observed.currentAvailable) ||
      (history && !observed.historyAvailable)
    )
      return {
        hasMore: true,
        nextCursor: options.cursor ?? this.save(coordinate),
        retry: true,
      };
    const update = (key: Exclude<Stage, "head">, value?: string | null) => {
      if (value && (value.length > 4096 || value === pending[key]))
        throw new DomainError("invalid", "活动续页未能推进，请重新载入。");
      if (value) pending[key] = value;
      else delete pending[key];
    };
    const a = observed.current,
      h = observed.history;
    if (
      (current &&
        (!a ||
          (a.has_more_threads && !a.next_thread_cursor) ||
          (a.has_more_objectives && !a.next_objective_cursor) ||
          (a.has_more_schedules && !a.next_schedule_cursor))) ||
      (history &&
        (!h ||
          (h.has_more_threads && !h.next_history_cursor) ||
          (h.has_more_objectives && !h.next_objective_cursor)))
    )
      throw new DomainError(
        "invalid",
        "活动续页信息缺失，请更新 Runtime 后重试。",
      );
    if (stage === "head") {
      update("threads", a?.next_thread_cursor);
      update("objectives", a?.next_objective_cursor);
      update("schedules", a?.next_schedule_cursor);
      update("history", h?.next_history_cursor);
      update("history-objectives", h?.next_objective_cursor);
    } else if (stage === "threads") update(stage, a?.next_thread_cursor);
    else if (stage === "objectives") update(stage, a?.next_objective_cursor);
    else if (stage === "schedules") update(stage, a?.next_schedule_cursor);
    else if (stage === "history") update(stage, h?.next_history_cursor);
    else update(stage, h?.next_objective_cursor);
    const nextStage = order.find((key) => pending[key]);
    if (nextStage) coordinate.stage = nextStage;
    else {
      const index = contexts.indexOf(coordinate.contextId);
      const next = contexts[index + 1];
      if (!next) return { hasMore: false, nextCursor: null };
      coordinate.contextId = next;
      coordinate.stage = "head";
      coordinate.pending = {};
    }
    return { hasMore: true, nextCursor: this.save(coordinate) };
  }
}
