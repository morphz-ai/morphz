import { expect, type Locator } from "@playwright/test";
import type { SessionPermissionsUpdate } from "../packages/core/src/session-permissions.js";

type Mode = SessionPermissionsUpdate["permissionMode"];
const labels: Record<Mode, string> = {
  request_approval: "询问批准",
  auto_review: "自动审批",
  full_access: "完全访问",
};

export async function chooseApproval(trigger: Locator, mode: Mode) {
  await trigger.click();
  const menu = trigger.page().getByRole("menu", {
    name: "会话审批方式选项",
    exact: true,
  });
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitemradio", { name: labels[mode], exact: true })
    .click();
  await expect(menu).not.toBeVisible();
}

export async function expectApprovalMode(trigger: Locator, mode: Mode | "") {
  await expect(trigger.locator("..")).toHaveAttribute(
    "data-approval-mode",
    mode || "unread",
  );
  if (mode)
    await expect(trigger.locator(".composer-approval-value")).toHaveText(
      labels[mode],
    );
}
