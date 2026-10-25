import { useLayoutEffect, type RefObject } from "react";

/** Keep keyboard scope inside this native modal (including Chromium's last
 * control -> browser-chrome boundary), without touching the main composer. */
export function useQuestionDialog(dialog: RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing)
        return;
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          "a[href],button,input,select,textarea,[tabindex]",
        ),
      ].filter(
        (control) =>
          control.tabIndex >= 0 &&
          !control.matches(":disabled") &&
          !control.closest("[inert]") &&
          control.getClientRects().length > 0 &&
          getComputedStyle(control).visibility !== "hidden",
      );
      const first = controls[0],
        last = controls.at(-1);
      if (
        !first ||
        (event.shiftKey
          ? document.activeElement === first
          : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    element.addEventListener("keydown", keyboard);
    element.showModal();
    return () => {
      element.removeEventListener("keydown", keyboard);
      element.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !document.querySelector("dialog[open]")
      )
        previous.focus({ preventScroll: true });
    };
  }, [dialog]);
}
