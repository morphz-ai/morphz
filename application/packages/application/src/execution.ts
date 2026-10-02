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
import { jobsWithRuntimeAnnotations } from "./response-annotations.js";

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
  additionalRoot?: (rootId: string, threadId: string) => Promise<boolean>;
  threadIds?: () => Promise<string[]>;
} | null;
const sessionIds = (binding: NonNullable<Binding>) => [
  ...new Set([binding.sessionId, ...(binding.legacySessionIds ?? [])]),
];
// The Job API supplies physical facts. Display annotations are only accepted
// from the separately verified exact-Thread Runtime projection below.
const runtimeJobSchema = jobSchema.omit({ annotation: true });
type ThreadProofs = Map<string, { generation?: number }>;
const proofKey = (sessionId: string, threadId: string) =>
  `${sessionId}\u0000${threadId}`;
export const approvalFingerprint = (value: unknown) =>
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
    const candidates = data.approvals
      .filter(
        (a) =>
          sessionIds(binding).includes(a.request.session_id) &&
          a.request.context_id === binding.contextId,
      )
      .filter(
        (a) =>
          !binding.rootsBySession?.[a.request.session_id] ||
          (!!a.request.root_turn_id &&
            binding.rootsBySession[a.request.session_id]!.includes(
              a.request.root_turn_id,
            )),
      );
    const matches: boolean[] = [];
    for (let offset = 0; offset < candidates.length; offset += 4)
      matches.push(
        ...(await Promise.all(
          candidates.slice(offset, offset + 4).map(async (a) => {
            const original =
              (!binding.rootId || a.request.root_turn_id === binding.rootId) &&
              (!binding.threadId || a.request.thread_id === binding.threadId);
            return (
              original ||
              (!!binding.additionalRoot &&
                !!a.request.root_turn_id &&
                !!a.request.thread_id &&
                (await binding.additionalRoot(
                  a.request.root_turn_id,
                  a.request.thread_id,
                )))
            );
          }),
        )),
      );
    return candidates
      .filter((_, i) => matches[i])
      .map((a) => ({ ...a, fingerprint: approvalFingerprint(a) }));
  }
  /** The task list needs a scoped count, not every execution job and result.
   * Reuse the same exact Session/Context/root/Thread checks as the inspector. */
  async pendingApprovalCount(scope: ExecutionScope) {
    const binding = this.binding(scope);
    return binding ? (await this.approvals(binding)).length : 0;
  }
  private async job(binding: NonNullable<Binding>, jobId: string) {
    const job = runtimeJobSchema.parse(
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
    proofs?: ThreadProofs,
  ) {
    if (
      binding.threadId &&
      binding.threadId !== job.thread_id &&
      !binding.additionalRoot
    )
      return false;
    const roots = binding.rootsBySession?.[job.session_id];
    // Legacy whole-Session inspectors keep their existing factual read; the
    // new display projection is restricted to an exact proven work root.
    if (!binding.rootId && !roots) return true;
    const data = z
      .object({
        snapshot: z.object({
          thread: z.object({
            id: z.literal(job.thread_id),
            session_id: z.literal(job.session_id),
            context_id: z.literal(binding.contextId),
            root_turn_id: z.string(),
            generation: z.unknown().optional(),
          }),
        }),
      })
      .parse(
        await this.request(
          `/api/contexts/${encodeURIComponent(binding.contextId)}/threads/${encodeURIComponent(job.thread_id)}`,
        ),
      );
    const thread = data.snapshot.thread;
    const rootId = thread.root_turn_id;
    const original =
      (!binding.threadId || binding.threadId === job.thread_id) &&
      (binding.rootId
        ? rootId === binding.rootId
        : !roots || roots.includes(rootId));
    const allowed =
      original ||
      (!!binding.additionalRoot &&
        (await binding.additionalRoot(rootId, job.thread_id)));
    if (allowed && proofs) {
      const generation = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .safeParse(thread.generation);
      proofs.set(proofKey(job.session_id, job.thread_id), {
        ...(generation.success ? { generation: generation.data } : {}),
      });
    }
    return allowed;
  }
  private async annotatedJobs(
    binding: NonNullable<Binding>,
    jobs: ExecutionSnapshot["jobs"],
    proofs: ThreadProofs,
  ): Promise<ExecutionSnapshot["jobs"]> {
    const groups = new Map<string, ExecutionSnapshot["jobs"]>();
    for (const job of jobs) {
      const key = proofKey(job.session_id, job.thread_id);
      const group = groups.get(key) ?? [];
      group.push(job);
      groups.set(key, group);
    }
    const annotated = new Map<string, ExecutionSnapshot["jobs"][number]>();
    const entries = [...groups.entries()];
    for (let offset = 0; offset < entries.length; offset += 4)
      await Promise.all(
        entries.slice(offset, offset + 4).map(async ([key, group]) => {
          const job = group[0]!;
          const proof = proofs.get(key);
          // Older Runtime responses have no generation or projection endpoint.
          // Their factual inspector remains usable, without guessed annotations.
          if (proof?.generation === undefined) return;
          try {
            const raw = await this.request(
              `/api/sessions/${encodeURIComponent(job.session_id)}/threads/${encodeURIComponent(job.thread_id)}/annotations`,
            );
            for (const value of jobsWithRuntimeAnnotations(group, raw, {
              sessionId: job.session_id,
              contextId: binding.contextId,
              threadId: job.thread_id,
              generation: proof.generation,
            }))
              annotated.set(value.id, value);
          } catch {
            // A failed optional read cannot hide Jobs, invent success, or cause
            // tool/model replay. The next explicit refresh can read it again.
          }
        }),
      );
    return jobs.map((job) => annotated.get(job.id) ?? job);
  }
  async snapshot(scope: ExecutionScope): Promise<ExecutionSnapshot> {
    const binding = this.binding(scope);
    if (!binding) return { jobs: [], approvals: [], limit: 100 };
    const proofs: ThreadProofs = new Map();
    if (binding.threadIds) {
      const threadIds = [...new Set(await binding.threadIds())];
      let jobs: z.infer<typeof jobSchema>[] = [];
      const approvals = await this.approvals(binding);
      for (let offset = 0; offset < threadIds.length; offset += 4) {
        const batch = await Promise.all(
          threadIds.slice(offset, offset + 4).map(async (threadId) => {
            const result = z.object({ jobs: z.array(runtimeJobSchema) }).parse(
              await this.request(
                "/api/execution-jobs?" +
                  new URLSearchParams({
                    session_id: binding.sessionId,
                    context_id: binding.contextId,
                    thread_id: threadId,
                    include_terminal: "true",
                    newest_first: "true",
                    limit: "100",
                  }),
              ),
            );
            const scoped = result.jobs.filter(
              (job) =>
                job.session_id === binding.sessionId &&
                job.context_id === binding.contextId &&
                job.thread_id === threadId,
            );
            // Every selected job names this same exact immutable Thread/root;
            // one fresh provenance proof applies to all its returned job IDs.
            return !scoped.length ||
              (await this.belongsToRoot(binding, scoped[0]!, proofs))
              ? scoped
              : [];
          }),
        );
        jobs = [...jobs, ...batch.flat()]
          .sort(
            (a, b) =>
              b.created_at.localeCompare(a.created_at) ||
              b.id.localeCompare(a.id),
          )
          .slice(0, 100);
      }
      return {
        jobs: await this.annotatedJobs(binding, jobs, proofs),
        approvals,
        limit: 100,
      };
    }
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
      (value) =>
        z.object({ jobs: z.array(runtimeJobSchema) }).parse(value).jobs,
    );
    const scoped = jobs.filter(
      (j) =>
        sessionIds(binding).includes(j.session_id) &&
        j.context_id === binding.contextId,
    );
    const matches = await Promise.all(
      scoped.map((j) => this.belongsToRoot(binding, j, proofs)),
    );
    return {
      jobs: await this.annotatedJobs(
        binding,
        scoped
          .filter((_, i) => matches[i])
          .sort(
            (a, b) =>
              b.created_at.localeCompare(a.created_at) ||
              b.id.localeCompare(a.id),
          )
          .slice(0, 100),
        proofs,
      ),
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
