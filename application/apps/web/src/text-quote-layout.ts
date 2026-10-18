/** Quote UI uses viewport DOMRects, but fixed offsets use the portal's CSS
 * pixels. Its boundary is the visible work canvas, not the whole window. */
export function textQuoteRegion(element: HTMLElement) {
  let zoom = (element as HTMLElement & { currentCSSZoom?: number })
    .currentCSSZoom;
  if (!zoom) {
    zoom = 1;
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.parentElement
    ) {
      const value = getComputedStyle(node).zoom;
      const factor = Number.parseFloat(value) / (value.endsWith("%") ? 100 : 1);
      if (Number.isFinite(factor) && factor > 0) zoom *= factor;
    }
  }
  const app = element.closest(".app");
  const work = app?.querySelector(".primary-panel");
  const rect = (work ?? app)?.getBoundingClientRect();
  let left = Math.max(0, rect?.left ?? 0);
  let right = Math.min(innerWidth, rect?.right ?? innerWidth);
  const top = Math.max(0, rect?.top ?? 0);
  const bottom = Math.min(innerHeight, rect?.bottom ?? innerHeight);
  // In narrow windows an inspector/navigation rail can cover rather than
  // resize the canvas. That covered area still belongs to the sidebar.
  for (const sidebar of app?.querySelectorAll(
    ".sidebar, .workspace-inspector",
  ) ?? []) {
    const box = sidebar.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom <= top || box.top >= bottom)
      continue;
    if (sidebar.matches(".sidebar") && box.right > left && box.left <= left)
      left = Math.min(right, box.right);
    if (
      sidebar.matches(".workspace-inspector") &&
      box.left < right &&
      box.right >= right
    )
      right = Math.max(left, box.left);
  }
  const gapX = Math.min(8 * zoom, Math.max(0, right - left) / 4);
  const gapY = Math.min(8 * zoom, Math.max(0, bottom - top) / 4);
  return {
    zoom,
    left: (left + gapX) / zoom,
    right: (right - gapX) / zoom,
    top: (top + gapY) / zoom,
    bottom: (bottom - gapY) / zoom,
  };
}

export function positionTextQuote(
  element: HTMLElement,
  point: { x: number; y: number; above?: boolean; start?: boolean },
) {
  const area = textQuoteRegion(element);
  const width = Math.max(0, area.right - area.left);
  const height = Math.max(0, area.bottom - area.top);
  element.style.visibility = width && height ? "" : "hidden";
  element.style.maxWidth = `${width}px`;
  element.style.maxHeight = `${height}px`;
  const x = point.x / area.zoom - (point.start ? 0 : element.offsetWidth);
  const y = point.y / area.zoom;
  const below = y + 8;
  const above = y - element.offsetHeight - 8;
  const preferAbove =
    point.above ||
    (below + element.offsetHeight > area.bottom && above >= area.top);
  element.style.left = `${Math.max(area.left, Math.min(x, area.right - element.offsetWidth))}px`;
  element.style.top = `${Math.max(area.top, Math.min(preferAbove ? above : below, area.bottom - element.offsetHeight))}px`;
}

/** Keep the same open editor/textarea while either sidebar, the work surface
 * or CSS zoom changes. Geometry updates never commit or replace its draft. */
export function observeTextQuoteLayout(
  element: HTMLElement,
  position: () => void,
) {
  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  };
  const app = element.closest(".app");
  const resize = new ResizeObserver(update);
  const observe = () => {
    resize.observe(element);
    if (app) {
      resize.observe(app);
      for (const node of app.querySelectorAll(
        ".primary-panel, .workspace, .sidebar, .workspace-inspector",
      ))
        resize.observe(node);
    }
  };
  const mutation = new MutationObserver((records) => {
    if (
      records.every(
        (record) =>
          element.contains(record.target) ||
          (record.target instanceof Element &&
            record.target.closest("[data-quote-ui]")),
      )
    )
      return;
    observe();
    update();
  });
  if (app)
    mutation.observe(app, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-inspector-mode"],
    });
  observe();
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update, true);
  position();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    window.removeEventListener("resize", update);
    window.removeEventListener("scroll", update, true);
  };
}
