import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../../packages/core/src/model.js";
import {
  approvalSchema,
  jobSchema,
  executionControlSchema,
  isExecutionThreadControl,
  reusableApprovalScopes,
  type ExecutionScope,
  type ExecutionReadScope,
  type ExecutionSnapshot,
} from "../../../packages/core/src/execution.js";
import { jobsWithRuntimeAnnotations } from "./response-annotations.js";
import {
  readExecutionRecords,
  type RuntimeExecutionRecords,
} from "./execution-thread-tree.js";
import { executionThreadsWithWait } from "./execution-wait-projection.js";

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
  records?: RuntimeExecutionRecords;
  principalId?: string;
} | null;
const sessionIds = (binding: NonNullable<Binding>) => [
  ...new Set([binding.sessionId, ...(binding.legacySessionIds ?? [])]),
];
// The Job API supplies physical facts. Display annotations are only accepted
// from the separately verified exact-Thread Runtime projection below.
const runtimeJobSchema = jobSchema.omit({ annotation: true });
export const approvalFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Uses only scoped Runtime reads and control APIs, never its database. */
export class ExecutionControls {
  constructor(
    private request: RuntimeRequest,
    private binding: (scope: ExecutionReadScope) => Binding,
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
  ) {
    if (
      binding.threadId &&
      binding.threadId !== job.thread_id &&
      !binding.additionalRoot
    )
      return false;
    const roots = binding.rootsBySession?.[job.session_id];
    if (!binding.rootId && !roots) return true;
    // Exact immutable provenance only. Never download full Thread history to
    // authorize a single result/control operation.
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
          `/api/sessions/${encodeURIComponent(job.session_id)}/threads/${encodeURIComponent(job.thread_id)}`,
        ),
      );
    const rootId = data.snapshot.thread.root_turn_id;
    return (
      ((!binding.threadId || binding.threadId === job.thread_id) &&
        (binding.rootId
          ? rootId === binding.rootId
          : !roots || roots.includes(rootId))) ||
      !!(
        binding.additionalRoot &&
        (await binding.additionalRoot(rootId, job.thread_id))
      )
    );
  }
  async snapshot(
    scope: ExecutionReadScope,
    includeApprovals = true,
  ): Promise<ExecutionSnapshot> {
    const binding = this.binding(scope);
    if (!binding) return { jobs: [], approvals: [], limit: 100 };
    const requestedIds = binding.threadIds
      ? [...new Set(await binding.threadIds())]
      : undefined;
    if (requestedIds?.length === 0)
      return {
        jobs: [],
        approvals: includeApprovals ? await this.approvals(binding) : [],
        limit: 100,
      };
    const [pages, approvals] = await Promise.all([
      binding.records
        ? Promise.resolve([binding.records])
        : Promise.all(
            sessionIds(binding).map((sessionId) =>
              readExecutionRecords(this.request, {
                sessionId,
                contextId: binding.contextId,
                ...(requestedIds
                  ? { threadIds: requestedIds }
                  : binding.threadId
                    ? { threadId: binding.threadId }
                    : {}),
                ...(!binding.additionalRoot
                  ? {
                      rootIds: binding.rootId
                        ? [binding.rootId]
                        : binding.rootsBySession?.[sessionId],
                    }
                  : {}),
              }),
            ),
          ),
      includeApprovals ? this.approvals(binding) : Promise.resolve([]),
    ]);
    const jobs = pages
      .flatMap((page) => page.jobs)
      .sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
      )
      .slice(0, 100);
    const returned = [];
    for (const page of pages)
      for (const thread of page.threads) {
        const group = jobs.filter(
          (job) =>
            job.session_id === page.session_id && job.thread_id === thread.id,
        );
        const original =
          (!binding.threadId || binding.threadId === thread.id) &&
          (binding.rootId
            ? thread.root_turn_id === binding.rootId
            : !binding.rootsBySession?.[page.session_id] ||
              binding.rootsBySession[page.session_id]!.includes(
                thread.root_turn_id,
              ));
        if (
          !original &&
          !(
            binding.additionalRoot &&
            (await binding.additionalRoot(thread.root_turn_id, thread.id))
          )
        )
          continue;
        returned.push(
          ...jobsWithRuntimeAnnotations(group, thread.response_annotations, {
            sessionId: page.session_id,
            contextId: binding.contextId,
            threadId: thread.id,
            generation: thread.generation,
          }),
        );
      }
    return {
      jobs: returned.sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
      ),
      approvals,
      limit: 100,
      ...(binding.records
        ? {
            threads: await executionThreadsWithWait(
              this.request,
              binding.records,
            ),
            threadsTruncated: binding.records.threads_truncated,
          }
        : {}),
    };
  }
  async result(scope: ExecutionReadScope, jobId: string) {
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
    if (action.type === "cancel-delegation")
      throw new DomainError(
        "forbidden",
        "子智能体须通过已核验的原始委派控制。",
      );
    const binding = this.binding(scope);
    if (!binding) throw new DomainError("not_found", "工作对话不存在。");
    if (isExecutionThreadControl(action)) {
      if (scope.threadId !== action.threadId)
        throw new DomainError("forbidden", "控制目标与查看的执行不一致。");
      const path = `/api/contexts/${encodeURIComponent(binding.contextId)}/threads/${encodeURIComponent(action.threadId)}`;
      const thread =
        action.type !== "cancel-thread"
          ? (
              await readExecutionRecords(this.request, {
                sessionId: binding.sessionId,
                contextId: binding.contextId,
                threadId: action.threadId,
                metadataOnly: true,
              })
            ).threads[0]!
          : z
              .object({
                snapshot: z.object({
                  thread: z.object({
                    id: z.literal(action.threadId),
                    session_id: z.string(),
                    context_id: z.literal(binding.contextId),
                    root_turn_id: z.string(),
                    revision: z.number(),
                    lifecycle: z.string().optional(),
                    control_state: z.string().optional(),
                    generation: z.number().int().nonnegative().optional(),
                  }),
                }),
              })
              .parse(
                await this.request(
                  `/api/sessions/${encodeURIComponent(binding.sessionId)}/threads/${encodeURIComponent(action.threadId)}`,
                ),
              ).snapshot.thread;
      if (
        !sessionIds(binding).includes(thread.session_id) ||
        thread.root_turn_id !== binding.rootId
      )
        throw new DomainError("forbidden", "执行不属于选中的工作。");
      if (thread.revision !== action.revision)
        throw new DomainError("conflict", "执行状态已变化，请刷新后重新决定。");
      if (
        action.type !== "cancel-thread" &&
        (thread.lifecycle !== "open" ||
          !["active", "paused"].includes(thread.control_state ?? ""))
      )
        throw new DomainError(
          "conflict",
          "执行已结束或控制状态不可用，请重新查看。",
        );
      if (action.type === "supersede-thread" && thread.generation === undefined)
        throw new DomainError("conflict", "执行代次不可用，未提交修改。");
      const operation = {
        "cancel-thread": "cancel",
        "pause-thread": "pause",
        "resume-thread": "resume",
        "supersede-thread": "supersede",
      }[action.type];
      const result = z
        .object({
          updated: z.literal(true),
          thread: z.object({
            id: z.literal(action.threadId),
            lifecycle: z.string(),
            control_state: z.string().optional(),
            generation: z.number().int().nonnegative().optional(),
            revision: z.number().int().positive().optional(),
            session_id: z.string().optional(),
            context_id: z.string().optional(),
            root_turn_id: z.string().optional(),
          }),
        })
        .parse(
          await this.request(
            action.type === "supersede-thread" ? `${path}/supersede` : path,
            "POST",
            {
              ...(action.type === "supersede-thread"
                ? { intent: action.intent }
                : { action: operation }),
              expected_revision: action.revision,
              reason: {
                cancel: "用户在 Morphz 停止此执行分支",
                pause: "用户在 Morphz 暂停此执行分支",
                resume: "用户在 Morphz 恢复此执行分支",
                supersede: "用户在 Morphz 纠正并继续此执行分支",
              }[operation],
            },
          ),
        );
      if (action.type === "cancel-thread")
        return { accepted: true, status: result.thread.lifecycle };
      const expectedState =
        action.type === "pause-thread" ? "paused" : "active";
      if (
        result.thread.lifecycle !== "open" ||
        !(result.thread.revision! > thread.revision) ||
        result.thread.session_id !== thread.session_id ||
        result.thread.context_id !== binding.contextId ||
        result.thread.root_turn_id !== thread.root_turn_id ||
        result.thread.control_state !== expectedState ||
        (action.type === "supersede-thread" &&
          result.thread.generation !== thread.generation! + 1)
      )
        throw new DomainError(
          "conflict",
          "Runtime 控制回执不匹配，请核对最新状态。",
        );
      return { accepted: true, status: result.thread.control_state };
    }
    if (action.type === "cancel-job") {
      const job = await this.job(binding, action.jobId);
      // Descendant aggregation is read-only. A mutation must explicitly select
      // that exact Thread and pass its fresh input/parent provenance again.
      if (binding.threadId && job.thread_id !== binding.threadId)
        throw new DomainError("forbidden", "停止目标与选中的执行不一致。");
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
    if (binding.threadId && approval.request.thread_id !== binding.threadId)
      throw new DomainError("forbidden", "审批目标与选中的执行不一致。");
    const reusable =
      action.type === "allow-objective" || action.type === "allow-session";
    if (reusable) {
      const offer = approval.request.lease_offer;
      if (!binding.principalId || offer?.principal_id !== binding.principalId)
        throw new DomainError(
          "forbidden",
          "持续授权只能由原始请求的用户确认。",
        );
      // Re-read one bounded exact-Thread page for causal Job evidence. Never
      // mistake the model attempt ID or a nearby goal for the approved Job.
      const records =
        action.type === "allow-objective" && offer.scope !== "objective"
          ? await readExecutionRecords(this.request, {
              sessionId: approval.request.session_id,
              contextId: binding.contextId,
              threadId: approval.request.thread_id,
            })
          : undefined;
      const desired =
        action.type === "allow-objective" ? "objective" : "session";
      if (!reusableApprovalScopes(approval, records?.jobs).includes(desired))
        throw new DomainError(
          "conflict",
          "持续授权范围不可用或已过期，请重新查看。",
        );
    }
    const receipt = z
      .object({ accepted: z.literal(true) })
      .passthrough()
      .parse(
        await this.request(
          `/api/approvals/${encodeURIComponent(action.approvalId)}`,
          "POST",
          {
            decision: {
              "allow-once": "allow_once",
              deny: "deny",
              "allow-objective": "allow_objective",
              "allow-session": "allow_session",
            }[action.type],
            rationale: "用户通过 Morphz 明确决定此次操作",
          },
        ),
      );
    if (
      reusable &&
      !z
        .object({
          approval_id: z.literal(action.approvalId),
          scope: z.literal(
            action.type === "allow-objective" ? "objective" : "session",
          ),
        })
        .safeParse(receipt).success
    )
      throw new DomainError(
        "conflict",
        "持续授权回执未确认，请核对状态，不要重复批准。",
      );
    return receipt;
  }
}
