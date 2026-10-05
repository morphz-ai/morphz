import { createHash } from "node:crypto";
import {
  parseCognitiveAppDefinition,
  isPortableText,
  type CognitiveAppDefinition,
} from "../../cognitive-app-sdk/src/protocol.js";
import { canonicalJsonBytes } from "../../cognitive-app-sdk/src/domain-wire.js";
import { safeInteger, type SqlQuery } from "../../storage/src/sql.js";
import { ensureApplicationInstallation } from "./application-installation.js";

/** Platform-internal, scoped to the caller's existing transaction. The Store
 * resolves real Human/Runtime identity before opening that transaction and
 * checks project/member/source policy with this same q. No SDK/renderer export.
 */
export type CognitiveAppRegistryContext = {
  q: SqlQuery;
  backend: "sqlite" | "postgres";
  tenantId: string;
  principalId: string;
  fail(
    code: "invalid" | "forbidden" | "not_found" | "conflict",
    message: string,
  ): never;
};
export type CognitiveAppVersion = {
  appId: string;
  version: string;
  installationId: string;
  definitionHash: string;
  definition: CognitiveAppDefinition;
  installedByPrincipalId: string;
  installedAt: string;
};
export type CognitiveAppGrant = {
  appId: string;
  version: string;
  state: "active" | "disabled";
  revision: number;
  consentedAt: string;
  updatedAt: string;
};
export type CognitiveAppAuthority = {
  appId: string;
  instanceId: string;
  serviceId: string;
  dataAuthorityId: string;
};
/** Public metadata is selected explicitly: no Host alias, address or credential. */
export type CognitiveAppConnection = CognitiveAppAuthority & {
  connectionId: string;
  state: "active" | "disabled" | "unavailable";
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type CognitiveAppRegistryCatalog = {
  versions: Array<CognitiveAppVersion & { grant: CognitiveAppGrant }>;
  connections: CognitiveAppConnection[];
  nextVersionsAfter: string | null;
  nextConnectionsAfter: string | null;
};
export type CognitiveAppRegistryCatalogRequest = {
  limit: number;
  appId?: string;
  versionsAfter?: string;
  connectionsAfter?: string;
};
export type CognitiveAppTargetSnapshot = CognitiveAppAuthority & {
  version: string;
  definitionHash: string;
  definition: CognitiveAppDefinition;
  installationId: string;
  connectionId: string;
  connectionRevision: number;
  grantRevision: number;
};
export type CognitiveAppConsentRequest = {
  appId: string;
  version: string;
  expectedDefinitionHash?: string;
  expectedGrantRevision?: number;
};
export type CognitiveAppViewBinding = CognitiveAppAuthority & {
  viewId: string;
  projectId: string;
  version: string;
  connectionId: string;
  revision: number;
  viewRevision: number;
  createdAt: string;
  updatedAt: string;
};
export type CognitiveAppGrantChange = {
  appId: string;
  version: string;
  expectedRevision: number;
  state: "active" | "disabled";
  now: string;
};
export type CognitiveAppAuthorityRequest = {
  appId: string;
  serviceId: string;
  dataAuthorityId: string;
  now: string;
};
export type CognitiveAppConnectionCreate = CognitiveAppAuthorityRequest & {
  version: string;
  connectionId: string;
  hostBindingId: string;
  expectedRevision: 0;
};
export type CognitiveAppConnectionChange = {
  expectedAppId?: string;
  connectionId: string;
  expectedRevision: number;
  serviceId: string;
  dataAuthorityId: string;
  hostBindingId: string;
  state: CognitiveAppConnection["state"];
  now: string;
};
export type CognitiveAppTargetRequest = {
  appId: string;
  version: string;
  connectionId: string;
  expectedDefinitionHash?: string;
  expectedGrantRevision?: number;
  expectedConnectionRevision?: number;
};
export type CognitiveAppHostConnectionRequest = CognitiveAppAuthority & {
  connectionId: string;
};
export type CognitiveAppViewBindingRequest = {
  viewId: string;
  projectId: string;
  appId: string;
  version: string;
  connectionId: string;
  expectedViewRevision: number;
  expectedBindingRevision: number;
  now: string;
};

type VersionRow = {
  app_id: string;
  version: string;
  installation_id: string;
  definition_hash: string;
  definition_json: string;
  installed_by_principal_id: string;
  installed_at: string;
};
type GrantRow = {
  app_id: string;
  version: string;
  state: CognitiveAppGrant["state"];
  revision: number | string;
  consented_at: string;
  updated_at: string;
};
type ConnectionRow = {
  connection_id: string;
  owner_principal_id: string;
  app_id: string;
  instance_id: string;
  service_id: string;
  data_authority_id: string;
  host_binding_id: string;
  state: CognitiveAppConnection["state"];
  revision: number | string;
  created_at: string;
  updated_at: string;
};
type ConnectionPublicRow = Omit<
  ConnectionRow,
  "host_binding_id" | "owner_principal_id"
>;
type InstanceRow = {
  instance_id: string;
  app_id: string;
  route_kind: string;
  node_id: string | null;
  route_ref: string;
  state: string;
  service_id: string;
  data_authority_id: string;
};
type BindingRow = {
  view_id: string;
  owner_principal_id: string;
  project_id: string;
  app_id: string;
  version: string;
  instance_id: string;
  connection_id: string;
  revision: number | string;
  created_at: string;
  updated_at: string;
};
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const grantDto = (row: GrantRow): CognitiveAppGrant => ({
  appId: row.app_id,
  version: row.version,
  state: row.state,
  revision: safeInteger(row.revision, "应用许可修订"),
  consentedAt: row.consented_at,
  updatedAt: row.updated_at,
});
const connectionDto = (row: ConnectionPublicRow): CognitiveAppConnection => ({
  appId: row.app_id,
  instanceId: row.instance_id,
  serviceId: row.service_id,
  dataAuthorityId: row.data_authority_id,
  connectionId: row.connection_id,
  state: row.state,
  revision: safeInteger(row.revision, "应用连接修订"),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Pure persistence helper, not a credential verifier or an application API.
 * Await no network, UI bytes or Runtime verifier while its transaction is held.
 * PostgreSQL lock order: installation → grant → instance → connection → view;
 * command identity and project policy locks belong to the outer caller first.
 */
export function createCognitiveAppRegistry(ctx: CognitiveAppRegistryContext) {
  const { q, backend, tenantId, principalId, fail } = ctx;
  const shared = backend === "postgres" ? " FOR SHARE" : "";
  const exclusive = backend === "postgres" ? " FOR UPDATE" : "";
  const id = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
      fail("invalid", "应用操作标识无效。");
  };
  const app = (value: string) => {
    if (
      typeof value !== "string" ||
      !/^[a-z][a-z0-9.-]{2,80}$/.test(value) ||
      value.startsWith("morphz.")
    )
      fail("invalid", "第三方应用标识无效。");
  };
  const versionId = (value: string) => {
    if (
      typeof value !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(value) ||
      value.length > 100
    )
      fail("invalid", "应用版本无效。");
  };
  const reference = (value: string) => {
    if (!isPortableText(value) || value.length < 1 || value.length > 200)
      fail("invalid", "保存方标识无效。");
  };
  const alias = (value: string) => {
    if (
      typeof value !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(value)
    )
      fail("invalid", "Host 连接标识必须是不含地址或凭据的 opaque 标识。");
  };
  const revision = (value: number, zero = false) => {
    if (
      !Number.isSafeInteger(value) ||
      value < (zero ? 0 : 1) ||
      value >= Number.MAX_SAFE_INTEGER
    )
      fail("invalid", "应用修订前提无效。");
  };
  const time = (value: string) => {
    if (
      typeof value !== "string" ||
      value.length > 40 ||
      !Number.isFinite(Date.parse(value))
    )
      fail("invalid", "应用操作时间无效。");
  };
  id(tenantId);
  id(principalId);
  const advisory = async (kind: string, parts: readonly string[]) => {
    if (backend === "postgres")
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked",
        [JSON.stringify(["cognitive-registry/v1", kind, tenantId, ...parts])],
      );
  };
  const routeRef = (
    appId: string,
    serviceId: string,
    dataAuthorityId: string,
  ) =>
    `cognitive_authority_${digest(JSON.stringify([tenantId, appId, serviceId, dataAuthorityId]))}`;
  async function installation(appId: string, active = true) {
    const row = (
      await q.all<{ installation_id: string; state: string }>(
        `SELECT installation_id,state FROM app_installations WHERE tenant_id=? AND app_id=?${shared}`,
        [tenantId, appId],
      )
    )[0];
    if (!row) return fail("not_found", "应用尚未安装。");
    if (active && row.state !== "active")
      fail("forbidden", "应用安装已停用或不可用。");
    return row;
  }
  function definitionDto(row: VersionRow): CognitiveAppVersion {
    let definition: CognitiveAppDefinition;
    let canonical: string;
    try {
      definition = parseCognitiveAppDefinition(JSON.parse(row.definition_json));
      canonical = new TextDecoder().decode(canonicalJsonBytes(definition));
    } catch {
      return fail("conflict", "已安装的应用定义不符合固定协议。");
    }
    if (
      definition.id !== row.app_id ||
      definition.version !== row.version ||
      canonical !== row.definition_json ||
      digest(canonical) !== row.definition_hash
    )
      fail("conflict", "已安装的应用定义身份或摘要不一致。");
    return {
      appId: row.app_id,
      version: row.version,
      installationId: row.installation_id,
      definitionHash: row.definition_hash,
      definition,
      installedByPrincipalId: row.installed_by_principal_id,
      installedAt: row.installed_at,
    };
  }
  async function exactVersion(appId: string, version: string) {
    app(appId);
    versionId(version);
    const row = (
      await q.all<VersionRow>(
        "SELECT app_id,version,installation_id,definition_hash,definition_json,installed_by_principal_id,installed_at FROM cognitive_app_versions WHERE tenant_id=? AND app_id=? AND version=?",
        [tenantId, appId, version],
      )
    )[0];
    if (!row) return fail("not_found", "应用的精确版本尚未安装。");
    return definitionDto(row);
  }
  async function ownGrant(appId: string, version: string, lock = shared) {
    const row = (
      await q.all<GrantRow>(
        `SELECT app_id,version,state,revision,consented_at,updated_at FROM cognitive_app_grants WHERE tenant_id=? AND principal_id=? AND app_id=? AND version=?${lock}`,
        [tenantId, principalId, appId, version],
      )
    )[0];
    if (!row || row.state !== "active")
      return fail("forbidden", "本人尚未同意这个应用版本或许可已停用。");
    return grantDto(row);
  }
  async function ownConnection(connectionId: string, lock = "") {
    id(connectionId);
    const row = (
      await q.all<ConnectionRow>(
        `SELECT connection_id,owner_principal_id,app_id,instance_id,service_id,data_authority_id,host_binding_id,state,revision,created_at,updated_at FROM cognitive_app_connections WHERE tenant_id=? AND connection_id=? AND owner_principal_id=?${lock}`,
        [tenantId, connectionId, principalId],
      )
    )[0];
    if (!row) return fail("not_found", "应用连接不存在或不属于本人。");
    return row;
  }
  async function exactInstance(
    expected: CognitiveAppAuthority,
    active: boolean,
  ) {
    const row = (
      await q.all<InstanceRow>(
        `SELECT i.instance_id,i.app_id,i.route_kind,i.node_id,i.route_ref,i.state,a.service_id,a.data_authority_id FROM app_instances i JOIN cognitive_app_authorities a ON a.tenant_id=i.tenant_id AND a.app_id=i.app_id AND a.instance_id=i.instance_id WHERE i.tenant_id=? AND i.app_id=? AND i.instance_id=?${backend === "postgres" ? " FOR SHARE OF i,a" : ""}`,
        [tenantId, expected.appId, expected.instanceId],
      )
    )[0];
    if (!row) return fail("not_found", "应用的固定保存方不存在。");
    if (
      row.service_id !== expected.serviceId ||
      row.data_authority_id !== expected.dataAuthorityId ||
      row.route_kind !== "service" ||
      row.node_id !== null ||
      row.route_ref !==
        routeRef(expected.appId, expected.serviceId, expected.dataAuthorityId)
    )
      fail(
        "conflict",
        "应用保存方身份或稳定服务路由不一致；不能改为节点转发。",
      );
    if (active && row.state !== "active")
      fail("forbidden", "应用保存方已停用或不可用。");
    return row;
  }

  async function installVersion(
    input: unknown,
    now: string,
  ): Promise<CognitiveAppVersion> {
    time(now);
    let definition: CognitiveAppDefinition;
    let canonical: string;
    try {
      definition = parseCognitiveAppDefinition(input);
      canonical = new TextDecoder().decode(canonicalJsonBytes(definition));
    } catch {
      return fail("invalid", "应用定义不符合有界声明协议。");
    }
    app(definition.id);
    if (definition.ui !== null)
      fail(
        "invalid",
        "界面字节尚未通过真实 Store 来源与 SHA 核验；当前入口仅安装 headless 定义。",
      );
    const definitionHash = digest(canonical);
    await advisory("installation", [definition.id]);
    const identity = await ensureApplicationInstallation(q, {
      tenantId,
      appId: definition.id,
      proposedInstallationId: `install_cognitive_${digest(JSON.stringify([tenantId, definition.id])).slice(0, 64)}`,
      installedAt: now,
    });
    await installation(definition.id);
    await q.change(
      "INSERT INTO cognitive_app_versions(tenant_id,app_id,version,installation_id,definition_hash,definition_json,installed_by_principal_id,installed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,app_id,version) DO NOTHING",
      [
        tenantId,
        definition.id,
        definition.version,
        identity.installationId,
        definitionHash,
        canonical,
        principalId,
        now,
      ],
    );
    const retained = await exactVersion(definition.id, definition.version);
    if (retained.definitionHash !== definitionHash)
      fail("conflict", "同一应用版本已经固定另一份不可变定义。");
    return retained;
  }

  async function changeOwnGrant(
    request: CognitiveAppGrantChange,
  ): Promise<CognitiveAppGrant> {
    const { appId, version, expectedRevision, state, now } = request;
    app(appId);
    versionId(version);
    revision(expectedRevision, true);
    time(now);
    if (state !== "active" && state !== "disabled")
      fail("invalid", "应用许可状态无效。");
    await installation(appId);
    await exactVersion(appId, version);
    await advisory("grant", [principalId, appId, version]);
    const current = (
      await q.all<GrantRow>(
        `SELECT app_id,version,state,revision,consented_at,updated_at FROM cognitive_app_grants WHERE tenant_id=? AND principal_id=? AND app_id=? AND version=?${exclusive}`,
        [tenantId, principalId, appId, version],
      )
    )[0];
    if (!current) {
      if (expectedRevision !== 0 || state !== "active")
        fail("conflict", "首次应用许可必须以修订零显式同意。");
      await q.change(
        "INSERT INTO cognitive_app_grants VALUES(?,?,?,?,?,1,?,?)",
        [tenantId, principalId, appId, version, state, now, now],
      );
    } else {
      if (safeInteger(current.revision, "应用许可修订") !== expectedRevision)
        fail("conflict", "应用许可已变化，请读取当前修订。");
      const changed = await q.change(
        "UPDATE cognitive_app_grants SET state=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND principal_id=? AND app_id=? AND version=? AND revision=?",
        [state, now, tenantId, principalId, appId, version, expectedRevision],
      );
      if (changed !== 1) fail("conflict", "应用许可修订冲突。");
    }
    return grantDto(
      (
        await q.all<GrantRow>(
          "SELECT app_id,version,state,revision,consented_at,updated_at FROM cognitive_app_grants WHERE tenant_id=? AND principal_id=? AND app_id=? AND version=?",
          [tenantId, principalId, appId, version],
        )
      )[0]!,
    );
  }

  /** Tuple is evidence already authenticated by Host /describe, not author
   * request authority. Its physical URL/credentials never enter this relation.
   */
  async function ensureAuthority(
    request: CognitiveAppAuthorityRequest,
  ): Promise<CognitiveAppAuthority> {
    const { appId, serviceId, dataAuthorityId, now } = request;
    app(appId);
    reference(serviceId);
    reference(dataAuthorityId);
    time(now);
    await installation(appId);
    if (
      !(
        await q.all(
          "SELECT 1 AS present FROM cognitive_app_versions WHERE tenant_id=? AND app_id=? LIMIT 1",
          [tenantId, appId],
        )
      ).length
    )
      fail("not_found", "保存方接入缺少已安装的领域定义。");
    await advisory("authority", [appId, serviceId, dataAuthorityId]);
    const current = (
      await q.all<{ instance_id: string }>(
        "SELECT instance_id FROM cognitive_app_authorities WHERE tenant_id=? AND app_id=? AND service_id=? AND data_authority_id=?",
        [tenantId, appId, serviceId, dataAuthorityId],
      )
    )[0];
    const instanceId =
      current?.instance_id ??
      `cognitive_instance_${digest(JSON.stringify([tenantId, appId, serviceId, dataAuthorityId]))}`;
    const authority = { appId, instanceId, serviceId, dataAuthorityId };
    if (!current) {
      await q.change(
        "INSERT INTO app_instances(tenant_id,app_id,instance_id,route_kind,node_id,route_ref,revision,state,created_at) VALUES(?,?,?,'service',NULL,?,1,'active',?) ON CONFLICT(tenant_id,instance_id) DO NOTHING",
        [
          tenantId,
          appId,
          instanceId,
          routeRef(appId, serviceId, dataAuthorityId),
          now,
        ],
      );
      const instance = (
        await q.all<{
          app_id: string;
          route_kind: string;
          node_id: string | null;
          route_ref: string;
          state: string;
        }>(
          `SELECT app_id,route_kind,node_id,route_ref,state FROM app_instances WHERE tenant_id=? AND instance_id=?${shared}`,
          [tenantId, instanceId],
        )
      )[0];
      if (!instance) return fail("conflict", "保存方实例标识未能保留。");
      if (
        instance.app_id !== appId ||
        instance.route_kind !== "service" ||
        instance.node_id !== null ||
        instance.route_ref !== routeRef(appId, serviceId, dataAuthorityId)
      )
        fail("conflict", "保存方实例标识已绑定其他不可变目标。");
      if (instance.state !== "active") fail("forbidden", "保存方实例已停用。");
      await q.change(
        "INSERT INTO cognitive_app_authorities VALUES(?,?,?,?,?)",
        [tenantId, appId, instanceId, serviceId, dataAuthorityId],
      );
    }
    await exactInstance(authority, true);
    return authority;
  }

  async function createOwnConnection(
    request: CognitiveAppConnectionCreate,
  ): Promise<CognitiveAppConnection> {
    const { appId, version, connectionId, hostBindingId, now } = request;
    app(appId);
    versionId(version);
    id(connectionId);
    alias(hostBindingId);
    time(now);
    if (request.expectedRevision !== 0)
      fail("invalid", "首次连接必须使用修订零。");
    await installation(appId);
    await exactVersion(appId, version);
    await ownGrant(appId, version);
    const authority = await ensureAuthority(request);
    await advisory("connection", [connectionId]);
    const existing = (
      await q.all<{ owner_principal_id: string }>(
        `SELECT owner_principal_id FROM cognitive_app_connections WHERE tenant_id=? AND connection_id=?${exclusive}`,
        [tenantId, connectionId],
      )
    )[0];
    if (existing) {
      if (existing.owner_principal_id !== principalId)
        fail("not_found", "应用连接不存在或不属于本人。");
      fail("conflict", "应用连接已存在，请使用当前修订修改。");
    }
    await q.change(
      "INSERT INTO cognitive_app_connections VALUES(?,?,?,?,?,?,?,?,'active',1,?,?)",
      [
        tenantId,
        connectionId,
        principalId,
        appId,
        authority.instanceId,
        authority.serviceId,
        authority.dataAuthorityId,
        hostBindingId,
        now,
        now,
      ],
    );
    return connectionDto(await ownConnection(connectionId));
  }

  async function changeOwnConnection(
    request: CognitiveAppConnectionChange,
  ): Promise<CognitiveAppConnection> {
    const {
      connectionId,
      expectedRevision,
      serviceId,
      dataAuthorityId,
      hostBindingId,
      state,
      now,
    } = request;
    id(connectionId);
    revision(expectedRevision);
    reference(serviceId);
    reference(dataAuthorityId);
    alias(hostBindingId);
    time(now);
    if (!["active", "disabled", "unavailable"].includes(state))
      fail("invalid", "应用连接状态无效。");
    const before = await ownConnection(connectionId);
    if (request.expectedAppId !== undefined) {
      app(request.expectedAppId);
      if (before.app_id !== request.expectedAppId)
        fail("conflict", "原连接不属于 Host 已核应用。");
    }
    await installation(before.app_id, state === "active");
    await exactInstance(connectionDto(before), state === "active");
    const current = await ownConnection(connectionId, exclusive);
    if (
      current.app_id !== before.app_id ||
      current.instance_id !== before.instance_id ||
      current.service_id !== serviceId ||
      current.data_authority_id !== dataAuthorityId ||
      current.host_binding_id !== hostBindingId
    )
      fail("conflict", "原件保存方与 Host 路由已固定；更换入口必须新建连接。");
    if (safeInteger(current.revision, "应用连接修订") !== expectedRevision)
      fail("conflict", "应用连接已变化，请读取当前修订。");
    const changed = await q.change(
      "UPDATE cognitive_app_connections SET state=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND connection_id=? AND owner_principal_id=? AND revision=?",
      [state, now, tenantId, connectionId, principalId, expectedRevision],
    );
    if (changed !== 1) fail("conflict", "应用连接修订冲突。");
    return connectionDto(await ownConnection(connectionId));
  }

  async function readOwnRegistry(
    request: CognitiveAppRegistryCatalogRequest,
  ): Promise<CognitiveAppRegistryCatalog> {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    )
      fail("invalid", "应用目录分页范围为 1 到 100。");
    if (request.appId !== undefined) app(request.appId);
    // Cursors are bounded scoped sort positions, not credentials or a stored
    // workspace snapshot. Versions and connections advance independently.
    const cursorScope = (kind: string) => [
      1,
      kind,
      tenantId,
      principalId,
      request.appId ?? null,
    ];
    const cursor = (kind: string, sortApp: string, tail: string) =>
      Buffer.from(
        JSON.stringify([...cursorScope(kind), sortApp, tail]),
      ).toString("base64url");
    const decode = (
      value: string | undefined,
      kind: "versions" | "connections",
    ): [string, string] | null => {
      if (value === undefined) return null;
      let parsed: unknown;
      try {
        if (
          typeof value !== "string" ||
          value.length > 1024 ||
          !/^[a-zA-Z0-9_-]+$/.test(value)
        )
          throw new Error();
        const bytes = Buffer.from(value, "base64url");
        if (bytes.toString("base64url") !== value) throw new Error();
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return fail("invalid", "应用目录 continuation 无效。");
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 7 ||
        JSON.stringify(parsed.slice(0, 5)) !==
          JSON.stringify(cursorScope(kind)) ||
        typeof parsed[5] !== "string" ||
        typeof parsed[6] !== "string"
      )
        return fail("invalid", "应用目录 continuation 不属于当前查询范围。");
      app(parsed[5]);
      if (kind === "versions") versionId(parsed[6]);
      else id(parsed[6]);
      return [parsed[5], parsed[6]];
    };
    const versionAfter = decode(request.versionsAfter, "versions");
    const connectionAfter = decode(request.connectionsAfter, "connections");
    const filter = request.appId === undefined ? "" : " AND v.app_id=?";
    const versions = await q.all<
      VersionRow & {
        grant_state: CognitiveAppGrant["state"];
        grant_revision: number | string;
        consented_at: string;
        grant_updated_at: string;
      }
    >(
      `SELECT v.app_id,v.version,v.installation_id,v.definition_hash,v.definition_json,v.installed_by_principal_id,v.installed_at,g.state AS grant_state,g.revision AS grant_revision,g.consented_at,g.updated_at AS grant_updated_at FROM cognitive_app_versions v JOIN cognitive_app_grants g ON g.tenant_id=v.tenant_id AND g.app_id=v.app_id AND g.version=v.version WHERE g.tenant_id=? AND g.principal_id=?${filter}${versionAfter ? " AND (v.app_id>? OR (v.app_id=? AND v.version>?))" : ""} ORDER BY v.app_id,v.version LIMIT ?`,
      [
        tenantId,
        principalId,
        ...(request.appId === undefined ? [] : [request.appId]),
        ...(versionAfter
          ? [versionAfter[0], versionAfter[0], versionAfter[1]]
          : []),
        request.limit + 1,
      ],
    );
    const rows = await q.all<ConnectionPublicRow>(
      `SELECT connection_id,app_id,instance_id,service_id,data_authority_id,state,revision,created_at,updated_at FROM cognitive_app_connections WHERE tenant_id=? AND owner_principal_id=?${request.appId === undefined ? "" : " AND app_id=?"}${connectionAfter ? " AND (app_id>? OR (app_id=? AND connection_id>?))" : ""} ORDER BY app_id,connection_id LIMIT ?`,
      [
        tenantId,
        principalId,
        ...(request.appId === undefined ? [] : [request.appId]),
        ...(connectionAfter
          ? [connectionAfter[0], connectionAfter[0], connectionAfter[1]]
          : []),
        request.limit + 1,
      ],
    );
    return {
      versions: versions.slice(0, request.limit).map((row) => ({
        ...definitionDto(row),
        grant: grantDto({
          app_id: row.app_id,
          version: row.version,
          state: row.grant_state,
          revision: row.grant_revision,
          consented_at: row.consented_at,
          updated_at: row.grant_updated_at,
        }),
      })),
      connections: rows.slice(0, request.limit).map(connectionDto),
      nextVersionsAfter:
        versions.length > request.limit
          ? cursor(
              "versions",
              versions[request.limit - 1]!.app_id,
              versions[request.limit - 1]!.version,
            )
          : null,
      nextConnectionsAfter:
        rows.length > request.limit
          ? cursor(
              "connections",
              rows[request.limit - 1]!.app_id,
              rows[request.limit - 1]!.connection_id,
            )
          : null,
    };
  }

  /** Exact immutable version retained for Host recovery/state management even
   * after consent is revoked. Not operation/dispatch authority. */
  async function lockRetainedVersion(
    request: Omit<CognitiveAppConsentRequest, "expectedGrantRevision">,
  ): Promise<CognitiveAppVersion> {
    app(request.appId);
    versionId(request.version);
    if (
      request.expectedDefinitionHash !== undefined &&
      !/^[a-f0-9]{64}$/.test(request.expectedDefinitionHash)
    )
      fail("invalid", "应用定义摘要前提无效。");
    const installationRow = await installation(request.appId, false);
    const version = await exactVersion(request.appId, request.version);
    if (
      version.installationId !== installationRow.installation_id ||
      (request.expectedDefinitionHash !== undefined &&
        request.expectedDefinitionHash !== version.definitionHash)
    )
      fail("conflict", "应用固定定义已变化。");
    return version;
  }

  async function lockOwnConsent(request: CognitiveAppConsentRequest): Promise<{
    version: CognitiveAppVersion;
    grant: CognitiveAppGrant;
  }> {
    const version = await lockRetainedVersion(request);
    await installation(request.appId);
    if (request.expectedGrantRevision !== undefined)
      revision(request.expectedGrantRevision);
    const grant = await ownGrant(request.appId, request.version);
    if (
      request.expectedGrantRevision !== undefined &&
      request.expectedGrantRevision !== grant.revision
    )
      fail("conflict", "本人应用许可修订已变化。");
    return { version, grant };
  }

  async function lockCurrentTarget(
    request: CognitiveAppTargetRequest,
  ): Promise<CognitiveAppTargetSnapshot> {
    id(request.connectionId);
    if (request.expectedConnectionRevision !== undefined)
      revision(request.expectedConnectionRevision);
    const { version, grant } = await lockOwnConsent(request);
    const before = await ownConnection(request.connectionId);
    if (before.app_id !== request.appId)
      fail("conflict", "连接不属于这个应用。");
    const authority = connectionDto(before);
    await exactInstance(authority, true);
    const connection = await ownConnection(request.connectionId, shared);
    if (
      connection.app_id !== before.app_id ||
      connection.instance_id !== before.instance_id ||
      connection.service_id !== before.service_id ||
      connection.data_authority_id !== before.data_authority_id
    )
      fail("conflict", "应用连接的不可变保存方已变化。");
    if (connection.state !== "active")
      fail("forbidden", "应用连接已停用或不可用。");
    const connectionRevision = safeInteger(connection.revision, "应用连接修订");
    if (
      (request.expectedGrantRevision !== undefined &&
        request.expectedGrantRevision !== grant.revision) ||
      (request.expectedConnectionRevision !== undefined &&
        request.expectedConnectionRevision !== connectionRevision)
    )
      fail("conflict", "应用许可或连接修订已变化。");
    return {
      appId: version.appId,
      version: version.version,
      definitionHash: version.definitionHash,
      definition: version.definition,
      installationId: version.installationId,
      instanceId: authority.instanceId,
      serviceId: authority.serviceId,
      dataAuthorityId: authority.dataAuthorityId,
      connectionId: connection.connection_id,
      connectionRevision,
      grantRevision: grant.revision,
    };
  }

  /** Host-only exact alias accessor. It does not authorize an operation or
   * receipt recovery: that purpose must come from the caller's durable source.
   * Inactive instance/grant cannot erase an old admitted target, but a revoked
   * personal connection must not be used even for a new receipt query.
   */
  async function readHostConnection(
    expected: CognitiveAppHostConnectionRequest,
  ): Promise<CognitiveAppConnection & { hostBindingId: string }> {
    app(expected.appId);
    id(expected.instanceId);
    reference(expected.serviceId);
    reference(expected.dataAuthorityId);
    const before = await ownConnection(expected.connectionId);
    if (
      before.app_id !== expected.appId ||
      before.instance_id !== expected.instanceId ||
      before.service_id !== expected.serviceId ||
      before.data_authority_id !== expected.dataAuthorityId
    )
      fail("conflict", "Host 请求与原连接的固定保存方不一致。");
    await exactInstance(expected, false);
    const row = await ownConnection(expected.connectionId, shared);
    if (
      row.app_id !== expected.appId ||
      row.instance_id !== expected.instanceId ||
      row.service_id !== expected.serviceId ||
      row.data_authority_id !== expected.dataAuthorityId
    )
      fail("conflict", "Host 请求与原连接的固定保存方不一致。");
    if (row.state !== "active") fail("forbidden", "本人连接已停用或不可用。");
    return { ...connectionDto(row), hostBindingId: row.host_binding_id };
  }

  async function bindOwnView(
    request: CognitiveAppViewBindingRequest,
  ): Promise<CognitiveAppViewBinding> {
    id(request.viewId);
    id(request.projectId);
    revision(request.expectedViewRevision);
    revision(request.expectedBindingRevision, true);
    time(request.now);
    const target = await lockCurrentTarget(request);
    if (target.definition.ui === null)
      fail(
        "invalid",
        "Headless 应用没有经核验的界面，不能凭旧 UI 窗口创建领域绑定。",
      );
    const view = (
      await q.all<{
        view_id: string;
        project_id: string;
        app_id: string;
        package_version: string;
        revision: number | string;
        status: string;
      }>(
        `SELECT view_id,project_id,app_id,package_version,revision,status FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND view_id=?${exclusive}`,
        [tenantId, principalId, request.viewId],
      )
    )[0];
    if (!view) return fail("not_found", "应用窗口不存在或不属于本人。");
    if (
      view.project_id !== request.projectId ||
      view.app_id !== request.appId ||
      view.package_version !== request.version
    )
      fail("conflict", "窗口不属于这个精确项目与应用版本。");
    if (
      view.status !== "open" ||
      safeInteger(view.revision, "应用窗口修订") !==
        request.expectedViewRevision
    )
      fail("conflict", "应用窗口已关闭或修订变化。");
    const current = (
      await q.all<BindingRow>(
        `SELECT view_id,owner_principal_id,project_id,app_id,version,instance_id,connection_id,revision,created_at,updated_at FROM cognitive_app_view_bindings WHERE tenant_id=? AND view_id=?${exclusive}`,
        [tenantId, request.viewId],
      )
    )[0];
    if (
      (current ? safeInteger(current.revision, "窗口绑定修订") : 0) !==
      request.expectedBindingRevision
    )
      fail("conflict", "窗口保存方绑定已变化。");
    if (
      current &&
      (current.owner_principal_id !== principalId ||
        current.project_id !== request.projectId ||
        current.app_id !== request.appId ||
        current.version !== request.version)
    )
      fail("conflict", "窗口绑定的不可变所有权不一致。");
    const dto = (
      row: BindingRow,
      viewRevision: number,
    ): CognitiveAppViewBinding => ({
      appId: row.app_id,
      version: row.version,
      instanceId: row.instance_id,
      serviceId: target.serviceId,
      dataAuthorityId: target.dataAuthorityId,
      viewId: row.view_id,
      projectId: row.project_id,
      connectionId: row.connection_id,
      revision: safeInteger(row.revision, "窗口绑定修订"),
      viewRevision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    if (
      current?.connection_id === target.connectionId &&
      current.instance_id === target.instanceId
    )
      return dto(current, request.expectedViewRevision);
    if (current) {
      const changed = await q.change(
        "UPDATE cognitive_app_view_bindings SET instance_id=?,connection_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND view_id=? AND owner_principal_id=? AND revision=?",
        [
          target.instanceId,
          target.connectionId,
          request.now,
          tenantId,
          request.viewId,
          principalId,
          request.expectedBindingRevision,
        ],
      );
      if (changed !== 1) fail("conflict", "窗口绑定修订冲突。");
    } else
      await q.change(
        "INSERT INTO cognitive_app_view_bindings VALUES(?,?,?,?,?,?,?,?,1,?,?)",
        [
          tenantId,
          request.viewId,
          principalId,
          request.projectId,
          request.appId,
          request.version,
          target.instanceId,
          target.connectionId,
          request.now,
          request.now,
        ],
      );
    const changed = await q.change(
      "UPDATE app_view_instances SET state_json='{}',revision=revision+1,updated_at=? WHERE tenant_id=? AND view_id=? AND owner_principal_id=? AND project_id=? AND app_id=? AND package_version=? AND status='open' AND revision=?",
      [
        request.now,
        tenantId,
        request.viewId,
        principalId,
        request.projectId,
        request.appId,
        request.version,
        request.expectedViewRevision,
      ],
    );
    if (changed !== 1) fail("conflict", "窗口导航清空修订冲突。");
    const row = (
      await q.all<BindingRow>(
        "SELECT view_id,owner_principal_id,project_id,app_id,version,instance_id,connection_id,revision,created_at,updated_at FROM cognitive_app_view_bindings WHERE tenant_id=? AND view_id=?",
        [tenantId, request.viewId],
      )
    )[0]!;
    return dto(row, request.expectedViewRevision + 1);
  }

  /** Host-only Human management metadata. Disabling an owned connection must
   * not require credentials or a still-active instance/grant. This does not
   * grant dispatch or receipt-read authority; those purposes use their gates. */
  async function readOwnConnectionForManagement(request: {
    appId: string;
    connectionId: string;
  }): Promise<CognitiveAppConnection & { hostBindingId: string }> {
    app(request.appId);
    const row = await ownConnection(request.connectionId);
    if (row.app_id !== request.appId)
      return fail("not_found", "应用连接不存在或不属于本人。");
    return { ...connectionDto(row), hostBindingId: row.host_binding_id };
  }

  return {
    installVersion,
    changeOwnGrant,
    ensureAuthority,
    createOwnConnection,
    changeOwnConnection,
    readOwnRegistry,
    lockCurrentTarget,
    lockOwnConsent,
    lockRetainedVersion,
    /** Immutable declaration read only, not consent/connection authority. */
    readExactVersion: exactVersion,
    readHostConnection,
    readOwnConnectionForManagement,
    bindOwnView,
  };
}
