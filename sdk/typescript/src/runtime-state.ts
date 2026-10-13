/** Runtime lifecycle semantics shared by operator and product clients.
 * Unknown states remain inspectable current work, never assumed terminal. */
export function objectiveIsTerminal(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}
