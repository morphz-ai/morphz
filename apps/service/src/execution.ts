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
    return job;
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
    return {
      jobs: jobs
        .filter(
          (j) =>
            sessionIds(binding).includes(j.session_id) &&
            j.context_id === binding.contextId,
        )
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
