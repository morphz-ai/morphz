import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import "./composer-creation-menu.css";

/** A presented creation intent, never a domain invocation or a grant. The
 * owning Host rechecks its original scope when onSelect is called. */
export type ComposerCreationAction = Readonly<{
  key: string;
  label: string;
  application: string;
  icon: ReactNode;
  disabled?: boolean;
  title?: string;
  onSelect(): void;
}>;

/** Content for the existing + popover. No business Client, store or Session. */
export function ComposerCreationMenu({
  primary,
  additional = [],
  attachments,
  onClose,
}: {
  primary: readonly ComposerCreationAction[];
  additional?: readonly ComposerCreationAction[];
  attachments: ReactNode;
  onClose(): void;
}) {
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const previousMore = useRef(false);
  useLayoutEffect(() => {
    if (more) search.current?.focus({ preventScroll: true });
    else if (previousMore.current)
      moreButton.current?.focus({ preventScroll: true });
    previousMore.current = more;
  }, [more]);
  const matches = additional.filter((action) =>
    `${action.label} ${action.application}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const row = (action: ComposerCreationAction) => (
    <button
      key={action.key}
      type="button"
      className="composer-creation-action"
      aria-label={`${action.label}，${action.application}`}
      title={action.title}
      disabled={action.disabled}
      onClick={() => {
        onClose();
        action.onSelect();
      }}
    >
      {action.icon}
      <span>{action.label}</span>
      <small>{action.application}</small>
    </button>
  );
  return (
    <div className="composer-creation-menu">
      {more ? (
        <>
          <div className="composer-creation-search-heading">
            <button
              type="button"
              className="icon-button"
              aria-label="返回新建与添加"
              onClick={() => setMore(false)}
            >
              <ArrowLeft />
            </button>
            <strong>更多应用</strong>
          </div>
          <label className="composer-creation-search">
            <Search aria-hidden="true" />
            <input
              ref={search}
              aria-label="搜索应用的新建能力"
              placeholder="搜索应用或新建能力"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "ArrowDown" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                const first = results.current?.querySelector<HTMLButtonElement>(
                  "button:not(:disabled)",
                );
                if (first) {
                  event.preventDefault();
                  first.focus({ preventScroll: true });
                }
              }}
            />
          </label>
          <div ref={results} className="composer-creation-results">
            {matches.map(row)}
            {matches.length === 0 && (
              <p role="status">
                {additional.length
                  ? "没有匹配的新建能力。"
                  : "暂无其他已接入的新建能力。"}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {primary.length > 0 && (
            <section aria-label="新建">
              <h3>新建</h3>
              {primary.map(row)}
            </section>
          )}
          <section aria-label="添加资料">
            <h3>添加资料</h3>
            {attachments}
          </section>
          <button
            ref={moreButton}
            type="button"
            className="composer-creation-more"
            aria-label="更多应用新建能力"
            onClick={() => setMore(true)}
          >
            <span>更多应用</span>
            <ChevronRight />
          </button>
        </>
      )}
    </div>
  );
}
