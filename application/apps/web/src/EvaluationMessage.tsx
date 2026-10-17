import type { ReactNode } from "react";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import { evaluationDisplayValue } from "../../../packages/core/src/evaluation-result.js";

/** A result is readable evidence of a computation, not a claim that the
 * caller, its task, or an Objective has finished. Never execute returned code. */
export function EvaluationMessage({
  message,
  renderText,
  streaming,
}: {
  message: LiveMessage;
  renderText: (text: string) => ReactNode;
  streaming?: boolean;
}) {
  const display = evaluationDisplayValue(message);
  if (message.evaluation?.consumed || display === undefined || display === "")
    return null;
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
    if (!entries.length) return <code>{JSON.stringify(fields)}</code>;
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
  return (
    <div className="evaluation-body">
      <div className="evaluation-value">{value(display)}</div>
      {(streaming ?? message.streaming) && !message.incomplete && (
        <span
          className="response-dots"
          data-animated="true"
          aria-label="正在回复"
        >
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}
