import {
  observeTextPopover,
  positionTextPopover,
  textPopoverArea,
  type TextAnchor,
} from "../../../packages/core/src/text-popover-layout.js";

export function textQuoteRegion(element: HTMLElement) {
  const area = textPopoverArea(element);
  return {
    zoom: area.zoom,
    left: area.x / area.zoom,
    right: (area.x + area.width) / area.zoom,
    top: area.y / area.zoom,
    bottom: (area.y + area.height) / area.zoom,
  };
}
export function positionTextQuote(element: HTMLElement, point: TextAnchor) {
  void positionTextPopover(element, point);
}
export const observeTextQuoteLayout = observeTextPopover;
