/** A workspace has one exchange surface; layout never creates a Session. */
export type InteractionMode = "hidden" | "input" | "recent" | "history";
export function revealInput(mode: InteractionMode): InteractionMode {
  // Explicit opening focuses the input and reveals history. Commit that layout
  // once; rendering input-only and resizing again on focus leaves an iframe's
  // hit-test surface momentarily covering the newly visible composer controls.
  return mode === "history" ? mode : "recent";
}
export function afterSend(mode: InteractionMode): InteractionMode {
  return mode === "hidden" ? mode : mode === "history" ? mode : "recent";
}
export function shouldFollow(bottomDistance: number) {
  return bottomDistance <= 48;
}
