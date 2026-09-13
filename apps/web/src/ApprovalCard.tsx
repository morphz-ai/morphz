import { Shield } from "lucide-react";
import type {
  ExecutionSnapshot,
} from "../../../packages/core/src/execution.js";

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
