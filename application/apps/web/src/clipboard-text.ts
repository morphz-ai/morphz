/** Explicit user-gesture text copy. Never reads the clipboard or grants access. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Desktop may reject async clipboard writes; preserve selection and focus
    // while using the existing user gesture for the same requested text only.
    const selection = window.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) =>
          selection.getRangeAt(i).cloneRange(),
        )
      : [];
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(input);
    try {
      input.select();
      if (!document.execCommand("copy")) throw new Error("Copy unavailable");
    } finally {
      input.remove();
      focused?.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
}
