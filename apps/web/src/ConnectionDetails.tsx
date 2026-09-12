import { useRef } from "react";
import { X, RefreshCw } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import { useModal } from "./useModal.js";
export function ConnectionDetails({
  client,
  onClose,
}: {
  client: WorkspaceClient;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModal(dialog);
  const runtime = client.boot!.runtime;
  return (
    <dialog
      ref={dialog}
      className="create-dialog connection-dialog"
      aria-label="连接详情"
      onCancel={onClose}
    >
      <header>
        <h2>连接详情</h2>
        <div className="dialog-actions">
          <button
            className="secondary-action"
            onClick={() => void client.refresh()}
          >
            <RefreshCw size={14} />
            检查连接
          </button>
          <button
            className="icon-button"
            aria-label="关闭连接详情"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
      </header>
      <dl className="connection-facts">
        <dt>工作中心</dt>
        <dd>{client.online ? "已连接" : "已断开"}</dd>
        <dt>Agent</dt>
        <dd>
          {runtime.connected
            ? "已连接"
            : runtime.configured
              ? "正在重新连接"
              : "尚未配置"}
        </dd>
        <dt>当前模型</dt>
        <dd>{runtime.model || "尚未配置"}</dd>
      </dl>
      {(client.error || runtime.error) && (
        <p role="alert">{client.error || runtime.error}</p>
      )}
    </dialog>
  );
}
