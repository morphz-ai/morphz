/** Focus ownership stays native. Only its visual cue follows the last human
 * input: Chromium may otherwise carry focus-visible from a text field into a
 * pointer-opened menu or a programmatically restored scroll region. */
export function installFocusModality(document: Document) {
  const root = document.documentElement;
  const previous = root.getAttribute("data-ui-focus");
  const set = (mode: "pointer" | "keyboard") => {
    if (root.dataset.uiFocus !== mode) root.dataset.uiFocus = mode;
  };
  let position: Pick<PointerEvent, "pointerId" | "screenX" | "screenY"> | null =
    null;
  const remember = (event: PointerEvent) => {
    position = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
    };
  };
  const pointer = (event: PointerEvent) => {
    remember(event);
    set("pointer");
  };
  const move = (event: PointerEvent) => {
    // Returning to the mouse must not require clicking a second control.
    // Screen coordinates distinguish real motion from layout/scroll changes
    // beneath a stationary cursor, which must preserve keyboard navigation.
    const moved =
      !position ||
      position.pointerId !== event.pointerId ||
      position.screenX !== event.screenX ||
      position.screenY !== event.screenY;
    remember(event);
    if (moved) set("pointer");
  };
  const wheel = () => set("pointer");
  const keyboard = (event: KeyboardEvent) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
      set("keyboard");
  };
  const capture = { capture: true };
  set("pointer");
  document.addEventListener("pointerdown", pointer, capture);
  document.addEventListener("pointermove", move, { ...capture, passive: true });
  document.addEventListener("wheel", wheel, { ...capture, passive: true });
  document.addEventListener("keydown", keyboard, capture);
  return () => {
    document.removeEventListener("pointerdown", pointer, capture);
    document.removeEventListener("pointermove", move, capture);
    document.removeEventListener("wheel", wheel, capture);
    document.removeEventListener("keydown", keyboard, capture);
    if (previous === null) root.removeAttribute("data-ui-focus");
    else root.setAttribute("data-ui-focus", previous);
  };
}
