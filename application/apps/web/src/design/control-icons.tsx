import {
  ChevronDown,
  Maximize2,
  MessageSquareText,
  Minimize2,
  PanelLeft,
  PanelRight,
  Pin,
} from "lucide-react";

/** The existing glyphs for the first migrated control roles, not app icons. */
export const controlIcons = {
  "panel-left": PanelLeft,
  "panel-right": PanelRight,
  "message-square-text": MessageSquareText,
  maximize: Maximize2,
  minimize: Minimize2,
  pin: Pin,
  "chevron-down": ChevronDown,
} as const;
export type ControlIconId = keyof typeof controlIcons;

export const controlRoleIcons = {
  "sidebar-visibility": ["panel-left", "panel-right"],
  "exchange-operation": [
    "message-square-text",
    "maximize",
    "minimize",
    "pin",
    "chevron-down",
  ],
} as const;
export type ControlRole = keyof typeof controlRoleIcons;
export type ControlIconForRole<Role extends ControlRole> =
  (typeof controlRoleIcons)[Role][number];
export type ControlIconSelection = {
  [Role in ControlRole]: {
    controlRole: Role;
    iconId: ControlIconForRole<Role>;
  };
}[ControlRole];

export function assertControlIconRole(
  role: ControlRole,
  name: ControlIconId,
): void {
  if (
    !Object.hasOwn(controlRoleIcons, role) ||
    !Object.hasOwn(controlIcons, name)
  )
    throw new TypeError("Unknown control role or icon");
  const allowed: readonly ControlIconId[] = controlRoleIcons[role];
  if (!allowed.includes(name))
    throw new TypeError("Control icon does not belong to this role");
}

/** No wrapper, SVG attributes, fallback glyph or visual policy is added. */
export function ControlIcon({ name }: { name: ControlIconId }) {
  if (!Object.hasOwn(controlIcons, name))
    throw new TypeError("Unknown control icon");
  const Icon = controlIcons[name];
  return <Icon />;
}
