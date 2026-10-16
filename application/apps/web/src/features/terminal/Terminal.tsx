import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronUp,
  Copy,
  CornerDownLeft,
  MessageCircle,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Sun,
  Unplug,
} from "lucide-react";
import type { ApplicationInstance } from "../../../../../packages/core/src/applications.js";
import type {
  TerminalRecord,
  TerminalScreen,
  TerminalView,
} from "../../../../../packages/core/src/terminal.js";
import type { WorkspaceClient } from "../../client.js";
import { copyText } from "../../clipboard-text.js";
import { useObservedRead } from "../../useObservedRead.js";
import { ApplicationRequestError } from "../../../../../packages/core/src/application-api.js";
import { ComposerOptions } from "../../ComposerOptions.js";
import {
  readTerminalTheme,
  saveTerminalTheme,
  terminalColor,
  terminalThemes,
  type TerminalTheme,
} from "./terminal-appearance.js";

function readFailure(cause: unknown, fallback: string) {
  if (cause instanceof ApplicationRequestError && cause.status >= 500)
    return "终端暂不可读取，请检查 Runtime 连接后重试。";
  return cause instanceof Error ? cause.message : fallback;
}

const labels: Record<TerminalRecord["status"], string> = {
  starting: "正在连接",
  open: "会话已连接",
  exited: "进程已退出",
  closed: "会话已结束",
  lost: "终端连接已丢失",
};

export function TerminalCanvas({
  screen,
  connected,
}: {
  screen: TerminalScreen;
  connected: boolean;
}) {
  return (
    <div
      className="terminal-screen"
      tabIndex={0}
      role="region"
      aria-label="真实终端屏幕"
    >
      <div
        className="terminal-grid"
        style={{ "--terminal-cols": screen.cols } as CSSProperties}
      >
        {screen.lines.map((line, row) => (
          <div className="terminal-line" key={row}>
            {line.map((span, index) => (
              <span
                key={index}
                style={{
                  color: span.inverse
                    ? (terminalColor(span.bg, span.bg_index) ??
                      "var(--terminal-paper)")
                    : terminalColor(span.fg, span.fg_index),
                  backgroundColor: span.inverse
                    ? (terminalColor(span.fg, span.fg_index) ??
                      "var(--terminal-ink)")
                    : terminalColor(span.bg, span.bg_index),
                  fontWeight: span.bold ? 700 : undefined,
                  fontStyle: span.italic ? "italic" : undefined,
                  textDecoration: span.underline ? "underline" : undefined,
                }}
              >
                {span.text}
              </span>
            ))}
          </div>
        ))}
        {connected && screen.cursor_visible && (
          <span
            className="terminal-cursor"
            aria-hidden
            style={{
              left: `${screen.cursor[1]}ch`,
              top: `${screen.cursor[0] * 1.5}em`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A real Runtime PTY view. The shared composer remains the only Agent input;
 * opening this component never spawns a shell or sends a command. */
export function Terminal({
  client,
  instance,
  projectId,
  conversationId,
  active,
  onCompose,
  onNotice,
}: {
  client: WorkspaceClient;
  instance: ApplicationInstance;
  projectId: string;
  conversationId?: string;
  active: boolean;
  onCompose: (text: string) => { ok: boolean; error?: string };
  onNotice: (message: string) => void;
}) {
  const preferenceScope = `${client.boot?.centerId ?? "disconnected"}:${client.boot?.principalId ?? "disconnected"}`;
  const [appearance, setAppearance] = useState(() => ({
    scope: preferenceScope,
    theme: readTerminalTheme(preferenceScope),
  }));
  const theme =
    appearance.scope === preferenceScope
      ? appearance.theme
      : readTerminalTheme(preferenceScope);
  function changeTheme(theme: TerminalTheme) {
    setAppearance({ scope: preferenceScope, theme });
    try {
      saveTerminalTheme(preferenceScope, theme);
    } catch {
      onNotice("终端外观已切换，但本机偏好未能保存。");
    }
  }
  const [selection, setSelection] = useState<string | null>(
    typeof instance.state.terminalId === "string"
      ? instance.state.terminalId
      : null,
  );
  const [catalog, setCatalog] = useState<{
    scope: string;
    terminals: TerminalRecord[];
    hasMore: boolean;
  } | null>(null);
  const [observation, setObservation] = useState<{
    scope: string;
    view: TerminalView;
  } | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [screenError, setScreenError] = useState("");
  const error = screenError || catalogError;
  const [tick, setTick] = useState(0);
  const [scrollback, setScrollback] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [selecting, setSelecting] = useState(false);
  const api = useRef(client);
  api.current = client;
  const identity = JSON.stringify([
    client.boot?.centerId,
    client.boot?.principalId,
    client.boot?.csrfToken,
    instance.id,
    projectId,
    conversationId,
  ]);
  const current = useRef(identity);
  current.current = identity;
  const scope = {
    projectId,
    artifactId: null,
    ...(conversationId ? { conversationId } : {}),
  };
  const observationScope = JSON.stringify([identity, selection, scrollback]);
  const currentScreen = useRef(observationScope);
  currentScreen.current = observationScope;
  const automaticSelection = useRef("");
  const records = catalog?.scope === identity ? catalog.terminals : [];
  const view =
    observation?.scope === observationScope ? observation.view : null;
  const terminal = view?.terminal ?? records.find((t) => t.id === selection);
  const connected = !!view?.connected && client.online && !error;

  useEffect(() => {
    setSelection(
      typeof instance.state.terminalId === "string"
        ? instance.state.terminalId
        : null,
    );
    setCatalog(null);
    setObservation(null);
    setCatalogError("");
    setScreenError("");
    setScrollback(0);
    setCopyState("idle");
    automaticSelection.current = "";
  }, [identity]);
  useEffect(() => {
    if (!active || !client.online) return;
    const timer = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, client.online]);
  const refreshCatalog = useObservedRead({
    scope: identity,
    enabled: active && client.online,
    revision: Math.floor(tick / 4) + client.workspaceChangeRevision,
    invalidation: "coalesce",
    read: (signal) => api.current.terminalCatalog(scope, signal),
    publish: (page) => {
      setCatalog({
        scope: identity,
        terminals: page.terminals,
        hasMore: page.has_more,
      });
      setCatalogError("");
    },
    failed: (cause) =>
      setCatalogError(readFailure(cause, "无法读取终端会话。")),
  });
  const refreshView = useObservedRead({
    scope: observationScope,
    enabled: active && client.online && !!selection,
    revision: tick,
    invalidation: "coalesce",
    read: (signal) =>
      api.current.terminalRead(scope, selection!, scrollback, signal),
    publish: (view) => {
      setObservation({ scope: observationScope, view });
      setScreenError("");
    },
    failed: (cause) => setScreenError(readFailure(cause, "无法读取终端屏幕。")),
  });
  useEffect(() => {
    setCopyState("idle");
  }, [observationScope, view?.screen?.text]);
  useEffect(() => {
    const key = JSON.stringify([identity, records[0]?.id]);
    if (
      active &&
      !selection &&
      records.length === 1 &&
      !selecting &&
      automaticSelection.current !== key
    ) {
      automaticSelection.current = key;
      void select(records[0]!.id);
    }
  }, [active, selection, records[0]?.id, records.length, selecting, identity]);

  async function select(id: string) {
    if (selecting || selection === id) return;
    const captured = identity;
    setSelecting(true);
    try {
      await client.execute({
        type: "set-application-state",
        instanceId: instance.id,
        expectedRevision: instance.revision,
        state: { terminalId: id },
      });
      if (current.current === captured) {
        setSelection(id);
        setScrollback(0);
        setObservation(null);
        setCopyState("idle");
      }
    } catch (cause) {
      if (current.current === captured)
        onNotice(cause instanceof Error ? cause.message : "终端选择未保存。");
    } finally {
      if (current.current === captured) setSelecting(false);
    }
  }
  function compose(text: string) {
    const result = onCompose(text);
    if (!result.ok) onNotice(result.error ?? "无法准备输入，原草稿已保留。");
  }
  function ask(text: string) {
    compose(
      `${text}\n\n使用内置 Terminal 的同一会话${selection ? `（terminal_id: ${selection}）` : ""}，不要改用独立的 exec。`,
    );
  }
  async function copy() {
    if (!view?.screen) return;
    const captured = observationScope;
    try {
      await copyText(view.screen.text);
      if (currentScreen.current === captured) setCopyState("copied");
    } catch {
      if (currentScreen.current === captured) setCopyState("failed");
    }
  }
  return (
    <section
      className="terminal-app"
      data-terminal-theme={theme}
      aria-label="Terminal 认知应用"
    >
      <header className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {records.map((record) => (
            <button
              type="button"
              role="tab"
              aria-selected={selection === record.id}
              title={`${record.title}\n${record.cwd}`}
              key={record.id}
              disabled={selecting}
              onClick={() => void select(record.id)}
            >
              <span
                className={`terminal-status-dot terminal-status-${record.status}`}
              />
              <span>{record.title}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="terminal-new"
          title="让 Morphz 新建终端（准备输入，不立即执行）"
          onClick={() =>
            compose(
              "请在内置 Terminal 中新建一个终端会话，保留原有会话，不执行其他命令。种类使用系统默认 Shell。",
            )
          }
        >
          <Plus size={16} />
          <span>新终端</span>
        </button>
        <ComposerOptions
          label="终端配色"
          menuLabel="终端配色"
          below
          singleChoice
          triggerClassName="icon-button terminal-theme"
          triggerIcon={<Palette size={15} />}
          options={terminalThemes.map((option) => ({
            label: option.label,
            icon:
              option.value === "auto" ? (
                <Monitor size={15} />
              ) : option.value === "dark" ? (
                <Moon size={15} />
              ) : (
                <Sun size={15} />
              ),
            pressed: theme === option.value,
            onSelect: () => changeTheme(option.value),
          }))}
        />
        <button
          type="button"
          className="icon-button terminal-refresh"
          aria-label="刷新终端"
          onClick={() => {
            void refreshCatalog();
            void refreshView();
          }}
        >
          <RefreshCw size={15} />
        </button>
      </header>
      {error && (
        <div className="terminal-notice" role="status">
          <Unplug size={15} />
          <span>{error}　现有会话不会被重新执行。</span>
        </div>
      )}
      {!client.online && (
        <div className="terminal-notice" role="status">
          Runtime 未连接；保留最后屏幕，不重放命令。
        </div>
      )}
      {terminal ? (
        <>
          <div className="terminal-location">
            <span title={`起始目录：${terminal.cwd}`}>
              起始于 {terminal.cwd}
            </span>
            <span className="terminal-state">
              <span
                className={`terminal-status-dot terminal-status-${connected ? "open" : terminal.status === "open" ? "starting" : terminal.status}`}
              />
              {terminal.status === "open" && !connected
                ? "正在核对连接"
                : labels[terminal.status]}
              {terminal.exit_code !== null
                ? ` · 退出码 ${terminal.exit_code}`
                : ""}
            </span>
          </div>
          {view?.checkpoint && (
            <div className="terminal-notice">
              这是最后保存的屏幕，不代表进程仍在运行；旧命令不会自动重发。
            </div>
          )}
          {terminal.last_input_status === "uncertain" && (
            <div className="terminal-notice" role="status">
              上次输入的提交回执待核对；仍可读取输出，但不会重发或继续排队输入。请让
              Morphz 核对后关闭此会话，再新建终端。
            </div>
          )}
          {view?.screen ? (
            <TerminalCanvas screen={view.screen} connected={connected} />
          ) : (
            <div className="terminal-loading" role="status">
              {error ? "屏幕暂不可用" : "正在读取终端屏幕…"}
            </div>
          )}
          <footer className="terminal-footer">
            <div className="terminal-output-controls">
              <button
                type="button"
                disabled={!view?.screen?.previous_available}
                onClick={() =>
                  setScrollback(
                    Math.min(500, scrollback + (view?.screen?.rows ?? 24)),
                  )
                }
              >
                <ChevronUp size={14} />
                <span>此前输出</span>
              </button>
              {scrollback > 0 && (
                <button type="button" onClick={() => setScrollback(0)}>
                  <CornerDownLeft size={14} />
                  <span>最新屏幕</span>
                </button>
              )}
              <button
                type="button"
                className="terminal-copy"
                onClick={() => void copy()}
                disabled={!view?.screen}
                aria-label={
                  copyState === "copied"
                    ? "已复制终端文本"
                    : copyState === "failed"
                      ? "复制失败，点击重试"
                      : "复制当前屏幕文本"
                }
              >
                {copyState === "copied" ? (
                  <Check size={14} />
                ) : (
                  <Copy size={14} />
                )}
                <span>
                  {copyState === "copied"
                    ? "已复制"
                    : copyState === "failed"
                      ? "重试复制"
                      : "复制文本"}
                </span>
              </button>
            </div>
            <span
              className="terminal-boundary"
              title={`${terminal.target_id} · 网络${terminal.network_enabled ? "允许" : "受限"}`}
            >
              <ShieldCheck size={13} />
              {terminal.sandbox_status === "enforced"
                ? "工作区权限"
                : "完全访问"}
              <span>
                {" "}
                · {terminal.cols}×{terminal.rows}
              </span>
            </span>
            <button
              type="button"
              className="terminal-ask"
              onClick={() => ask("请在当前终端继续操作。具体要求：")}
            >
              <MessageCircle size={14} />
              <span>让 Morphz 操作</span>
            </button>
          </footer>
        </>
      ) : (
        <div className="terminal-empty">
          <SquareTerminal size={28} strokeWidth={1.5} />
          <h2>
            {records.length ? "选择一个终端会话" : "让 Morphz 在这里执行命令"}
          </h2>
          <p>真实输入与输出就在这里。目录和环境会保留在同一终端会话中。</p>
          {!records.length && (
            <button
              type="button"
              onClick={() =>
                compose(
                  "请在内置 Terminal 中新建一个终端会话，并显示当前工作目录。不要使用独立的 exec。",
                )
              }
            >
              新建终端并查看工作目录
            </button>
          )}
          <small>打开应用不会执行命令。终端输出仅在需要时由 Agent 读取。</small>
        </div>
      )}
      {catalog?.scope === identity && catalog.hasMore && (
        <div className="terminal-notice">
          当前显示最近 50 个获授权会话；更多历史尚未加载。
        </div>
      )}
    </section>
  );
}
