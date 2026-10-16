import type { TerminalScreen } from "../../../../../packages/core/src/terminal.js";

/** Render only trusted cursor/SGR sequences around Runtime-parsed text cells.
 * Untrusted PTY OSC/DCS (clipboard, links, downloads) never reach the renderer. */
export function terminalScreenFrame(screen: TerminalScreen) {
  const color = (
    hex: string | undefined,
    index: number | undefined,
    bg = false,
  ) =>
    index !== undefined
      ? `\x1b[${bg ? 48 : 38};5;${index}m`
      : hex
        ? `\x1b[${bg ? 48 : 38};2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`
        : "";
  let frame = "\x1b[?25l\x1b[0m\x1b[H\x1b[2J";
  for (let row = 0; row < screen.lines.length; row++) {
    frame += `\x1b[${row + 1};1H`;
    for (const span of screen.lines[row]!)
      frame +=
        "\x1b[0m" +
        color(span.fg, span.fg_index) +
        color(span.bg, span.bg_index, true) +
        (span.bold ? "\x1b[1m" : "") +
        (span.italic ? "\x1b[3m" : "") +
        (span.underline ? "\x1b[4m" : "") +
        (span.inverse ? "\x1b[7m" : "") +
        span.text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  }
  return (
    frame +
    `\x1b[0m\x1b[${screen.cursor[0] + 1};${screen.cursor[1] + 1}H\x1b[?1${screen.application_cursor ? "h" : "l"}\x1b[?2004${screen.bracketed_paste ? "h" : "l"}\x1b[?25${screen.cursor_visible && !screen.scrollback ? "h" : "l"}`
  );
}
