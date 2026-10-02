import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { BrandMark } from "./BrandMark.js";

export type ProfileAvatarState =
  | "idle"
  | "processing"
  | "working"
  | "approval"
  | "paused"
  | "waiting"
  | "offline"
  | "unavailable";

export interface ProfileAvatarProps {
  name: string;
  /** Host-authorized asset URL. A still image remains a still image. */
  src?: string;
  posterSrc?: string;
  animated?: boolean;
  mediaType?: "image" | "video";
  size?: number;
  state?: ProfileAvatarState;
  active?: boolean;
  allowMotion?: boolean;
  /** The caller supplies an actual status label, if a status is to be named. */
  label?: string;
  className?: string;
}

const motionQuery = "(prefers-reduced-motion: reduce)";

function subscribeMotionPreference(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getMotionPreference() {
  return (
    typeof window !== "undefined" && window.matchMedia(motionQuery).matches
  );
}

function subscribeVisibility(onChange: () => void) {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isDocumentVisible() {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function subscribeWindowFocus(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

function isWindowFocused() {
  return typeof document === "undefined" || document.hasFocus();
}

export function profileAvatarInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() || "M";
}

export function profileAvatarSize(size: number = 96) {
  return Number.isFinite(size) ? Math.min(512, Math.max(16, size)) : 96;
}

/**
 * This view never derives execution state or schedules synthetic activity.
 * The default is the existing Morphz mark. Uploaded stills remain stills.
 */
export function ProfileAvatar({
  name,
  src,
  posterSrc,
  animated = false,
  mediaType = "image",
  size = 96,
  state = "idle",
  active = true,
  allowMotion = true,
  label,
  className,
}: ProfileAvatarProps) {
  const reducedMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getMotionPreference,
    () => false,
  );
  const visible = useSyncExternalStore(
    subscribeVisibility,
    isDocumentVisible,
    () => true,
  );
  const focused = useSyncExternalStore(
    subscribeWindowFocus,
    isWindowFocused,
    () => true,
  );
  const [failedSource, setFailedSource] = useState<string>();
  const dimension = profileAvatarSize(size);
  const motion =
    active &&
    allowMotion &&
    !reducedMotion &&
    visible &&
    focused &&
    state !== "offline" &&
    state !== "unavailable";
  const movingAsset = animated || mediaType === "video";
  const displaySource = src
    ? movingAsset && !motion
      ? posterSrc
      : src
    : undefined;
  const native = !src;
  const showVideo =
    mediaType === "video" && motion && displaySource === src && !!src;
  const showSource = !!displaySource && failedSource !== displaySource;
  const nativeMotion = native && motion;
  const accessibleName = label?.trim() || name.trim() || "Morphz";
  const style = {
    "--profile-avatar-size": `${dimension}px`,
  } as CSSProperties;

  return (
    <span
      className={["profile-avatar", className].filter(Boolean).join(" ")}
      style={style}
      role="img"
      aria-label={accessibleName}
      title={accessibleName}
      data-state={state}
      data-motion={
        nativeMotion || (movingAsset && motion && showSource) ? "on" : "off"
      }
      data-small={dimension <= 32 ? "true" : "false"}
      data-avatar-kind={native ? "native" : showSource ? "media" : "initial"}
    >
      {native ? (
        <BrandMark lively={nativeMotion} />
      ) : showSource ? (
        showVideo ? (
          <video
            key={displaySource}
            className="profile-avatar-media"
            src={displaySource}
            poster={posterSrc}
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            aria-hidden="true"
            disablePictureInPicture
            onError={() => setFailedSource(displaySource)}
          />
        ) : (
          <img
            className="profile-avatar-media"
            src={displaySource}
            alt=""
            draggable={false}
            onError={() => setFailedSource(displaySource)}
          />
        )
      ) : (
        <span className="profile-avatar-initial" aria-hidden="true">
          {profileAvatarInitial(name)}
        </span>
      )}
    </span>
  );
}
