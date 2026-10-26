import { useRef, useState } from "react";
import { Shield, X } from "lucide-react";
import {
  reusableApprovalScopes,
  type ExecutionApprovalControl,
} from "../../../packages/core/src/execution.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { useModal } from "./useModal.js";
import type {
  ExecutionAttention,
  ExecutionSnapshot,
} from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";

export function ApprovalDetails({
  approval,
  reusable = false,
  heading = true,
}: {
  reusable?: boolean;
  heading?: boolean;
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
      {heading && (
        <h3>
          <Shield size={15} />
          需要你的批准
        </h3>
      )}
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
        <pre>
          {JSON.stringify(
            { action, requested, lease_offer: approval.request.lease_offer },
            null,
            2,
          )}
        </pre>
      </details>
      <small className="muted">
        {reusable
          ? "授权仅覆盖本次确认的范围和执行节点。"
          : "“仅允许这一次”不授予持续权限。"}
      </small>
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
  async function decide(action: ExecutionApprovalControl) {
    if (submitted.current || !available) return;
    submitted.current = true;
    setLocked(true);
    setNotice("正在确认…");
    try {
      await client.controlExecution({
        scope,
        action,
      });
      setNotice(action.type === "deny" ? "已拒绝本次请求" : "已提交授权决定");
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
        <ApprovalActions
          approval={approval}
          disabled={!available || locked || previouslySubmitted}
          onDecide={decide}
        />
      </div>
    </section>
  );
}

export function ApprovalActions({
  approval,
  jobs = [],
  disabled,
  onDecide,
}: {
  approval: ExecutionSnapshot["approvals"][number];
  jobs?: ExecutionSnapshot["jobs"];
  disabled: boolean;
  onDecide(action: ExecutionApprovalControl): Promise<unknown>;
}) {
  const [confirmation, setConfirmation] = useState<{
    scope: "objective" | "session";
    approval: typeof approval;
  } | null>(null);
  const scopes = reusableApprovalScopes(approval, jobs);
  const action = (
    type: ExecutionApprovalControl["type"],
  ): ExecutionApprovalControl => ({
    type,
    approvalId: approval.request.approval_id,
    fingerprint: approval.fingerprint,
  });
  return (
    <>
      <button disabled={disabled} onClick={() => void onDecide(action("deny"))}>
        拒绝
      </button>
      <button
        className="primary"
        disabled={disabled}
        onClick={() => void onDecide(action("allow-once"))}
      >
        仅允许这一次
      </button>
      {scopes.length > 0 && (
        <ComposerOptions
          label="更多授权范围"
          menuLabel="授权范围"
          triggerDisabled={disabled}
          options={scopes.map((scope) => ({
            label:
              scope === "objective" ? "在此目标内允许…" : "在此会话内允许…",
            icon: <Shield />,
            onSelect: () => setConfirmation({ scope, approval }),
          }))}
        />
      )}
      {confirmation && (
        <ScopedApprovalConfirmation
          approval={confirmation.approval}
          scope={confirmation.scope}
          disabled={disabled || !scopes.includes(confirmation.scope)}
          onClose={() => setConfirmation(null)}
          onConfirm={async () => {
            const captured = confirmation;
            setConfirmation(null);
            await onDecide({
              type:
                captured.scope === "objective"
                  ? "allow-objective"
                  : "allow-session",
              approvalId: captured.approval.request.approval_id,
              fingerprint: captured.approval.fingerprint,
            });
          }}
        />
      )}
    </>
  );
}

function ScopedApprovalConfirmation({
  approval,
  scope,
  disabled,
  onClose,
  onConfirm,
}: {
  approval: ExecutionSnapshot["approvals"][number];
  scope: "objective" | "session";
  disabled: boolean;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModal(dialog);
  const offer = approval.request.lease_offer!;
  const duration = offer.duration_secs;
  const lifetime =
    duration % 3600 === 0
      ? `${duration / 3600} 小时`
      : duration % 60 === 0
        ? `${duration / 60} 分钟`
        : `${duration} 秒`;
  return (
    <dialog
      ref={dialog}
      className="create-dialog execution-control-dialog"
      aria-label="确认授权范围"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{scope === "objective" ? "在此目标内允许" : "在此会话内允许"}</h2>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X />
        </button>
      </header>
      <p className="muted">
        仅允许下列范围内的同类操作，批准后 {lifetime}内有效。
      </p>
      <ApprovalDetails
        reusable
        heading={false}
        approval={{
          ...approval,
          request: { ...approval.request, requested: offer.requested },
        }}
      />
      <div className="approval-operation">
        <span>执行节点</span>
        <code>{offer.target_id}</code>
      </div>
      <footer>
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          disabled={disabled || !(duration > 0)}
          onClick={() => void onConfirm()}
        >
          确认允许
        </button>
      </footer>
    </dialog>
  );
}
