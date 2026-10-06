import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  approvalLabel,
  ComposerApprovalIcon,
} from "../apps/web/src/ComposerApprovalIcon.js";

test("approval presets use a hand, terminal shield and warning shield on one shared icon", () => {
  const modes = ["request_approval", "auto_review", "full_access"] as const;
  const drawings = modes.map((mode) =>
    renderToStaticMarkup(createElement(ComposerApprovalIcon, { mode })),
  );
  assert.match(drawings[0]!, /lucide-hand/);
  assert.match(drawings[1]!, /d="m8 10 3 3-3 3m5 0h3"/);
  assert.match(drawings[2]!, /lucide-shield-alert/);
  for (const [index, drawing] of drawings.entries()) {
    assert.match(drawing, new RegExp(`data-approval-mode="${modes[index]}"`));
    assert.match(drawing, /viewBox="0 0 24 24"/);
    assert.match(drawing, /stroke-width="2"/);
    assert.match(drawing, /stroke-linecap="round"/);
    assert.match(drawing, /stroke-linejoin="round"/);
    assert.match(drawing, /aria-hidden="true"/);
    assert.match(drawing, /fill="none"/);
    assert.doesNotMatch(
      drawing,
      /lucide-shield-user|lucide-shield-check|lucide-lock-open/,
    );
  }
  assert.deepEqual(modes.map(approvalLabel), [
    "询问批准",
    "自动审批",
    "完全访问",
  ]);
});

test("unread and custom policies never borrow an approved preset icon or label", () => {
  for (const mode of [undefined, null, "custom"] as const) {
    const drawing = renderToStaticMarkup(
      createElement(ComposerApprovalIcon, { mode }),
    );
    assert.match(
      drawing,
      /class="lucide lucide-shield composer-approval-icon"/,
    );
    assert.match(
      drawing,
      new RegExp(`data-approval-mode="${mode ?? "unread"}"`),
    );
    assert.equal((drawing.match(/<path /g) ?? []).length, 1);
    assert.equal(
      approvalLabel(mode),
      mode === "custom" ? "自定义策略" : "审批方式尚未读取",
    );
  }
});
