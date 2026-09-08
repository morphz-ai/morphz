/** A workspace has one exchange surface; layout never creates a Session. */
export type InteractionMode = "hidden" | "input" | "recent" | "history";
export function revealInput(mode: InteractionMode): InteractionMode {
  return mode === "hidden" ? "input" : mode;
}
export function afterSend(mode: InteractionMode): InteractionMode {
  return mode === "hidden" ? mode : mode === "history" ? mode : "recent";
}
export function shouldFollow(bottomDistance: number) {
  return bottomDistance <= 48;
}
