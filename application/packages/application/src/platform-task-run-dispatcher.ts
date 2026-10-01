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
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private stopped = false;
  private afterEventId: string | undefined;
  private afterStopSequence: number | undefined;
  private afterControlSequence: number | undefined;
  private afterSourceSequence: number | undefined;
  private readonly retry = new Map<string, { count: number; at: number }>();

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
  ) {}

  start() {
    if (this.timer || this.stopped) return;
    void this.drain().catch((error) => this.onError(error));
    this.timer = setInterval(
      () => void this.drain().catch((error) => this.onError(error)),
      1500,
    );
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  async drain() {
    if (this.stopped) return;
    if (this.draining) return this.draining;
    this.draining = this.drainBatch().finally(() => {
      this.draining = undefined;
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
      this.afterEventId = undefined;
      return;
    }
    for (const admission of admissions) {
      this.afterEventId = admission.eventId;
      if (this.stopped) return;
      if ((this.retry.get(admission.eventId)?.at ?? 0) > this.now()) continue;
      try {
        const access = await this.authorize(admission);
        const prepared = await this.prepare(admission, access);
        if (!prepared) {
          this.retry.delete(admission.eventId);
          continue;
        }
        const receipt = await this.runtime.deliverTaskRun(prepared, access);
        await this.platform.confirmTaskRun(
          this.tenantId,
          admission.eventId,
          receipt,
        );
        this.retry.delete(admission.eventId);
      } catch (error) {
        const count = Math.min(
          (this.retry.get(admission.eventId)?.count ?? 0) + 1,
          6,
        );
        if (this.retry.size >= 1000)
          this.retry.delete(this.retry.keys().next().value!);
        this.retry.set(admission.eventId, {
          count,
          at: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)),
        });
        this.onError(error, admission.eventId);
      }
    }
    if (admissions.length < 50) this.afterEventId = undefined;
  }

  private async drainStops() {
    const stops = await this.platform.pendingTaskRunStops(
      this.tenantId,
      50,
      this.afterStopSequence,
    );
    if (!stops.length) {
      this.afterStopSequence = undefined;
      return;
    }
    for (const pending of stops) {
      this.afterStopSequence = pending.sequence;
      if (this.stopped) return;
      const key = `stop:${pending.taskId}:${pending.runNumber}`;
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
        this.retry.delete(key);
      } catch (error) {
        const count = Math.min((this.retry.get(key)?.count ?? 0) + 1, 6);
        this.retry.set(key, {
          count,
          at: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)),
        });
        this.onError(error, key);
      }
    }
    if (stops.length < 50) this.afterStopSequence = undefined;
  }

  private async drainScheduleControls() {
    const controls = await this.platform.pendingTaskRunScheduleControls(
      this.tenantId,
      50,
      this.afterControlSequence,
    );
    if (!controls.length) {
      this.afterControlSequence = undefined;
      return;
    }
    for (const pending of controls) {
      this.afterControlSequence = pending.sequence;
      if (this.stopped) return;
      const key = `control:${pending.taskId}:${pending.runNumber}`;
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
        this.retry.delete(key);
      } catch (error) {
        const count = Math.min((this.retry.get(key)?.count ?? 0) + 1, 6);
        this.retry.set(key, {
          count,
          at: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)),
        });
        this.onError(error, key);
      }
    }
    if (controls.length < 50) this.afterControlSequence = undefined;
  }

  private async drainSources() {
    if (!this.source) return;
    const runs = await this.platform.watchedTaskRuns(
      this.tenantId,
      50,
      this.afterSourceSequence,
    );
    if (!runs.length) {
      this.afterSourceSequence = undefined;
      return;
    }
    for (const run of runs) {
      this.afterSourceSequence = run.sequence;
      if (this.stopped) return;
      const key = `source:${run.admission.eventId}`;
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
        this.retry.delete(key);
      } catch (error) {
        const count = Math.min((this.retry.get(key)?.count ?? 0) + 1, 6);
        this.retry.set(key, {
          count,
          at: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)),
        });
        this.onError(error, key);
      }
    }
    if (runs.length < 50) this.afterSourceSequence = undefined;
  }
}
