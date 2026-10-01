import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, type AccessContext } from "../../core/src/model.js";
import {
  compileProfileRom,
  parseProfileRom,
  profileRom,
  profileUpdateSchema,
  defaultAgentProfile,
  defaultHumanProfile,
  type ProfileUpdate,
} from "../../core/src/profile.js";
import type { RuntimeConfig } from "./runtime.js";

const keySchema = z.object({
  agent_id: z.string().min(1).max(512),
  namespace: z.string(),
  principal_scope: z.string().min(1).max(512).optional(),
});
const recordSchema = z.object({
  entry_id: z.string(),
  key: keySchema,
  revision: z.number().int().positive(),
  schema_tag: z.string(),
  canonical_sexpr: z.string(),
  enabled: z.boolean(),
  content_hash: z.string(),
  canonical_format_version: z.literal(1),
  created_by: z.string(),
  created_at: z.string(),
});
const receiptSchema = z.object({
  command_id: z.string(),
  actor_authority_id: z.string(),
  request_hash: z.string(),
  entry_id: z.string(),
  expected_revision: z.number().int().nonnegative(),
  committed_revision: z.number().int().positive(),
  committed_at: z.string(),
});

/** The configured operator/trusted Host boundary is not an Agent tool. No
 * browser can supply Runtime URLs, tokens, Agent IDs or Principal scopes. */
export class RuntimeProfileClient {
  constructor(
    private readonly configuration: () => RuntimeConfig,
    private readonly request: typeof fetch = (...args) =>
      globalThis.fetch(...args),
  ) {}
  private async call(
    path: string,
    active: () => void,
    method = "GET",
    body?: unknown,
    principal?: string,
    authority: "operator" | "gateway" = "operator",
  ) {
    active();
    const config = this.configuration();
    const token =
      authority === "gateway"
        ? config.token
        : config.identityMode === "trusted_gateway"
          ? config.operatorToken
          : (config.operatorToken ?? config.token);
    if (!token)
      throw new DomainError(
        "invalid",
        "管理员尚未配置 Runtime Profile 访问，资料暂不可用。",
      );
    if (token.length > 8192 || !/^[\x21-\x7e]+$/.test(token))
      throw new DomainError(
        "invalid",
        "Runtime Profile 管理凭据格式无效，请联系管理员。",
      );
    let response: Response;
    try {
      response = await this.request(config.url + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(principal ? { "X-Morphz-Principal": principal } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      active();
      // Native fetch/header errors may include the entire Bearer credential.
      // Do not forward message, stack or cause to Host logs or the renderer.
      throw new DomainError(
        "invalid",
        "Runtime Profile 连接失败，请稍后重试。",
      );
    }
    active();
    if (response.status === 404) return null;
    if (!response.ok)
      throw new DomainError(
        response.status === 409 ? "conflict" : "invalid",
        response.status === 409
          ? "Profile 已更新，请重新读取后保存。"
          : "Runtime Profile 暂不可用，请检查连接后重试。",
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new DomainError(
        "invalid",
        "Runtime Profile 回复无效，请稍后重试。",
      );
    }
    active();
    return value;
  }
  async identity(
    access: Pick<AccessContext, "principalId">,
    active: () => void = () => {},
  ) {
    const status = z
      .object({
        agent_id: z.string().min(1).max(512),
        principal_id: z.string().min(1).max(512),
      })
      .parse(await this.call("/api/status", active));
    const config = this.configuration();
    const team = config.identityMode === "trusted_gateway";
    const principalId = team
      ? "mw-" +
        createHash("sha256")
          .update(config.namespace + ":" + access.principalId)
          .digest("hex")
      : status.principal_id;
    if (team) {
      const registered = z
        .object({ principal_id: z.literal(principalId) })
        .parse(
          await this.call(
            "/api/principal/self",
            active,
            "POST",
            undefined,
            principalId,
            "gateway",
          ),
        );
      if (registered.principal_id !== principalId)
        throw new DomainError("forbidden", "用户 Runtime 身份未可靠登记。");
    }
    return { agentId: status.agent_id, principalId, agentEditable: !team };
  }
  private async readRecord(
    subject: "human" | "agent",
    identity: { agentId: string; principalId: string },
    active: () => void,
  ) {
    const expected = {
      agent_id: identity.agentId,
      namespace: profileRom[subject].namespace,
      ...(subject === "human" ? { principal_scope: identity.principalId } : {}),
    };
    const path =
      `/api/agents/${encodeURIComponent(identity.agentId)}/rom/${profileRom[subject].namespace}` +
      (subject === "human"
        ? "?principal_scope=" + encodeURIComponent(identity.principalId)
        : "");
    const raw = await this.call(path, active);
    if (raw === null)
      return {
        revision: 0,
        data: subject === "human" ? defaultHumanProfile : defaultAgentProfile,
      };
    const record = recordSchema.parse(raw);
    if (
      record.key.agent_id !== expected.agent_id ||
      record.key.namespace !== expected.namespace ||
      record.key.principal_scope !== expected.principal_scope ||
      record.schema_tag !== profileRom[subject].schemaTag
    )
      throw new DomainError("invalid", "Runtime Profile 版本或主体不匹配。");
    if (!record.enabled)
      throw new DomainError(
        "invalid",
        "Runtime Profile 已停用，请先恢复配置。",
      );
    return {
      revision: record.revision,
      data:
        subject === "human"
          ? parseProfileRom("human", record.canonical_sexpr)
          : parseProfileRom("agent", record.canonical_sexpr),
    };
  }
  async read(access: AccessContext, active: () => void = () => {}) {
    const identity = await this.identity(access, active);
    // A missing entry is a valid default; a missing ROM API is not support.
    const capability = await this.call(
      `/api/agents/${encodeURIComponent(identity.agentId)}/rom`,
      active,
    );
    if (capability === null)
      throw new DomainError("invalid", "当前 Runtime 尚不支持 Profile ROM。");
    z.object({ entries: z.array(recordSchema) }).parse(capability);
    const [human, agent] = await Promise.all([
      this.readRecord("human", identity, active),
      this.readRecord("agent", identity, active),
    ]);
    return { identity, human, agent };
  }
  async update(
    access: AccessContext,
    raw: unknown,
    active: () => void = () => {},
  ) {
    const request = profileUpdateSchema.parse(raw),
      identity = await this.identity(access, active);
    if (request.subject === "agent" && !identity.agentEditable)
      throw new DomainError("forbidden", "团队智能体资料只读。");
    const key = {
      agent_id: identity.agentId,
      namespace: profileRom[request.subject].namespace,
      ...(request.subject === "human"
        ? { principal_scope: identity.principalId }
        : {}),
    };
    const path =
      `/api/agents/${encodeURIComponent(identity.agentId)}/rom/${key.namespace}` +
      (request.subject === "human"
        ? "?principal_scope=" + encodeURIComponent(identity.principalId)
        : "");
    const body =
      request.subject === "human"
        ? compileProfileRom("human", request.data)
        : compileProfileRom("agent", request.data);
    const rawResult = await this.call(path, active, "PUT", {
      command_id: request.commandId,
      expected_revision: request.expectedRevision,
      key,
      schema_tag: profileRom[request.subject].schemaTag,
      body_sexpr: body,
      enabled: true,
    });
    const result = z
      .discriminatedUnion("status", [
        z.object({
          status: z.literal("committed"),
          record: recordSchema,
          receipt: receiptSchema,
          duplicate: z.boolean(),
        }),
        z.object({
          status: z.literal("conflict"),
          current: recordSchema.nullable().optional(),
        }),
        z.object({ status: z.literal("not_found") }),
      ])
      .parse(rawResult);
    if (result.status !== "committed")
      throw new DomainError("conflict", "Profile 已更新，请重新读取后保存。");
    if (
      result.record.key.agent_id !== key.agent_id ||
      result.record.key.namespace !== key.namespace ||
      result.record.key.principal_scope !== key.principal_scope ||
      result.record.schema_tag !== profileRom[request.subject].schemaTag ||
      result.receipt.command_id !== request.commandId ||
      result.receipt.expected_revision !== request.expectedRevision ||
      result.receipt.committed_revision !== result.record.revision ||
      result.receipt.entry_id !== result.record.entry_id
    )
      throw new Error("Runtime Profile 保存回执与请求不匹配。");
    const data =
      request.subject === "human"
        ? parseProfileRom("human", result.record.canonical_sexpr)
        : parseProfileRom("agent", result.record.canonical_sexpr);
    if (JSON.stringify(data) !== JSON.stringify(request.data)) {
      // Optional empty customStyle is normalized by the profile schema.
      const normalized = (value: ProfileUpdate["data"]) =>
        JSON.stringify({
          ...value,
          ...("traits" in value
            ? { customStyle: value.customStyle || undefined }
            : {}),
        });
      if (normalized(data) !== normalized(request.data))
        throw new Error("Runtime Profile 内容回执与请求不匹配。");
    }
    return {
      subject: request.subject,
      revision: result.record.revision,
      data,
      commandId: request.commandId,
    };
  }
}
