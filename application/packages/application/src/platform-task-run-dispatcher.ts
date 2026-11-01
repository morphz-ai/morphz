import {
  observeSqlChanges,
  type SqlChangeSource,
  type SqlChangeSubscription,
} from "../../storage/src/commit-notifications.js";
import type { AccessContext } from "../../core/src/model.js";
import type { PlatformStore, TaskSourceRun } from "../../platform/src/store.js";
import type { TaskRunAdmission } from "../../platform/src/task-run-admission.js";
import { TaskSourceRejectedError, type RuntimeBridge } from "./runtime.js";

type Delivery = Pick<
  RuntimeBridge,
  "deliverTaskRun" | "stopPlatformTaskRun" | "controlPlatformTaskRunSchedule"
>;
type SourceDelivery = Pick<
  RuntimeBridge,
  | "inspectTaskSourceDestination"
  | "reconcileTaskSourceEvent"
  | "deliverTaskSource"
  | "stopTaskSource"
>;
export type TaskSourceHooks = SourceDelivery & {
  prepare(
    run: TaskSourceRun,
    destination: import("../../platform/src/task-run-source.js").TaskSourceDestination,
    access: AccessContext,
  ): ReturnType<PlatformStore["prepareTaskSourceEvent"]>;
  check(run: TaskSourceRun, access: AccessContext): Promise<void>;
  attempt(
    run: TaskSourceRun,
    event: import("../../platform/src/task-run-source.js").TaskSourceEvent,
    access: AccessContext,
  ): Promise<string>;
};

/** Drains Platform's committed task admissions into Runtime. Neither the
 * browser nor a model chooses the Runtime request or supplies a credential.
 * A lost POST acknowledgement is retried with the exact persisted request. */
export class PlatformTaskRunDispatcher {
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private ready = false;
  private starting: Promise<void> = Promise.resolve();
  private pending = false;
  private subscriptions: SqlChangeSubscription[] = [];
  private disposeRuntime?: () => void;
  private draining?: Promise<void>;
  private stopped = false;
  private afterEventId: string | undefined;
  private afterStopSequence: number | undefined;
  private afterControlSequence: number | undefined;
  private afterSourceSequence: number | undefined;
  private readonly retry = new Map<string, { count: number; at: number }>();
  private readonly retryKind = new Map<string, string>();
  private readonly seenRetry = new Map<string, Set<string>>();
  private markRetryKey(kind: string, key: string) {
    if (!this.retry.has(key)) return;
    const set = this.seenRetry.get(kind) ?? new Set<string>();
    set.add(key);
    this.seenRetry.set(kind, set);
  }
  private forgetRetry(key: string) {
    this.retry.delete(key);
    this.retryKind.delete(key);
  }
  private pruneRetries(kind: string) {
    const seen = this.seenRetry.get(kind) ?? new Set<string>();
    for (const [key, value] of this.retryKind)
      if (value === kind && !seen.has(key)) this.forgetRetry(key);
    this.seenRetry.delete(kind);
  }
  private failed(kind: string, key: string) {
    const count = Math.min((this.retry.get(key)?.count ?? 0) + 1, 6);
    if (!this.retry.has(key) && this.retry.size >= 1000)
      this.forgetRetry(this.retry.keys().next().value!);
    this.retry.set(key, {
      count,
      at: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)),
    });
    this.retryKind.set(key, kind);
    this.markRetryKey(kind, key);
  }

  constructor(
    private readonly platform: PlatformStore,
    private readonly tenantId: string,
    private readonly runtime: Delivery,
    private readonly authorize: (
      admission: TaskRunAdmission,
    ) => Promise<AccessContext>,
    private readonly prepare: (
      admission: TaskRunAdmission,
      access: AccessContext,
    ) => Promise<TaskRunAdmission | null>,
    private readonly onError: (error: unknown, eventId?: string) => void,
    private readonly now = Date.now,
    private readonly source?: TaskSourceHooks,
    private readonly wakeups?: {
      sources: SqlChangeSource[];
      observeRuntime?: (listener: () => void) => () => void;
    },
  ) {}

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    const sources = new Map(
      [this.platform.changeSource(), ...(this.wakeups?.sources ?? [])].map(
        (source) => [source.driver + source.identity, source],
      ),
    );
    for (const source of sources.values())
      this.subscriptions.push(observeSqlChanges(source, () => this.wake()));
    this.disposeRuntime = this.wakeups?.observeRuntime?.(() => this.wake());
    // Subscribe first. Startup/reconnect closes a bounded queue gap without a
    // healthy polling interval or any browser subscriber.
    this.starting = Promise.all(this.subscriptions.map((s) => s.ready))
      .then(() => {
        if (this.stopped) return;
        this.ready = true;
        this.wake();
      })
      .catch((error) => this.onError(error));
  }

  private wake() {
    if (this.stopped) return;
    this.pending = true;
    if (!this.ready || this.draining) return;
    void this.drain().catch((error) => this.onError(error));
  }
  private armFailedRetry() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.stopped || !this.retry.size) return;
    const at = Math.min(...[...this.retry.values()].map((r) => r.at));
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wake();
      },
      Math.max(1, at - this.now()),
    );
    this.timer.unref?.();
  }
  /** Lifecycle/test join only; observing idle never requests another read. */
  async whenIdle() {
    await this.starting;
    await this.draining;
  }
  async stop() {
    this.stopped = true;
    this.pending = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.disposeRuntime?.();
    this.disposeRuntime = undefined;
    await Promise.all(this.subscriptions.map((s) => s.close()));
    this.subscriptions = [];
    await this.draining;
  }
  async drain() {
    if (this.stopped) return;
    this.pending = true;
    if (this.draining) return this.draining;
    this.draining = Promise.resolve()
      .then(async () => {
        do {
          this.pending = false;
          try {
            await this.drainBatch();
          } catch (error) {
            // Transport/read failure alone owns a retry. Empty healthy queues
            // never arm this timer. Keep the committed queue as authority.
            this.retry.set("$queue", { count: 1, at: this.now() + 1500 });
            throw error;
          }
          this.retry.delete("$queue");
        } while (this.pending && !this.stopped);
      })
      .finally(() => {
        this.draining = undefined;
        this.armFailedRetry();
      });
    return this.draining;
  }

  private async drainBatch() {
    await this.drainStops();
    await this.drainScheduleControls();
    await this.drainSources();
    const admissions = await this.platform.pendingTaskRuns(
      this.tenantId,
      50,
      this.afterEventId,
    );
    if (!admissions.length) {
      this.pruneRetries("admission");
      this.afterEventId = undefined;
      return;
    }
    for (const admission of admissions) {
      this.afterEventId = admission.eventId;
      this.markRetryKey("admission", admission.eventId);
      if (this.stopped) return;
      if ((this.retry.get(admission.eventId)?.at ?? 0) > this.now()) continue;
      try {
        const access = await this.authorize(admission);
        const prepared = await this.prepare(admission, access);
        if (!prepared) {
          this.forgetRetry(admission.eventId);
          continue;
        }
        const receipt = await this.runtime.deliverTaskRun(prepared, access);
        await this.platform.confirmTaskRun(
          this.tenantId,
          admission.eventId,
          receipt,
        );
        this.forgetRetry(admission.eventId);
      } catch (error) {
        this.failed("admission", admission.eventId);
        this.onError(error, admission.eventId);
      }
    }
    if (admissions.length < 50) {
      this.afterEventId = undefined;
      this.pruneRetries("admission");
    } else this.pending = true;
  }

  private async drainStops() {
    const stops = await this.platform.pendingTaskRunStops(
      this.tenantId,
      50,
      this.afterStopSequence,
    );
    if (!stops.length) {
      this.pruneRetries("stop");
      this.afterStopSequence = undefined;
      return;
    }
    for (const pending of stops) {
      this.afterStopSequence = pending.sequence;
      if (this.stopped) return;
      const key = `stop:${pending.taskId}:${pending.runNumber}`;
      this.markRetryKey("stop", key);
      if ((this.retry.get(key)?.at ?? 0) > this.now()) continue;
      try {
        const admission = await this.platform.taskRunAdmissionForRuntime(
          this.tenantId,
          pending.runtime.sessionId,
          pending.runtime.scheduleId,
        );
        if (
          admission.taskId !== pending.taskId ||
          admission.runNumber !== pending.runNumber
        )
          throw new Error("停止请求与原事项执行不一致。");
        const access = await this.authorize(admission);
        if (this.source) {
          let after: string | undefined;
          for (;;) {
            const events = await this.platform.taskRunSourceEvents(
              this.tenantId,
              pending.taskId,
              pending.runNumber,
              after,
            );
            for (const item of events) {
              if (item.discarded) continue;
              const receipt = await this.source.stopTaskSource(
                item.event,
                access,
              );
              if (receipt) {
                if (!item.receipt)
                  await this.platform.confirmTaskSourceEvent(
                    this.tenantId,
                    item.event,
                    receipt,
                  );
              } else {
                if (item.deliveryAttempted)
                  throw new Error("来源投递回执尚未核对，暂不能确认停止。");
                await this.platform.discardUnacceptedTaskSourceEvent(
                  this.tenantId,
                  item.event,
                );
              }
            }
            if (events.length < 100) break;
            after = events.at(-1)!.event.eventId;
          }
        }
        const observation = await this.runtime.stopPlatformTaskRun(
          pending,
          admission,
          access,
        );
        await this.platform.confirmTaskRunStop(
          this.tenantId,
          pending,
          observation,
        );
        this.forgetRetry(key);
      } catch (error) {
        this.failed("stop", key);
        this.onError(error, key);
      }
    }
    if (stops.length < 50) {
      this.afterStopSequence = undefined;
      this.pruneRetries("stop");
    } else this.pending = true;
  }

  private async drainScheduleControls() {
    const controls = await this.platform.pendingTaskRunScheduleControls(
      this.tenantId,
      50,
      this.afterControlSequence,
    );
    if (!controls.length) {
      this.pruneRetries("control");
      this.afterControlSequence = undefined;
      return;
    }
    for (const pending of controls) {
      this.afterControlSequence = pending.sequence;
      if (this.stopped) return;
      const key = `control:${pending.taskId}:${pending.runNumber}`;
      this.markRetryKey("control", key);
      if ((this.retry.get(key)?.at ?? 0) > this.now()) continue;
      try {
        const admission = await this.platform.taskRunAdmissionForRuntime(
          this.tenantId,
          pending.runtime.sessionId,
          pending.runtime.scheduleId,
        );
        if (
          admission.taskId !== pending.taskId ||
          admission.runNumber !== pending.runNumber
        )
          throw new Error("执行控制与原事项执行不一致。");
        const access = await this.authorize(admission);
        const result = await this.runtime.controlPlatformTaskRunSchedule(
          pending,
          admission,
          access,
        );
        await this.platform.confirmTaskRunScheduleControl(
          this.tenantId,
          pending,
          result.observation,
          result.error,
        );
        this.forgetRetry(key);
      } catch (error) {
        this.failed("control", key);
        this.onError(error, key);
      }
    }
    if (controls.length < 50) {
      this.afterControlSequence = undefined;
      this.pruneRetries("control");
    } else this.pending = true;
  }

  private async drainSources() {
    if (!this.source) return;
    const runs = await this.platform.watchedTaskRuns(
      this.tenantId,
      50,
      this.afterSourceSequence,
    );
    if (!runs.length) {
      this.pruneRetries("source");
      this.afterSourceSequence = undefined;
      return;
    }
    for (const run of runs) {
      this.afterSourceSequence = run.sequence;
      if (this.stopped) return;
      const key = `source:${run.admission.eventId}`;
      this.markRetryKey("source", key);
      if ((this.retry.get(key)?.at ?? 0) > this.now()) continue;
      try {
        const access = await this.authorize(run.admission);
        const destination = await this.source.inspectTaskSourceDestination(
          run.admission,
          run.runtime,
          access,
        );
        if (!destination) continue;
        const event = await this.source.prepare(run, destination, access);
        if (!event) continue;
        await this.source.check(run, access);
        const earlier = await this.source.reconcileTaskSourceEvent(
          event,
          access,
        );
        if (
          !earlier &&
          JSON.stringify(event.destination) !== JSON.stringify(destination)
        ) {
          await this.platform.discardUnacceptedTaskSourceEvent(
            this.tenantId,
            event,
          );
          continue;
        }
        let receipt = earlier;
        if (!receipt) {
          const attemptId = await this.source.attempt(run, event, access);
          try {
            receipt = await this.source.deliverTaskSource(
              event,
              run.admission,
              access,
            );
          } catch (error) {
            if (error instanceof TaskSourceRejectedError)
              await this.platform.clearRejectedTaskSourceAttempt(
                this.tenantId,
                event,
                attemptId,
              );
            throw error;
          }
        }
        await this.platform.confirmTaskSourceEvent(
          this.tenantId,
          event,
          receipt,
        );
        this.forgetRetry(key);
      } catch (error) {
        this.failed("source", key);
        this.onError(error, key);
      }
    }
    if (runs.length < 50) {
      this.afterSourceSequence = undefined;
      this.pruneRetries("source");
    } else this.pending = true;
  }
}
