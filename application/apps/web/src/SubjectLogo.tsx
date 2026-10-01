import { BrandMark } from "./BrandMark.js";
import type { SubjectLogoState, SubjectView } from "./subject-sidebar-model.js";
import "./subject-logo.css";

export function SubjectLogo({
  presence,
  onOpen,
}: {
  presence: SubjectLogoState;
  onOpen(view: SubjectView): void;
}) {
  const action = presence.view === "permissions" ? "授权" : "活动";
  return (
    <button
      className="wordmark agent-presence"
      data-state={presence.state}
      data-working={presence.working}
      aria-label={`Morphz · ${presence.label} · 查看${action}`}
      title={`${presence.label} · 查看${action}`}
      onClick={() => onOpen(presence.view)}
    >
      <span className="agent-presence-mark" aria-hidden="true">
        <BrandMark lively />
        {presence.state !== "idle" && (
          <svg className="agent-presence-status" viewBox="0 0 16 16">
            {presence.state === "working" && (
              <circle
                cx="8"
                cy="8"
                r="2.25"
                fill="currentColor"
                stroke="none"
              />
            )}
            {presence.state === "approval" && <path d="M8 3.5v5M8 12h.01" />}
            {presence.state === "paused" && <path d="M5.5 4v8M10.5 4v8" />}
            {presence.state === "waiting" && (
              <>
                <circle cx="8" cy="8" r="5" />
                <path d="M8 5v3l2 1" />
              </>
            )}
            {presence.state === "unknown" && <path d="M4.5 8h7" />}
          </svg>
        )}
      </span>
      <span className="wordmark-label">Morphz</span>
    </button>
  );
}
