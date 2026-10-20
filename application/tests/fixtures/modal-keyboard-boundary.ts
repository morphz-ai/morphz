// The reviewed October 20 event-order and initial-position changes of modal owners.
// Normalize only these exact spans back to the unchanged migration baselines;
// never replace the archived owner hashes with a new whole-file snapshot.
export const modalKeyboardChanges = [
  [
    `      // React controls handle IME, Escape and Tab before this native boundary.
      // Escape still belongs to the modal even if that handler unmounted it.
      // Do not prevent the browser's cancel action for an unhandled Escape.`,
    `      // A cancel handler may synchronously unmount the dialog before the
      // window shortcut sees this key. Escape still belongs to this modal,
      // never to the inspector/composer underneath it. Keep native cancel.`,
  ],
  [
    `      if (
        event.key !== "Tab" ||
        event.defaultPrevented ||
        !element.isConnected ||
        !element.open
      )
        return;`,
    `      if (event.key !== "Tab" || event.defaultPrevented) return;`,
  ],
  [
    `    const scopeKeyboardEvent = (event: KeyboardEvent) => {
      if (
        (event.key !== "Escape" && event.key !== "Tab") ||
        event
          .composedPath()
          .find((node) => node instanceof HTMLDialogElement) !== element
      )
        return;
      // A dialog-level bubble listener runs before React's delegated handlers.
      // Capture ownership now, then finish after those handlers at document.
      // This event-scoped listener intentionally survives synchronous cleanup:
      // removing the dialog must not expose this same Escape to window shortcuts.
      const finish = (candidate: KeyboardEvent) => {
        if (candidate !== event) return;
        document.removeEventListener("keydown", finish);
        window.clearTimeout(cleanup);
        keepFocus(event);
      };
      document.addEventListener("keydown", finish);
      // A child may stop propagation, so document may never receive this key.
      // Native input dispatch may run microtasks between listeners; retain the
      // guard through the whole event task, not just the capture callback.
      const cleanup = window.setTimeout(
        () => document.removeEventListener("keydown", finish),
        0,
      );
    };
    element.addEventListener("keydown", scopeKeyboardEvent, true);`,
    `    element.addEventListener("keydown", keepFocus);`,
  ],
  [
    `      element.removeEventListener("keydown", scopeKeyboardEvent, true);`,
    `      element.removeEventListener("keydown", keepFocus);`,
  ],
] as const;

export const modalInitialPositionChange = [
  `    element.showModal();
    // Hidden dialogs report currentCSSZoom=1 even inside a zoomed canvas.
    // Measure after showModal exposes the real scale, synchronously before paint;
    // the initial position must not depend on a later ResizeObserver delivery.
    position();`,
  `    position();
    element.showModal();`,
] as const;

export const inspectorModalKeyboardGuard = `        // A portaled modal is still a React descendant of this inspector.
        // Its child handlers run first; even synchronous unmount must not make
        // that modal's Escape close the inspector as the event bubbles here.
        if (
          event.nativeEvent
            .composedPath()
            .some((node) => node instanceof HTMLDialogElement)
        )
          return;
`;

function replaceExactlyOnce(source: string, current: string, old: string) {
  if (source.split(current).length !== 2)
    throw new Error("Unreviewed modal keyboard boundary change");
  return source.replace(current, old);
}

export function beforeReviewedModalChanges(source: string) {
  source = replaceExactlyOnce(source, ...modalInitialPositionChange);
  for (const [current, old] of modalKeyboardChanges)
    source = replaceExactlyOnce(source, current, old);
  return source;
}

export function beforeReviewedInspectorKeyboardChange(source: string) {
  return replaceExactlyOnce(source, inspectorModalKeyboardGuard, "");
}
