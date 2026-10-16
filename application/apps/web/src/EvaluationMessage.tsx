import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import { evaluationPreview } from "../../../packages/core/src/evaluation-result.js";

/** A result is readable evidence of a computation, not a claim that the
 * caller, its task, or an Objective has finished. Never execute returned code. */
export function EvaluationMessage({
  message,
  renderText,
}: {
  message: LiveMessage;
  renderText: (text: string) => ReactNode;
}) {
  const preview = evaluationPreview(message.text);
  function value(node: unknown, depth = 0): ReactNode {
    if (typeof node === "string")
      return node ? renderText(node) : <code>""</code>;
    if (node === null || typeof node === "boolean" || typeof node === "number")
      return <code>{JSON.stringify(node)}</code>;
    if (node === undefined) return <pre>{message.text.slice(0, 12000)}</pre>;
    if (depth >= 8) return <code>…</code>;
    const object = node as Record<string, unknown>;
    const tagged = object.$yao as { fields?: unknown } | undefined;
    const fields =
      tagged?.fields && typeof tagged.fields === "object"
        ? tagged.fields
        : node;
    const entries = Object.entries(fields as object).slice(0, 64);
    const body = (
      <dl>
        {entries.map(([key, child]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value(child, depth + 1)}</dd>
          </div>
        ))}
      </dl>
    );
    return depth === 0 ? (
      body
    ) : (
      <details>
        <summary>
          {Array.isArray(fields) ? "列表" : "记录"} · {entries.length} 项
        </summary>
        {body}
      </details>
    );
  }
  const status = message.evaluation?.consumed
    ? "已用于回复"
    : message.evaluation?.validation === "rejected"
      ? "校验未通过"
      : message.incomplete
        ? "输出中断"
        : message.streaming
          ? "生成中"
          : message.evaluation?.validation === "accepted"
            ? "已校验"
            : "已生成";
  return (
    <details
      className="evaluation-message"
      open={!message.evaluation?.consumed}
      data-validation={message.evaluation?.validation}
    >
      <summary
        data-animated={
          !!(
            message.streaming &&
            !message.incomplete &&
            !message.evaluation?.consumed
          )
        }
      >
        <ChevronRight
          className="evaluation-chevron"
          size={12}
          aria-hidden="true"
        />
        <span>求值结果</span>
        <small>{status}</small>
        {message.streaming &&
          !message.incomplete &&
          !message.evaluation?.consumed && (
            <span className="response-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
      </summary>
      <div className="evaluation-value">{value(preview.value)}</div>
    </details>
  );
}
