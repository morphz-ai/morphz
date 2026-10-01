import type { CSSProperties } from "react";
import { ProfileAvatar, profileAvatarInitial } from "./ProfileAvatar.js";
export function HumanAvatar({
  name,
  src,
  posterSrc,
  animated,
  size = 32,
  allowMotion = true,
}: {
  name: string;
  src?: string;
  posterSrc?: string;
  animated?: boolean;
  size?: number;
  allowMotion?: boolean;
}) {
  return src ? (
    <ProfileAvatar
      name={name}
      src={src}
      posterSrc={posterSrc}
      animated={animated}
      size={size}
      allowMotion={allowMotion}
    />
  ) : (
    <span
      className="profile-avatar profile-human-avatar"
      role="img"
      aria-label={name}
      style={{ "--profile-avatar-size": `${size}px` } as CSSProperties}
    >
      <span className="profile-avatar-initial">
        {profileAvatarInitial(name)}
      </span>
    </span>
  );
}
