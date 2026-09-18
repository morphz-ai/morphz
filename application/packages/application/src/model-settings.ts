import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import { modelOptionSchema } from "../../core/src/inference.js";
import {
  modelSettingsActionSchema,
  type ModelSettingsSnapshot,
  type ModelSettingsResult,
} from "../../core/src/model-settings.js";
import type { RuntimeConfig } from "./runtime.js";

// Kept in the host. Never return provider headers, credential references or raw
// upstream errors to the renderer, tools, workspace snapshots or receipts.
const profile = z.record(z.string(), z.unknown());
const providersSchema = z.object({
  auth_adapters: z
    .array(z.object({ id: z.string(), stability: z.string().optional() }))
    .default([]),
  provider_instances: z
    .record(
      z.string(),
      z.object({
        models: z.record(z.string(), profile).default({}),
      }),
    )
    .default({}),
  auth_accounts: z.record(
    z.string(),
    z.object({
      config: z.object({
        label: z.string().nullish(),
        provider: z.string().nullish(),
      }),
      effective_enabled: z.boolean(),
      oauth: z.boolean(),
      authenticated: z.boolean(),
      state: z.object({ status: z.string() }).nullish(),
    }),
  ),
  model_routes: z
    .record(
      z.string(),
      z.object({
        display_alias: z.string().nullish(),
        candidates: z.array(
          z.object({
            provider: z.string(),
            model: z.string(),
            account: z.string().nullish(),
          }),
        ),
      }),
    )
    .default({}),
  discovered_models: z
    .array(
      z.object({ auth_account_id: z.string(), physical_model: z.string() }),
    )
    .default([]),
});
type Providers = z.infer<typeof providersSchema>;
const inferenceSchema = z.object({
  model: z.string().default(""),
  models: z.array(z.string()).default([]),
  model_options: z.array(modelOptionSchema).optional(),
  reasoning_effort: z.string().nullish(),
});
const servicesSchema = z.object({
  services: z.array(z.object({ id: z.string(), auth_adapter: z.string() })),
});
const serviceNames: Record<string, string> = {
  codex: "ChatGPT / Codex",
  anthropic: "Claude",
  claude: "Claude",
  kimi: "Kimi",
  antigravity: "Google Antigravity",
  xai: "Grok",
};
function accountVersion(snapshot: Providers, accountId: string) {
  const account = snapshot.auth_accounts[accountId];
  return createHash("sha256")
    .update(
      JSON.stringify({
        account,
        models:
          snapshot.provider_instances[account?.config.provider ?? ""]?.models,
        routes: snapshot.model_routes,
      }),
    )
    .digest("hex");
}
function safeEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("invalid", "请填写有效的 API 地址。");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new DomainError(
      "invalid",
      "API 地址需使用 HTTPS；本机服务可使用 HTTP。地址不能包含凭据或查询参数。",
    );
  return url.toString().replace(/\/$/, "");
}

/** Small domain facade over the existing Runtime provider APIs, not a proxy. */
export class RuntimeModelSettings {
  private busy = false;
  // Login capabilities are owned by this application identity, never arbitrary
  // Runtime login IDs supplied by another window or an Agent.
  private logins = new Set<string>();
  constructor(private configuration: () => RuntimeConfig) {}
  private async request(
    path: string,
    signal: AbortSignal,
    assertActive: () => void,
    method = "GET",
    body?: unknown,
  ) {
    assertActive();
    signal.throwIfAborted();
    const config = this.configuration();
    if (config.identityMode)
      throw new DomainError("forbidden", "此工作空间的模型由管理员管理。");
    let response: Response;
    try {
      response = await fetch(config.url + path, {
        method,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new DomainError(
        "invalid",
        method === "GET"
          ? "暂时无法读取模型设置，请检查连接后重试。"
          : "未能确认操作结果，请先刷新设置；已提交的操作不会回滚。",
      );
    }
    assertActive();
    signal.throwIfAborted();
    if (this.configuration() !== config)
      throw new DomainError("conflict", "连接已更新，请重新打开模型设置。");
    if (!response.ok) {
      // Cancelling an already expired/completed login is a successful no-op.
      // Otherwise the UI would trap users in an expired authorization screen.
      if (
        response.status === 404 &&
        method === "DELETE" &&
        /^\/api\/runtime\/providers\/oauth\/[^/]+\/continue$/.test(path)
      )
        return undefined;
      // Runtime/provider errors can echo keys, URLs or callback codes.
      throw new DomainError(
        response.status === 401 || response.status === 403
          ? "forbidden"
          : "invalid",
        response.status === 401 || response.status === 403
          ? "连接凭据无效或没有模型管理权限，请检查连接设置。"
          : response.status === 404
            ? "操作已失效或当前运行服务不支持，请刷新后重试。"
            : method === "GET"
              ? "未能读取模型设置，请重试。"
              : "运行服务未确认操作成功，请检查配置并刷新设置后重试。",
      );
    }
    const text = await response.text();
    assertActive();
    signal.throwIfAborted();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
  async read(
    signal: AbortSignal,
    assertActive: () => void,
  ): Promise<ModelSettingsSnapshot> {
    const [raw, inference, services] = await Promise.all([
      this.request("/api/runtime/providers", signal, assertActive).then((v) =>
        providersSchema.parse(v),
      ),
      this.request("/api/runtime/inference", signal, assertActive).then((v) =>
        inferenceSchema.parse(v),
      ),
      this.request(
        "/api/runtime/providers/oauth/services",
        signal,
        assertActive,
      )
        .then((v) => servicesSchema.parse(v))
        .catch(() => null),
    ]);
    assertActive();
    signal.throwIfAborted();
    return {
      catalog: {
        current: inference.model,
        options:
          inference.model_options ??
          inference.models.map((id) => ({ id, label: id })),
      },
      accounts: Object.entries(raw.auth_accounts)
        .filter(
          ([, a]) =>
            !a.oauth || a.authenticated || a.state?.status === "disabled",
        )
        .map(([id, a]) => {
          const enabled = new Set(
            Object.values(raw.model_routes).flatMap((r) =>
              r.candidates
                .filter(
                  (c) =>
                    c.account === id ||
                    (!c.account && c.provider === a.config.provider),
                )
                .map((c) => c.model),
            ),
          );
          const available = new Set([
            ...enabled,
            ...raw.discovered_models
              .filter((m) => m.auth_account_id === id)
              .map((m) => m.physical_model),
          ]);
          return {
            id,
            label: a.config.label || (a.oauth ? "订阅账号" : "API 连接"),
            kind: a.oauth ? "oauth" : "api",
            state: !a.effective_enabled
              ? "disabled"
              : a.oauth
                ? a.authenticated
                  ? "ready"
                  : "needs-login"
                : "configured",
            version: accountVersion(raw, id),
            models: [...available]
              .sort()
              .map((id) => ({ id, enabled: enabled.has(id) })),
          };
        }),
      services: (services?.services ?? []).flatMap((s) => {
        const adapter = raw.auth_adapters.find((a) => a.id === s.auth_adapter);
        return adapter
          ? [
              {
                id: s.id,
                label: serviceNames[s.id] ?? s.id,
                experimental: adapter.stability === "experimental",
              },
            ]
          : [];
      }),
      servicesUnavailable: !services,
    };
  }
  async apply(
    raw: unknown,
    signal: AbortSignal,
    assertActive: () => void,
  ): Promise<ModelSettingsResult> {
    const action = modelSettingsActionSchema.parse(raw);
    if (this.busy)
      throw new DomainError("conflict", "另一项模型设置正在处理，请稍后重试。");
    this.busy = true;
    const call = (path: string, method = "GET", body?: unknown) =>
      this.request(path, signal, assertActive, method, body);
    try {
      assertActive();
      signal.throwIfAborted();
      if (action.action === "default") {
        const current = inferenceSchema.parse(
          await call("/api/runtime/inference"),
        );
        if (current.model === action.model) return { kind: "saved" };
        if (current.model !== action.expectedCurrent)
          throw new DomainError(
            "conflict",
            "默认模型已被修改，请刷新后再选择。",
          );
        const option = (
          current.model_options ??
          current.models.map((id) => ({ id, label: id }))
        ).find((m) => m.id === action.model);
        if (!option)
          throw new DomainError(
            "invalid",
            "此模型当前不可用，请刷新模型列表。",
          );
        const levels = current.model_options?.find(
          (m) => m.id === action.model,
        )?.supported_reasoning_efforts;
        await call("/api/runtime/inference", "PUT", {
          model: action.model,
          ...(current.reasoning_effort &&
          levels &&
          !levels.some((level) => level === current.reasoning_effort)
            ? { reasoning_effort: "default" }
            : {}),
        });
        return { kind: "saved" };
      }
      if (action.action === "discover" || action.action === "connect-api") {
        const baseUrl = safeEndpoint(action.baseUrl);
        if (action.action === "discover") {
          const result = z.object({ models: z.array(z.string()) }).parse(
            await call("/api/runtime/providers/discover-models", "POST", {
              protocol: action.protocol,
              base_url: baseUrl,
              api_key: action.apiKey,
            }),
          );
          return {
            kind: "discovered",
            models: [...new Set(result.models)].sort(),
          };
        }
        // Stable IDs make an uncertain retry an upsert, never another account.
        // Each submission owns an isolated provider/route, preserving all others.
        const provider = `desktop-${action.requestId}`,
          account = `${provider}-account`,
          route = `${provider}-model`;
        const credential = `${provider}-key`,
          name = `MORPHZ_API_${action.requestId.replaceAll("-", "_").toUpperCase()}`;
        await call("/api/runtime/providers/setup", "PUT", {
          provider_id: provider,
          provider: {
            adapter: action.protocol.startsWith("openai-")
              ? "openai-compatible"
              : "protocol-compatible",
            protocol: action.protocol,
            base_url: baseUrl,
            accounts: [account],
            models: { [action.model]: {} },
            headers: {},
            env_headers: {},
          },
          account_id: account,
          account: {
            auth_adapter: "credential",
            credential_ref: credential,
            secret_backend: "morphz_env_file",
            provider,
            label: action.label,
            enabled: true,
          },
          credential_id: credential,
          credential: { source: "env", name, service: null, command: [] },
          managed_secret: {
            name,
            value: action.apiKey,
            scope_kind: "runtime",
            value_backend: "morphz_env_file",
          },
          route_id: route,
          route: {
            display_alias: `${action.model} · ${action.label}`,
            aliases: [`${action.model} · ${action.label}`],
            candidates: [
              {
                provider,
                model: action.model,
                priority: 0,
                account,
                capabilities: [],
              },
            ],
            affinity: "context",
            selection: "available-least-recently-used",
            fallback: false,
          },
        });
        return { kind: "saved", accountId: account };
      }
      if (
        action.action === "account-refresh" ||
        action.action === "account-models"
      ) {
        const snapshot = providersSchema.parse(
          await call("/api/runtime/providers"),
        );
        const account = snapshot.auth_accounts[action.accountId];
        if (!account)
          throw new DomainError("not_found", "账号已不存在，请刷新。");
        const path = `/api/runtime/providers/accounts/${encodeURIComponent(action.accountId)}`;
        if (action.action === "account-refresh") {
          const diagnostic = z
            .object({
              catalog_error: z.string().nullish(),
              health_verified: z.boolean().optional(),
            })
            .parse(await call(path + "/refresh-models", "POST", {}));
          if (diagnostic.catalog_error)
            throw new DomainError(
              "invalid",
              "未能读取服务商的模型列表，原有配置已保留。请稍后重试。",
            );
          return {
            kind: "saved",
            accountId: action.accountId,
            ...(diagnostic.health_verified === false
              ? { warning: "模型列表已更新，但测试调用未通过。配置已保留。" }
              : {}),
          };
        } else {
          if (
            action.expectedVersion !==
            accountVersion(snapshot, action.accountId)
          )
            throw new DomainError(
              "conflict",
              "账号模型已更新，请刷新后重新选择。",
            );
          const profiles =
            snapshot.provider_instances[account.config.provider ?? ""]
              ?.models ?? {};
          const allowed = new Set([
            ...Object.keys(profiles),
            ...snapshot.discovered_models
              .filter((m) => m.auth_account_id === action.accountId)
              .map((m) => m.physical_model),
          ]);
          if (action.models.some((m) => !allowed.has(m)))
            throw new DomainError("invalid", "请选择此账号已发现的模型。");
          await call(path + "/models", "PUT", {
            models: [...new Set(action.models)].map((id) => ({
              ...profiles[id],
              id,
              alias:
                Object.values(snapshot.model_routes).find((r) =>
                  r.candidates.some(
                    (c) => c.model === id && c.account === action.accountId,
                  ),
                )?.display_alias ?? undefined,
            })),
          });
        }
        return { kind: "saved", accountId: action.accountId };
      }
      if (action.action === "oauth-start") {
        const services = servicesSchema.parse(
          await call("/api/runtime/providers/oauth/services"),
        );
        if (!services.services.some((s) => s.id === action.service))
          throw new DomainError(
            "invalid",
            "此账号登录方式当前不可用，请刷新。",
          );
        const challenge = z
          .object({
            login_id: z.string(),
            account_id: z.string(),
            authorization_url: z.string().nullish(),
            verification_uri_complete: z.string().nullish(),
            verification_uri: z.string().nullish(),
            user_code: z.string().nullish(),
            expires_at: z.string(),
            poll_interval_secs: z.number().nullish(),
            flow: z.string(),
          })
          .parse(
            await call("/api/runtime/providers/oauth/start", "POST", {
              service: action.service,
            }),
          );
        this.logins.add(challenge.login_id);
        const url =
          challenge.authorization_url ||
          challenge.verification_uri_complete ||
          challenge.verification_uri ||
          "";
        if (
          !url ||
          new URL(url).protocol !== "https:" ||
          new URL(url).username ||
          new URL(url).password
        )
          throw new DomainError(
            "invalid",
            "登录服务没有返回安全的授权地址，请重试。",
          );
        return {
          kind: "login",
          login: {
            loginId: challenge.login_id,
            accountId: challenge.account_id,
            url,
            userCode: challenge.user_code ?? undefined,
            expiresAt: challenge.expires_at,
            pollSeconds: Math.max(2, challenge.poll_interval_secs ?? 3),
            manualResponse: challenge.flow === "authorization_code_pkce",
          },
        };
      }
      if (!this.logins.has(action.loginId))
        throw new DomainError("forbidden", "登录已失效，请重新连接账号。");
      const path = `/api/runtime/providers/oauth/${encodeURIComponent(action.loginId)}/continue`;
      if (action.action === "oauth-cancel") {
        await call(path, "DELETE");
        this.logins.delete(action.loginId);
        return { kind: "cancelled" };
      }
      const progress = z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("pending"),
            retry_after_secs: z.number(),
          }),
          z.object({
            status: z.literal("complete"),
            account: z.object({ account_id: z.string() }),
          }),
        ])
        .parse(
          await call(
            path,
            "POST",
            action.action === "oauth-complete"
              ? { kind: "authorization_response", response: action.response }
              : { kind: "poll" },
          ),
        );
      if (progress.status === "pending")
        return {
          kind: "pending",
          retrySeconds: Math.max(2, progress.retry_after_secs),
        };
      this.logins.delete(action.loginId);
      return { kind: "saved", accountId: progress.account.account_id };
    } finally {
      this.busy = false;
    }
  }
}
