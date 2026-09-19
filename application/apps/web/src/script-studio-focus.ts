/** Capture before async disable/removal; restore only if the user has not moved on. */
export function scriptFocusReturn(
  scope: HTMLElement | null,
  origin = document.activeElement as HTMLElement | null,
) {
  const usable = (element: HTMLElement | null): element is HTMLElement =>
    !!element?.isConnected &&
    element.getClientRects().length > 0 &&
    !element.matches(":disabled") &&
    !element.closest("[inert]");
  return () =>
    requestAnimationFrame(() => {
      if (!usable(scope)) return;
      const modal = document.querySelector("dialog[open]");
      if (modal && !modal.contains(scope)) return;
      const active = document.activeElement as HTMLElement | null;
      if (active !== document.body && active !== origin && usable(active))
        return;
      const target = usable(origin)
        ? origin
        : scope.querySelector<HTMLElement>("[data-script-focus-anchor]");
      if (usable(target)) target.focus({ preventScroll: true });
    });
}
