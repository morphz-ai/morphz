import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../../packages/core/src/model.js";
import {
  approvalSchema,
  jobSchema,
  executionControlSchema,
  type ExecutionScope,
  type ExecutionSnapshot,
} from "../../../packages/core/src/execution.js";

export type RuntimeRequest = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<unknown>;
type Binding = {
  sessionId: string;
  contextId: string;
  legacySessionIds?: string[];
  rootId?: string;
  threadId?: string;
  rootsBySession?: Record<string, string[]>;
} | null;
const sessionIds = (binding: NonNullable<Binding>) => [
  ...new Set([binding.sessionId, ...(binding.legacySessionIds ?? [])]),
];
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Uses only scoped Runtime reads and control APIs, never its database. */
export class ExecutionControls {
  constructor(
    private request: RuntimeRequest,
    private binding: (scope: ExecutionScope) => Binding,
  ) {}
  private async approvals(binding: NonNullable<Binding>) {
    const data = z
      .object({ approvals: z.array(approvalSchema) })
      .parse(await this.request("/api/approvals"));
    return data.approvals
      .filter(
        (a) =>
          sessionIds(binding).includes(a.request.session_id) &&
          a.request.context_id === binding.contextId,
      )
      .filter(
        (a) => !binding.rootId || a.request.root_turn_id === binding.rootId,
      )
      .filter(
        (a) => !binding.threadId || a.request.thread_id === binding.threadId,
      )
      .filter(
        (a) =>
          !binding.rootsBySession?.[a.request.session_id] ||
          (!!a.request.root_turn_id &&
            binding.rootsBySession[a.request.session_id]!.includes(
              a.request.root_turn_id,
            )),
      )
      .map((a) => ({ ...a, fingerprint: fingerprint(a) }));
  }
  private async job(binding: NonNullable<Binding>, jobId: string) {
    const job = jobSchema.parse(
      await this.request(`/api/execution-jobs/${encodeURIComponent(jobId)}`),
    );
    if (
      job.context_id !== binding.contextId ||
      !sessionIds(binding).includes(job.session_id)
    )
      throw new DomainError("forbidden", "执行不属于当前工作对话。");
    if (!(await this.belongsToRoot(binding, job)))
      throw new DomainError("forbidden", "执行不属于选中的工作。");
    return job;
  }
  private async belongsToRoot(
    binding: NonNullable<Binding>,
    job: z.infer<typeof jobSchema>,
  ) {
    if (binding.threadId && binding.threadId !== job.thread_id) return false;
    const roots = binding.rootsBySession?.[job.session_id];
    if (!binding.rootId && !roots) return true;
    const data = z
      .object({
        snapshot: z.object({
          thread: z.object({
            id: z.literal(job.thread_id),
            session_id: z.literal(job.session_id),
            context_id: z.literal(binding.contextId),
            root_turn_id: z.string(),
          }),
        }),
      })
      .parse(
        await this.request(
          `/api/contexts/${encodeURIComponent(binding.contextId)}/threads/${encodeURIComponent(job.thread_id)}`,
        ),
      );
    return binding.rootId
      ? data.snapshot.thread.root_turn_id === binding.rootId
      : roots!.includes(data.snapshot.thread.root_turn_id);
  }
  async snapshot(scope: ExecutionScope): Promise<ExecutionSnapshot> {
    const binding = this.binding(scope);
    if (!binding) return { jobs: [], approvals: [], limit: 100 };
    const [data, approvals] = await Promise.all([
      Promise.all(
        sessionIds(binding).map((sessionId) =>
          this.request(
            "/api/execution-jobs?" +
              new URLSearchParams({
                session_id: sessionId,
                context_id: binding.contextId,
                include_terminal: "true",
                newest_first: "true",
                limit: "100",
              }),
          ),
        ),
      ),
      this.approvals(binding),
    ]);
    const jobs = data.flatMap(
      (value) => z.object({ jobs: z.array(jobSchema) }).parse(value).jobs,
    );
    const scoped = jobs.filter(
      (j) =>
        sessionIds(binding).includes(j.session_id) &&
        j.context_id === binding.contextId,
    );
    const matches = await Promise.all(
      scoped.map((j) => this.belongsToRoot(binding, j)),
    );
    return {
      jobs: scoped
        .filter((_, i) => matches[i])
        .sort(
          (a, b) =>
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        )
        .slice(0, 100),
      approvals,
      limit: 100,
    };
  }
  async result(scope: ExecutionScope, jobId: string) {
    const binding = this.binding(scope);
    if (!binding) throw new DomainError("not_found", "工作对话不存在。");
    const job = await this.job(binding, jobId);
    const data = z
      .object({
        job_id: z.literal(jobId),
        event: z
          .object({
            id: z.string(),
            payload: z.object({
              session_id: z.literal(job.session_id),
              context_id: z.literal(binding.contextId),
              text: z.string().optional(),
            }),
          })
          .nullable(),
      })
      .parse(
        await this.request(
          `/api/execution-jobs/${encodeURIComponent(jobId)}/result`,
        ),
      );
    if (data.event && data.event.id !== job.result_event_id)
      throw new DomainError("conflict", "执行结果已变化，请刷新后查看。");
    const text = data.event?.payload.text ?? "";
    return {
      text: text.slice(0, 64000),
      truncated: text.length > 64000,
      available: !!data.event,
    };
  }
  async control(raw: unknown) {
    const { scope, action } = executionControlSchema.parse(raw);
    const binding = this.binding(scope);
    if (!binding) throw new DomainError("not_found", "工作对话不存在。");
    if (action.type === "cancel-thread") {
      if (scope.threadId !== action.threadId)
        throw new DomainError("forbidden", "停止目标与查看的执行不一致。");
      const path = `/api/contexts/${encodeURIComponent(binding.contextId)}/threads/${encodeURIComponent(action.threadId)}`;
      const current = z
        .object({
          snapshot: z.object({
            thread: z.object({
              id: z.literal(action.threadId),
              session_id: z.string(),
              context_id: z.literal(binding.contextId),
              root_turn_id: z.string(),
              revision: z.number(),
            }),
          }),
        })
        .parse(await this.request(path));
      const thread = current.snapshot.thread;
      if (
        !sessionIds(binding).includes(thread.session_id) ||
        thread.root_turn_id !== binding.rootId
      )
        throw new DomainError("forbidden", "执行不属于选中的工作。");
      if (thread.revision !== action.revision)
        throw new DomainError("conflict", "执行状态已变化，请刷新后重新决定。");
      const result = z
        .object({
          updated: z.literal(true),
          thread: z.object({
            id: z.literal(action.threadId),
            lifecycle: z.string(),
          }),
        })
        .parse(
          await this.request(path, "POST", {
            action: "cancel",
            expected_revision: action.revision,
            reason: "用户在 Morphz 停止此执行分支",
          }),
        );
      return { accepted: true, status: result.thread.lifecycle };
    }
    if (action.type === "cancel-job") {
      const job = await this.job(binding, action.jobId);
      if (job.revision !== action.revision)
        throw new DomainError("conflict", "执行状态已变化，请刷新后重新决定。");
      const updated = jobSchema.parse(
        await this.request(
          `/api/execution-jobs/${encodeURIComponent(job.id)}/cancel`,
          "POST",
          {
            expected_revision: action.revision,
            reason: "用户在 Morphz 请求停止本项执行",
          },
        ),
      );
      return {
        accepted: true,
        status: updated.status,
        cancelRequested: !!updated.cancel_requested_at,
      };
    }
    const approval = (await this.approvals(binding)).find(
      (a) => a.request.approval_id === action.approvalId,
    );
    if (!approval || approval.fingerprint !== action.fingerprint)
      throw new DomainError("conflict", "审批已结束或内容已变化，请重新查看。");
    const receipt = z.object({ accepted: z.literal(true) }).parse(
      await this.request(
        `/api/approvals/${encodeURIComponent(action.approvalId)}`,
        "POST",
        {
          decision: action.type === "allow-once" ? "allow_once" : "deny",
          rationale: "用户通过 Morphz 明确决定此次操作",
        },
      ),
    );
    return receipt;
  }
}
