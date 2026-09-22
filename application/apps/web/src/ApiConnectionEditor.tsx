import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  ApiConnectionSettings,
  ModelSettingsAction,
} from "../../../packages/core/src/model-settings.js";

const protocolNames = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
  "gemini-content": "Gemini",
};

export function ApiConnectionEditor({
  connection,
  label,
  busy,
  onSave,
  onReload,
}: {
  connection: ApiConnectionSettings;
  label: string;
  busy: boolean;
  onSave: (action: ModelSettingsAction) => Promise<boolean>;
  onReload: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [key, setKey] = useState("");
  const [endpointConfirmed, setEndpointConfirmed] = useState(false);
  const [keyConfirmed, setKeyConfirmed] = useState(false);
  useEffect(() => {
    setBaseUrl(connection.baseUrl);
  }, [connection.baseUrl]);
  const target = {
    accountId: connection.accountId,
    expectedVersion: connection.version,
  };
  return (
    <section
      className="model-connection-editor"
      aria-label={`编辑连接：${label}`}
    >
      <div className="model-settings-section-heading">
        <div>
          <strong>{label}</strong>
          <small className="muted">{protocolNames[connection.protocol]}</small>
        </div>
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={onReload}
        >
          <RefreshCw size={14} />
          重新载入连接
        </button>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            busy ||
            (connection.endpointAccounts.length > 1 && !endpointConfirmed)
          )
            return;
          await onSave({ action: "api-endpoint", ...target, baseUrl });
        }}
      >
        <label htmlFor="edit-api-base-url">API 地址（Base URL）</label>
        <div className="model-connection-field">
          <input
            id="edit-api-base-url"
            type="url"
            required
            value={baseUrl}
            disabled={busy}
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <button
            className="secondary-action"
            disabled={
              busy ||
              !baseUrl.trim() ||
              baseUrl.trim().replace(/\/$/, "") === connection.baseUrl ||
              (connection.endpointAccounts.length > 1 && !endpointConfirmed)
            }
          >
            保存地址
          </button>
        </div>
        {baseUrl.trim().replace(/\/$/, "") !== connection.baseUrl && (
          <small className="muted">
            后续请求会将此连接的密钥发送到新地址，请确认它属于可信服务。
          </small>
        )}
        {connection.endpointAccounts.length > 1 && (
          <label className="model-shared-confirm">
            <input
              type="checkbox"
              checked={endpointConfirmed}
              disabled={busy}
              onChange={(e) => setEndpointConfirmed(e.target.checked)}
            />
            同时更新共用此地址的账号：{connection.endpointAccounts.join("、")}
          </label>
        )}
      </form>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            busy ||
            !key.trim() ||
            !connection.keyEditable ||
            (connection.keyAccounts.length > 1 && !keyConfirmed)
          )
            return;
          if (await onSave({ action: "api-key", ...target, apiKey: key }))
            setKey("");
        }}
      >
        <label htmlFor="edit-api-key">API Key</label>
        <div className="model-connection-field">
          <input
            id="edit-api-key"
            type="password"
            value={key}
            disabled={busy || !connection.keyEditable}
            maxLength={16384}
            autoComplete="new-password"
            spellCheck={false}
            placeholder="输入新密钥以替换，留空保持原密钥"
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            className="secondary-action"
            disabled={
              busy ||
              !key.trim() ||
              !connection.keyEditable ||
              (connection.keyAccounts.length > 1 && !keyConfirmed)
            }
          >
            更新密钥
          </button>
        </div>
        {connection.keyUnavailableReason && (
          <small className="muted">{connection.keyUnavailableReason}</small>
        )}
        {connection.keyAccounts.length > 1 && (
          <label className="model-shared-confirm">
            <input
              type="checkbox"
              checked={keyConfirmed}
              disabled={busy}
              onChange={(e) => setKeyConfirmed(e.target.checked)}
            />
            同时更新共用此密钥的账号：{connection.keyAccounts.join("、")}
          </label>
        )}
      </form>
      <small className="muted">
        原密钥不回显。地址和密钥分别保存，不改变已选模型，也不会发起测试或重发消息。
      </small>
    </section>
  );
}
