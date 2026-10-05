import { RotateCcw } from "lucide-react";
import { createPortal } from "react-dom";
import type { Workspace } from "../../../packages/core/src/model.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import type { CognitiveOriginal } from "./host/use-cognitive-original.js";

/** Read-only App-owned original. The Host's existing toolbar and composer stay
 * the only owners of navigation/input; no builtin Artifact or numeric version
 * is manufactured to render an independent original. */
export function CognitiveOriginalView({
  original,
  message,
  onRetry,
  toolbarTarget,
  state,
  onOpen,
}: {
  original: CognitiveOriginal | null;
  message: string;
  onRetry: () => void;
  toolbarTarget: HTMLElement | null;
  state: Workspace;
  onOpen: (id: string) => void;
}) {
  const content = original?.original.content;
  const version = original?.locator.object.versionRef;
  const controls = (
    <div className="editor-actions">
      {version && (
        <span className="muted" title={version}>
          版本：{version}
        </span>
      )}
      {(original || message) && (
        <button
          className="secondary-action"
          type="button"
          onClick={onRetry}
          aria-label={message ? "重试读取原件" : "重新读取原件"}
          title={message ? "重试读取原件" : "重新读取原件"}
        >
          <RotateCcw aria-hidden="true" />
          <span className="toolbar-action-label">
            {message ? "重试" : "重新读取"}
          </span>
        </button>
      )}
    </div>
  );
  return (
    <>
      {toolbarTarget && createPortal(controls, toolbarTarget)}
      <article
        className="object-paper"
        aria-label={original?.original.title ?? "原件"}
      >
        {message ? (
          <p role="alert">{message}</p>
        ) : !content ? (
          <p role="status">正在读取原件…</p>
        ) : (
          <div className="document-body">
            {content.format === "markdown" ? (
              <SafeMarkdown
                state={state}
                onOpen={onOpen}
                documentTitle={original!.original.title}
              >
                {content.text}
              </SafeMarkdown>
            ) : (
              <pre>
                {content.format === "json"
                  ? JSON.stringify(content.value, null, 2)
                  : content.text}
              </pre>
            )}
          </div>
        )}
      </article>
    </>
  );
}
