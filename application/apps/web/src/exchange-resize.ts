import type { InteractionMode } from "./interaction.js";

export type ExchangeSize = {
  mode: Exclude<InteractionMode, "hidden">;
  height: number;
};

/** Heights describe the reading area, so a longer draft does not change the
 * user's preferred message size. These are product snap distances, not limits
 * on message or draft length. Snapping happens once, when the gesture ends. */
export function exchangeResizeLimits(available: number) {
  const max = Number.isFinite(available) ? Math.max(0, available) : 0;
  return {
    max,
    collapse: Math.min(64, max * 0.25),
    expand: max - Math.min(48, max * 0.15),
  };
}

export function preferredExchangeHeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function resolveExchangeSize(
  height: number,
  available: number,
): ExchangeSize {
  const limits = exchangeResizeLimits(available);
  const next = Math.max(
    0,
    Math.min(limits.max, Number.isFinite(height) ? height : 0),
  );
  return {
    mode:
      next <= limits.collapse
        ? "input"
        : next >= limits.expand
          ? "history"
          : "recent",
    height: next,
  };
}

export function stepExchangeSize(
  mode: InteractionMode,
  height: number,
  available: number,
  key: string,
  largeStep = false,
): ExchangeSize | null {
  const limits = exchangeResizeLimits(available);
  const step = largeStep ? 64 : 24;
  if (key === "Home") return { mode: "input", height: 0 };
  if (key === "End") return resolveExchangeSize(limits.max, limits.max);
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  // A snapped endpoint must be escapable with one key press, not require an
  // invisible accumulation of repeated keys below/above the same threshold.
  if (mode === "input" && key === "ArrowUp")
    return resolveExchangeSize(
      limits.collapse + Math.min(step, limits.max * 0.1),
      limits.max,
    );
  if (mode === "history" && key === "ArrowDown")
    return resolveExchangeSize(
      limits.expand - Math.min(step, limits.max * 0.1),
      limits.max,
    );
  return resolveExchangeSize(
    height + (key === "ArrowUp" ? step : -step),
    limits.max,
  );
}
