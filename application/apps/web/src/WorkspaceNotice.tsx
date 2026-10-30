import { useLayoutEffect, useRef } from "react";
import { RotateCw, X } from "lucide-react";
import "./workspace-notice.css";

/** A read failure belongs only to its still-selected authorized conversation. */
export function ConversationHistoryNotice({
  error,
  projectId,
  conversationId,
  onRetry,
}: {
  error: { projectId: string; conversationId: string; message: string } | null;
  projectId: string;
  conversationId: string;
  onRetry: () => void;
}) {
  return error?.projectId === projectId &&
    error.conversationId === conversationId ? (
    <WorkspaceNotice message={error.message} scrollable onRetry={onRetry} />
  ) : null;
}

/** The same real notice is placed in the active reading surface or workspace. */
export function WorkspaceNotice({
  message,
  onDismiss,
  onRetry,
  scrollable = false,
}: {
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
  scrollable?: boolean;
}) {
  const notice = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = notice.current;
    const reading = scrollable
      ? root?.closest<HTMLElement>(".conversation")
      : null;
    if (!root || !reading) return;
    const measure = () => {
      const readingStyle = getComputedStyle(reading);
      const noticeStyle = getComputedStyle(root);
      // clientHeight and computed padding are layout CSS pixels, including
      // under CSS zoom. The border-box limit already includes this notice's
      // padding/border; reserve its flow margins as well so sticky positioning
      // never pushes an oversized notice above the reading controls.
      const available = Math.max(
        0,
        Math.floor(
          reading.clientHeight -
            parseFloat(readingStyle.paddingTop) -
            parseFloat(readingStyle.paddingBottom) -
            parseFloat(noticeStyle.marginTop) -
            parseFloat(noticeStyle.marginBottom),
        ),
      );
      const limit = `${available}px`;
      if (
        root.style.getPropertyValue("--workspace-notice-max-height") !== limit
      )
        root.style.setProperty("--workspace-notice-max-height", limit);
    };
    // Observe the existing reading box, not the notice or its inner scrolling
    // text. The limit only follows available space; no layout state or polling.
    const observer = new ResizeObserver(measure);
    observer.observe(reading);
    measure();
    return () => {
      observer.disconnect();
      root.style.removeProperty("--workspace-notice-max-height");
    };
  }, [scrollable]);
  return (
    <div className="workspace-notice" ref={notice}>
      <span role="alert" tabIndex={scrollable ? 0 : undefined}>
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          className="icon-button"
          aria-label="重试读取对话历史"
          onClick={onRetry}
        >
          <RotateCw />
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="icon-button"
          aria-label="关闭提示"
          onClick={onDismiss}
        >
          <X />
        </button>
      )}
    </div>
  );
}
