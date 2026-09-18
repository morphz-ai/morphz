import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import {
  configureConnectionSchema,
  unconfiguredConnection,
  type ConnectionDetails,
} from "../../core/src/connection.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime.js";
import type { WorkspaceStore } from "./store.js";

export function runtimeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError(
      "invalid",
      "请输入完整的本机服务地址，例如 http://127.0.0.1:18089。",
    );
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new DomainError(
      "invalid",
      "这里只能连接本机运行服务，地址不能包含登录凭据或其他路径。",
    );
  return url.origin;
}

/** GET-only diagnosis. No tick, inference request, delivery retry or process restart. */
export async function inspectRuntimeConnection(
  config: RuntimeConfig,
  signal?: AbortSignal,
  principalId?: string,
): Promise<ConnectionDetails> {
  const result: ConnectionDetails = {
    ...unconfiguredConnection,
    state: "unreachable",
    checkedAt: new Date().toISOString(),
    message: "无法连接智能体。请确认运行服务已启动，再重试连接。",
  };
  const request = async (path: string) =>
    fetch(config.url + path, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(principalId ? { "X-Morphz-Principal": principalId } : {}),
      },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
  try {
    const response = await request(
      config.identityMode ? "/api/sessions" : "/api/status",
    );
    if (response.status === 401 || response.status === 403)
      return {
        ...result,
        state: "authentication-required",
        message: "连接凭据已失效或权限不足，请更新连接凭据。",
      };
    if (!response.ok)
      return {
        ...result,
        state: "error",
        message: `运行服务返回错误（HTTP ${response.status}）。请检查服务后重试。`,
      };
    let status: { model: string; identity_mode?: string };
    try {
      status = config.identityMode
        ? (z
            .object({ sessions: z.array(z.unknown()) })
            .parse(await response.json()),
          { model: "" })
        : z
            .object({ model: z.string(), identity_mode: z.string().optional() })
            .parse(await response.json());
    } catch {
      return {
        ...result,
        state: "error",
        message: "该地址没有返回可识别的运行服务状态，请确认服务地址和版本。",
      };
    }
    if (
      !config.identityMode &&
      status.identity_mode &&
      status.identity_mode !== "default"
    )
      return {
        ...result,
        state: "error",
        message: "此地址使用多人网关身份，不能作为个人智能体连接。",
      };
    result.state = "connected";
    result.model = status.model;
    result.message = "";
    if (config.identityMode)
      return {
        ...result,
        message: "运行服务已连接；模型配置由工作空间管理员管理。",
      };
    const models = await request("/api/runtime/inference");
    if (models.status === 401 || models.status === 403)
      return {
        ...result,
        state: "authentication-required",
        message: "无法读取模型配置，连接凭据已失效或权限不足。请更新连接凭据。",
      };
    if (!models.ok)
      return {
        ...result,
        modelState: "unavailable",
        message: `运行服务已连接，但无法读取模型配置（HTTP ${models.status}）。请检查模型设置。`,
      };
    const catalog = z
      .object({
        model: z.string().optional(),
        models: z.array(z.string()).optional(),
        model_options: z.array(z.object({ id: z.string() })).optional(),
      })
      .parse(await models.json());
    result.model = catalog.model ?? result.model;
    const choices =
      catalog.model_options?.map((item) => item.id) ?? catalog.models;
    result.modelState =
      result.model && (choices === undefined || choices.includes(result.model))
        ? "configured"
        : "not-configured";
    if (result.modelState === "not-configured")
      result.message = "运行服务已连接，请先配置一个可用的默认模型。";
    return result;
  } catch {
    signal?.throwIfAborted();
    return result.state === "connected"
      ? {
          ...result,
          modelState: "unavailable",
          message:
            "运行服务已连接，但未能确认模型配置。请重试检查或打开模型设置。",
        }
      : result;
  }
}

/** Local-owner setup only. Credentials never appear in snapshots or diagnostic replies. */
export class LocalRuntimeConnection {
  private saving = false;
  constructor(
    private directory: string,
    private store: WorkspaceStore,
    private prepare: (
      config: RuntimeConfig,
    ) => Promise<{ commit(): void; discard(): Promise<void> }>,
  ) {}
  private file() {
    return join(this.directory, "runtime.json");
  }
  private version() {
    if (!existsSync(this.file())) return "unconfigured";
    const stat = lstatSync(this.file());
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 16384 ||
      (process.platform !== "win32" &&
        (stat.mode & 0o077 || stat.uid !== process.getuid!()))
    )
      throw new DomainError(
        "invalid",
        "连接配置文件权限不安全，未读取或覆盖。请由本机管理员检查。",
      );
    return createHash("sha256").update(readFileSync(this.file())).digest("hex");
  }
  details() {
    const version = this.version();
    const config = loadRuntimeConfig(this.directory);
    return {
      configurable: !config?.identityMode,
      version,
      ...(config
        ? {
            endpoint: config.url,
            ...(!config.identityMode ? { modelSettingsAvailable: true } : {}),
          }
        : {}),
    };
  }
  async configure(raw: unknown, assertActive: () => void, signal: AbortSignal) {
    const request = configureConnectionSchema.parse(raw);
    if (this.saving)
      throw new DomainError("conflict", "连接设置正在保存，请稍后查看结果。");
    this.saving = true;
    let temporary: string | undefined;
    let prepared:
      Awaited<ReturnType<LocalRuntimeConnection["prepare"]>> | undefined;
    try {
      const version = this.version();
      if (request.expectedVersion !== version)
        throw new DomainError(
          "conflict",
          "连接设置已变化，请重新检查后再保存。",
        );
      const old = loadRuntimeConfig(this.directory);
      if (old?.identityMode)
        throw new DomainError("forbidden", "多人工作空间的连接由管理员配置。");
      const saved = this.store.runtimeState() as {
        endpoint?: string;
        namespace?: string;
        identityMode?: string;
      } | null;
      const endpoint = runtimeOrigin(request.endpoint);
      if (
        (old && old.url !== endpoint) ||
        (saved?.endpoint && saved.endpoint !== endpoint) ||
        saved?.identityMode
      )
        throw new DomainError(
          "conflict",
          "已有会话绑定了原运行服务；不能通过重新连接切换到另一个服务。",
        );
      const config: RuntimeConfig = {
        url: endpoint,
        token: request.token,
        namespace: old?.namespace ?? saved?.namespace ?? this.store.identity(),
      };
      const checked = await inspectRuntimeConnection(config, signal);
      if (checked.state !== "connected")
        throw new DomainError("invalid", checked.message);
      signal.throwIfAborted();
      assertActive();
      if (this.version() !== version)
        throw new DomainError("conflict", "连接设置已变化，原配置没有被覆盖。");
      temporary = this.file() + "." + randomUUID();
      writeFileSync(temporary, JSON.stringify(config), {
        flag: "wx",
        mode: 0o600,
      });
      prepared = await this.prepare(config);
      signal.throwIfAborted();
      assertActive();
      if (this.version() !== version)
        throw new DomainError("conflict", "连接设置已变化，原配置没有被覆盖。");
      renameSync(temporary, this.file());
      temporary = undefined;
      prepared.commit();
      prepared = undefined;
      return { ...checked, ...this.details() };
    } finally {
      try {
        await prepared?.discard();
      } finally {
        try {
          if (temporary) unlinkSync(temporary);
        } finally {
          this.saving = false;
        }
      }
    }
  }
}
