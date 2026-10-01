import { useLayoutEffect, useRef, type RefObject } from "react";

/** Native dialog owns modality; explicitly restore selection and initiating focus. */
export function useModal(
  dialog: RefObject<HTMLDialogElement | null>,
  initialFocus?: RefObject<HTMLElement | null>,
  open = true,
  fallbackFocus?: (origin: HTMLElement) => HTMLElement | null,
) {
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;
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
      // DOMRect is already rendered through CSS zoom. The dialog's fixed
      // offsets and dimensions are layout CSS pixels; applying the rendered
      // coordinates directly would scale them a second time.
      const nativeZoom = (element as HTMLElement & { currentCSSZoom?: number })
        .currentCSSZoom;
      let zoom = nativeZoom ?? 1;
      if (nativeZoom === undefined) {
        for (
          let ancestor: HTMLElement | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const value = getComputedStyle(ancestor).zoom;
          const factor = value.endsWith("%")
            ? Number.parseFloat(value) / 100
            : Number.parseFloat(value);
          if (Number.isFinite(factor) && factor > 0) zoom *= factor;
        }
      }
      if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;
      element.style.setProperty(
        "--modal-center",
        `${(bounds.x + bounds.width / 2) / zoom}px`,
      );
      element.style.setProperty(
        "--modal-max-width",
        `${Math.max(0, bounds.width / zoom - 32)}px`,
      );
      element.style.setProperty(
        "--modal-max-height",
        `${Math.max(0, window.innerHeight / zoom - 32)}px`,
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
          : (origin.closest("details")?.querySelector<HTMLElement>("summary") ??
            fallback.current?.(origin));
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
