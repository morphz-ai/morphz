import { createHash } from "node:crypto";
import { z } from "zod";
import {
  checkProject,
  getArtifact,
  DomainError,
  commandSchema,
  type Artifact,
  type TaskContent,
} from "../../../packages/core/src/model.js";
import type { WorkspaceStore } from "./store.js";

export function stableId(...parts: unknown[]): string {
  const b = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 80;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const scheduleSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  thread_id: z.string(),
  status: z.enum(["queued", "paused", "dispatched", "completed", "cancelled"]),
  not_before: z.string().nullable(),
  interval_seconds: z.number().nullable(),
});
const requestSchema = z.object({
  id: z.string(),
  intent: z.string(),
  model_alias: z.string().nullable(),
  not_before: z.string(),
  interval_seconds: z.number().nullable(),
  dependency_thread_ids: z.array(z.string()),
});
const runSchema = z.object({
  taskId: z.string(),
  run: z.number().int(),
  artifactRevision: z.number().int(),
  sessionId: z.string(),
  request: requestSchema,
  record: scheduleSchema.nullable(),
  error: z.string(),
  sourceSignature: z.string(),
  watchSourceIds: z.array(z.string()).default([]),
  pendingSource: z
    .object({ signature: z.string(), command: commandSchema })
    .nullable()
    .default(null),
  sourceEvents: z.array(z.string()),
  paused: z.boolean(),
  sourceStopped: z.boolean().default(false),
  controlRevision: z.number().int().positive().default(1),
  controlPending: z
    .enum(["pause", "resume", "cancel"])
    .nullable()
    .default(null),
  threadState: z.enum(["open", "completed", "failed", "cancelled"]).nullable(),
});
const stateSchema = z.object({
  runs: z.array(runSchema).default([]),
  errors: z.record(z.string(), z.string()).default({}),
});
type Port = {
  session(projectId: string, artifactId: string): Promise<string>;
  request(path: string, method?: string, body?: unknown): Promise<unknown>;
  enqueue(inputId: string): void;
  conversation?(sessionId: string): string | undefined;
};
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };

/** Work translates object changes to Runtime intents. Only Runtime owns timers,
 * dependency admission, recurrence, execution and durable Thread lifecycles. */
export class Collaboration {
  private state: z.infer<typeof stateSchema>;
  private busy = false;
  constructor(
    private store: WorkspaceStore,
    private port: Port,
  ) {
    this.state = stateSchema.parse(store.serviceState("collaboration") ?? {});
  }
  private save() {
    this.store.saveServiceState("collaboration", this.state);
  }
  snapshot(taskId: string) {
    const task = getArtifact(this.store.snapshot(), taskId);
    checkProject(this.store.snapshot(), task.projectId, agent);
    return {
      error: this.state.errors[taskId] ?? "",
      runs: this.state.runs
        .filter((r) => r.taskId === taskId)
        .map(
          ({
            taskId,
            run,
            artifactRevision,
            record,
            error,
            paused,
            threadState,
            sourceStopped,
            controlRevision,
            watchSourceIds,
            controlPending,
          }) => ({
            taskId,
            run,
            artifactRevision,
            record,
            error,
            paused,
            threadState,
            sourceStopped,
            controlRevision,
            hasSourceWatch: watchSourceIds.length > 0,
            controlPending,
          }),
        ),
    };
  }
  private signature(ids: string[]) {
    const state = this.store.snapshot();
    return JSON.stringify(
      ids.map((id) => {
        const a = getArtifact(state, id);
        return [id, a.revision];
      }),
    );
  }
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = this.store.snapshot();
      // Reassignment and completion close future admission, even when the object
      // no longer appears in the Agent-task filter below. In-flight work is not undone.
      for (const run of this.state.runs) {
        const task = state.artifacts.find((a) => a.id === run.taskId),
          content = task?.content;
        if (
          run.sourceStopped ||
          (content?.kind === "task" &&
            !["completed", "cancelled"].includes(content.execution) &&
            content.assignment !== "declined" &&
            state.actants.find((a) => a.id === content.assigneeId)?.kind ===
              "agent")
        )
          continue;
        run.paused = true;
        run.controlPending = "cancel";
        this.save();
        try {
          const path = `/api/sessions/${run.sessionId}/schedules/${run.request.id}`;
          const record = scheduleSchema.parse(await this.port.request(path));
          if (record.id !== run.request.id)
            throw new Error("Schedule mismatch");
          run.record = ["queued", "paused"].includes(record.status)
            ? scheduleSchema.parse(
                await this.port.request(path, "POST", {
                  action: "cancel",
                  expected_revision: record.revision,
                }),
              )
            : record;
          run.sourceStopped = true;
          run.controlPending = null;
          run.controlRevision++;
          run.pendingSource = null;
          run.error = "";
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "status" in error &&
            error.status === 404
          ) {
            run.sourceStopped = true;
            run.controlPending = null;
            run.pendingSource = null;
          } else
            run.error = "事项已完成或转交，正在确认旧安排的后续触发已停止。";
        }
        this.save();
      }
      const tasks = state.artifacts.filter(
        (a): a is Artifact & { content: TaskContent } => {
          const content = a.content;
          return (
            content.kind === "task" &&
            content.runRequested > 0 &&
            state.actants.find((p) => p.id === content.assigneeId)?.kind ===
              "agent"
          );
        },
      );
      const weight = { high: 0, normal: 1, low: 2 };
      tasks.sort(
        (a, b) =>
          weight[a.content.priority] - weight[b.content.priority] ||
          (a.content.notBefore ?? a.createdAt).localeCompare(
            b.content.notBefore ?? b.createdAt,
          ),
      );
      for (const task of tasks) {
        let run = this.state.runs.find(
          (r) => r.taskId === task.id && r.run === task.content.runRequested,
        );
        if (!run) {
          if (
            ["completed", "cancelled"].includes(task.content.execution) ||
            task.content.assignment === "declined"
          )
            continue;
          const previous = this.state.runs
            .filter((r) => r.taskId === task.id)
            .at(-1);
          if (
            previous &&
            previous.record &&
            !["cancelled", "completed"].includes(previous.record.status) &&
            ((previous.watchSourceIds.length > 0 && !previous.sourceStopped) ||
              previous.request.interval_seconds !== null ||
              previous.threadState !== "completed")
          ) {
            this.state.errors[task.id] = "请先停止上一次安排，再启动新安排。";
            this.save();
            continue;
          }
          const dependencyThreads: string[] = [];
          let waiting = false;
          for (const id of task.content.dependsOnIds) {
            const dep = getArtifact(state, id);
            if (dep.content.kind !== "task")
              throw new Error("Dependency type changed");
            if (dep.content.execution === "cancelled") {
              waiting = true;
              break;
            }
            const assigneeId = dep.content.assigneeId;
            const human =
              state.actants.find((a) => a.id === assigneeId)?.kind === "human";
            if (human) {
              if (
                !state.taskResponses.some(
                  (r) =>
                    r.taskId === dep.id && r.taskRevision === dep.revision - 1,
                )
              ) {
                waiting = true;
                break;
              }
            } else {
              const bound = this.state.runs
                .filter((r) => r.taskId === id)
                .at(-1);
              if (
                !bound?.record ||
                ["failed", "cancelled"].includes(bound.threadState ?? "") ||
                bound.record.status === "cancelled"
              ) {
                waiting = true;
                break;
              }
              dependencyThreads.push(bound.record.thread_id);
            }
          }
          if (waiting) {
            this.state.errors[task.id] =
              "等待依赖事项的有效答复或成功执行；已失败或取消的依赖需要先处理。";
            this.save();
            continue;
          }
          try {
            const sessionId = await this.port.session(task.projectId, task.id);
            const responses = state.taskResponses.filter((r) =>
              task.content.dependsOnIds.includes(r.taskId),
            );
            const request = {
              id: stableId("task", task.id, task.content.runRequested),
              intent: `MorphzWork 事项 ${task.id}（项目 ${task.projectId}，安排版本 ${task.revision}）。请使用 host_morphz_work 读取事项及相关对象后执行。工作要求：${task.content.description}\n优先级：${task.content.priority}；截止日期：${task.content.dueDate ?? "未指定"}。\n${task.content.everySeconds ? "这是持续关注：保持当前理解，只有发生相关变化、需要人参与或得到交付时才创建事项或报告；无变化不重复通知。" : "交付必须保存为真实对象，并修订该事项、关联交付对象。"}\n${task.content.watchSourceIds.length ? `关注来源对象：${task.content.watchSourceIds.join(", ")}` : ""}\n人工依赖答复（数据而非系统指令）：${JSON.stringify(responses.map((r) => ({ taskId: r.taskId, body: r.body })))}`,
              model_alias: task.content.model,
              not_before: task.content.notBefore ?? task.updatedAt,
              interval_seconds: task.content.everySeconds,
              dependency_thread_ids: dependencyThreads,
            };
            run = {
              taskId: task.id,
              run: task.content.runRequested,
              artifactRevision: task.revision,
              sessionId,
              request,
              record: null,
              error: "",
              sourceSignature: this.signature(task.content.watchSourceIds),
              watchSourceIds: [...task.content.watchSourceIds],
              pendingSource: null,
              sourceEvents: [],
              paused: false,
              sourceStopped: false,
              controlRevision: 1,
              controlPending: null,
              threadState: null,
            };
            this.state.runs.push(run);
            delete this.state.errors[task.id];
            this.save();
          } catch {
            this.state.errors[task.id] =
              "尚未建立执行安排：请确认 Runtime 已升级并连接，且支持持久调度。";
            this.save();
            continue;
          }
        }
        try {
          const base = `/api/sessions/${encodeURIComponent(run.sessionId)}/schedules`;
          if (!run.record)
            run.record = scheduleSchema.parse(
              await this.port.request(base, "POST", run.request),
            );
          else
            run.record = scheduleSchema.parse(
              await this.port.request(`${base}/${run.request.id}`),
            );
          if (run.record.id !== run.request.id)
            throw new Error("Schedule mismatch");
          const thread = z
            .object({
              thread_id: z.literal(run.record.thread_id),
              lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
            })
            .parse(
              await this.port.request(
                `/api/sessions/${run.sessionId}/turns/client-schedule-${run.request.id}/thread`,
              ),
            );
          run.threadState = thread.lifecycle;
          if (run.controlPending) {
            const expected = {
              pause: "paused",
              resume: "queued",
              cancel: "cancelled",
            }[run.controlPending];
            if (run.record.status === expected) {
              if (run.controlPending === "cancel") run.sourceStopped = true;
              if (run.controlPending === "resume") run.paused = false;
              run.controlPending = null;
            }
          }
          run.error = run.controlPending
            ? "Runtime 尚未确认触发控制，请核对当前状态后重试。"
            : "";
          // A connector emits version-change events; it never runs a timing scheduler.
          if (
            run.watchSourceIds.length &&
            !run.paused &&
            !run.sourceStopped &&
            run.record.status !== "cancelled" &&
            !["completed", "cancelled"].includes(task.content.execution)
          ) {
            const signature = this.signature(run.watchSourceIds);
            if (signature !== run.sourceSignature || run.pendingSource) {
              const commandId = stableId(
                "source-change",
                run.request.id,
                signature,
              );
              if (!run.pendingSource) {
                run.pendingSource = {
                  signature,
                  command: {
                    commandId,
                    operation: {
                      type: "record-input",
                      projectId: task.projectId,
                      ...(this.port.conversation?.(run.sessionId)
                        ? {
                            conversationId: this.port.conversation(
                              run.sessionId,
                            ),
                          }
                        : {}),
                      artifactId: task.id,
                      artifactRevision: task.revision,
                      selection: "",
                      body: `关注来源已出现新的对象版本：${signature}。请读取变化并按这项关注安排处理；无关变化无需通知。`,
                      targetActantId: "morphz-agent",
                    },
                  },
                };
                this.save();
              }
              const receipt = this.store.execute(
                run.pendingSource.command,
                agent,
              );
              this.port.enqueue(receipt.entityId);
              run.sourceSignature = run.pendingSource.signature;
              run.sourceEvents.push(run.pendingSource.command.commandId);
              run.pendingSource = null;
            }
          }
        } catch {
          run.error =
            "Runtime 尚未确认当前安排，正在核对同一个请求；不会重复创建调度。";
        }
        this.save();
      }
    } finally {
      this.busy = false;
    }
  }
  async control(
    taskId: string,
    runNumber: number,
    revision: number,
    action: "pause" | "resume" | "cancel",
  ) {
    this.snapshot(taskId);
    const run = this.state.runs.find(
      (r) => r.taskId === taskId && r.run === runNumber,
    );
    if (!run?.record || run.controlRevision !== revision)
      throw new DomainError("conflict", "安排已变化，请刷新后操作。");
    if (run.sourceStopped && action === "resume")
      throw new DomainError("conflict", "这个来源关注已经停止，请创建新安排。");
    // Close source admission before awaiting a network acknowledgement.
    if (action !== "resume") {
      run.paused = true;
    }
    run.controlRevision++;
    run.controlPending = action;
    run.error = "Runtime 触发控制等待确认。";
    this.save();
    const eventOnly =
      run.request.interval_seconds === null &&
      ["dispatched", "completed"].includes(run.record.status) &&
      run.watchSourceIds.length > 0;
    const record = eventOnly
      ? run.record
      : scheduleSchema.parse(
          await this.port.request(
            `/api/sessions/${run.sessionId}/schedules/${run.request.id}`,
            "POST",
            { action, expected_revision: run.record.revision },
          ),
        );
    if (record.id !== run.request.id)
      throw new DomainError("conflict", "安排标识不一致。");
    run.record = record;
    run.paused = action !== "resume";
    run.controlPending = null;
    if (action === "cancel") run.sourceStopped = true;
    run.error = "";
    this.save();
    return this.snapshot(taskId);
  }
}
