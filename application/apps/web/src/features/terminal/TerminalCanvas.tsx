import { useEffect, useRef, useState } from "react";
import type { Terminal as Emulator, ITheme } from "@xterm/xterm";
import type { TerminalScreen } from "../../../../../packages/core/src/terminal.js";
import { terminalScreenFrame } from "./terminal-screen.js";
import { terminalColor } from "./terminal-appearance.js";

function theme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  // Resolve light-dark() through actual computed colors, not raw custom values.
  const probe = document.createElement("span");
  element.append(probe);
  const value = (name: string) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  const colors = Array.from({ length: 16 }, (_, i) =>
    value(`--terminal-ansi-${i}`),
  );
  const result: ITheme = {
    foreground: style.color,
    background: style.backgroundColor,
    cursor: value("--terminal-accent"),
    cursorAccent: style.backgroundColor,
    selectionBackground: value("--terminal-selection"),
    black: colors[0],
    red: colors[1],
    green: colors[2],
    yellow: colors[3],
    blue: colors[4],
    magenta: colors[5],
    cyan: colors[6],
    white: colors[7],
    brightBlack: colors[8],
    brightRed: colors[9],
    brightGreen: colors[10],
    brightYellow: colors[11],
    brightBlue: colors[12],
    brightMagenta: colors[13],
    brightCyan: colors[14],
    brightWhite: colors[15],
  };
  probe.remove();
  return result;
}

/** xterm owns keyboard, IME, selection and glyph rendering, not process state.
 * Only Runtime-parsed cells enter its output parser; no untrusted OSC handlers. */
export function TerminalCanvas({
  screen,
  connected,
  canInput = false,
  onData,
  onResize,
  onFocusChange,
}: {
  screen: TerminalScreen;
  connected: boolean;
  canInput?: boolean;
  onData?: (data: string) => void;
  onResize?: (rows: number, cols: number) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    term = useRef<Emulator | null>(null);
  const latest = useRef({
    screen,
    connected,
    canInput,
    onData,
    onResize,
    onFocusChange,
  });
  latest.current = {
    screen,
    connected,
    canInput,
    onData,
    onResize,
    onFocusChange,
  };
  const [ready, setReady] = useState(false);
  const write = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false,
      renderer: Emulator | undefined,
      resize: ResizeObserver | undefined,
      appearance: MutationObserver | undefined,
      cleanup = () => {},
      writing = false,
      pending = false,
      lastFrame = "";
    const draw = () => {
      if (!renderer || disposed || !host.current) return;
      if (writing) {
        pending = true;
        return;
      }
      const state = latest.current;
      renderer.options.disableStdin = !state.canInput;
      renderer.options.cursorBlink =
        !matchMedia("(prefers-reduced-motion: reduce)").matches &&
        document.documentElement.dataset.appMotion !== "reduce";
      host.current!.dataset.cursorMotion = renderer.options.cursorBlink
        ? "blink"
        : "static";
      renderer.options.theme = theme(host.current!);
      const key = JSON.stringify([
        state.screen.sequence,
        state.screen.scrollback,
        state.screen.rows,
        state.screen.cols,
        state.screen.application_cursor,
        state.screen.bracketed_paste,
        state.connected,
      ]);
      if (key === lastFrame) return;
      lastFrame = key;
      if (
        renderer.rows !== state.screen.rows ||
        renderer.cols !== state.screen.cols
      )
        renderer.resize(state.screen.cols, state.screen.rows);
      writing = true;
      renderer.write(
        terminalScreenFrame({
          ...state.screen,
          cursor_visible: state.connected && state.screen.cursor_visible,
        }),
        () => {
          writing = false;
          if (pending) {
            pending = false;
            draw();
          }
        },
      );
    };
    write.current = draw;
    void import("@xterm/xterm").then(({ Terminal }) => {
      const element = host.current,
        container = mount.current;
      if (disposed || !element || !container) return;
      renderer = new Terminal({
        cols: latest.current.screen.cols,
        rows: latest.current.screen.rows,
        scrollback: 0,
        fontSize: 14,
        lineHeight: 1.25,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
        cursorStyle: "block",
        cursorInactiveStyle: "outline",
        disableStdin: !latest.current.canInput,
        theme: theme(element),
        allowProposedApi: false,
        allowTransparency: false,
        convertEol: false,
        screenReaderMode: false,
        minimumContrastRatio: 1,
      });
      term.current = renderer;
      renderer.open(container);
      renderer.textarea?.setAttribute("aria-label", "终端输入");
      const data = renderer.onData((data) => {
        if (latest.current.canInput) latest.current.onData?.(data);
      });
      const measure = () => {
        if (
          !renderer ||
          !latest.current.canInput ||
          !mount.current?.contains(document.activeElement)
        )
          return;
        const box = renderer.element
          ?.querySelector(".xterm-screen")
          ?.getBoundingClientRect();
        if (!box?.width || !box.height) return;
        const parent = mount.current.getBoundingClientRect();
        const cols = Math.max(
          20,
          Math.min(160, Math.floor(parent.width / (box.width / renderer.cols))),
        );
        const rows = Math.max(
          4,
          Math.min(
            60,
            Math.floor(parent.height / (box.height / renderer.rows)),
          ),
        );
        if (
          rows !== latest.current.screen.rows ||
          cols !== latest.current.screen.cols
        )
          latest.current.onResize?.(rows, cols);
      };
      const focused = () => {
        latest.current.onFocusChange?.(true);
        measure();
      };
      const blurred = () => latest.current.onFocusChange?.(false);
      container.addEventListener("focusin", focused);
      container.addEventListener("focusout", blurred);
      resize = new ResizeObserver(measure);
      resize.observe(container);
      appearance = new MutationObserver(draw);
      appearance.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [
          "data-app-motion",
          "data-appearance",
          "class",
          "style",
        ],
      });
      const app = element.closest(".app");
      if (app)
        appearance.observe(app, {
          attributes: true,
          attributeFilter: ["data-appearance"],
        });
      const terminal = element.closest(".terminal-app");
      if (terminal)
        appearance.observe(terminal, {
          attributes: true,
          attributeFilter: ["data-terminal-theme"],
        });
      const motion = matchMedia("(prefers-reduced-motion: reduce)");
      motion.addEventListener("change", draw);
      cleanup = () => {
        data.dispose();
        motion.removeEventListener("change", draw);
        container.removeEventListener("focusin", focused);
        container.removeEventListener("focusout", blurred);
      };
      draw();
      setReady(true);
    });
    return () => {
      disposed = true;
      cleanup();
      resize?.disconnect();
      appearance?.disconnect();
      renderer?.dispose();
      term.current = null;
    };
  }, []);
  useEffect(() => write.current(), [screen, connected, canInput]);
  return (
    <div
      ref={host}
      className="terminal-screen"
      role="region"
      aria-label="真实终端屏幕"
      data-input={canInput ? "enabled" : "readonly"}
      onPointerDown={(event) => {
        if (canInput && event.button === 0) term.current?.focus();
      }}
    >
      <div
        ref={mount}
        className="terminal-emulator"
        data-ready={ready || undefined}
      />
      {!ready && (
        <div className="terminal-fallback">
          {screen.lines.map((line, row) => (
            <div className="terminal-line" key={row}>
              {line.map((span, i) => (
                <span
                  key={i}
                  style={{
                    color: terminalColor(span.fg, span.fg_index),
                    background: terminalColor(span.bg, span.bg_index),
                  }}
                >
                  {span.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
