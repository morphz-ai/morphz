import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Plus,
  RefreshCw,
  Pencil,
  X,
} from "lucide-react";
import { ApiConnectionEditor } from "./ApiConnectionEditor.js";
import { applicationCall } from "./application-transport.js";
import { modelLabel } from "../../../packages/core/src/inference.js";
import {
  modelSettingsSchema,
  modelSettingsResultSchema,
  type ModelSettingsAction,
  type ModelSettingsSnapshot,
  type ModelLogin,
  type ApiConnectionSettings,
} from "../../../packages/core/src/model-settings.js";

export function ModelSettings({
  onChanged,
  onBusy,
  onBack,
  onClose,
  closeButton,
  exitLocked,
  embedded = false,
}: {
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
  onBack?: () => void;
  onClose: () => void;
  closeButton: RefObject<HTMLButtonElement | null>;
  exitLocked: boolean;
  embedded?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [view, setView] = useState<"main" | "add" | "models" | "connection">(
    "main",
  );
  const [connection, setConnection] = useState<ApiConnectionSettings | null>(
    null,
  );
  const [connectionRead, setConnectionRead] = useState(0);
  const [mode, setMode] = useState<"oauth" | "api">("oauth");
  const [busy, setBusy] = useState(false);
  const [connectingService, setConnectingService] = useState<string | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [login, setLogin] = useState<ModelLogin | null>(null);
  const [polling, setPolling] = useState(true);
  const [callback, setCallback] = useState("");
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [api, setApi] = useState({
    requestId: crypto.randomUUID(),
    label: "",
    protocol: "openai-responses" as
      | "openai-responses"
      | "openai-chat"
      | "anthropic-messages"
      | "gemini-content",
    baseUrl: "",
    apiKey: "",
    model: "",
  });
  const pending = useRef<AbortController | null>(null);
  const activeLogin = useRef<ModelLogin | null>(null);
  const callbacks = useRef({ onChanged, onBusy });
  callbacks.current = { onChanged, onBusy };
  const body = useRef<HTMLDivElement>(null);
  activeLogin.current = login;
  const account = snapshot?.accounts.find((a) => a.id === accountId);
  function changed() {
    window.dispatchEvent(new Event("morphz:models-changed"));
    callbacks.current.onChanged();
  }
  async function load(signal: AbortSignal) {
    const next = modelSettingsSchema.parse(
      await applicationCall("model-settings.read", undefined, { signal }),
    );
    if (!signal.aborted) {
      setSnapshot(next);
      setModel(next.catalog.current);
    }
    return next;
  }
  async function run<T>(
    action: (signal: AbortSignal) => Promise<T>,
    clearNotice = true,
    lockExit = true,
  ) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    callbacks.current.onBusy(lockExit);
    setError("");
    if (clearNotice) setNotice("");
    try {
      return await action(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "操作未完成，请重试。");
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        callbacks.current.onBusy(false);
      }
    }
  }
  const update = async (action: ModelSettingsAction, signal: AbortSignal) =>
    modelSettingsResultSchema.parse(
      await applicationCall("model-settings.update", action, { signal }),
    );
  useEffect(() => {
    void run(load, true, false);
    return () => {
      pending.current?.abort();
      pending.current = null;
      // Closing the dialog cancels only this unfinished login, never a saved account.
      const current = activeLogin.current;
      if (current)
        void applicationCall(
          "model-settings.update",
          { action: "oauth-cancel", loginId: current.loginId },
          { signal: AbortSignal.timeout(5000) },
        ).catch(() => {});
      callbacks.current.onBusy(false);
    };
  }, []);
  useEffect(() => {
    body.current?.focus({ preventScroll: true });
  }, [view, !!login]);
  function editAccount(next: ModelSettingsSnapshot, id: string) {
    const found = next.accounts.find((a) => a.id === id);
    setAccountId(id);
    setSelected(found?.models.filter((m) => m.enabled).map((m) => m.id) ?? []);
    setView("models");
  }
  async function openAuthorization(current: ModelLogin) {
    try {
      if (window.morphzDesktop?.openExternal)
        await window.morphzDesktop.openExternal(current.url);
      else window.open(current.url, "_blank", "noopener,noreferrer");
    } catch {
      setError("浏览器未能打开，请点击「前往授权」重试。");
    }
  }
  async function finishLogin(id: string, signal: AbortSignal) {
    activeLogin.current = null;
    setLogin(null);
    setCallback("");
    setNotice("账号已连接，请选择要使用的模型。");
    changed();
    const next = await load(signal);
    editAccount(next, id);
    // Runtime's catalog refresh also probes a model. Keep that explicit;
    // completing a login must not silently spend inference quota.
  }
  useEffect(() => {
    if (!login || !polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (stopped) return;
      if (Date.now() >= Date.parse(login!.expiresAt)) {
        setError("授权已过期，请取消后重新登录。");
        setPolling(false);
        return;
      }
      if (pending.current) {
        timer = setTimeout(poll, 1000);
        return;
      }
      let seconds = login!.pollSeconds;
      const result = await run(async (signal) => {
        const result = await update(
          { action: "oauth-poll", loginId: login!.loginId },
          signal,
        );
        if (result.kind === "saved" && result.accountId)
          await finishLogin(result.accountId, signal);
        if (result.kind === "pending") seconds = result.retrySeconds;
        return result;
      }, false);
      if (stopped) return;
      if (!result) {
        setPolling(false);
        return;
      }
      if (result.kind === "pending") timer = setTimeout(poll, seconds * 1000);
    }
    timer = setTimeout(poll, login.pollSeconds * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login, polling]);
  const saveDefault = () =>
    run(async (signal) => {
      await update(
        {
          action: "default",
          model,
          expectedCurrent: snapshot!.catalog.current,
        },
        signal,
      );
      setNotice("默认模型已保存。");
      changed();
      await load(signal);
    });
  const resetApi = () => {
    setApi({
      requestId: crypto.randomUUID(),
      label: "",
      protocol: "openai-responses",
      baseUrl: "",
      apiKey: "",
      model: "",
    });
    setDiscovered([]);
  };
  const readConnection = (id: string) =>
    run(
      async (signal) => {
        const result = await update(
          { action: "api-connection-read", accountId: id },
          signal,
        );
        if (result.kind === "connection") {
          setConnection(result.connection);
          setConnectionRead((n) => n + 1);
        }
      },
      true,
      false,
    );
  return (
    <>
      <header>
        <div className="model-settings-heading">
          {!login && (view !== "main" || onBack) && (
            <button
              className="icon-button"
              disabled={exitLocked}
              aria-label={view === "main" ? "返回连接详情" : "返回模型设置"}
              title={view === "main" ? "返回连接详情" : "返回模型设置"}
              onClick={() => {
                if (view === "main") onBack?.();
                else {
                  setView("main");
                  setConnection(null);
                  resetApi();
                  setError("");
                  setNotice("");
                }
              }}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <h2>
            {login
              ? "连接账号"
              : view === "add"
                ? "添加账号"
                : view === "models"
                  ? "选择模型"
                  : view === "connection"
                    ? "编辑 API 连接"
                    : embedded
                      ? "模型与账号"
                      : "模型设置"}
          </h2>
        </div>
        {!embedded && (
          <button
            ref={closeButton}
            className="icon-button"
            aria-label="关闭模型设置"
            disabled={exitLocked}
            onClick={onClose}
          >
            <X />
          </button>
        )}
      </header>
      <div className="model-settings" ref={body} tabIndex={-1} aria-busy={busy}>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!snapshot && (
          <p className="muted">
            {busy ? "正在读取模型设置…" : "暂时无法读取模型设置。"}
          </p>
        )}
        {!snapshot && !busy && (
          <button
            className="secondary-action"
            onClick={() => void run(load, true, false)}
          >
            重新加载
          </button>
        )}
        {snapshot && view === "main" && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveDefault();
              }}
              className="model-default-form"
            >
              <label>
                默认模型
                <select
                  aria-label="默认模型"
                  value={model}
                  disabled={busy || !snapshot.catalog.options.length}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {!snapshot.catalog.options.some((m) => m.id === model) && (
                    <option value={model}>
                      {model ? "当前模型不可用" : "尚无可用模型"}
                    </option>
                  )}
                  {snapshot.catalog.options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={busy || !model || model === snapshot.catalog.current}
              >
                设为默认
              </button>
              <small className="muted">
                用于后续未单独指定模型的请求，不会重新发送已有消息。
              </small>
            </form>
            <section aria-label="已连接账号">
              <div className="model-settings-section-heading">
                <h3>已连接账号</h3>
                <button
                  className="secondary-action"
                  disabled={busy}
                  onClick={() => void run(load)}
                  aria-label="刷新模型设置"
                >
                  <RefreshCw size={14} />
                  刷新
                </button>
              </div>
              {!snapshot.accounts.length && (
                <p className="muted">
                  还没有账号。登录已有订阅，或填写 API Key。
                </p>
              )}
              <ul className="model-account-list">
                {snapshot.accounts.map((a) => (
                  <li key={a.id}>
                    <div>
                      <strong title={a.label}>{a.label}</strong>
                      <small className="muted">
                        {a.kind === "oauth" ? "账号登录" : "API Key"} ·{" "}
                        {
                          {
                            ready: "已连接",
                            disabled: "已停用",
                            "needs-login": "需要登录",
                            configured: "已配置",
                          }[a.state]
                        }{" "}
                        · {a.models.filter((m) => m.enabled).length} 个模型
                      </small>
                    </div>
                    <div className="model-account-actions">
                      {a.kind === "api" && (
                        <button
                          className="secondary-action"
                          disabled={busy}
                          onClick={() => {
                            setAccountId(a.id);
                            setConnection(null);
                            setView("connection");
                            void readConnection(a.id);
                          }}
                        >
                          <Pencil size={14} />
                          编辑连接
                        </button>
                      )}
                      <button
                        className="secondary-action"
                        disabled={busy || a.state === "disabled"}
                        onClick={() => {
                          editAccount(snapshot, a.id);
                          setError("");
                          setNotice("");
                        }}
                      >
                        选择模型
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <button
              className="secondary-action model-add-account"
              disabled={busy}
              onClick={() => {
                resetApi();
                setView("add");
                setError("");
                setNotice("");
              }}
            >
              <Plus size={14} />
              添加账号
            </button>
          </>
        )}
        {snapshot && view === "add" && !login && (
          <>
            <div
              className="model-connection-modes"
              role="group"
              aria-label="账号连接方式"
            >
              <button
                aria-pressed={mode === "oauth"}
                disabled={busy}
                onClick={() => {
                  setMode("oauth");
                  resetApi();
                  setError("");
                }}
              >
                账号登录
              </button>
              <button
                aria-pressed={mode === "api"}
                disabled={busy}
                onClick={() => {
                  setMode("api");
                  setError("");
                }}
              >
                API Key
              </button>
            </div>
            {mode === "oauth" ? (
              <>
                <p className="muted">选择服务商，在浏览器完成授权。</p>
                {snapshot.servicesUnavailable && (
                  <p role="alert">
                    暂时无法读取登录方式。
                    <button
                      className="secondary-action"
                      disabled={busy}
                      onClick={() => void run(load)}
                    >
                      重试
                    </button>
                  </p>
                )}
                {!snapshot.servicesUnavailable && !snapshot.services.length && (
                  <p className="muted">
                    当前运行服务未提供账号登录，可使用 API Key。
                  </p>
                )}
                <div
                  className="model-service-list"
                  role="group"
                  aria-label="可连接的账号"
                >
                  {snapshot.services.map((s) => (
                    <button
                      key={s.id}
                      className="secondary-action model-service-button"
                      aria-label={`登录并连接 ${s.label}${s.experimental ? "（实验性）" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        void run(async (signal) => {
                          setConnectingService(s.id);
                          try {
                            const result = await update(
                              { action: "oauth-start", service: s.id },
                              signal,
                            );
                            if (result.kind === "login") {
                              activeLogin.current = result.login;
                              setLogin(result.login);
                              setPolling(true);
                              await openAuthorization(result.login);
                            }
                          } finally {
                            setConnectingService(null);
                          }
                        })
                      }
                    >
                      <span className="model-service-name">
                        {s.label}
                        {s.experimental && (
                          <small className="muted">实验性</small>
                        )}
                      </span>
                      <span className="model-service-action">
                        {connectingService === s.id
                          ? "正在连接…"
                          : "登录并连接"}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <form
                className="model-api-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async (signal) => {
                    const result = await update(
                      { action: "connect-api", ...api },
                      signal,
                    );
                    if (result.kind === "saved") {
                      resetApi();
                      setView("main");
                      setNotice("API 连接已保存，可在上方设为默认模型。");
                      changed();
                      await load(signal);
                    }
                  });
                }}
              >
                <label>
                  名称
                  <input
                    value={api.label}
                    required
                    maxLength={100}
                    disabled={busy}
                    placeholder="例如：我的 API"
                    onChange={(e) => setApi({ ...api, label: e.target.value })}
                  />
                </label>
                <label>
                  API 协议
                  <select
                    aria-label="API 协议"
                    value={api.protocol}
                    disabled={busy}
                    onChange={(e) => {
                      setApi({
                        ...api,
                        protocol: e.target.value as typeof api.protocol,
                      });
                      setDiscovered([]);
                    }}
                  >
                    <option value="openai-responses">OpenAI Responses</option>
                    <option value="openai-chat">OpenAI Chat Completions</option>
                    <option value="anthropic-messages">
                      Anthropic Messages
                    </option>
                    <option value="gemini-content">Gemini</option>
                  </select>
                </label>
                <label>
                  API 地址
                  <input
                    type="url"
                    value={api.baseUrl}
                    required
                    disabled={busy}
                    placeholder="服务商提供的 API 地址"
                    onChange={(e) => {
                      setApi({ ...api, baseUrl: e.target.value });
                      setDiscovered([]);
                    }}
                  />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    value={api.apiKey}
                    required
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    onChange={(e) => {
                      setApi({ ...api, apiKey: e.target.value });
                      setDiscovered([]);
                    }}
                  />
                </label>
                <label>
                  模型
                  <input
                    value={api.model}
                    required
                    list="model-settings-discovered"
                    disabled={busy}
                    placeholder="填写模型 ID，或先读取列表"
                    onChange={(e) => setApi({ ...api, model: e.target.value })}
                  />
                </label>
                <datalist id="model-settings-discovered">
                  {discovered.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <small className="muted">
                  凭据由运行服务保存，不会放进对话。保存配置不会发起模型推理。
                </small>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={busy || !api.baseUrl.trim() || !api.apiKey.trim()}
                    onClick={() =>
                      void run(async (signal) => {
                        const result = await update(
                          {
                            action: "discover",
                            protocol: api.protocol,
                            baseUrl: api.baseUrl,
                            apiKey: api.apiKey,
                          },
                          signal,
                        );
                        if (result.kind === "discovered") {
                          setDiscovered(result.models);
                          setNotice(
                            result.models.length
                              ? `已读取 ${result.models.length} 个模型，请在模型框中选择。`
                              : "服务未返回模型列表，可以直接填写模型 ID。",
                          );
                        }
                      })
                    }
                  >
                    读取模型
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !api.label.trim() ||
                      !api.baseUrl.trim() ||
                      !api.apiKey.trim() ||
                      !api.model.trim()
                    }
                  >
                    {busy ? "处理中…" : "保存连接"}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {view === "connection" &&
          account &&
          (connection ? (
            <ApiConnectionEditor
              key={`${account.id}:${connectionRead}`}
              connection={connection}
              label={account.label}
              busy={busy}
              onReload={() => void readConnection(account.id)}
              onSave={async (action) =>
                !!(await run(async (signal) => {
                  const result = await update(action, signal);
                  if (result.kind !== "connection") return false;
                  setConnection(result.connection);
                  setNotice(
                    action.action === "api-key"
                      ? "密钥已更新。"
                      : "API 地址已保存。",
                  );
                  changed();
                  return true;
                }))
              }
            />
          ) : (
            <>
              <p className="muted">
                {busy ? "正在读取连接…" : "暂时无法读取连接设置。"}
              </p>
              <button
                className="secondary-action"
                disabled={busy}
                onClick={() => void readConnection(account.id)}
              >
                重新载入连接
              </button>
            </>
          ))}
        {login && (
          <section className="model-login" aria-label="账号授权">
            <h3>等待账号授权</h3>
            <p className="muted">请在浏览器中完成登录，这里会自动接收结果。</p>
            {login.userCode && (
              <p>
                授权码：
                <strong className="model-user-code">{login.userCode}</strong>
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="secondary-action"
                disabled={busy}
                onClick={() => void openAuthorization(login)}
              >
                前往授权
              </button>
              <button
                className="secondary-action"
                disabled={busy}
                onClick={() => {
                  setPolling(false);
                  void run(async (signal) => {
                    await update(
                      { action: "oauth-cancel", loginId: login.loginId },
                      signal,
                    );
                    activeLogin.current = null;
                    setLogin(null);
                    setCallback("");
                  });
                }}
              >
                取消登录
              </button>
              {!polling && (
                <button
                  className="secondary-action"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setPolling(true);
                  }}
                >
                  继续检查
                </button>
              )}
            </div>
            {login.manualResponse && (
              <details>
                <summary>浏览器没有自动返回？</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setPolling(false);
                    void run(async (signal) => {
                      const result = await update(
                        {
                          action: "oauth-complete",
                          loginId: login.loginId,
                          response: callback,
                        },
                        signal,
                      );
                      if (result.kind === "saved" && result.accountId)
                        await finishLogin(result.accountId, signal);
                      else setPolling(true);
                    });
                  }}
                >
                  <label>
                    授权结果
                    <input
                      type="password"
                      autoComplete="off"
                      value={callback}
                      disabled={busy}
                      placeholder="粘贴浏览器返回的完整地址"
                      onChange={(e) => setCallback(e.target.value)}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !callback.trim()}
                  >
                    完成授权
                  </button>
                </form>
              </details>
            )}
          </section>
        )}
        {snapshot && view === "models" && account && (
          <section aria-label="账号模型">
            <div className="model-settings-section-heading">
              <h3 title={account.label}>{account.label}</h3>
              <button
                className="secondary-action"
                disabled={busy}
                onClick={() =>
                  void run(async (signal) => {
                    const result = await update(
                      { action: "account-refresh", accountId },
                      signal,
                    );
                    editAccount(await load(signal), accountId);
                    changed();
                    if (result.kind === "saved")
                      setNotice(result.warning ?? "模型列表已更新。");
                  })
                }
              >
                <RefreshCw size={14} />
                读取并测试
              </button>
            </div>
            <p className="muted">选择可供对话和事项使用的模型。</p>
            <small className="muted">
              读取并测试会向服务商获取模型列表并发起少量测试请求，不发送对话内容。
            </small>
            {!account.models.length && (
              <p>尚未读取模型，请点击「读取并测试」。</p>
            )}
            <div className="model-enabled-list">
              {account.models.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(m.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, m.id]
                          : selected.filter((id) => id !== m.id),
                      )
                    }
                  />
                  <span title={m.id}>{m.id}</span>
                </label>
              ))}
            </div>
            <div className="dialog-actions">
              <button
                className="primary"
                disabled={busy || !selected.length}
                onClick={() =>
                  void run(async (signal) => {
                    await update(
                      {
                        action: "account-models",
                        accountId,
                        models: selected,
                        expectedVersion: account.version,
                      },
                      signal,
                    );
                    setNotice("可用模型已保存。");
                    setView("main");
                    changed();
                    await load(signal);
                  })
                }
              >
                保存模型
              </button>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
