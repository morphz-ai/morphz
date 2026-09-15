import { useRef, useState } from "react";
import { Shield } from "lucide-react";
import type {
  ExecutionAttention,
  ExecutionSnapshot,
} from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";

export function ApprovalDetails({
  approval,
}: {
  approval: ExecutionSnapshot["approvals"][number];
}) {
  const action = approval.request.action;
  const requested = approval.request.requested;
  const knownScope = Object.entries(requested).every(([key, value]) =>
    key === "network"
      ? typeof value === "boolean"
      : ["read_roots", "write_roots", "secret_env"].includes(key) &&
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string"),
  );
  const values = (key: string) =>
    Array.isArray(requested[key])
      ? (requested[key] as unknown[]).map(String).join("、")
      : String(requested[key]);
  return (
    <>
      <h3>
        <Shield size={15} />
        需要你的批准
      </h3>
      <p>{approval.request.justification}</p>
      <div className="approval-operation">
        <span>操作</span>
        <code>
          {action.kind === "shell" && typeof action.command === "string"
            ? action.command
            : action.kind === "tool_operation" &&
                typeof action.tool === "string"
              ? `${action.tool} · ${String(action.operation)}${action.target ? ` · ${String(action.target)}` : ""}`
              : JSON.stringify(action)}
        </code>
      </div>
      {action.cwd != null && (
        <div className="approval-operation">
          <span>工作目录</span>
          <code>{String(action.cwd)}</code>
        </div>
      )}
      <div className="approval-operation">
        <span>新增权限</span>
        <code>
          {knownScope
            ? [
                requested.network === true ? "允许联网" : "不额外授权联网",
                ...(Array.isArray(requested.read_roots) &&
                requested.read_roots.length
                  ? [`读取：${values("read_roots")}`]
                  : []),
                ...(Array.isArray(requested.write_roots) &&
                requested.write_roots.length
                  ? [`写入：${values("write_roots")}`]
                  : []),
                ...(Array.isArray(requested.secret_env) &&
                requested.secret_env.length
                  ? [`传入凭据变量：${values("secret_env")}`]
                  : []),
              ].join("\n")
            : JSON.stringify(requested)}
        </code>
      </div>
      <details className="approval-raw">
        <summary>查看完整请求</summary>
        <pre>{JSON.stringify({ action, requested }, null, 2)}</pre>
      </details>
      <small className="muted">仅限本次请求，不授予持续权限。</small>
    </>
  );
}

/** The receipt and exact scope travel together. No optimistic approval or retry. */
export function ApprovalCard({
  entry,
  client,
  available,
  origin,
  onInspect,
}: {
  entry: ExecutionAttention["approvals"][number];
  client: WorkspaceClient;
  available: boolean;
  origin?: string;
  onInspect?: () => void;
}) {
  const [notice, setNotice] = useState("");
  const [locked, setLocked] = useState(false);
  const submitted = useRef(false);
  const { approval, scope } = entry;
  const previouslySubmitted = client.approvalSubmitted(
    approval.request.approval_id,
    approval.fingerprint,
  );
  async function decide(type: "allow-once" | "deny") {
    if (submitted.current || !available) return;
    submitted.current = true;
    setLocked(true);
    setNotice("正在确认…");
    try {
      await client.controlExecution({
        scope,
        action: {
          type,
          approvalId: approval.request.approval_id,
          fingerprint: approval.fingerprint,
        },
      });
      setNotice(type === "deny" ? "已拒绝本次请求" : "已允许本次请求");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "结果未确认，请查看最新执行状态；不要重复批准。",
      );
    }
    // Remain locked even if the cached poll still contains this approval. A new
    // fingerprint is a new explicit decision, not an automatic resubmission.
    await client.refresh();
  }
  return (
    <section
      className="execution-approval inline-approval"
      aria-label="待审批操作"
      data-approval-id={approval.request.approval_id}
    >
      {origin && <small className="approval-origin">{origin}</small>}
      <ApprovalDetails approval={approval} />
      {!available && <p role="status">审批状态待确认，暂不能操作。</p>}
      {notice && <p role="status">{notice}</p>}
      {!notice && previouslySubmitted && (
        <p role="status">已提交本次决定，等待最新状态确认。</p>
      )}
      <div className="execution-actions">
        {onInspect && <button onClick={onInspect}>查看执行</button>}
        <button
          disabled={!available || locked || previouslySubmitted}
          onClick={() => void decide("deny")}
        >
          拒绝
        </button>
        <button
          className="primary"
          disabled={!available || locked || previouslySubmitted}
          onClick={() => void decide("allow-once")}
        >
          仅允许这一次
        </button>
      </div>
    </section>
  );
}
