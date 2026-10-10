/** A workspace has one exchange surface; layout never creates a Session. */
export type InteractionMode =
  "hidden" | "input" | "recent" | "history" | "recent-only" | "history-only";
export function readingMode(mode: InteractionMode) {
  return mode === "recent-only"
    ? "recent"
    : mode === "history-only"
      ? "history"
      : mode;
}
export function withoutInput(mode: InteractionMode): InteractionMode {
  const reading = readingMode(mode);
  return reading === "recent"
    ? "recent-only"
    : reading === "history"
      ? "history-only"
      : "hidden";
}
/** Pinning retains only already visible parts; it is never an open action. */
export function afterLeave(
  mode: InteractionMode,
  inputPinned: boolean,
  historyPinned: boolean,
): InteractionMode {
  const input =
    inputPinned &&
    (mode === "input" || mode === "recent" || mode === "history");
  const reading = readingMode(mode);
  const history =
    historyPinned && (reading === "recent" || reading === "history");
  return history
    ? input
      ? reading
      : withoutInput(reading)
    : input
      ? "input"
      : "hidden";
}
export function revealInput(mode: InteractionMode): InteractionMode {
  // Opening or focusing the composer must not override reading visibility.
  return mode === "hidden" ? "input" : readingMode(mode);
}
export function afterSend(mode: InteractionMode): InteractionMode {
  return mode === "hidden" ||
    mode === "history" ||
    mode === "recent-only" ||
    mode === "history-only"
    ? mode
    : "recent";
}
export function shouldFollow(bottomDistance: number) {
  return bottomDistance <= 48;
}
