import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronUp,
  Copy,
  CornerDownLeft,
  Plus,
  RefreshCw,
  ShieldAlert,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import type { ApplicationInstance } from "../../../../../packages/core/src/applications.js";
import type {
  TerminalRecord,
  TerminalView,
} from "../../../../../packages/core/src/terminal.js";
import type { WorkspaceClient } from "../../client.js";
import { copyText } from "../../clipboard-text.js";
import { useObservedRead } from "../../useObservedRead.js";
import { ApplicationRequestError } from "../../../../../packages/core/src/application-api.js";
import { TerminalCanvas } from "./TerminalCanvas.js";
export { TerminalCanvas } from "./TerminalCanvas.js";
import { TerminalInput } from "./terminal-input.js";
import type { TerminalContext } from "./terminal-context.js";
import {
  terminalConnectionNotice,
  terminalSessionDescription,
} from "./terminal-presentation.js";

function readFailure(cause: unknown, fallback: string) {
  if (cause instanceof ApplicationRequestError && cause.status >= 500)
    return "终端暂不可读取，请检查 Runtime 连接后重试。";
  return cause instanceof Error ? cause.message : fallback;
}

/** A real Runtime PTY view. The shared composer remains the only Agent input;
 * opening this component never spawns a shell or sends a command. */
export function Terminal({
  client,
  instance,
  projectId,
  conversationId,
  active,
  onNotice,
  onContext,
}: {
  client: WorkspaceClient;
  instance: ApplicationInstance;
  projectId: string;
  conversationId?: string;
  active: boolean;
  onNotice: (message: string) => void;
  onContext?: (context: TerminalContext) => void;
}) {
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
  const [opening, setOpening] = useState(false);
  const [createError, setCreateError] = useState("");
  const creating = useRef(false);
  const pendingCreate = useRef<{
    identity: string;
    commandId: string;
    terminal?: TerminalRecord;
  } | null>(null);
  const [inputError, setInputError] = useState("");
  const [pendingCopy, setPendingCopy] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const keyboard = useRef<TerminalInput | null>(null);
  const api = useRef(client);
  api.current = client;
  const contextListener = useRef(onContext);
  contextListener.current = onContext;
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
  useEffect(() => {
    if (active && terminal && terminal.id === selection)
      contextListener.current?.({
        instanceId: instance.id,
        projectId,
        conversationId,
        terminalId: terminal.id,
        title: terminal.title,
      });
  }, [active, identity, selection, terminal?.id, terminal?.title]);
  const connected = !!view?.connected && client.online && !error;
  const connectionNotice = terminalConnectionNotice(
    client.online,
    error,
    terminal,
    view,
  );
  const inputFailure =
    inputError ||
    (terminal?.last_input_status === "uncertain"
      ? "上次输入的提交结果待核对，已暂停后续输入；不会自动重发。"
      : "");
  const canInput =
    active &&
    connected &&
    !!view?.input_supported &&
    !inputError &&
    scrollback === 0 &&
    terminal?.last_input_status !== "uncertain";
  const liveInputScope = useRef({ identity, selection });
  liveInputScope.current = { identity, selection };
  useEffect(() => {
    setInputError("");
    setPendingCopy("idle");
    if (!selection || !view?.input_supported || !terminal) return;
    const captured = identity;
    const controller = new TerminalInput(
      terminal.revision,
      (command) => {
        if (
          liveInputScope.current.identity !== captured ||
          liveInputScope.current.selection !== selection ||
          !api.current.online
        )
          throw Error("terminal input scope changed");
        return api.current.terminalCommand(scope, selection, command);
      },
      () => {
        setScrollback(0);
        setTick((n) => n + 1);
      },
      setInputError,
    );
    controller.setEnabled(active);
    keyboard.current = controller;
    return () => {
      controller.dispose();
      if (keyboard.current === controller) keyboard.current = null;
    };
  }, [identity, selection, view?.input_supported]);
  useEffect(() => {
    keyboard.current?.setEnabled(active && connected);
  }, [active, connected]);
  useEffect(() => {
    if (terminal)
      keyboard.current?.observe(
        terminal.revision,
        terminal.rows,
        terminal.cols,
      );
  }, [terminal?.revision, terminal?.rows, terminal?.cols]);

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
    setOpening(false);
    setCreateError("");
    pendingCreate.current = null;
    creating.current = false;
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
    if (selection === id) return true;
    if (selecting) return false;
    if (keyboard.current?.pending()) {
      onNotice("当前仍有未确认输入，请先核对并复制；切换不会重发这些文字。");
      return false;
    }
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
        return true;
      }
    } catch (cause) {
      if (current.current === captured)
        onNotice(cause instanceof Error ? cause.message : "终端选择未保存。");
    } finally {
      if (current.current === captured) setSelecting(false);
    }
    return false;
  }
  async function openTerminal() {
    if (creating.current || selecting || !active || !client.online) return;
    if (keyboard.current?.pending()) {
      onNotice("当前仍有未确认输入，请先核对并复制，再新建终端。");
      return;
    }
    const captured = identity;
    const pending =
      pendingCreate.current?.identity === identity
        ? pendingCreate.current
        : { identity, commandId: crypto.randomUUID() };
    pendingCreate.current = pending;
    creating.current = true;
    setOpening(true);
    setCreateError("");
    try {
      // A lost receipt is reconciled using the same command identity. Neither
      // a refresh nor a render retries creation or prepares an Agent message.
      const record =
        pending.terminal ??
        (await api.current.terminalOpen(scope, pending.commandId)).terminal;
      pending.terminal = record;
      if (current.current !== captured) return;
      setCatalog((page) => ({
        scope: identity,
        terminals: [
          record,
          ...(page?.scope === identity ? page.terminals : []).filter(
            (item) => item.id !== record.id,
          ),
        ].slice(0, 50),
        hasMore: page?.scope === identity ? page.hasMore : false,
      }));
      if (!(await select(record.id)))
        throw Error("终端已创建，选择未保存；点击核对新建，不会重复创建。");
      if (current.current !== captured) return;
      pendingCreate.current = null;
      void refreshCatalog();
    } catch (cause) {
      if (current.current === captured)
        setCreateError(
          cause instanceof ApplicationRequestError && cause.status >= 500
            ? "新建回执暂未确认，请点击加号核对。"
            : cause instanceof Error
              ? cause.message
              : "新建回执尚未确认；再次点击仅核对同一次新建。",
        );
    } finally {
      if (current.current === captured) {
        creating.current = false;
        setOpening(false);
      }
    }
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
    <section className="terminal-app" aria-label="Terminal 认知应用">
      <header className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {records.map((stored) => {
            const record =
              stored.id === selection && view ? view.terminal : stored;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={selection === record.id}
                title={terminalSessionDescription(
                  record,
                  client.online && !error,
                )}
                aria-description={terminalSessionDescription(
                  record,
                  client.online && !error,
                )}
                key={record.id}
                disabled={selecting || opening}
                onClick={() => void select(record.id)}
              >
                <span
                  className={`terminal-status-dot terminal-status-${client.online && !error ? record.status : "unknown"}`}
                />
                <span>{record.title}</span>
              </button>
            );
          })}
        </div>
        {terminal?.sandbox_status === "disabled" && (
          <span
            className="terminal-access"
            role="img"
            tabIndex={0}
            aria-label="当前终端为完全访问，无工作区沙盒限制"
            title="当前终端为完全访问，无工作区沙盒限制。权限详情见会话标签。"
          >
            <ShieldAlert size={14} aria-hidden="true" />
          </span>
        )}
        {view?.screen?.previous_available && (
          <button
            type="button"
            className="icon-button"
            aria-label="此前输出"
            title="此前输出"
            onClick={() =>
              setScrollback(
                Math.min(500, scrollback + (view?.screen?.rows ?? 24)),
              )
            }
          >
            <ChevronUp size={15} />
          </button>
        )}
        {scrollback > 0 && (
          <button
            type="button"
            className="icon-button terminal-latest"
            aria-label="最新屏幕"
            title="返回最新屏幕，恢复键盘输入"
            onClick={() => setScrollback(0)}
          >
            <CornerDownLeft size={15} />
          </button>
        )}
        {view?.screen && (
          <button
            type="button"
            className="icon-button terminal-copy"
            onClick={() => void copy()}
            aria-label={
              copyState === "copied"
                ? "已复制终端文本"
                : copyState === "failed"
                  ? "复制失败，点击重试"
                  : "复制当前屏幕文本"
            }
            title={
              copyState === "copied"
                ? "已复制"
                : copyState === "failed"
                  ? "复制失败，点击重试"
                  : "复制当前屏幕文本"
            }
          >
            {copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
        <button
          type="button"
          className="icon-button terminal-new"
          aria-label={
            opening ? "正在新建终端" : createError ? "核对新建终端" : "新终端"
          }
          title={
            opening
              ? "正在新建终端…"
              : createError
                ? "核对上一次新建，不重复创建"
                : "新终端"
          }
          aria-busy={opening}
          disabled={opening || selecting || !client.online}
          onClick={() => void openTerminal()}
        >
          <Plus size={16} />
        </button>
        {(error || !client.online || view?.checkpoint) && (
          <button
            type="button"
            className="icon-button terminal-refresh"
            aria-label="刷新终端"
            title="重新核对终端，不执行命令"
            onClick={() => {
              void refreshCatalog();
              void refreshView();
            }}
          >
            <RefreshCw size={15} />
          </button>
        )}
      </header>
      {createError && (
        <div className="terminal-notice" role="status">
          {createError}　未发送 Agent 消息；核对使用原新建编号，不会重放命令。
        </div>
      )}
      {connectionNotice && (
        <div className="terminal-notice" role="status">
          <Unplug size={15} />
          <span>{connectionNotice}</span>
        </div>
      )}
      {inputFailure && (
        <div className="terminal-notice terminal-input-error" role="status">
          <span>{inputFailure}</span>
          {keyboard.current?.pending() && (
            <button
              type="button"
              onClick={() => {
                void copyText(keyboard.current?.pending() ?? "").then(
                  () => setPendingCopy("copied"),
                  () => setPendingCopy("failed"),
                );
              }}
            >
              {pendingCopy === "copied"
                ? "已复制"
                : pendingCopy === "failed"
                  ? "复制失败，重试"
                  : "复制未确认输入"}
            </button>
          )}
        </div>
      )}
      {terminal ? (
        <>
          {view?.screen ? (
            <TerminalCanvas
              screen={view.screen}
              connected={connected}
              canInput={canInput}
              onData={(data) => keyboard.current?.input(data)}
              onResize={(rows, cols) => keyboard.current?.resize(rows, cols)}
            />
          ) : (
            <div
              className="terminal-loading"
              role={connectionNotice ? undefined : "status"}
            >
              {connectionNotice ? null : "正在读取终端屏幕…"}
            </div>
          )}
        </>
      ) : (
        <div className="terminal-empty">
          <SquareTerminal size={28} strokeWidth={1.5} />
          <p>{records.length ? "选择终端" : "点击右上角 ＋ 新建终端"}</p>
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
