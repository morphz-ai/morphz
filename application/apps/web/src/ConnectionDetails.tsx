import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Settings2 } from "lucide-react";
import { ModelSettings } from "./ModelSettings.js";
import type { WorkspaceClient } from "./client.js";
import { RequestError } from "./client.js";
import { useModal } from "./useModal.js";
import type { ConnectionDetails as Details } from "../../../packages/core/src/connection.js";
export function ConnectionDetails({
  client,
  onClose,
}: {
  client: WorkspaceClient;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModal(dialog, closeButton);
  const [modelBusy, setModelBusy] = useState(false);
  const [models, setModels] = useState(false);
  return (
    <dialog
      ref={dialog}
      className="create-dialog connection-dialog"
      aria-label={models ? "模型设置" : "连接详情"}
      onCancel={(event) => {
        if (modelBusy) event.preventDefault();
        else onClose();
      }}
    >
      {models ? (
        <ModelSettings
          onChanged={() => void client.refresh()}
          onBusy={setModelBusy}
          exitLocked={modelBusy}
          closeButton={closeButton}
          onClose={onClose}
          onBack={() => {
            setModels(false);
            requestAnimationFrame(() => closeButton.current?.focus());
          }}
        />
      ) : (
        <ConnectionSettings
          client={client}
          onClose={onClose}
          closeButton={closeButton}
          onModels={() => setModels(true)}
          onBusy={setModelBusy}
        />
      )}
    </dialog>
  );
}

/** The same connection controls are used by Settings and contextual recovery. */
export function ConnectionSettings({
  client,
  onClose,
  closeButton,
  onModels,
  onBusy,
  embedded = false,
}: {
  client: WorkspaceClient;
  onClose: () => void;
  closeButton: React.RefObject<HTMLButtonElement | null>;
  onModels: () => void;
  onBusy: (busy: boolean) => void;
  embedded?: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);
  const runtime = client.boot!.runtime;
  const latest = useRef(client);
  latest.current = client;
  const request = useRef<AbortController | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const credentialInput = useRef<HTMLInputElement>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<"setup" | "check" | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    onBusy(busy && editing);
  }, [busy, editing, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  useEffect(() => {
    if (editing) (endpoint ? credentialInput : addressInput).current?.focus();
  }, [editing]);
  useEffect(() => {
    if (editing || busy) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    // Restore focus lost to a removed/disabled control, never newer user focus.
    if (
      target &&
      (document.activeElement === document.body ||
        document.activeElement === body.current?.closest("dialog"))
    )
      (target === "setup" ? setupButton : checkButton).current?.focus();
  }, [editing, busy]);
  const finishEditing = () => {
    returnFocus.current = "setup";
    setEditing(false);
    setToken("");
  };
  async function check() {
    if (request.current) return;
    const pending = new AbortController();
    request.current = pending;
    if (document.activeElement === checkButton.current)
      returnFocus.current = "check";
    setBusy(true);
    setError("");
    try {
      await latest.current.refresh();
      if (pending.signal.aborted) return;
      const value = await latest.current.checkConnection(pending.signal);
      if (!pending.signal.aborted) setDetails(value);
    } catch (e) {
      if (!pending.signal.aborted) {
        setDetails(null);
        setError(
          e instanceof RequestError && e.status === 404
            ? "当前版本尚不支持连接检查，请更新应用后重试。"
            : "未能完成连接检查，请稍后重试；草稿仍保留在本机。",
        );
      }
    } finally {
      if (request.current === pending) {
        request.current = null;
        if (!pending.signal.aborted) setBusy(false);
      }
    }
  }
  useEffect(() => {
    void check();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, []);
  async function save() {
    if (!details?.version || request.current) return;
    const pending = new AbortController();
    request.current = pending;
    setBusy(true);
    setError("");
    try {
      const saved = await latest.current.configureConnection(
        { endpoint, token, expectedVersion: details.version },
        pending.signal,
      );
      if (pending.signal.aborted) return;
      setDetails(saved);
      finishEditing();
      await latest.current.refresh();
    } catch (e) {
      if (!pending.signal.aborted)
        setError(e instanceof Error ? e.message : "连接未保存，请重试。");
    } finally {
      if (request.current === pending) {
        request.current = null;
        if (!pending.signal.aborted) setBusy(false);
      }
    }
  }
  const serviceLabel = details
    ? {
        "not-configured": "尚未连接",
        connected: "已连接",
        unreachable: "无法连接",
        "authentication-required": "需要更新凭据",
        error: "连接异常",
      }[details.state]
    : busy
      ? "检查中…"
      : "待确认";
  const modelLabel =
    details?.modelState === "configured"
      ? details.model
      : details?.modelState === "not-configured"
        ? "尚未配置"
        : "待确认";
  const startEditing = () => {
    setEndpoint(details?.endpoint ?? "");
    setError("");
    setEditing(true);
  };
  const setupLabel =
    details?.state === "not-configured"
      ? "连接智能体"
      : details?.state === "authentication-required"
        ? "更新连接凭据"
        : "连接设置";
  return (
    <div ref={body} className="connection-settings">
      <header>
        <h2>{embedded ? "智能体连接" : "连接详情"}</h2>
        <div className="dialog-actions">
          <button
            ref={checkButton}
            className="secondary-action"
            disabled={busy}
            onClick={() => void check()}
          >
            <RefreshCw size={14} />
            {busy ? "检查中…" : !client.online ? "重新连接" : "检查连接"}
          </button>
          {!embedded && (
            <button
              ref={closeButton}
              className="icon-button"
              aria-label="关闭连接详情"
              disabled={busy && editing}
              onClick={onClose}
            >
              <X />
            </button>
          )}
        </div>
      </header>
      <dl className="connection-facts">
        <dt>应用数据</dt>
        <dd>{client.online ? "可访问" : "暂不可访问"}</dd>
        <dt>智能体</dt>
        <dd>{client.online ? serviceLabel : "待确认"}</dd>
        <dt>当前模型</dt>
        <dd>{client.online ? modelLabel : "待确认"}</dd>
      </dl>
      {!client.online ? (
        <p role="status">暂时无法读取应用数据，草稿已保留。请重新连接。</p>
      ) : (
        details?.message && <p role="status">{details.message}</p>
      )}
      {client.online &&
        details &&
        !details.configurable &&
        (details.state !== "connected" ||
          ["not-configured", "unavailable"].includes(details.modelState)) && (
          <p className="muted">
            请联系此工作空间的管理员检查连接和模型配置，然后重新检查。
          </p>
        )}
      {error && <p role="alert">{error}</p>}
      {editing ? (
        <form
          className="connection-setup"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            运行服务地址
            <input
              ref={addressInput}
              type="url"
              value={endpoint}
              readOnly={!!details?.endpoint}
              required
              placeholder="http://127.0.0.1:18089"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          <label>
            连接凭据
            <input
              ref={credentialInput}
              type="password"
              value={token}
              required
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <small className="muted">
            使用本机运行服务提供的连接凭据，不是模型 API Key。
          </small>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-action"
              disabled={busy}
              onClick={() => {
                finishEditing();
                setError("");
              }}
            >
              取消设置
            </button>
            <button
              className="primary"
              disabled={
                busy || !client.online || !endpoint.trim() || !token.trim()
              }
            >
              {busy ? "验证中…" : "验证并连接"}
            </button>
          </div>
        </form>
      ) : (
        <div className="connection-actions">
          {client.online && details?.configurable && (
            <button
              ref={setupButton}
              className="secondary-action"
              disabled={busy}
              onClick={startEditing}
            >
              <Settings2 size={14} />
              {setupLabel}
            </button>
          )}
          {client.online &&
            details?.state === "connected" &&
            details.modelSettingsAvailable && (
              <button
                className="secondary-action"
                disabled={busy}
                title="管理账号和默认模型"
                onClick={onModels}
              >
                <Settings2 size={14} />
                设置模型
              </button>
            )}
        </div>
      )}
      {(client.error || runtime.error) && (
        <details className="connection-error-detail">
          <summary>错误详情</summary>
          <p>{client.error || runtime.error}</p>
        </details>
      )}
      {details?.checkedAt && !busy && (
        <small className="muted connection-checked">
          上次检查{" "}
          {new Date(details.checkedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </small>
      )}
    </div>
  );
}
