import { Shield, ShieldCheck } from "lucide-react";
import type { SessionPermissionsSnapshot } from "../../../packages/core/src/session-permissions.js";

export function ComposerApprovalIcon({
  mode,
}: {
  mode?: SessionPermissionsSnapshot["permissionMode"];
}) {
  const Icon = mode === "auto_review" ? ShieldCheck : Shield;
  return (
    <Icon
      className="composer-approval-icon"
      data-approval-mode={mode ?? "unread"}
      fill={mode === "full_access" ? "currentColor" : "none"}
      aria-hidden="true"
    />
  );
}

const labels: Record<string, string> = {
  request_approval: "询问批准",
  auto_review: "自动安全评审",
  full_access: "完全访问",
  custom: "自定义策略",
};
export const approvalLabel = (
  mode?: SessionPermissionsSnapshot["permissionMode"],
) => labels[mode ?? ""] ?? "审批方式尚未读取";
