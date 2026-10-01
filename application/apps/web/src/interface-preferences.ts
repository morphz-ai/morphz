import type { InputDispatchMode } from "../../../packages/core/src/model.js";

/** Device-local presentation/input preferences, separate from workspace routing. */
export type InterfacePreferences = {
  appearance: "system" | "light" | "dark";
  accent: "cyan" | "iris" | "coral" | "mono";
  textSize: "standard" | "large" | "larger";
  motion: "system" | "reduce";
  sendShortcut: "enter" | "mod-enter";
};

export function interfacePreferences(value: unknown): InterfacePreferences {
  const p =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    appearance:
      p.appearance === "light" || p.appearance === "dark"
        ? p.appearance
        : "system",
    accent:
      p.accent === "iris" || p.accent === "coral" || p.accent === "mono"
        ? p.accent
        : "cyan",
    textSize:
      p.textSize === "large" || p.textSize === "larger"
        ? p.textSize
        : "standard",
    motion: p.motion === "reduce" ? "reduce" : "system",
    sendShortcut: p.sendShortcut === "mod-enter" ? "mod-enter" : "enter",
  };
}

export function shouldSubmitInput(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "shiftKey"
    | "altKey"
    | "metaKey"
    | "ctrlKey"
    | "repeat"
    | "isComposing"
    | "keyCode"
  >,
  shortcut: InterfacePreferences["sendShortcut"],
): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    (shortcut === "enter" || event.metaKey || event.ctrlKey)
  );
}

/** Parallel input is an explicit gesture, never a persistent composer mode. */
export function inputDispatchMode(
  event: Parameters<typeof shouldSubmitInput>[0],
  shortcut: InterfacePreferences["sendShortcut"],
): InputDispatchMode | null {
  if (
    event.key === "Enter" &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229
  )
    return "parallel";
  return shouldSubmitInput(event, shortcut) ? "interrupt" : null;
}
