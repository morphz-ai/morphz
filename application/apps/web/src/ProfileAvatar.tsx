import {
  useId,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent,
} from "react";

export type ProfileAvatarState =
  | "idle"
  | "processing"
  | "working"
  | "approval"
  | "paused"
  | "waiting"
  | "offline"
  | "unavailable";

export type ProfileAvatarConcept = "seed" | "fold" | "wing";

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
  concept?: ProfileAvatarConcept;
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
 * Native expression is separate from the brand mark and from uploaded media.
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
  concept = "seed",
}: ProfileAvatarProps) {
  const id = useId().replace(/:/g, "");
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
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
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
    "--profile-avatar-gaze-x": `${nativeMotion ? gaze.x : 0}px`,
    "--profile-avatar-gaze-y": `${nativeMotion ? gaze.y : 0}px`,
  } as CSSProperties;

  function followPointer(event: PointerEvent<HTMLSpanElement>) {
    if (!nativeMotion || dimension <= 32) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    setGaze({
      x: clamp(((event.clientX - bounds.left) / bounds.width - 0.5) * 2) * 2.4,
      y: clamp(((event.clientY - bounds.top) / bounds.height - 0.5) * 2) * 1.6,
    });
  }

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
      data-concept={native ? concept : undefined}
      data-avatar-kind={native ? "native" : showSource ? "media" : "initial"}
      onPointerMove={native ? followPointer : undefined}
      onPointerLeave={native ? () => setGaze({ x: 0, y: 0 }) : undefined}
    >
      {native ? (
        <svg
          className="profile-avatar-character"
          viewBox="0 0 96 96"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0.8" y2="1">
              <stop className="profile-avatar-gradient-light" offset="0" />
              <stop className="profile-avatar-gradient-base" offset="1" />
            </linearGradient>
          </defs>
          <g className="profile-avatar-body">
            {concept === "seed" ? (
              <>
                <path
                  className="profile-avatar-fold profile-avatar-fold-left"
                  d="M28 37C20 29 12 28 11 35c-2 10 6 20 19 23l9-13Z"
                />
                <path
                  className="profile-avatar-fold profile-avatar-fold-right"
                  d="M68 37c8-8 16-9 17-2 2 10-6 20-19 23l-9-13Z"
                />
                <path
                  fill={`url(#${id}-body)`}
                  d="M48 13c14 0 29 18 31 34 3 21-10 35-31 35S14 68 17 47c2-16 17-34 31-34Z"
                />
                <path
                  className="profile-avatar-facet"
                  d="M48 13c-14 0-29 18-31 34-3 21 10 35 31 35-11-9-16-21-14-37 1-12 6-23 14-32Z"
                />
                <path
                  className="profile-avatar-seam"
                  d="M48 17c-5 8-7 14-8 19"
                />
              </>
            ) : concept === "fold" ? (
              <>
                <path
                  className="profile-avatar-fold profile-avatar-fold-left"
                  d="M25 31 12 45l13 17 15-16Z"
                />
                <path
                  className="profile-avatar-fold profile-avatar-fold-right"
                  d="m71 31 13 14-13 17-15-16Z"
                />
                <path
                  fill={`url(#${id}-body)`}
                  d="M29 19c8-7 30-7 38 0l12 24c3 8 1 23-6 29-11 11-39 11-50 0-7-6-9-21-6-29Z"
                />
                <path
                  className="profile-avatar-facet"
                  d="m29 19 9 22-7 34c-11-3-18-15-14-32Z"
                />
                <path className="profile-avatar-seam" d="m31 20 8 19" />
              </>
            ) : (
              <>
                <path
                  className="profile-avatar-fold profile-avatar-fold-left"
                  d="M39 33C27 16 13 17 10 28 7 40 16 59 34 66Z"
                />
                <path
                  className="profile-avatar-fold profile-avatar-fold-right"
                  d="M57 33c12-17 26-16 29-5 3 12-6 31-24 38Z"
                />
                <path
                  fill={`url(#${id}-body)`}
                  d="M48 24c17 0 29 13 29 30S65 81 48 81 19 71 19 54s12-30 29-30Z"
                />
                <path
                  className="profile-avatar-facet"
                  d="M48 24C31 24 19 37 19 54s12 27 29 27c-9-5-16-16-16-29 0-12 7-22 16-28Z"
                />
              </>
            )}
            <g className="profile-avatar-face">
              <g className="profile-avatar-look">
                <g className="profile-avatar-eyes">
                  <ellipse cx="39" cy="49" rx="3.7" ry="5.5" />
                  <ellipse cx="58" cy="49" rx="3.7" ry="5.5" />
                </g>
                <g className="profile-avatar-rest-eyes">
                  <path d="M35 50q4 3 8 0M54 50q4 3 8 0" />
                </g>
                <path className="profile-avatar-mouth" d="M44 62q4.5 3 9 0" />
                <path className="profile-avatar-attentive-mouth" d="M46 62h5" />
              </g>
            </g>
          </g>
        </svg>
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
