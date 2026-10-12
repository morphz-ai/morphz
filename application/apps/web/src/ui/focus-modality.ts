/** Focus ownership stays native. Only its visual cue follows the last human
 * input: Chromium may otherwise carry focus-visible from a text field into a
 * pointer-opened menu or a programmatically restored scroll region. */
export function installFocusModality(document: Document) {
  const root = document.documentElement;
  const previous = root.getAttribute("data-ui-focus");
  const set = (mode: "pointer" | "keyboard") => {
    if (root.dataset.uiFocus !== mode) root.dataset.uiFocus = mode;
  };
  const pointer = () => set("pointer");
  const keyboard = (event: KeyboardEvent) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
      set("keyboard");
  };
  const capture = { capture: true };
  set("pointer");
  document.addEventListener("pointerdown", pointer, capture);
  document.addEventListener("keydown", keyboard, capture);
  return () => {
    document.removeEventListener("pointerdown", pointer, capture);
    document.removeEventListener("keydown", keyboard, capture);
    if (previous === null) root.removeAttribute("data-ui-focus");
    else root.setAttribute("data-ui-focus", previous);
  };
}
