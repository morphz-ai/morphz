import type { InputDraft } from "./exchange-drafts.js";
import { quotedInputText } from "../../../../packages/core/src/text-quotes.js";

/** Keep local text intact. These are the existing typed operation's admission
 * budgets, not textarea clipping or an instruction to split/send the draft. */
export function exchangeDraftLengthError(
  draft: Pick<
    InputDraft,
    | "body"
    | "textQuotes"
    | "selection"
    | "revision"
    | "taskResult"
    | "continuation"
  >,
  artifactAnnotation = false,
): string | undefined {
  // The renderer's draft is plain data. Do not execute an accessor while doing
  // an early length check: the submission owner retains its original deferred
  // payload-construction order, and the typed gateway still enforces budgets.
  const bodySlot = Object.getOwnPropertyDescriptor(draft, "body");
  if (bodySlot && !("value" in bodySlot)) return undefined;
  const annotation = artifactAnnotation && !draft.continuation;
  const text =
    annotation || (draft.taskResult && !draft.continuation)
      ? quotedInputText(draft.body, draft.textQuotes)
      : draft.body;
  const limit = annotation ? 10000 : 30000;
  if (text.trim().length > limit)
    return `内容超过单次发送的 ${limit.toLocaleString("zh-CN")} 字符限制；全文已保留，请缩短后发送。`;
  if (
    draft.textQuotes &&
    draft.textQuotes.reduce((n, q) => n + q.text.length + q.comment.length, 0) >
      30000
  )
    return "引用与评论超过单次发送的 30,000 字符限制；草稿已保留，请分次发送。";
  return undefined;
}
