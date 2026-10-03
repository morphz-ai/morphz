import type { ComponentPropsWithRef, ReactNode } from "react";
import {
  assertControlIconRole,
  ControlIcon,
  type ControlIconSelection,
} from "../design/control-icons.js";

export type IconButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  "children" | "dangerouslySetInnerHTML"
> &
  ControlIconSelection & {
    /** Decoration after the registered glyph, such as the existing unread mark. */
    afterIcon?: ReactNode;
  };

/** One native button. Native props (including the React 19 ref) pass unchanged;
 * role and icon identity are not DOM attributes or styling defaults. */
export function IconButton({
  controlRole,
  iconId,
  afterIcon,
  ...buttonProps
}: IconButtonProps) {
  assertControlIconRole(controlRole, iconId);
  return (
    <button {...buttonProps}>
      <ControlIcon name={iconId} />
      {afterIcon}
    </button>
  );
}
