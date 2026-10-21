import { useEffect, useState } from "react";
import { responseElapsed } from "./conversation-presentation.js";

/** A local clock, not a publication, progress estimate or polling request. */
export function ResponseWaiting({
  inputId,
  createdAt,
  label,
  connected,
  animated = connected,
  showElapsed = true,
}: {
  inputId: string;
  createdAt: string;
  label: string;
  connected: boolean;
  animated?: boolean;
  showElapsed?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!showElapsed) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      setNow(Date.now());
      if (document.visibilityState === "visible")
        timer = setInterval(() => setNow(Date.now()), 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [showElapsed]);
  const elapsed = showElapsed ? responseElapsed(createdAt, now) : null;
  return (
    <div
      className="response-placeholder"
      data-waiting-input-id={inputId}
      data-connected={connected}
      data-animated={animated && connected}
    >
      <span className="response-waiting" role="status">
        <span className="response-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="response-label" title={label}>
          {label}
        </span>
      </span>
      {elapsed && (
        <span className="response-elapsed" title="自这条消息发送起的耗时">
          {elapsed}
        </span>
      )}
    </div>
  );
}
