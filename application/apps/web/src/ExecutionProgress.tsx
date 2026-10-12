import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";

function ProgressEntry({
  message,
  latest = false,
}: {
  message: LiveMessage;
  latest?: boolean;
}) {
  const date = new Date(message.createdAt);
  const validTime = Number.isFinite(date.getTime());
  return (
    <article
      className="execution-progress-entry"
      data-progress-id={message.id}
      data-latest={latest || undefined}
    >
      <header>
        {latest && <span>最新进展</span>}
        {validTime && (
          <time dateTime={message.createdAt}>
            {date.toLocaleString("zh-CN", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        )}
      </header>
      <p>{message.text}</p>
      {(message.truncated || message.incomplete) && (
        <small>此条进展未完整接收</small>
      )}
    </article>
  );
}

/** Presentation only: the inspector's existing exact-scope stream owns the
 * messages and order. Keep native scroll anchoring and stable historical keys;
 * new publications never scroll, focus, or expand the reader's history. */
export function ExecutionProgress({
  messages,
  running,
}: {
  messages: LiveMessage[];
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const progress = messages.filter((message) => message.kind === "progress");
  const latest = progress.at(-1);
  if (!latest) return null;
  const previous = progress.slice(0, -1).reverse();
  return (
    <section
      className="execution-progress"
      aria-label="工作进展"
      data-running={running || undefined}
    >
      <ProgressEntry key={latest.id} message={latest} latest />
      {previous.length > 0 && (
        <details
          className="execution-progress-history"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            此前进展 · {previous.length} 条
          </summary>
          {previous.map((message) => (
            <ProgressEntry key={message.id} message={message} />
          ))}
        </details>
      )}
    </section>
  );
}
