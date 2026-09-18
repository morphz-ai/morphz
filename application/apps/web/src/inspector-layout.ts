export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 520;
export const CANVAS_MIN_WIDTH = 640;

/** Host geometry, independent of application, conversation and execution scope. */
export function inspectorLayout(available: number, preferred = 340) {
  const width = Math.max(0, available);
  const requested = Number.isFinite(preferred)
    ? Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, preferred))
    : 340;
  const docked = width >= CANVAS_MIN_WIDTH + INSPECTOR_MIN_WIDTH;
  return {
    mode: docked ? ("docked" as const) : ("overlay" as const),
    width: docked
      ? Math.min(requested, width - CANVAS_MIN_WIDTH)
      : Math.min(340, width),
    maxWidth: Math.min(INSPECTOR_MAX_WIDTH, width - CANVAS_MIN_WIDTH),
  };
}

export type InspectorLayout = ReturnType<typeof inspectorLayout>;
