/** A hidden Human menu entry has a visible equivalent after sidebar reflow.
 * Only restore that exact entry; unrelated modal origins keep their own rules. */
export function visibleProfileMenuTrigger(origin: HTMLElement) {
  const selector =
    ".sidebar button.profile-trigger, .sidebar button.profile-compact, .sidebar button.profile-settings";
  if (!origin.matches(selector)) return null;
  return (
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (button) =>
        button.getClientRects().length > 0 &&
        getComputedStyle(button).visibility !== "hidden" &&
        !button.matches(":disabled"),
    ) ?? null
  );
}
