import assert from "node:assert/strict";
import type { Frame } from "@playwright/test";
import { cognitiveBrowserLimits } from "../../packages/cognitive-app-sdk/src/browser-wire.js";

const success = [
  "作者已确认保存",
  "原文引用已准备到输入框",
  "已记住阅读位置",
] as const;
export type NotesOperationSuccess = (typeof success)[number];
export function isNotesOperationSuccess(value: string): value is NotesOperationSuccess {
  return success.includes(value as NotesOperationSuccess);
}

/** One explicit SDK operation, not the pointer/readiness phase. Never repeats
 * a click/request and never counts an old error while an explicit recovery is
 * still busy. Business identity/receipt/draft assertions remain at each caller.
 * invoke/compose/saveState each has one outer SDK deadline: the router's several
 * readUi/author/save/post-authorize awaits are inside that same request, not
 * independent deadlines to add together. Actual SDK failure/retirement remains
 * authoritative and is never rescued by a later Host receipt. */
export async function waitForNotesOperationStatus(
  guest: Frame,
  expected: NotesOperationSuccess,
) {
  const result = await guest.waitForFunction(
    (expected) => {
      const text = document.getElementById("status")?.textContent ?? "";
      if (text.includes(expected)) return { ok: true, text };
      const failed = [
        "尚未确认保存结果",
        "当前工作区连接已结束",
        "这次操作未获确认",
        "未连接工作区",
      ].some((value) => text.includes(value));
      const idle = ["refresh", "recover"].some((id) => {
        const control = document.getElementById(id);
        return control instanceof HTMLButtonElement && !control.disabled;
      });
      const ended = document.getElementById("connection")?.textContent?.includes("已结束");
      return failed && (idle || ended) ? { ok: false, text } : false;
    },
    expected,
    { timeout: cognitiveBrowserLimits.deadlineMs },
  );
  try {
    const value = await result.jsonValue();
    assert.ok(value);
    assert.ok(value.ok, value.text);
  } finally {
    await result.dispose();
  }
}
