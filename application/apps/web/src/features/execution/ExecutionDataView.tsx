import { useMemo, useState, type ReactNode } from "react";
import type { ExecutionSnapshot } from "../../../../../packages/core/src/execution.js";
import {
  executionJSON,
  executionFieldLabel,
  executionReferenceField,
  type ExecutionJSON,
} from "./execution-json.js";

function LazyDetails({
  label,
  count,
  initialOpen = false,
  children,
}: {
  label: string;
  count?: number;
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details
      className="execution-data-details"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {label}
        {count !== undefined && <small>{count} 项</small>}
      </summary>
      {open && children}
    </details>
  );
}

function Scalar({
  node,
}: {
  node: Extract<ExecutionJSON, { kind: "string" | "literal" }>;
}) {
  return node.kind === "string" ? (
    <pre className="execution-value-text">{node.value || "（空文本）"}</pre>
  ) : (
    <span className="execution-value-scalar">
      {node.value === "true"
        ? "是"
        : node.value === "false"
          ? "否"
          : node.value === "null"
            ? "（空值）"
            : node.value}
    </span>
  );
}
function Fields({
  entries,
  depth,
}: {
  entries: { key: string; value: ExecutionJSON }[];
  depth: number;
}) {
  return (
    <dl className="execution-data-fields">
      {entries.slice(0, 16).map(({ key, value }, at) => {
        const block =
          value.kind === "object" ||
          value.kind === "array" ||
          (value.kind === "string" &&
            (value.value.length > 72 ||
              value.value.includes("\n") ||
              /^(body|text|note|message|error|warning|description|explanation|stdout|stderr)$/.test(
                key,
              )));
        return (
          <div
            className="execution-data-field"
            data-block={block || undefined}
            data-field={key}
            key={at}
          >
            <dt title={key}>{executionFieldLabel(key)}</dt>
            <dd>
              <Value node={value} depth={depth} />
            </dd>
          </div>
        );
      })}
      {entries.length > 16 && (
        <div className="execution-data-field" data-block="true">
          <dd>
            <LazyDetails label="其余字段" count={entries.length - 16}>
              <Fields entries={entries.slice(16)} depth={depth} />
            </LazyDetails>
          </dd>
        </div>
      )}
    </dl>
  );
}
function Value({ node, depth = 0 }: { node: ExecutionJSON; depth?: number }) {
  if (node.kind === "string" || node.kind === "literal")
    return <Scalar node={node} />;
  if (node.kind === "object") {
    if (!node.entries.length)
      return <span className="execution-value-empty">（空对象）</span>;
    return (
      <LazyDetails
        label="字段"
        count={node.entries.length}
        initialOpen={depth === 0 && node.entries.length <= 6}
      >
        <Fields entries={node.entries} depth={depth + 1} />
      </LazyDetails>
    );
  }
  if (!node.items.length)
    return <span className="execution-value-empty">（空列表）</span>;
  return (
    <LazyDetails label="列表" count={node.items.length}>
      <ArrayItems items={node.items} depth={depth + 1} />
    </LazyDetails>
  );
}
function ArrayItems({
  items,
  depth,
  start = 1,
}: {
  items: ExecutionJSON[];
  depth: number;
  start?: number;
}) {
  return (
    <>
      <ol className="execution-data-list" start={start}>
        {items.slice(0, 16).map((node, at) => (
          <li key={at}>
            <Value node={node} depth={depth} />
          </li>
        ))}
      </ol>
      {items.length > 16 && (
        <LazyDetails label="其余条目" count={items.length - 16}>
          <ArrayItems
            items={items.slice(16)}
            depth={depth}
            start={start + 16}
          />
        </LazyDetails>
      )}
    </>
  );
}

/** Local display state only. Never reads another receipt, navigates from data,
 * sends commands, derives success, or decodes arbitrary JSON-looking strings. */
export function ExecutionDataView({
  text,
  label,
  truncated = false,
  emptyText = "执行返回了空内容。",
}: {
  text: string;
  label: "结果" | "参数";
  truncated?: boolean;
  emptyText?: string;
}) {
  const parsed = useMemo(
    () => executionJSON(text, truncated),
    [text, truncated],
  );
  const [raw, setRaw] = useState(false);
  const entries = parsed?.kind === "object" ? parsed.entries : undefined;
  const visible = entries?.filter(
    (entry) => !executionReferenceField(entry.key),
  );
  const references = entries?.filter((entry) =>
    executionReferenceField(entry.key),
  );
  const failed = entries?.some(
    (entry) =>
      entry.key === "ok" &&
      entry.value.kind === "literal" &&
      entry.value.value === "false",
  );
  return (
    <div
      className="execution-data-view"
      data-returned-false={failed || undefined}
    >
      {parsed ? (
        <div
          className="execution-data-modes"
          role="group"
          aria-label={`${label}视图`}
        >
          <button
            type="button"
            aria-pressed={!raw}
            onClick={() => setRaw(false)}
          >
            {label}
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      ) : (
        <small className="execution-data-format">原始文本</small>
      )}
      {raw || !parsed ? (
        <pre className="execution-data-raw">{text || emptyText}</pre>
      ) : (
        <div className="execution-data-readable">
          {entries ? (
            <>
              {visible!.length > 0 && <Fields entries={visible!} depth={0} />}
              {references!.length > 0 && (
                <LazyDetails label="引用与分页">
                  <Fields entries={references!} depth={0} />
                </LazyDetails>
              )}
              {!entries.length && (
                <span className="execution-value-empty">（空对象）</span>
              )}
            </>
          ) : (
            <Value node={parsed} />
          )}
        </div>
      )}
    </div>
  );
}

export function ExecutionRequestDetails({
  job,
}: {
  job: ExecutionSnapshot["jobs"][number];
}) {
  const text = useMemo(
    () => JSON.stringify(job.request, null, 2) ?? "",
    [job.request],
  );
  return (
    <>
      <ExecutionDataView text={text} label="参数" emptyText="未提供参数。" />
      <LazyDetails label="执行信息">
        <dl className="execution-data-fields execution-data-identity">
          {[
            ["工具", job.tool_name],
            ["执行节点", job.target_id],
            ["执行 ID", job.id],
            ["线程 ID", job.thread_id],
            ["Session ID", job.session_id],
            ["Context ID", job.context_id],
            ["结果事件 ID", job.result_event_id],
            ["退出码", job.exit_code],
          ]
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([label, value]) => (
              <div className="execution-data-field" key={label!}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </LazyDetails>
    </>
  );
}
