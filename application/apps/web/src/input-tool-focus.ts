/** Restore a native picker to its still-mounted trigger, never another draft. */
export function restoreInputToolFocus(trigger: HTMLButtonElement | null) {
  requestAnimationFrame(() => {
    if (!trigger?.isConnected || trigger.disabled || !document.hasFocus())
      return;
    const active = document.activeElement;
    // Upload completion must not steal focus from typing or newer navigation.
    if (
      active !== document.body &&
      active !== document.documentElement &&
      active !== trigger &&
      !active?.matches('input[type="file"]')
    )
      return;
    trigger.focus({ preventScroll: true });
  });
}
