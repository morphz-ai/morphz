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
