import { BrandMark } from "./BrandMark.js";
import { ProfileAvatar } from "./ProfileAvatar.js";
import type { SubjectLogoState, SubjectView } from "./subject-sidebar-model.js";
import "./subject-logo.css";

export function SubjectLogo({
  presence,
  onOpen,
  name = "Morphz",
  avatarSrc,
  avatarPosterSrc,
  avatarAnimated = false,
  allowMotion = true,
}: {
  presence: SubjectLogoState;
  onOpen(view: SubjectView): void;
  name?: string;
  avatarSrc?: string;
  avatarPosterSrc?: string;
  avatarAnimated?: boolean;
  allowMotion?: boolean;
}) {
  const action = presence.view === "permissions" ? "授权" : "活动";
  return (
    <button
      className="wordmark agent-presence"
      data-state={presence.state}
      data-working={presence.working}
      data-processing={presence.processing || undefined}
      aria-label={`${name} · ${presence.label} · 查看${action}`}
      title={`${presence.label} · 查看${action}`}
      onClick={() => onOpen(presence.view)}
    >
      <span className="agent-presence-mark" aria-hidden="true">
        {avatarSrc ? (
          <ProfileAvatar
            name={name}
            src={avatarSrc}
            posterSrc={avatarPosterSrc}
            animated={avatarAnimated}
            allowMotion={allowMotion}
            size={28}
            state={
              presence.state === "unknown" ? "unavailable" : presence.state
            }
          />
        ) : (
          <BrandMark lively />
        )}
      </span>
      <span className="wordmark-label">{name}</span>
    </button>
  );
}
