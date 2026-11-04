import {
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Placement,
} from "@floating-ui/core";

export type TextAnchor = {
  x: number;
  y: number;
  rect?: Pick<DOMRect, "x" | "y" | "width" | "height">;
  above?: boolean;
  start?: boolean;
};
const generations = new WeakMap<HTMLElement, number>();

/** Geometry only. These observers never read a product API or database. */
export function textPopoverArea(element: HTMLElement) {
  const host =
    element.closest(".app,.page-shell") ??
    document.querySelector(".app,.page-shell") ??
    document.documentElement;
  const canvas =
    host.querySelector(".primary-panel,.conversation-view") ??
    host.querySelector(".view-frame") ??
    host;
  const bounds = canvas.getBoundingClientRect();
  const zoom =
    (element as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
  let left = Math.max(0, bounds.left),
    right = Math.min(innerWidth, bounds.right);
  let top = Math.max(0, bounds.top),
    bottom = Math.min(
      innerHeight,
      window.visualViewport?.height ?? innerHeight,
      bounds.bottom,
    );
  for (const rail of host.querySelectorAll<HTMLElement>(
    ".sidebar,.workspace-inspector",
  )) {
    const r = rail.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= top || r.top >= bottom) continue;
    if (r.left <= left && r.right > left) left = Math.min(right, r.right);
    if (r.right >= right && r.left < right) right = Math.max(left, r.left);
  }
  for (const blocker of host.querySelectorAll<HTMLElement>(
    ".topbar,.composer,.composer-area,.application-dock,[data-text-popover-blocker]",
  )) {
    if (element.contains(blocker) || !blocker.getClientRects().length) continue;
    const r = blocker.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= left || r.left >= right) continue;
    if (blocker.matches(".topbar") && r.top <= top)
      top = Math.max(top, r.bottom);
    else if (!blocker.matches(".topbar") && r.top > top)
      bottom = Math.min(bottom, r.top - 8 * zoom);
  }
  const gap = 8 * zoom;
  return {
    zoom,
    x: left + gap,
    y: top + gap,
    width: Math.max(0, right - left - 2 * gap),
    height: Math.max(0, bottom - top - 2 * gap),
  };
}

/** Floating UI owns placement and collision handling. All coordinates use
 * viewport rectangles, then convert once to the portal's CSS zoom units. */
export async function positionTextPopover(
  element: HTMLElement,
  anchor: TextAnchor,
  preferred: Placement = "bottom-end",
) {
  const generation = (generations.get(element) ?? 0) + 1;
  generations.set(element, generation);
  const area = textPopoverArea(element),
    zoom = area.zoom;
  if (!area.width || !area.height) {
    element.style.visibility = "hidden";
    return;
  }
  element.style.visibility = "";
  element.style.maxWidth = `${area.width / zoom}px`;
  element.style.maxHeight = `${Math.min(560, (innerHeight / zoom) * 0.75, area.height / zoom)}px`;
  const reference = anchor.rect ?? {
    x: anchor.x,
    y: anchor.y,
    width: 0,
    height: 0,
  };
  const dimensions = () => {
    const r = element.getBoundingClientRect();
    return { width: r.width, height: r.height };
  };
  const result = await computePosition(reference, element, {
    strategy: "fixed",
    placement: anchor.above
      ? "top-end"
      : anchor.start
        ? "bottom-start"
        : preferred,
    platform: {
      getElementRects: () => ({
        reference,
        floating: { x: 0, y: 0, ...dimensions() },
      }),
      getClippingRect: () => area,
      getDimensions: dimensions,
      isRTL: () => getComputedStyle(element).direction === "rtl",
    },
    middleware: [
      offset(8 * zoom),
      flip({
        fallbackPlacements:
          preferred === "right-start"
            ? ["left-start", "top-start", "bottom-start"]
            : ["top-end", "right-start", "left-start", "bottom-end"],
      }),
      shift({ mainAxis: true, crossAxis: false }),
      size({
        apply: ({ availableWidth, availableHeight }) => {
          if (generations.get(element) !== generation) return;
          element.style.maxWidth = `${Math.max(0, Math.min(area.width, availableWidth)) / zoom}px`;
          element.style.maxHeight = `${Math.max(0, Math.min(560 * zoom, innerHeight * 0.75, area.height, availableHeight)) / zoom}px`;
          element.dataset.textCompact =
            Number.parseFloat(element.style.maxHeight) < 300 ? "true" : "false";
        },
      }),
    ],
  });
  if (generations.get(element) !== generation || !element.isConnected) return;
  element.style.left = `${result.x / zoom}px`;
  element.style.top = `${result.y / zoom}px`;
  element.dataset.textPlacement = result.placement;
}

export function observeTextPopover(element: HTMLElement, position: () => void) {
  let frame = 0;
  const update = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        position();
      });
  };
  const host = element.closest(".app,.page-shell") ?? document.body;
  const resize = new ResizeObserver(update);
  const observe = () => {
    resize.observe(element);
    for (const node of host.querySelectorAll(
      ".primary-panel,.conversation-view,.view-frame,.topbar,.composer,.composer-area,.application-dock,.sidebar,.workspace-inspector,[data-text-popover-blocker]",
    ))
      resize.observe(node);
  };
  const mutation = new MutationObserver((records) => {
    if (
      records.every(
        (record) =>
          element.contains(record.target) ||
          (record.target instanceof Element &&
            record.target.closest("[data-quote-ui],[data-discussion-ui]")),
      )
    )
      return;
    observe();
    update();
  });
  mutation.observe(host, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "data-inspector-mode"],
  });
  observe();
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update, true);
  window.visualViewport?.addEventListener("resize", update);
  position();
  return () => {
    generations.set(element, (generations.get(element) ?? 0) + 1);
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    window.removeEventListener("resize", update);
    window.removeEventListener("scroll", update, true);
    window.visualViewport?.removeEventListener("resize", update);
  };
}
