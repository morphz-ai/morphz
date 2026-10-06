import { createHash } from "node:crypto";
import {
  parseCognitiveAppDefinition,
  isPortableText,
  type CognitiveAppDefinition,
} from "../../cognitive-app-sdk/src/protocol.js";
import { canonicalJsonBytes } from "../../cognitive-app-sdk/src/domain-wire.js";
import { safeInteger, type SqlQuery } from "../../storage/src/sql.js";
import { ensureApplicationInstallation } from "./application-installation.js";
import {
  applicationInstanceSchema,
  uiPackageHeaderSchema,
  type ApplicationInstance,
  type UiPackageHeader,
} from "../../core/src/applications.js";
import {
  readCognitiveAppUiByteProof,
  parseCognitiveAppUiHeader,
} from "./cognitive-app-ui-proof.js";
import {
  parseBrowserNavigationState,
  type BrowserNavigationState,
} from "../../cognitive-app-sdk/src/browser-wire.js";
import { parseCognitiveAppCatalog } from "../../core/src/cognitive-app-api.js";
import type {
  CognitiveAppViewLocation,
  CognitiveAppViewRequestMap,
} from "../../core/src/cognitive-app-view-api.js";

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
  versions: CognitiveAppCatalogVersion[];
  connections: CognitiveAppConnection[];
  nextVersionsAfter: string | null;
  nextConnectionsAfter: string | null;
};
export type CognitiveAppCatalogVersion = CognitiveAppVersion & {
  grant: CognitiveAppGrant | null;
  registeredAt: string;
  installationState: "active" | "disabled" | "unavailable";
};
/** Shared exact whitelist for paging budgets and the public Service projection. */
export function cognitiveAppCatalogMetadata(entry: CognitiveAppCatalogVersion) {
  const {
    appId,
    version,
    definitionHash,
    definition,
    grant,
    registeredAt,
    installationState,
  } = entry;
  const creationIntents = definition.operations.flatMap((operation) =>
    operation.compose === undefined
      ? []
      : [
          {
            operationId: operation.id,
            label: operation.compose.label,
            ...(operation.compose.prompt === undefined
              ? {}
              : { prompt: operation.compose.prompt }),
          },
        ],
  );
  return {
    appId,
    version,
    definitionHash,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    ...(definition.iconImage === undefined
      ? {}
      : { iconImage: definition.iconImage }),
    harness: definition.harness,
    ui: definition.ui,
    grant,
    registeredAt,
    installationState,
    ...(creationIntents.length ? { creationIntents } : {}),
  };
}
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
export type CognitiveAppViewMetadata = {
  view: ApplicationInstance;
  binding: CognitiveAppViewBinding | null;
};
/** Host-private exact installed-byte reference, never an author/renderer owner selector. */
export type CognitiveAppUiPackage = {
  appId: string;
  version: string;
  installedByPrincipalId: string;
  header: UiPackageHeader;
  storeId: string;
  artifactId: string;
  artifactRevision: number;
  sha256: string;
  byteLength: number;
  installedAt: string;
};
export type CognitiveAppViewCas = {
  viewId: string;
  expectedViewRevision: number;
  expectedBindingRevision: number;
};
type ViewRow = {
  view_id: string;
  project_id: string;
  app_id: string;
  package_version: string;
  state_json: string;
  revision: number | string;
  status: "open" | "closed";
  created_at: string;
  updated_at: string;
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
    verifiedUi?: unknown,
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
    const definitionHash = digest(canonical);
    const proof = readCognitiveAppUiByteProof(verifiedUi);
    if (definition.ui !== null) {
      if (!proof)
        return fail("invalid", "界面字节缺少实际 Host 核验的安装证明。");
      if (proof.tenantId !== tenantId || proof.principalId !== principalId)
        fail("forbidden", "界面字节安装证明不属于当前真实本人。");
      if (
        proof.purpose !== "cognitive-ui-installation" ||
        proof.appId !== definition.id ||
        proof.version !== definition.version ||
        proof.definitionHash !== definitionHash ||
        proof.version !== definition.ui.packageVersion ||
        proof.sha256 !== definition.ui.sha256
      )
        fail("conflict", "界面字节安装证明与精确应用定义不一致。");
    }
    await advisory("installation", [definition.id]);
    const identity = await ensureApplicationInstallation(q, {
      tenantId,
      appId: definition.id,
      proposedInstallationId: `install_cognitive_${digest(JSON.stringify([tenantId, definition.id])).slice(0, 64)}`,
      installedAt: now,
    });
    await installation(definition.id);
    if (definition.ui !== null) {
      // The proof grants no SQL authority. Lock the actual immutable package
      // after its shared installation and check current installer + exact ref.
      const row = (
        await q.all<{
          app_id: string;
          package_version: string;
          installed_by_principal_id: string;
          manifest_header: string;
          store_id: string;
          artifact_id: string;
          artifact_revision: number | string;
          sha256: string;
          byte_length: number | string;
        }>(
          `SELECT app_id,package_version,installed_by_principal_id,manifest_header,store_id,artifact_id,artifact_revision,sha256,byte_length FROM app_ui_packages WHERE tenant_id=? AND app_id=? AND package_version=?${shared}`,
          [tenantId, definition.id, definition.ui.packageVersion],
        )
      )[0];
      if (!row) return fail("not_found", "精确界面包尚未实际安装。");
      if (row.installed_by_principal_id !== principalId)
        fail("forbidden", "精确界面包不属于当前实际安装者。");
      let headerHash: string, artifactRevision: number, byteLength: number;
      try {
        headerHash = digest(
          canonicalJsonBytes(
            uiPackageHeaderSchema.parse(JSON.parse(row.manifest_header)),
          ),
        );
        artifactRevision = safeInteger(row.artifact_revision, "界面包版本");
        byteLength = safeInteger(row.byte_length, "界面包字节数");
      } catch {
        return fail("conflict", "精确界面包的已安装元数据无效。");
      }
      if (
        row.app_id !== proof!.appId ||
        row.package_version !== proof!.version ||
        headerHash !== proof!.headerHash ||
        row.store_id !== proof!.storeId ||
        row.artifact_id !== proof!.artifactId ||
        artifactRevision !== proof!.artifactRevision ||
        row.sha256 !== proof!.sha256 ||
        byteLength !== proof!.byteLength
      )
        fail("conflict", "精确界面包引用已变化；不能复用此前字节证明。");
    }
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
    await ensureOwnRegistration(retained, now);
    return retained;
  }

  async function ensureOwnRegistration(
    version: CognitiveAppVersion,
    now: string,
  ): Promise<boolean> {
    time(now);
    const changed = await q.change(
      "INSERT INTO cognitive_app_registrations(tenant_id,principal_id,app_id,version,definition_hash,registered_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,principal_id,app_id,version) DO NOTHING",
      [
        tenantId,
        principalId,
        version.appId,
        version.version,
        version.definitionHash,
        now,
      ],
    );
    const own = (
      await q.all<{ definition_hash: string }>(
        "SELECT definition_hash FROM cognitive_app_registrations WHERE tenant_id=? AND principal_id=? AND app_id=? AND version=?",
        [tenantId, principalId, version.appId, version.version],
      )
    )[0];
    if (!own || own.definition_hash !== version.definitionHash)
      fail("conflict", "本人登记与不可变应用定义不一致。");
    return changed === 1;
  }

  /** A metadata import has no byte-proof, consent, connection or activation. */
  async function registerInstalled(request: {
    appId: string;
    version: string;
    definitionHash: string;
    now: string;
  }) {
    app(request.appId);
    versionId(request.version);
    time(request.now);
    if (!/^[a-f0-9]{64}$/.test(request.definitionHash))
      fail("invalid", "应用定义校验值无效。");
    await installation(request.appId, false);
    const version = await exactVersion(request.appId, request.version);
    if (version.definitionHash !== request.definitionHash)
      fail("not_found", "精确应用定义不存在或不可登记。");
    return {
      version,
      changed: await ensureOwnRegistration(version, request.now),
    };
  }

  async function readRegisteredDefinition(request: {
    appId: string;
    version: string;
    expectedDefinitionHash: string;
  }): Promise<CognitiveAppCatalogVersion> {
    app(request.appId);
    versionId(request.version);
    if (!/^[a-f0-9]{64}$/.test(request.expectedDefinitionHash))
      fail("invalid", "应用定义校验值无效。");
    const row = (
      await q.all<
        VersionRow & {
          registered_at: string;
          installation_state: CognitiveAppCatalogVersion["installationState"];
          grant_state: CognitiveAppGrant["state"] | null;
          grant_revision: number | string | null;
          consented_at: string | null;
          grant_updated_at: string | null;
        }
      >(
        "SELECT v.*,r.registered_at,i.state AS installation_state,g.state AS grant_state,g.revision AS grant_revision,g.consented_at,g.updated_at AS grant_updated_at FROM cognitive_app_registrations r JOIN cognitive_app_versions v ON v.tenant_id=r.tenant_id AND v.app_id=r.app_id AND v.version=r.version AND v.definition_hash=r.definition_hash JOIN app_installations i ON i.tenant_id=v.tenant_id AND i.app_id=v.app_id AND i.installation_id=v.installation_id LEFT JOIN cognitive_app_grants g ON g.tenant_id=r.tenant_id AND g.principal_id=r.principal_id AND g.app_id=r.app_id AND g.version=r.version WHERE r.tenant_id=? AND r.principal_id=? AND r.app_id=? AND r.version=? AND r.definition_hash=?",
        [
          tenantId,
          principalId,
          request.appId,
          request.version,
          request.expectedDefinitionHash,
        ],
      )
    )[0];
    if (!row) return fail("not_found", "本人尚未登记此精确应用定义。");
    return catalogDto(row);
  }

  type CatalogRow = VersionRow & {
    registered_at: string;
    installation_state: CognitiveAppCatalogVersion["installationState"];
    grant_state: CognitiveAppGrant["state"] | null;
    grant_revision: number | string | null;
    consented_at: string | null;
    grant_updated_at: string | null;
  };
  function catalogDto(row: CatalogRow): CognitiveAppCatalogVersion {
    if (
      row.grant_state !== null &&
      (row.grant_revision === null ||
        row.consented_at === null ||
        row.grant_updated_at === null)
    )
      return fail("conflict", "应用许可元数据不完整。");
    return {
      ...definitionDto(row),
      registeredAt: row.registered_at,
      installationState: row.installation_state,
      grant:
        row.grant_state === null
          ? null
          : grantDto({
              app_id: row.app_id,
              version: row.version,
              state: row.grant_state,
              revision: row.grant_revision!,
              consented_at: row.consented_at!,
              updated_at: row.grant_updated_at!,
            }),
    };
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
    const definition = await exactVersion(appId, version);
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
    await ensureOwnRegistration(definition, now);
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
    visibility: { mode: "registered" | "granted"; projectId?: string } = {
      mode: "granted",
    },
  ): Promise<CognitiveAppRegistryCatalog> {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    )
      fail("invalid", "应用目录分页范围为 1 到 100。");
    if (request.appId !== undefined) app(request.appId);
    const head = (
      await q.all<{ access_revision: number | string }>(
        "SELECT access_revision FROM navigation_heads WHERE tenant_id=?",
        [tenantId],
      )
    )[0];
    if (!head) return fail("conflict", "应用目录权限修订缺失。");
    const scope = digest(
      JSON.stringify([
        tenantId,
        principalId,
        visibility.mode,
        visibility.projectId ?? null,
        request.appId ?? null,
        safeInteger(head.access_revision, "应用目录权限修订"),
      ]),
    );
    type Position = [string, string] | null;
    type Checkpoint = [Position, Position];
    // Both tokens retain the last actually emitted position of BOTH streams.
    // Continuing one non-null token cannot restart the stream already at EOF.
    const cursor = (kind: string, checkpoint: Checkpoint) =>
      Buffer.from(JSON.stringify([2, kind, scope, ...checkpoint])).toString(
        "base64url",
      );
    const decode = (
      value: string | undefined,
      kind: "versions" | "connections",
    ): Checkpoint | null => {
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
        parsed.length !== 5 ||
        parsed[0] !== 2 ||
        parsed[1] !== kind ||
        parsed[2] !== scope
      )
        return fail("invalid", "应用目录 continuation 不属于当前查询范围。");
      for (const [index, position] of [parsed[3], parsed[4]].entries()) {
        if (position === null) continue;
        if (
          !Array.isArray(position) ||
          position.length !== 2 ||
          typeof position[0] !== "string" ||
          typeof position[1] !== "string"
        )
          return fail("invalid", "应用目录 continuation 位置无效。");
        app(position[0]);
        if (index === 0) versionId(position[1]);
        else id(position[1]);
      }
      return [parsed[3] as Position, parsed[4] as Position];
    };
    const vCheckpoint = decode(request.versionsAfter, "versions");
    const cCheckpoint = decode(request.connectionsAfter, "connections");
    if (
      vCheckpoint &&
      cCheckpoint &&
      JSON.stringify(vCheckpoint) !== JSON.stringify(cCheckpoint)
    )
      return fail("invalid", "应用目录 continuation 不属于同一分页检查点。");
    const before = vCheckpoint ?? cCheckpoint ?? [null, null];
    const [versionAfter, connectionAfter] = before;
    const filter = request.appId === undefined ? "" : " AND v.app_id=?";
    const versions = await q.all<CatalogRow>(
      `SELECT v.app_id,v.version,v.installation_id,v.definition_hash,v.definition_json,v.installed_by_principal_id,v.installed_at,r.registered_at,i.state AS installation_state,g.state AS grant_state,g.revision AS grant_revision,g.consented_at,g.updated_at AS grant_updated_at FROM cognitive_app_registrations r JOIN cognitive_app_versions v ON v.tenant_id=r.tenant_id AND v.app_id=r.app_id AND v.version=r.version AND v.definition_hash=r.definition_hash JOIN app_installations i ON i.tenant_id=v.tenant_id AND i.app_id=v.app_id AND i.installation_id=v.installation_id LEFT JOIN cognitive_app_grants g ON g.tenant_id=r.tenant_id AND g.principal_id=r.principal_id AND g.app_id=r.app_id AND g.version=r.version WHERE r.tenant_id=? AND r.principal_id=?${visibility.mode === "granted" ? " AND g.version IS NOT NULL" : ""}${filter}${versionAfter ? " AND (v.app_id>? OR (v.app_id=? AND v.version>?))" : ""} ORDER BY v.app_id,v.version LIMIT ?`,
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
    const selectedVersions: CognitiveAppCatalogVersion[] = [],
      selectedConnections: CognitiveAppConnection[] = [];
    let versionBytes = 2,
      connectionBytes = 2;
    for (const row of versions.slice(0, request.limit)) {
      const entry = catalogDto(row);
      const bytes =
        Buffer.byteLength(JSON.stringify(cognitiveAppCatalogMetadata(entry))) +
        (selectedVersions.length ? 1 : 0);
      if (versionBytes + bytes > 384 * 1024) break;
      selectedVersions.push(entry);
      versionBytes += bytes;
    }
    for (const row of rows.slice(0, request.limit)) {
      const entry = connectionDto(row);
      const bytes =
        Buffer.byteLength(JSON.stringify(entry)) +
        (selectedConnections.length ? 1 : 0);
      if (connectionBytes + bytes > 80 * 1024) break;
      selectedConnections.push(entry);
      connectionBytes += bytes;
    }
    if (
      (versions.length && !selectedVersions.length) ||
      (rows.length && !selectedConnections.length)
    )
      return fail("conflict", "单项应用目录元数据超过分页预算。");
    const lastV = selectedVersions.at(-1),
      lastC = selectedConnections.at(-1);
    const checkpoint: Checkpoint = [
      lastV ? [lastV.appId, lastV.version] : versionAfter,
      lastC ? [lastC.appId, lastC.connectionId] : connectionAfter,
    ];
    const result: CognitiveAppRegistryCatalog = {
      versions: selectedVersions,
      connections: selectedConnections,
      nextVersionsAfter:
        versions.length > selectedVersions.length
          ? cursor("versions", checkpoint)
          : null,
      nextConnectionsAfter:
        rows.length > selectedConnections.length
          ? cursor("connections", checkpoint)
          : null,
    };
    try {
      parseCognitiveAppCatalog({
        ...result,
        versions: result.versions.map(cognitiveAppCatalogMetadata),
      });
    } catch {
      return fail("conflict", "应用目录元数据不符合有界公开契约。");
    }
    return result;
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
    time(request.now);
    const target = await lockCurrentTarget(request);
    if (target.definition.ui === null)
      return fail(
        "invalid",
        "Headless 应用没有经核验的界面，不能凭旧 UI 窗口创建领域绑定。",
      );
    const row = await ownViewRow(request.viewId, exclusive),
      binding = await ownBinding(row, exclusive);
    if (
      row.project_id !== request.projectId ||
      row.app_id !== request.appId ||
      row.package_version !== request.version
    )
      return fail("conflict", "窗口不属于这个精确项目与应用版本。");
    viewCas(row, binding, request);
    if (row.status !== "open") return fail("conflict", "应用窗口已关闭。");
    await uiPackageForTarget(target);
    if (
      binding?.connectionId === target.connectionId &&
      binding.instanceId === target.instanceId
    )
      return binding;
    if (binding) {
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
      if (changed !== 1) return fail("conflict", "窗口绑定修订冲突。");
    } else
      await q.change(
        "INSERT INTO cognitive_app_view_bindings VALUES(?,?,?,?,?,?,?,?,1,?,?)",
        [
          tenantId,
          row.view_id,
          principalId,
          row.project_id,
          row.app_id,
          row.package_version,
          target.instanceId,
          target.connectionId,
          request.now,
          request.now,
        ],
      );
    const changed = await q.change(
      "UPDATE app_view_instances SET state_json='{}',revision=revision+1,updated_at=? WHERE tenant_id=? AND view_id=? AND owner_principal_id=? AND revision=? AND status='open'",
      [
        request.now,
        tenantId,
        request.viewId,
        principalId,
        request.expectedViewRevision,
      ],
    );
    if (changed !== 1) return fail("conflict", "窗口导航清空修订冲突。");
    return (await readOwnView(request.viewId)).binding!;
  }

  const viewColumns =
    "view_id,project_id,app_id,package_version,state_json,revision,status,created_at,updated_at";
  const bindingColumns =
    "view_id,owner_principal_id,project_id,app_id,version,instance_id,connection_id,revision,created_at,updated_at";
  function viewDto(row: ViewRow): ApplicationInstance {
    try {
      return applicationInstanceSchema.parse({
        id: row.view_id,
        workspaceId: row.project_id,
        applicationId: row.app_id,
        applicationVersion: row.package_version,
        state: JSON.parse(row.state_json),
        revision: safeInteger(row.revision, "应用窗口修订"),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch {
      return fail("conflict", "应用窗口的已保存元数据无效。");
    }
  }
  async function ownViewRow(viewId: string, lock = ""): Promise<ViewRow> {
    id(viewId);
    const row = (
      await q.all<ViewRow>(
        `SELECT ${viewColumns} FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND view_id=?${lock}`,
        [tenantId, principalId, viewId],
      )
    )[0];
    if (!row) return fail("not_found", "应用窗口不存在或不属于本人。");
    return row;
  }
  async function ownBinding(
    row: Pick<
      ViewRow,
      "view_id" | "project_id" | "app_id" | "package_version" | "revision"
    >,
    lock = "",
  ): Promise<CognitiveAppViewBinding | null> {
    const binding = (
      await q.all<BindingRow>(
        `SELECT ${bindingColumns} FROM cognitive_app_view_bindings WHERE tenant_id=? AND view_id=?${lock}`,
        [tenantId, row.view_id],
      )
    )[0];
    if (!binding) return null;
    if (
      binding.owner_principal_id !== principalId ||
      binding.project_id !== row.project_id ||
      binding.app_id !== row.app_id ||
      binding.version !== row.package_version
    )
      return fail("conflict", "窗口绑定的不可变所有权不一致。");
    const authority = (
      await q.all<{ service_id: string; data_authority_id: string }>(
        "SELECT service_id,data_authority_id FROM cognitive_app_authorities WHERE tenant_id=? AND app_id=? AND instance_id=?",
        [tenantId, binding.app_id, binding.instance_id],
      )
    )[0];
    if (!authority) return fail("conflict", "窗口的固定保存方不存在。");
    return {
      appId: binding.app_id,
      version: binding.version,
      instanceId: binding.instance_id,
      serviceId: authority.service_id,
      dataAuthorityId: authority.data_authority_id,
      viewId: binding.view_id,
      projectId: binding.project_id,
      connectionId: binding.connection_id,
      revision: safeInteger(binding.revision, "窗口绑定修订"),
      viewRevision: safeInteger(row.revision, "窗口修订"),
      createdAt: binding.created_at,
      updatedAt: binding.updated_at,
    };
  }
  /** Own metadata only, including closed/revoked windows; no byte or operation authority. */
  async function readOwnView(
    viewId: string,
  ): Promise<CognitiveAppViewMetadata> {
    const row = await ownViewRow(viewId);
    const binding = await ownBinding(row),
      view = viewDto(row);
    if (binding) {
      try {
        view.state = parseBrowserNavigationState(view.state);
      } catch {
        return fail("conflict", "领域窗口不能包含正文或无效导航。");
      }
    }
    return { view, binding };
  }
  /** Exact unique Human/project/app/version slot. This is discovery metadata,
   * not an active-target gate: disabled, closed and unbound facts stay readable.
   * Its caller has checked the actual project's reader in this same read q. */
  async function locateOwnView(
    request: CognitiveAppViewRequestMap["locate"],
  ): Promise<CognitiveAppViewLocation> {
    const registered = (
      await q.all<{ definition_hash: string }>(
        "SELECT v.definition_hash FROM cognitive_app_registrations r JOIN cognitive_app_versions v ON v.tenant_id=r.tenant_id AND v.app_id=r.app_id AND v.version=r.version AND v.definition_hash=r.definition_hash WHERE r.tenant_id=? AND r.principal_id=? AND r.app_id=? AND r.version=? AND r.definition_hash=?",
        [
          tenantId,
          principalId,
          request.appId,
          request.version,
          request.expectedDefinitionHash,
        ],
      )
    )[0];
    if (!registered) return fail("not_found", "本人精确应用登记不存在。");
    const rows = await q.all<
      Pick<
        ViewRow,
        | "view_id"
        | "project_id"
        | "app_id"
        | "package_version"
        | "revision"
        | "status"
      >
    >(
      "SELECT view_id,project_id,app_id,package_version,revision,status FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND project_id=? AND app_id=? AND package_version=?",
      [
        tenantId,
        principalId,
        request.projectId,
        request.appId,
        request.version,
      ],
    );
    // The actual UNIQUE constraint includes closed rows. Do not hide or select
    // one duplicate if a damaged projection ever violates that premise.
    if (rows.length > 1) return fail("conflict", "本人精确窗口槽不唯一。");
    const row = rows[0],
      binding = row ? await ownBinding(row) : null;
    return {
      slot: {
        projectId: request.projectId,
        appId: request.appId,
        version: request.version,
        definitionHash: registered.definition_hash,
      },
      view: row
        ? {
            viewId: row.view_id,
            viewRevision: safeInteger(row.revision, "窗口修订"),
            status: row.status,
            binding: binding
              ? {
                  bindingRevision: binding.revision,
                  connectionId: binding.connectionId,
                  instanceId: binding.instanceId,
                  serviceId: binding.serviceId,
                  dataAuthorityId: binding.dataAuthorityId,
                }
              : null,
          }
        : null,
    };
  }
  async function uiPackageForTarget(
    target: CognitiveAppTargetSnapshot,
  ): Promise<CognitiveAppUiPackage> {
    if (target.definition.ui === null)
      return fail("invalid", "无界面应用不能打开领域窗口。");
    const row = (
      await q.all<{
        app_id: string;
        package_version: string;
        installed_by_principal_id: string;
        manifest_header: string;
        store_id: string;
        artifact_id: string;
        artifact_revision: number | string;
        sha256: string;
        byte_length: number | string;
        installed_at: string;
      }>(
        `SELECT app_id,package_version,installed_by_principal_id,manifest_header,store_id,artifact_id,artifact_revision,sha256,byte_length,installed_at FROM app_ui_packages WHERE tenant_id=? AND app_id=? AND package_version=?${shared}`,
        [tenantId, target.appId, target.version],
      )
    )[0];
    if (!row) return fail("not_found", "领域窗口的精确界面包不存在。");
    const version = await exactVersion(target.appId, target.version);
    try {
      const header = parseCognitiveAppUiHeader(
        target.definition,
        JSON.parse(row.manifest_header),
      );
      if (
        row.installed_by_principal_id !== version.installedByPrincipalId ||
        row.sha256 !== target.definition.ui.sha256 ||
        row.package_version !== target.definition.ui.packageVersion
      )
        return fail("conflict", "领域窗口的精确字节安装引用已变化。");
      id(row.store_id);
      id(row.artifact_id);
      const artifactRevision = safeInteger(
          row.artifact_revision,
          "界面原件修订",
        ),
        byteLength = safeInteger(row.byte_length, "界面字节数");
      if (artifactRevision < 1 || byteLength < 1 || byteLength > 1000000)
        return fail("conflict", "界面字节引用范围无效。");
      return {
        appId: row.app_id,
        version: row.package_version,
        installedByPrincipalId: row.installed_by_principal_id,
        header,
        storeId: row.store_id,
        artifactId: row.artifact_id,
        artifactRevision,
        sha256: row.sha256,
        byteLength,
        installedAt: row.installed_at,
      };
    } catch {
      return fail("conflict", "领域界面包的已安装元数据无效。");
    }
  }
  function viewCas(
    row: ViewRow,
    binding: CognitiveAppViewBinding | null,
    request: CognitiveAppViewCas,
    absentViewPremise = false,
  ) {
    revision(request.expectedViewRevision, absentViewPremise);
    revision(request.expectedBindingRevision, true);
    if (
      safeInteger(row.revision, "窗口修订") !== request.expectedViewRevision ||
      (binding?.revision ?? 0) !== request.expectedBindingRevision
    )
      fail("conflict", "应用窗口或保存方绑定已变化。");
  }
  function targetMatches(
    row: ViewRow,
    binding: CognitiveAppViewBinding | null,
    target: CognitiveAppTargetSnapshot,
  ) {
    if (
      !binding ||
      row.app_id !== target.appId ||
      row.package_version !== target.version ||
      binding.connectionId !== target.connectionId ||
      binding.instanceId !== target.instanceId ||
      binding.serviceId !== target.serviceId ||
      binding.dataAuthorityId !== target.dataAuthorityId
    )
      fail("conflict", "应用窗口已不属于本次精确保存方。");
  }
  /** Already-current target is locked first; this rechecks actual rows under
   * locks and supplies only the exact stored UI reference, never HTML. */
  async function readOwnViewForFrame(
    request: CognitiveAppViewCas,
    target: CognitiveAppTargetSnapshot,
  ) {
    const row = await ownViewRow(request.viewId, shared);
    const binding = await ownBinding(row, shared);
    viewCas(row, binding, request);
    targetMatches(row, binding, target);
    if (row.status !== "open") return fail("conflict", "应用窗口已关闭。");
    let state: BrowserNavigationState;
    try {
      state = parseBrowserNavigationState(JSON.parse(row.state_json));
    } catch {
      return fail("conflict", "领域窗口不能读取正文或无效导航状态。");
    }
    const uiPackage = await uiPackageForTarget(target);
    return { view: { ...viewDto(row), state }, binding: binding!, uiPackage };
  }
  async function launchOwnView(
    request: CognitiveAppTargetRequest & {
      viewId: string;
      projectId: string;
      expectedViewRevision: number;
      expectedBindingRevision: number;
      now: string;
    },
  ) {
    id(request.viewId);
    id(request.projectId);
    revision(request.expectedViewRevision, true);
    revision(request.expectedBindingRevision, true);
    time(request.now);
    const target = await lockCurrentTarget(request);
    if (target.definition.ui === null)
      return fail("invalid", "无界面应用不能打开领域窗口。");
    // One owner has at most 100 open windows, including concurrent distinct tuples.
    await lockOwnViewCapacity();
    await advisory("view", [
      principalId,
      request.projectId,
      request.appId,
      request.version,
    ]);
    let row = (
      await q.all<ViewRow>(
        `SELECT ${viewColumns} FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND project_id=? AND app_id=? AND package_version=?${exclusive}`,
        [
          tenantId,
          principalId,
          request.projectId,
          request.appId,
          request.version,
        ],
      )
    )[0];
    let binding = row ? await ownBinding(row, exclusive) : null;
    if (row) viewCas(row, binding, { ...request, viewId: row.view_id }, true);
    else if (
      request.expectedViewRevision !== 0 ||
      request.expectedBindingRevision !== 0
    )
      return fail("conflict", "应用窗口尚不存在，不能复用旧修订。");
    if (!row || row.status === "closed") {
      const count = (
        await q.all<{ count: number | string }>(
          "SELECT COUNT(*) AS count FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND status='open'",
          [tenantId, principalId],
        )
      )[0];
      if (safeInteger(count?.count ?? 0, "窗口数量") >= 100)
        return fail("conflict", "打开的应用窗口已达上限。");
    }
    const same =
      binding?.connectionId === target.connectionId &&
      binding.instanceId === target.instanceId;
    if (!row) {
      await q.change(
        "INSERT INTO app_view_instances(tenant_id,view_id,owner_principal_id,project_id,app_id,package_version,state_json,revision,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}',1,'open',?,?)",
        [
          tenantId,
          request.viewId,
          principalId,
          request.projectId,
          request.appId,
          request.version,
          request.now,
          request.now,
        ],
      );
      row = await ownViewRow(request.viewId);
    } else if (!same || row.status === "closed") {
      let state = "{}";
      if (same) {
        try {
          state = JSON.stringify(
            parseBrowserNavigationState(JSON.parse(row.state_json)),
          );
        } catch {
          return fail("conflict", "领域窗口的保留导航无效。");
        }
      }
      const changed = await q.change(
        "UPDATE app_view_instances SET state_json=?,status='open',revision=revision+1,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND view_id=? AND revision=?",
        [
          state,
          request.now,
          tenantId,
          principalId,
          row.view_id,
          request.expectedViewRevision,
        ],
      );
      if (changed !== 1) return fail("conflict", "应用窗口修订冲突。");
      row = await ownViewRow(row.view_id);
    }
    if (!same) {
      if (binding) {
        const changed = await q.change(
          "UPDATE cognitive_app_view_bindings SET instance_id=?,connection_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND view_id=? AND revision=?",
          [
            target.instanceId,
            target.connectionId,
            request.now,
            tenantId,
            principalId,
            row.view_id,
            request.expectedBindingRevision,
          ],
        );
        if (changed !== 1) return fail("conflict", "窗口绑定修订冲突。");
      } else
        await q.change(
          "INSERT INTO cognitive_app_view_bindings VALUES(?,?,?,?,?,?,?,?,1,?,?)",
          [
            tenantId,
            row.view_id,
            principalId,
            row.project_id,
            row.app_id,
            row.package_version,
            target.instanceId,
            target.connectionId,
            request.now,
            request.now,
          ],
        );
    }
    await uiPackageForTarget(target);
    const metadata = await readOwnView(row.view_id);
    return { view: metadata.view, binding: metadata.binding!, target };
  }
  async function changeOwnView(
    request: CognitiveAppViewCas & {
      state?: BrowserNavigationState;
      close?: true;
      now: string;
    },
    target?: CognitiveAppTargetSnapshot,
  ) {
    time(request.now);
    if (!!request.close === (request.state !== undefined))
      return fail("invalid", "领域窗口操作无效。");
    let state: BrowserNavigationState | undefined;
    try {
      state =
        request.state === undefined
          ? undefined
          : parseBrowserNavigationState(request.state);
    } catch {
      return fail("invalid", "领域窗口只能保存有界导航。");
    }
    const row = await ownViewRow(request.viewId, exclusive),
      binding = await ownBinding(row, exclusive);
    viewCas(row, binding, request);
    if (!binding || row.status !== "open")
      return fail("conflict", "领域窗口未绑定或已关闭。");
    if (state !== undefined) {
      if (!target) return fail("invalid", "保存导航缺少当前精确保存方。");
      targetMatches(row, binding, target);
      await uiPackageForTarget(target);
    }
    const changed = await q.change(
      "UPDATE app_view_instances SET state_json=?,status=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND view_id=? AND revision=? AND status='open'",
      [
        state === undefined ? row.state_json : JSON.stringify(state),
        request.close ? "closed" : "open",
        request.now,
        tenantId,
        principalId,
        row.view_id,
        request.expectedViewRevision,
      ],
    );
    if (changed !== 1) return fail("conflict", "领域窗口修订冲突。");
    return {
      view: viewDto(await ownViewRow(row.view_id)),
      binding: { ...binding, viewRevision: request.expectedViewRevision + 1 },
    };
  }
  /** Shared with legacy launch solely to serialize the same owner capacity. */
  async function lockOwnViewCapacity() {
    await advisory("view-owner", [principalId]);
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
    registerInstalled,
    readRegisteredDefinition,
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
    readOwnView,
    locateOwnView,
    readOwnViewForFrame,
    launchOwnView,
    changeOwnView,
    uiPackageForTarget,
    lockOwnViewCapacity,
  };
}
