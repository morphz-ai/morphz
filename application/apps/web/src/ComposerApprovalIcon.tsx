import { Hand, Shield, ShieldAlert } from "lucide-react";
import type { SessionPermissionsSnapshot } from "../../../packages/core/src/session-permissions.js";

export function ComposerApprovalIcon({
  mode,
}: {
  mode?: SessionPermissionsSnapshot["permissionMode"];
}) {
  const Icon =
    mode === "request_approval"
      ? Hand
      : mode === "full_access"
        ? ShieldAlert
        : Shield;
  return (
    <Icon
      className="composer-approval-icon"
      data-approval-mode={mode ?? "unread"}
      strokeWidth={2}
      fill="none"
      aria-hidden="true"
    >
      {/* Keep Lucide's shared shield outline; >_ identifies automated tool
          review, not a checkmark that could imply the action was approved. */}
      {mode === "auto_review" && <path d="m8 10 3 3-3 3m5 0h3" />}
    </Icon>
  );
}

const labels: Record<string, string> = {
  request_approval: "询问批准",
  auto_review: "自动审批",
  full_access: "完全访问",
  custom: "自定义策略",
};
export const approvalLabel = (
  mode?: SessionPermissionsSnapshot["permissionMode"],
) => labels[mode ?? ""] ?? "审批方式尚未读取";
