import { readLocal, writeLocal } from "../../local-preferences.js";

export type TerminalTheme = "auto" | "light" | "dark";
export const terminalThemes: { value: TerminalTheme; label: string }[] = [
  { value: "auto", label: "跟随应用" },
  { value: "dark", label: "深色终端" },
  { value: "light", label: "浅色终端" },
];

export function readTerminalTheme(scope: string): TerminalTheme {
  const value = readLocal<unknown>("terminal-theme", "auto", scope);
  return terminalThemes.some((theme) => theme.value === value)
    ? (value as TerminalTheme)
    : "auto";
}

export function saveTerminalTheme(scope: string, theme: TerminalTheme) {
  writeLocal("terminal-theme", theme, scope);
}

/** Only the standard ANSI palette is themed. Truecolor and the 256-color
 * cube retain their exact values, even when they match a palette color. */
export function terminalColor(
  color?: string,
  index?: number,
): string | undefined {
  return index !== undefined &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < 16
    ? `var(--terminal-ansi-${index})`
    : color;
}
