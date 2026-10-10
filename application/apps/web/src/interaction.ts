/** A workspace has one exchange surface; layout never creates a Session. */
export type InteractionMode =
  "hidden" | "input" | "recent" | "history" | "recent-only" | "history-only";
export type ExchangeView = "input" | "recent" | "history";
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
/** Reading selection survives collapse. Legacy layouts provide a lazy default;
 * invalid local preferences never introduce another layout mode. */
export function exchangeView(
  mode: InteractionMode,
  selected?: unknown,
): ExchangeView {
  if (selected === "input" || selected === "recent" || selected === "history")
    return selected;
  const reading = readingMode(mode);
  return reading === "recent" || reading === "history" ? reading : "input";
}
/** Selected records follow a pinned input. The separate history pin can also
 * retain reading alone; neither pin is an implicit open action. */
export function afterLeave(
  mode: InteractionMode,
  inputPinned: boolean,
  historyPinned: boolean,
  view = exchangeView(mode),
): InteractionMode {
  const input =
    inputPinned &&
    (mode === "input" || mode === "recent" || mode === "history");
  const reading = readingMode(mode);
  const history =
    (historyPinned || (input && view !== "input")) &&
    (reading === "recent" || reading === "history");
  return history
    ? input
      ? reading
      : withoutInput(reading)
    : input
      ? "input"
      : "hidden";
}
export function revealInput(
  mode: InteractionMode,
  view = exchangeView(mode),
): InteractionMode {
  return view;
}
export function afterSend(
  mode: InteractionMode,
  view = exchangeView(mode),
): InteractionMode {
  return mode === "hidden" ||
    mode === "history" ||
    mode === "recent-only" ||
    mode === "history-only"
    ? mode
    : view;
}
export function shouldFollow(bottomDistance: number) {
  return bottomDistance <= 48;
}
