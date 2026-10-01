export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_ICON_WIDTH = 80;
export const SIDEBAR_COLLAPSE_WIDTH = 160;
const MAIN_MIN_WIDTH = 480;

export type SidebarPreference = {
  sidebarWidth: number;
  sidebarCompact: boolean;
};

export function sidebarPreference(
  width?: unknown,
  compact?: unknown,
): SidebarPreference {
  return {
    sidebarWidth:
      typeof width === "number" && Number.isFinite(width)
        ? Math.round(
            Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)),
          )
        : SIDEBAR_DEFAULT_WIDTH,
    sidebarCompact: compact === true,
  };
}

/** Viewport pressure changes the presentation, never the saved preference. */
export function sidebarLayout(
  available: number,
  preference: SidebarPreference,
) {
  const mobile = available <= 560;
  const maxWidth = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, available - MAIN_MIN_WIDTH),
  );
  const compact =
    !mobile &&
    (preference.sidebarCompact ||
      available < MAIN_MIN_WIDTH + SIDEBAR_MIN_WIDTH);
  return {
    mobile,
    compact,
    width: compact
      ? SIDEBAR_ICON_WIDTH
      : Math.min(preference.sidebarWidth, maxWidth),
    maxWidth,
  };
}

export function resizeSidebar(
  requested: number,
  maxWidth: number,
  previous: SidebarPreference,
): SidebarPreference {
  return requested < SIDEBAR_COLLAPSE_WIDTH
    ? { ...previous, sidebarCompact: true }
    : {
        sidebarCompact: false,
        sidebarWidth: Math.round(
          Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, requested)),
        ),
      };
}

export function stepSidebar(
  width: number,
  key: string,
  shift: boolean,
  maxWidth: number,
  previous: SidebarPreference,
): SidebarPreference | null {
  if (key === "Home") return { ...previous, sidebarCompact: true };
  if (key === "End") return { sidebarCompact: false, sidebarWidth: maxWidth };
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  // A rail expands immediately on the first right key; shrinking the expanded
  // minimum similarly enters the rail instead of getting stuck at 200px.
  if (width === SIDEBAR_ICON_WIDTH && key === "ArrowRight")
    return { sidebarCompact: false, sidebarWidth: SIDEBAR_MIN_WIDTH };
  if (width <= SIDEBAR_MIN_WIDTH && key === "ArrowLeft")
    return { ...previous, sidebarCompact: true };
  return resizeSidebar(
    width + (key === "ArrowRight" ? 1 : -1) * (shift ? 32 : 16),
    maxWidth,
    previous,
  );
}
