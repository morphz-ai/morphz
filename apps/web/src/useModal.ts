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
    element.showModal();
    (
      initialFocus?.current ??
      element.querySelector<HTMLElement>("[autofocus]") ??
      element.querySelector<HTMLElement>("input, textarea, select") ??
      element.querySelector<HTMLElement>("button")
    )?.focus();
    return () => {
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
