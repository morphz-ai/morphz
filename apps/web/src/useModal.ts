import { useLayoutEffect, type RefObject } from "react";

/** Native dialog owns modality; explicitly restore selection and initiating focus. */
export function useModal(
  dialog: RefObject<HTMLDialogElement | null>,
  initialFocus?: RefObject<HTMLElement | null>,
  open = true,
) {
  useLayoutEffect(() => {
    const origin = document.activeElement as HTMLElement | null;
    const textOrigin =
      origin instanceof HTMLInputElement ||
      origin instanceof HTMLTextAreaElement
        ? origin
        : null;
    const textSelection =
      textOrigin && textOrigin.selectionStart !== null
        ? ([
            textOrigin.selectionStart,
            textOrigin.selectionEnd ?? textOrigin.selectionStart,
          ] as const)
        : null;
    const selection = window.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) =>
          selection.getRangeAt(i).cloneRange(),
        )
      : [];
    const element = dialog.current;
    if (!element || !open) return;
    const main = document.querySelector<HTMLElement>(".workspace");
    const position = () => {
      const bounds = main?.getBoundingClientRect();
      if (!bounds || bounds.width < 1) return;
      element.style.setProperty(
        "--modal-center",
        `${bounds.x + bounds.width / 2}px`,
      );
      element.style.setProperty(
        "--modal-max-width",
        `${Math.max(240, bounds.width - 32)}px`,
      );
    };
    const observer = new ResizeObserver(position);
    if (main) observer.observe(main);
    window.addEventListener("resize", position);
    position();
    element.showModal();
    // Chromium can move Tab from the last native-dialog control to browser
    // chrome (and leave activeElement on body). Keep this task's keyboard loop
    // explicit, including compact headers/footers whose DOM order has changed.
    const keepFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          "a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=true]",
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
    element.addEventListener("keydown", keepFocus);
    (
      initialFocus?.current ??
      element.querySelector<HTMLElement>("[autofocus]") ??
      element.querySelector<HTMLElement>("input, textarea, select") ??
      element.querySelector<HTMLElement>("button")
    )?.focus();
    return () => {
      observer.disconnect();
      element.removeEventListener("keydown", keepFocus);
      window.removeEventListener("resize", position);
      element.close();
      if (origin?.isConnected && !document.querySelector("dialog[open]")) {
        const returnTarget = origin.getClientRects().length
          ? origin
          : origin.closest("details")?.querySelector<HTMLElement>("summary");
        returnTarget?.focus({ preventScroll: true });
        if (textOrigin && textSelection)
          textOrigin.setSelectionRange(...textSelection);
        else if (
          ranges.every(
            (r) => r.startContainer.isConnected && r.endContainer.isConnected,
          )
        ) {
          selection?.removeAllRanges();
          for (const range of ranges) selection?.addRange(range);
        }
      }
    };
  }, [dialog, initialFocus, open]);
}
