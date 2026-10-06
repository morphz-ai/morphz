import { createLucideIcon, Shield, ShieldAlert } from "lucide-react";
import type { SessionPermissionsSnapshot } from "../../../packages/core/src/session-permissions.js";

// A compact upright palm, reviewed at the composer's actual 16px size. Keep
// the common Lucide grid and stroke, but do not reuse its wide splayed hand.
const ApprovalHand = createLucideIcon("ApprovalHand", [
  [
    "path",
    {
      d: "M7.5 13V6.5a1.5 1.5 0 0 1 3 0v-2a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v2a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.4-3.4l-2.1-4.1a1.5 1.5 0 0 1 2.6-1.5L8 14",
      key: "palm",
    },
  ],
  ["path", { d: "M10.5 6.5V11", key: "index" }],
  ["path", { d: "M13.5 5.5V11", key: "middle" }],
  ["path", { d: "M16.5 7.5V12", key: "ring" }],
]);

export function ComposerApprovalIcon({
  mode,
}: {
  mode?: SessionPermissionsSnapshot["permissionMode"];
}) {
  const Icon =
    mode === "request_approval"
      ? ApprovalHand
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
