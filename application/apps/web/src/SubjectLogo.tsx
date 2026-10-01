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
      data-processing={presence.processing || undefined}
      aria-label={`Morphz · ${presence.label} · 查看${action}`}
      title={`${presence.label} · 查看${action}`}
      onClick={() => onOpen(presence.view)}
    >
      <span className="agent-presence-mark" aria-hidden="true">
        <BrandMark lively />
      </span>
      <span className="wordmark-label">Morphz</span>
    </button>
  );
}
