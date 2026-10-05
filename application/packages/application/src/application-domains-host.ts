import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import {
  localAccess,
  morphzAgentAccess,
  quotedText,
  type AccessContext,
} from "../../core/src/model.js";
import { BrowserStore } from "../../browser/src/store.js";
import { ObjectsStore } from "../../objects/src/store.js";
import { ReaderStore } from "../../reader/src/store.js";
import {
  ManagedArtifactStore,
  type StoreAuthorizationRequest,
} from "../../managed-artifact-store/src/store.js";
import type { S3ByteLocation } from "../../managed-artifact-store/src/s3-bytes.js";
import type { S3Client } from "@aws-sdk/client-s3";
import { ScriptStudioStore } from "../../script-studio/src/store.js";
import {
  PlatformStore,
  PlatformStorageError,
  type ApplicationProviderRoute,
  type PlatformAuthorityVerifier,
} from "../../platform/src/store.js";
import {
  BrowserBookmarkService,
  platformBrowserBookmarkAuthority,
} from "./browser-bookmark-service.js";
import { HumanPlatformAuthority } from "./human-platform-authority.js";
import { platformObjectsAuthority } from "./document-service.js";
import { platformScriptStudioAuthority } from "./script-production-service.js";
import { recoverEmbeddedDirectory } from "./directory-recovery.js";
import type { IdentityCenter } from "./identity.js";
import type { RuntimeBridge } from "./runtime.js";
import type { LocalFiles } from "./local-files.js";
import { RuntimePlatformAuthority } from "./runtime-platform-authority.js";
import { PlatformTaskRunDispatcher } from "./platform-task-run-dispatcher.js";
import type { WorkspaceStore } from "./store.js";
import { Notifications } from "./notifications.js";
import { PlatformWorkService } from "./platform-work-service.js";
import { ReaderService, platformReaderAuthority } from "./reader-service.js";
import { MessageAttachmentService } from "./message-attachment-service.js";
import { ImageService } from "./image-service.js";
import { ProfileAvatarService } from "./profile-avatar-service.js";
import { ProfileService } from "./profile-service.js";
import { UiPackageService } from "./ui-package-service.js";
import {
  createCognitiveAppHost,
  type CognitiveAppHostOptions,
} from "./cognitive-app-host.js";
import { sourceContainsSelection } from "./platform-message-source.js";
import { authorizeCognitiveAppInputObject } from "./cognitive-app-input-source.js";
import { coherentCognitiveAppInput } from "../../core/src/cognitive-app-object-locator.js";
import {
  embeddedApplicationInstanceIds,
  sealEmbeddedApplicationInstances,
} from "./embedded-application-identity.js";

export { embeddedApplicationInstanceIds } from "./embedded-application-identity.js";

export type PostgresApplicationDomains = {
  connectionStrings: {
    objects: string;
    scriptStudio: string;
    reader: string;
    browser: string;
  };
  deploymentId: string;
  schemas: {
    objects: string;
    scriptStudio: string;
    reader: string;
    browser: string;
  };
};

/** A cloud deployment has one explicit, stable app-instance identity across
 * Hosts. Database/schema names are locations, not identities: moving a schema
 * must not silently create another original in the Platform catalog.
 */
export function postgresApplicationInstanceIds(
  tenantId: string,
  options: PostgresApplicationDomains,
) {
  z.uuid().parse(tenantId);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(options.deploymentId))
    throw new Error("认知应用部署标识无效。");
  if (
    Object.values(options.connectionStrings).length !== 4 ||
    Object.values(options.connectionStrings).some((connection) => !connection)
  )
    throw new Error("四个认知应用的 PostgreSQL 连接必须分别配置。");
  const schemas = Object.entries(options.schemas) as Array<
    [keyof PostgresApplicationDomains["schemas"], string]
  >;
  if (
    schemas.length !== 4 ||
    schemas.some(([, schema]) => !/^[a-z][a-z0-9_]{0,62}$/.test(schema))
  )
    throw new Error("四个认知应用必须分别配置有效的 PostgreSQL schema。");
  if (
    new Set(
      schemas.map(
        ([kind, schema]) => `${options.connectionStrings[kind]}\0${schema}`,
      ),
    ).size !== 4
  )
    throw new Error("同一 PostgreSQL 数据库内不能复用认知应用 schema。");
  const identity = (kind: string, prefix: string) =>
    `${prefix}_${createHash("sha256")
      .update(
        JSON.stringify([
          "morphz-app-instance-v1",
          tenantId,
          options.deploymentId,
          kind,
        ]),
      )
      .digest("hex")
      .slice(0, 32)}`;
  return {
    objects: identity("objects", "objects"),
    scriptStudio: identity("script-studio", "script"),
    reader: identity("reader", "reader"),
    browser: identity("browser", "browser"),
  };
}

/** The binding lives with each private schema, not in Host-local config.
 * Platform records it in the instance route, so a Host pointed at an empty or
 * different database cannot present the same catalog identity as its originals.
 */
async function postgresApplicationBindings(
  options: PostgresApplicationDomains,
  tenantId: string,
) {
  const bindings: Partial<Record<keyof typeof options.schemas, string>> = {};
  for (const [kind, schema, appId] of [
    ["objects", options.schemas.objects, "morphz.objects"],
    ["scriptStudio", options.schemas.scriptStudio, "morphz.script-studio"],
    ["reader", options.schemas.reader, "morphz.reader"],
    ["browser", options.schemas.browser, "morphz.browser"],
  ] as const) {
    const pool = new Pool({
      connectionString: options.connectionStrings[kind],
      max: 1,
    });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || $1, 0))",
        [schema],
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS "${schema}".morphz_app_binding (
          tenant_id TEXT PRIMARY KEY,
          deployment_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          binding_id UUID NOT NULL
        )`,
      );
      await client.query(
        `INSERT INTO "${schema}".morphz_app_binding
          (tenant_id,deployment_id,app_id,binding_id)
          VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO NOTHING`,
        [tenantId, options.deploymentId, appId, randomUUID()],
      );
      const { rows } = await client.query<{
        deployment_id: string;
        app_id: string;
        binding_id: string;
      }>(
        `SELECT deployment_id,app_id,binding_id
           FROM "${schema}".morphz_app_binding WHERE tenant_id=$1`,
        [tenantId],
      );
      const binding = rows[0];
      if (
        !binding ||
        binding.deployment_id !== options.deploymentId ||
        binding.app_id !== appId
      )
        throw new Error("PostgreSQL 认知应用私库已绑定另一部署或应用。");
      bindings[kind] = binding.binding_id;
      await client.query("COMMIT");
    } catch (error) {
      if (client) await client.query("ROLLBACK");
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  }
  return bindings as Record<keyof typeof options.schemas, string>;
}

async function postgresReaderHasBooks(
  options: PostgresApplicationDomains,
  tenantId: string,
) {
  const pool = new Pool({
    connectionString: options.connectionStrings.reader,
    max: 1,
  });
  try {
    const schema = options.schemas.reader;
    const relation = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass($1) AS relation",
      [`${schema}.books`],
    );
    if (!relation.rows[0]?.relation) return false;
    const books = await pool.query(
      `SELECT 1 FROM "${schema}".books WHERE tenant_id=$1 LIMIT 1`,
      [tenantId],
    );
    return books.rowCount !== 0;
  } finally {
    await pool.end();
  }
}

/** Opens Platform and application-domain storage behind the trusted Host.
 * Neither a renderer nor an Agent receives a database handle or credential.
 */
export async function openApplicationDomainsHost(
  directory: string,
  workspace: WorkspaceStore,
  identity?: IdentityCenter,
  options: {
    /** The caller must assert that this Host is the only delivery owner before
     * a Host-local input check may authorize project retirement. */
    retirementInputCoverage?: "single-host" | "cross-host-unverified";
    platform?:
      | { kind: "sqlite" }
      | { kind: "postgres"; connectionString: string; schema: string };
    applications?: PostgresApplicationDomains;
    uiPackages?: {
      root: string;
      postgres: { connectionString: string; schema: string };
    };
    cloudStore?: {
      stagingRoot: string;
      bytes: S3ByteLocation;
      connectionString: string;
      schemas: { ui: string; reader: string; images: string; avatars?: string };
      s3Client?: S3Client;
    };
    cognitiveApps?: CognitiveAppHostOptions;
  } = {},
) {
  const tenantId = workspace.identity();
  const privatePostgres = options.applications;
  const cloudStore = options.cloudStore;
  if (
    cloudStore &&
    (!privatePostgres ||
      options.platform?.kind !== "postgres" ||
      options.uiPackages)
  )
    throw new Error(
      "云对象 Store 需要 PostgreSQL Platform／应用私库，且不能同时配置本机界面包 Store。",
    );
  const cloudBytes = (kind: "ui" | "reader" | "images" | "avatars") => ({
    ...cloudStore!.bytes,
    prefix: `${cloudStore!.bytes.prefix}/${tenantId}/${kind}`,
  });
  if (
    privatePostgres &&
    [
      "application-instances.json",
      "objects.sqlite",
      "script-studio.sqlite",
      "reader.sqlite",
      "browser.sqlite",
    ].some((name) => existsSync(join(directory, name)))
  )
    throw new Error(
      "本机已有认知应用数据；拒绝直接切到 PostgreSQL 隐藏原件。请先执行独立迁移。",
    );
  const instanceIds = privatePostgres
    ? postgresApplicationInstanceIds(tenantId, privatePostgres)
    : embeddedApplicationInstanceIds(directory, tenantId);
  const humanIsCurrent = (access: AccessContext) =>
    identity
      ? identity.allowsShared(access)
      : access.principalId === localAccess.principalId &&
        access.actantId === localAccess.actantId;
  const human = new HumanPlatformAuthority(tenantId, humanIsCurrent);
  const agentFor = (runtime: RuntimeBridge) =>
    new RuntimePlatformAuthority(
      runtime.inputEvidenceReader(),
      async (
        runtimePrincipalId,
        runtimeAgentId,
        projectId,
        _inputId,
        claimedHumanActantId,
      ) => {
        if (!runtimeAgentId) return null;
        const humanIdentity = identity
          ? identity.resolveHumanActant(claimedHumanActantId)
          : claimedHumanActantId === localAccess.actantId
            ? { principalId: localAccess.principalId }
            : null;
        if (!humanIdentity) return null;
        const access = {
          principalId: humanIdentity.principalId,
          actantId: claimedHumanActantId,
        };
        if (!(await humanIsCurrent(access))) return null;
        if (
          runtime.teamIdentity &&
          runtime.principalId(access.principalId) !== runtimePrincipalId
        )
          return null;
        let project;
        try {
          project = await human.withSession(
            access,
            () => {},
            (actor) => platform.getProject(actor, projectId),
          );
        } catch (error) {
          if (
            error instanceof PlatformStorageError &&
            ["forbidden", "not_found"].includes(error.code)
          )
            return null;
          throw error;
        }
        if (
          project.deleted_at ||
          !project.member_principal_ids.includes(access.principalId) ||
          !project.member_principal_ids.includes(morphzAgentAccess.principalId)
        )
          return null;
        return {
          tenantId,
          principalId: access.principalId,
          humanActantId: access.actantId,
          agentActantId: morphzAgentAccess.actantId,
        };
      },
      {
        taskRuns: {
          sourceEventForRuntime: (sessionId, clientMessageId) => platform.taskRunSourceEventForRuntime(tenantId, sessionId, clientMessageId),
          admissionForRuntime: (sessionId, scheduleId) =>
            platform.taskRunAdmissionForRuntime(
              tenantId,
              sessionId,
              scheduleId,
            ),
          async identityForTaskRun(
            runtimePrincipalId,
            runtimeAgentId,
            admission,
          ) {
            if (
              !runtimeAgentId ||
              admission.tenantId !== tenantId ||
              (runtime.teamIdentity &&
                runtime.principalId(admission.principalId) !==
                  runtimePrincipalId)
            )
              return null;
            if (
              !(await humanIsCurrent({
                principalId: admission.principalId,
                actantId: admission.humanActantId,
              }))
            )
              return null;
            let project;
            try {
              project = await human.withSession(
                {
                  principalId: admission.principalId,
                  actantId: admission.humanActantId,
                },
                () => {},
                (actor) => platform.getProject(actor, admission.projectId),
              );
            } catch (error) {
              if (
                error instanceof PlatformStorageError &&
                ["forbidden", "not_found"].includes(error.code)
              )
                return null;
              throw error;
            }
            if (
              !project.member_principal_ids.includes(admission.principalId) ||
              !project.member_principal_ids.includes(
                morphzAgentAccess.principalId,
              )
            )
              return null;
            return {
              tenantId,
              principalId: admission.principalId,
              humanActantId: admission.humanActantId,
              agentActantId: morphzAgentAccess.actantId,
            };
          },
        },
      },
    );
  let objects: ObjectsStore | undefined;
  let studio: ScriptStudioStore | undefined;
  let reader: ReaderStore | undefined;
  let messageAttachments: MessageAttachmentService | undefined;
  let images: ImageService | undefined;
  let avatars: ProfileAvatarService | undefined;
  const remaining: Omit<PlatformAuthorityVerifier, "resolveActor"> = {
    async resolveProfileAgent({ tenantId: scopeTenant, principalId }) {
      if (scopeTenant !== tenantId || !activeAgent) return null;
      const resolved = await activeAgent.runtime.profiles.identity({ principalId });
      return { agentId: resolved.agentId, editable: resolved.agentEditable };
    },
    async verifyProfileAvatar({ actor, subject, subjectId, media }) {
      return !!avatars && avatars.verifyMedia(actor, subject, subjectId, media);
    },
    async resolveActant({ tenantId: scopeTenant, actantId }) {
      if (scopeTenant !== tenantId) return null;
      if (actantId === morphzAgentAccess.actantId)
        return { principalId: morphzAgentAccess.principalId, kind: "agent" };
      if (identity) return identity.resolveHumanActant(actantId);
      return actantId === localAccess.actantId
        ? { principalId: localAccess.principalId, kind: "human" }
        : null;
    },
    async resolveProjectAgent({ tenantId: scopeTenant }) {
      if (scopeTenant !== tenantId) return null;
      return morphzAgentAccess;
    },
    async verifyApplicationObject(request) {
      if (request.tenantId !== tenantId || request.proof !== request.receiptId)
        return false;
      if (
        request.instanceId === instanceIds.objects &&
        objects &&
        (await objects.verifyCommittedRename({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          objectId: request.objectId,
          projectId: request.projectId,
          kind: request.kind,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        }))
      )
        return true;
      if (
        request.instanceId === instanceIds.objects &&
        (request.kind === "document" ||
          request.kind === "image" ||
          request.kind === "interactive") &&
        objects
      )
        return objects[
          request.kind === "image"
            ? "verifyCommittedImage"
            : request.kind === "interactive"
              ? "verifyCommittedInteractive"
              : "verifyCommittedDocument"
        ]({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          objectId: request.objectId,
          projectId: request.projectId,
          kind: request.kind,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        });
      if (
        request.instanceId === instanceIds.scriptStudio &&
        request.kind === "script" &&
        studio
      ) {
        const proof = {
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        };
        return (
          (await studio.verifyCommittedProduction({
            ...proof,
            projectId: request.projectId,
          })) ||
          (await studio.verifyCommittedProductionUpdate(proof)) ||
          (await studio.verifyCommittedProductionRename(proof)) ||
          (await studio.verifyCommittedExport(proof)) ||
          (await studio.verifyCommittedWorkflow(proof)) ||
          (await studio.verifyCommittedReview(proof)) ||
          (await studio.verifyCommittedItemCreation(proof)) ||
          (await studio.verifyCommittedItemRevision(proof)) ||
          (await studio.verifyCommittedCandidateSubmission(proof)) ||
          (await studio.verifyCommittedCandidateDecision(proof))
        );
      }
      if (
        request.instanceId === instanceIds.reader &&
        request.kind === "publication" &&
        reader
      )
        return reader.verifyCommittedBook({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId ?? null,
          instanceId: request.instanceId,
          objectId: request.objectId,
          projectId: request.projectId,
          kind: request.kind,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        });
      return false;
    },
  };
  let activeAgent:
    | {
        runtime: RuntimeBridge;
        authority: RuntimePlatformAuthority;
        resolveActor: PlatformAuthorityVerifier["resolveActor"];
        dispatcher: PlatformTaskRunDispatcher;
      }
    | undefined;
  const verifier = human.verifier({
    ...remaining,
    resolveActor: (actor) =>
      activeAgent?.resolveActor(actor) ?? Promise.resolve(null),
  });
  const platform =
    options.platform?.kind === "postgres"
      ? await PlatformStore.postgres(options.platform, verifier)
      : await PlatformStore.sqlite(
          join(directory, "platform.sqlite"),
          verifier,
        );
  let browser: BrowserStore | undefined;
  let readerOriginals: ManagedArtifactStore | undefined;
  let uiPackages: UiPackageService | undefined;
  let cognitiveHost: ReturnType<typeof createCognitiveAppHost> | undefined;
  try {
    await platform.provisionTenant(tenantId);
    if (identity) await identity.bindPlatform(platform, tenantId);
    else if (await platform.teamIdentityConfigured(tenantId))
      throw new Error("团队身份配置缺失；拒绝以单用户模式打开 Platform。");
    if (options.platform?.kind === "postgres") {
      if (cloudStore) {
        uiPackages = await UiPackageService.open({
          tenantId,
          platform,
          verifier,
          root: join(cloudStore.stagingRoot, tenantId, "ui"),
          cloud: {
            connectionString: cloudStore.connectionString,
            schema: cloudStore.schemas.ui,
            bytes: cloudBytes("ui"),
            ...(cloudStore.s3Client ? { s3Client: cloudStore.s3Client } : {}),
          },
        });
        if (
          (await platform.hasUiPackages(tenantId)) &&
          !(await uiPackages.hasCommittedVersions())
        )
          throw new Error("Platform 已安装界面包，但云 Store 缺少已登记原件。");
      } else if (options.uiPackages) {
        uiPackages = await UiPackageService.open({
          tenantId,
          platform,
          verifier,
          ...options.uiPackages,
        });
      } else if (await platform.hasUiPackages(tenantId)) {
        throw new Error(
          "Platform 已安装界面包，但本 Host 未配置共享包 Store；拒绝隐藏已安装应用。",
        );
      }
    } else {
      if (options.uiPackages)
        throw new Error(
          "SQLite 中心的应用包 Store 由本中心管理，不接受外部配置。",
        );
      uiPackages = await UiPackageService.open({
        tenantId,
        platform,
        verifier,
        root: join(directory, "ui-packages"),
      });
    }
    if (privatePostgres)
      await platform.assertEmbeddedInstanceCoverage(tenantId, instanceIds);
    let registeredRoutes: Record<keyof typeof instanceIds, string> | null =
      null;
    const serviceProvider =
      (kind: keyof typeof instanceIds): (() => ApplicationProviderRoute) =>
      () => {
        const routeRef = registeredRoutes?.[kind];
        if (!routeRef) throw new Error("认知应用保存方尚未登记。");
        return { routeKind: "service", routeRef };
      };
    const objectsAuthority = platformObjectsAuthority(
      platform,
      instanceIds.objects,
      serviceProvider("objects"),
    );
    objects = privatePostgres
      ? await ObjectsStore.postgres({
          connectionString: privatePostgres.connectionStrings.objects,
          schema: privatePostgres.schemas.objects,
          authority: objectsAuthority,
        })
      : await ObjectsStore.sqlite(
          join(directory, "objects.sqlite"),
          objectsAuthority,
        );
    const studioAuthority = platformScriptStudioAuthority(
      platform,
      instanceIds.scriptStudio,
      serviceProvider("scriptStudio"),
      { objects, instanceId: instanceIds.objects },
      {
        async assertInputActive(inputId) {
          if (!activeAgent)
            throw new Error("剧本执行未连接 Runtime，不能继续读取或提交结果。");
          await activeAgent.runtime.assertPlatformInputActive(inputId);
        },
      },
    );
    studio = privatePostgres
      ? await ScriptStudioStore.postgres({
          connectionString: privatePostgres.connectionStrings.scriptStudio,
          schema: privatePostgres.schemas.scriptStudio,
          authority: studioAuthority,
        })
      : await ScriptStudioStore.sqlite(
          join(directory, "script-studio.sqlite"),
          studioAuthority,
        );
    const browserAuthority = platformBrowserBookmarkAuthority(
      platform,
      instanceIds.browser,
      serviceProvider("browser"),
    );
    browser = privatePostgres
      ? await BrowserStore.postgres({
          connectionString: privatePostgres.connectionStrings.browser,
          schema: privatePostgres.schemas.browser,
          authority: browserAuthority,
        })
      : await BrowserStore.sqlite(
          join(directory, "browser.sqlite"),
          browserAuthority,
        );
    messageAttachments = await MessageAttachmentService.open({
      root: join(directory, "message-attachments"),
      tenantId,
      verifier,
      human,
    });
    const imageRoot = cloudStore
      ? join(cloudStore.stagingRoot, tenantId, "images")
      : join(directory, "objects-images");
    if (
      cloudStore &&
      existsSync(join(directory, "objects-images", "manifest.sqlite"))
    )
      throw new Error("本机已有图片 Store；请先显式迁移原件，再切到云 Store。");
    if (
      !cloudStore &&
      (await objects.hasImageVersions(tenantId)) &&
      !existsSync(join(imageRoot, "manifest.sqlite"))
    )
      throw new Error(
        "Objects 图片原件 Store 缺失，拒绝创建空 Store 覆盖已登记图片。",
      );
    images = await ImageService.open({
      root: imageRoot,
      tenantId,
      verifier,
      objects,
      authorizeProvider: async (actor) => {
        await platform.authorizePersonalApplicationAtRoute(
          actor,
          instanceIds.objects,
          "morphz.objects",
          serviceProvider("objects")(),
        );
      },
      ...(cloudStore
        ? {
            cloud: {
              connectionString: cloudStore.connectionString,
              schema: cloudStore.schemas.images,
              bytes: cloudBytes("images"),
              ...(cloudStore.s3Client ? { s3Client: cloudStore.s3Client } : {}),
            },
          }
        : {}),
    });
    const avatarRoot = cloudStore ? join(cloudStore.stagingRoot, tenantId, "avatars") : join(directory, "profile-avatars");
    const avatarReferences = await platform.hasProfileAvatarReferences(tenantId);
    if (cloudStore && existsSync(join(directory, "profile-avatars", "manifest.sqlite"))) throw new Error("已有本机头像 Store；请显式迁移原件后再切到云 Store。");
    if (!cloudStore && avatarReferences && !existsSync(join(avatarRoot, "manifest.sqlite"))) throw new Error("头像原件 Store 缺失，拒绝创建空 Store 覆盖已保存头像。");
    if (cloudStore && !cloudStore.schemas.avatars && avatarReferences) throw new Error("已有头像引用但云头像 Store 未配置，拒绝不完整启动。");
    if (!cloudStore || cloudStore.schemas.avatars) {
      avatars = await ProfileAvatarService.open({ root: avatarRoot, tenantId, platform, verifier, ...(cloudStore ? { cloud: { connectionString: cloudStore.connectionString, schema: cloudStore.schemas.avatars!, bytes: cloudBytes("avatars"), ...(cloudStore.s3Client ? { s3Client: cloudStore.s3Client } : {}) } } : {}) });
    }
    if (avatarReferences && avatars && !await avatars.hasCommittedVersions()) throw new Error("已保存头像引用但头像 Store 缺少已提交原件，拒绝不完整启动。");
    if (
      cloudStore &&
      (await objects.hasImageVersions(tenantId)) &&
      !(await images.hasCommittedVersions())
    )
      throw new Error("Objects 已有图片版本，但云 Store 缺少图片原件。");
    const readerOriginalStoreId = `store_${instanceIds.reader}`;
    const readerRoot = cloudStore
      ? join(cloudStore.stagingRoot, tenantId, "reader")
      : join(directory, "reader-originals");
    if (
      cloudStore &&
      existsSync(join(directory, "reader-originals", "manifest.sqlite"))
    )
      throw new Error(
        "本机已有阅读原件 Store；请先显式迁移原件，再切到云 Store。",
      );
    if (
      privatePostgres &&
      !cloudStore &&
      !existsSync(join(readerRoot, "manifest.sqlite")) &&
      (await postgresReaderHasBooks(privatePostgres, tenantId))
    )
      throw new Error(
        "阅读器 PostgreSQL 私库已有书籍，但本节点缺少原件 Store；拒绝创建空 Store 遮盖书籍。",
      );
    const readerStoreOptions = {
      root: readerRoot,
      storeId: readerOriginalStoreId,
      authorizer: {
        async authorize(
          credential: string,
          operation: StoreAuthorizationRequest,
        ) {
          const actor = await verifier.resolveActor({ credential });
          if (
            !actor ||
            actor.tenantId !== tenantId ||
            !/^book_[a-f0-9]{40}$/.test(operation.artifactId) ||
            operation.storeId !== readerOriginalStoreId
          )
            throw new Error("阅读器原件 Store 未获授权。");
          await platform.authorizePersonalApplicationAtRoute(
            { credential },
            instanceIds.reader,
            "morphz.reader",
            serviceProvider("reader")(),
          );
          return { tenantId: actor.tenantId, principalId: actor.principalId };
        },
      },
      maxBytes: 32 * 1024 * 1024,
    };
    readerOriginals = cloudStore
      ? await ManagedArtifactStore.cloud({
          ...readerStoreOptions,
          connectionString: cloudStore.connectionString,
          schema: cloudStore.schemas.reader,
          bytes: cloudBytes("reader"),
          ...(cloudStore.s3Client ? { s3Client: cloudStore.s3Client } : {}),
        })
      : await ManagedArtifactStore.sqlite(readerStoreOptions);
    if (
      cloudStore &&
      (await postgresReaderHasBooks(privatePostgres!, tenantId)) &&
      !(await readerOriginals.hasCommittedVersions())
    )
      throw new Error("Reader 已有书籍，但云 Store 缺少阅读原件。");
    const readerAuthority = platformReaderAuthority({
      platform,
      objects,
      objectsInstanceId: instanceIds.objects,
      readerInstanceId: instanceIds.reader,
      objectsProvider: serviceProvider("objects"),
      readerProvider: serviceProvider("reader"),
      originalStore: readerOriginals,
      originalStoreId: readerOriginalStoreId,
      verifier,
    });
    reader = privatePostgres
      ? await ReaderStore.postgres(
          {
            connectionString: privatePostgres.connectionStrings.reader,
            schema: privatePostgres.schemas.reader,
          },
          readerAuthority,
        )
      : await ReaderStore.sqlite(
          join(directory, "reader.sqlite"),
          readerAuthority,
        );
    if (!privatePostgres)
      sealEmbeddedApplicationInstances(directory, tenantId, instanceIds);
    const privateBindings = privatePostgres
      ? await postgresApplicationBindings(privatePostgres, tenantId)
      : null;
    registeredRoutes = {
      objects: privateBindings
        ? `postgres:${instanceIds.objects}:${privateBindings.objects}`
        : `embedded:${instanceIds.objects}`,
      scriptStudio: privateBindings
        ? `postgres:${instanceIds.scriptStudio}:${privateBindings.scriptStudio}`
        : `embedded:${instanceIds.scriptStudio}`,
      reader: privateBindings
        ? `postgres:${instanceIds.reader}:${privateBindings.reader}`
        : `embedded:${instanceIds.reader}`,
      browser: privateBindings
        ? `postgres:${instanceIds.browser}:${privateBindings.browser}`
        : `embedded:${instanceIds.browser}`,
    };
    // Installation identifies the app type within a tenant; an instance
    // identifies one private data authority. A tenant may have more than one
    // instance of the same app, so installation IDs must not derive from the
    // private database's instance ID.
    await platform.registerApplication(tenantId, {
      appId: "morphz.objects",
      installationId: "install_morphz_objects",
      instanceId: instanceIds.objects,
      routeKind: "service",
      routeRef: registeredRoutes.objects,
    });
    await platform.registerApplication(tenantId, {
      appId: "morphz.script-studio",
      installationId: "install_morphz_script_studio",
      instanceId: instanceIds.scriptStudio,
      routeKind: "service",
      routeRef: registeredRoutes.scriptStudio,
    });
    await platform.registerApplication(tenantId, {
      appId: "morphz.reader",
      installationId: "install_morphz_reader",
      instanceId: instanceIds.reader,
      routeKind: "service",
      routeRef: registeredRoutes.reader,
    });
    await platform.registerApplication(tenantId, {
      appId: "morphz.browser",
      installationId: "install_morphz_browser",
      instanceId: instanceIds.browser,
      routeKind: "service",
      routeRef: registeredRoutes.browser,
    });
    await recoverEmbeddedDirectory({
      tenantId,
      platform,
      objects,
      objectsInstanceId: instanceIds.objects,
      studio,
      studioInstanceId: instanceIds.scriptStudio,
      reader,
      readerInstanceId: instanceIds.reader,
    });
    await identity?.reconcileCurrentMemberships();
    const contentObjects = objects;
    const contentStudio = studio;
    const contentBrowser = browser;
    const contentReader = reader;
    const contentReaderOriginals = readerOriginals;
    const contentMessageAttachments = messageAttachments;
    const contentImages = images;
    const contentAvatars = avatars;
    const profiles = new ProfileService(() => activeAgent?.runtime, platform, contentAvatars, identity ? access => identity.displayName(access) : undefined);
    const service = new BrowserBookmarkService(platform, contentBrowser);
    const work = new PlatformWorkService(
      platform,
      options.retirementInputCoverage ??
        (options.platform?.kind === "postgres"
          ? "cross-host-unverified"
          : "single-host"),
      async (actor, source) => {
        if (
          source.appId === "morphz.objects" &&
          source.instanceId === instanceIds.objects
        )
          return (
            await contentObjects.readObjectHead({
              credential: actor.credential,
              objectId: source.objectId,
            })
          ).versionRef;
        if (
          source.appId === "morphz.script-studio" &&
          source.instanceId === instanceIds.scriptStudio
        )
          return (
            await contentStudio.readProductionHead({
              credential: actor.credential,
              productionId: source.objectId,
            })
          ).versionRef;
        if (
          source.appId === "morphz.reader" &&
          source.instanceId === instanceIds.reader
        )
          return (
            await contentReader.readBookHead({
              credential: actor.credential,
              bookId: source.objectId,
            })
          ).versionRef;
        throw new PlatformStorageError(
          "invalid",
          "关注来源的应用尚未提供受权版本读取。",
        );
      },
    );
    const reading = new ReaderService(
      platform,
      contentObjects,
      contentReader,
      instanceIds.objects,
      instanceIds.reader,
      serviceProvider("objects"),
      serviceProvider("reader"),
      contentReaderOriginals,
      readerOriginalStoreId,
    );
    const notifications = new Notifications(platform, human);
    cognitiveHost = createCognitiveAppHost({
      tenantId,
      platform,
      viewPlatform: platform,
      ...(uiPackages ? { uiPackages } : {}),
      ...(options.cognitiveApps ? { config: options.cognitiveApps } : {}),
    });
    cognitiveHost.start();
    return {
      cognitiveApps: {
        authority: human,
        service: cognitiveHost.service,
        views: cognitiveHost.views,
      },
      workspaceChanges: {
        sources: [platform.changeSource(), contentObjects.changeSource(), contentBrowser.changeSource(), contentReader.changeSource(),
          contentStudio.changeSource()],
        async readVersion(access: AccessContext, assertActive: () => void) {
          return human.withSession(access, assertActive, async actor => {
            const before = await platform.workspaceChangeVersion(actor);
            const readable = async (read: () => Promise<unknown>) => {
              try { return await read(); } catch { assertActive(); return "unavailable"; }
            };
            const originals = await Promise.all(before.contentRefs.map(async ref => [ref.appId, ref.objectId,
              ref.appId === "morphz.objects"
                ? await readable(() => contentObjects.workspaceChangeVersion({ credential: actor.credential, objectId: ref.objectId }))
                : ref.appId === "morphz.script-studio"
                  ? await readable(() => contentStudio.readProductionHead({ credential: actor.credential, productionId: ref.objectId }))
                  : ref.appId === "morphz.reader"
                    ? await readable(() => contentReader.readBookHead({ credential: actor.credential, bookId: ref.objectId })) : null,
              await readable(() => contentReader.workspaceChangeVersion({ credential: actor.credential, ...ref })),
            ]));
            const bookmarks = await readable(() => contentBrowser.workspaceChangeVersion(actor));
            const profile = await readable(async () => {
              const snapshot = await profiles.read(actor, assertActive);
              return [snapshot.human.revision, snapshot.human.available, snapshot.agent.id, snapshot.agent.revision, snapshot.agent.available];
            });
            assertActive();
            // A grant removed during an app read never re-publishes its old proof.
            // Frames contain only invalidation, so a changed grant clears Client
            // protected projections before any independent re-read.
            const after = await platform.workspaceChangeVersion(actor);
            assertActive();
            return {
              version: createHash("sha256").update(JSON.stringify({
                platform: after.version,
                ...(before.accessVersion === after.accessVersion ? { originals, bookmarks, profile } : {}),
              })).digest("hex"),
              accessVersion: after.accessVersion,
              projectIds: after.projectIds,
            };
          });
        },
      },
      work: { authority: human, service: work },
      content: {
        authority: human,
        platform,
        objects: contentObjects,
        studio: contentStudio,
        images: contentImages,
        provider: serviceProvider("objects"),
        instanceIds,
      },
      browser: { authority: human, service },
      reader: { authority: human, service: reading },
      messageAttachments: {
        authority: human,
        service: contentMessageAttachments,
      },
      images: { authority: human, service: contentImages },
      profiles: { authority: human, service: profiles },
      uiPackages: uiPackages
        ? { authority: human, service: uiPackages }
        : undefined,
      notifications,
      taskRuns(runtime?: RuntimeBridge) {
        return {
          authority: human,
          store: platform,
          runtimeStatus: runtime?.taskRunStatusReader(),
        };
      },
      bindRuntime(runtime: RuntimeBridge, localFiles?: LocalFiles) {
        work.bindRetirementRuntime(runtime);
        runtime.bindMessageAttachments(contentMessageAttachments);
        runtime.bindPlatformInputAuthority(async (source) => {
          if (!(await humanIsCurrent(source.author)))
            throw new PlatformStorageError(
              "forbidden",
              "消息发起者身份已失效，未发送。",
            );
          const route = await human.withSession(
            source.author,
            () => {},
            async (actor) => {
              const route =
                source.firstInputId && source.phase === "prepare"
                  ? platform.authorizeConversationStart(actor, {
                      projectId: source.projectId,
                      conversationId: source.conversationId,
                      targetActantId: source.targetActantId,
                      firstInputId: source.firstInputId,
                    })
                  : platform.authorizeMessageRoute(actor, {
                      projectId: source.projectId,
                      conversationId: source.conversationId,
                      targetActantId: source.targetActantId,
                      ...(source.firstInputId
                        ? { firstInputId: source.firstInputId }
                        : {}),
                    });
              const authorized = await route;
              if (!coherentCognitiveAppInput(source))
                throw new PlatformStorageError(
                  "invalid",
                  "认知应用原件范围不完整，未发送。",
                );
              if (source.cognitiveObject) {
                const target = await authorizeCognitiveAppInputObject(
                  platform,
                  actor,
                  source.cognitiveObject,
                );
                if (
                  source.application &&
                  (source.application.id !== target.appId ||
                    source.application.version !== target.version ||
                    source.application.instanceId !== target.instanceId ||
                    JSON.stringify(source.application.harness) !==
                      JSON.stringify(target.definition.harness))
                )
                  throw new PlatformStorageError(
                    "conflict",
                    "消息应用与认知原件保存方不一致。",
                  );
              }
              if (source.application)
                await platform.authorizeApplicationProject(
                  actor,
                  source.application.instanceId,
                  source.application.id,
                  source.projectId,
                );
              if (
                !!source.artifactId !== !!source.artifactRevision ||
                (!source.artifactId && (source.selection || source.reading)) ||
                (source.artifactId && source.localFile)
              )
                throw new PlatformStorageError(
                  "invalid",
                  "消息关联的内容版本不完整。",
                );
              if (source.artifactId && source.artifactRevision) {
                let entry: Awaited<ReturnType<typeof platform.content>> | null =
                  null;
                try {
                  entry = await platform.content(actor, source.artifactId);
                } catch (error) {
                  if (
                    !(error instanceof PlatformStorageError) ||
                    error.code !== "not_found"
                  )
                    throw error;
                }
                if (!entry) {
                  if (source.reading)
                    throw new PlatformStorageError(
                      "invalid",
                      "事项不能作为阅读原件。",
                    );
                  const task = await platform.taskVersion(
                    actor,
                    source.artifactId,
                    source.artifactRevision,
                  );
                  if (
                    task.project_id !== source.projectId ||
                    (source.selection &&
                      !sourceContainsSelection(
                        `${task.title}\n${task.description}`,
                        source.selection,
                      ))
                  )
                    throw new PlatformStorageError(
                      "forbidden",
                      "事项版本不属于本次对话。",
                    );
                  return authorized;
                }
                if (
                  entry.project_id !== source.projectId ||
                  entry.availability !== "available"
                )
                  throw new PlatformStorageError(
                    "forbidden",
                    "内容不属于本次对话或已不可用。",
                  );
                if (
                  entry.app_id === "morphz.objects" &&
                  entry.instance_id === instanceIds.objects
                ) {
                  const version = await contentObjects.readObject({
                    credential: actor.credential,
                    objectId: entry.app_object_id,
                    revision: source.artifactRevision,
                  });
                  if (
                    version.contentId !== source.artifactId ||
                    version.revision !== source.artifactRevision
                  )
                    throw new PlatformStorageError(
                      "conflict",
                      "内容版本已变化，未发送。",
                    );
                  if (
                    source.selection &&
                    !source.reading &&
                    !sourceContainsSelection(
                      quotedText(version.content),
                      source.selection,
                    )
                  )
                    throw new PlatformStorageError(
                      "invalid",
                      "选中文字不属于这个内容版本。",
                    );
                } else if (
                  entry.app_id === "morphz.reader" &&
                  entry.instance_id === instanceIds.reader
                ) {
                  const book = await reading.bookOverview(
                    actor,
                    source.artifactId,
                    source.artifactRevision,
                  );
                  if (
                    book.bookId !== entry.app_object_id ||
                    book.revision !== source.artifactRevision
                  )
                    throw new PlatformStorageError(
                      "conflict",
                      "书籍版本已变化，未发送。",
                    );
                  if (source.selection && !source.reading)
                    throw new PlatformStorageError(
                      "invalid",
                      "请从阅读器重新选择原文。",
                    );
                } else
                  throw new PlatformStorageError(
                    "invalid",
                    "此应用内容尚未接入消息来源。",
                  );
                if (source.reading)
                  await reading.validateInputReference(
                    actor,
                    source.artifactId,
                    source.artifactRevision,
                    source.reading,
                    source.selection ?? "",
                  );
              }
              return authorized;
            },
          );
          if (
            source.phase !== "receipt" &&
            (source.localFile || source.directories?.length)
          ) {
            if (!localFiles)
              throw new PlatformStorageError(
                "invalid",
                "本机文件授权仅在持有原文件的桌面节点可用。",
              );
            if (source.localFile)
              localFiles.validate(
                source.localFile,
                source.projectId,
                source.author,
              );
            for (const directory of source.directories ?? [])
              localFiles.validateDirectory(
                directory,
                source.projectId,
                source.conversationId,
                source.author,
              );
          }
          return route;
        });
        runtime.bindPlatformReadAuthority((scope, access) =>
          human.withSession(
            access,
            () => {},
            (actor) => platform.authorizeConversationRead(actor, scope),
          ),
        );
        const authority = agentFor(runtime);
        runtime.bindPlatformAgentScope((route) =>
          authority.withInvocation(route, async (_actor, source) => ({
            projectId: source.projectId,
            platform: true,
            platformSource: source.kind,
            ...(source.inputId ? { inputId: source.inputId } : {}),
            access: {
              principalId: "morphz-service",
              actantId: "morphz-agent",
            },
          })),
        );
        const dispatcher = new PlatformTaskRunDispatcher(
          platform,
          tenantId,
          runtime,
          async (admission) => {
            const access = {
              principalId: admission.principalId,
              actantId: admission.humanActantId,
            };
            if (!(await humanIsCurrent(access)))
              throw new PlatformStorageError(
                "forbidden",
                "事项发起者身份已失效，未投递执行。",
              );
            const project = await human.withSession(
              access,
              () => {},
              (actor) => platform.getProject(actor, admission.projectId),
            );
            const agent = await remaining.resolveProjectAgent({ tenantId });
            if (
              project.archived_at ||
              project.deleted_at ||
              !agent ||
              !project.member_principal_ids.includes(agent.principalId)
            )
              throw new PlatformStorageError(
                "forbidden",
                "事项所属项目或 Agent 授权已变化，未投递执行。",
              );
            return access;
          },
          (admission, access) =>
            human.withSession(
              access,
              () => {},
              (actor) =>
                platform.prepareTaskRun(actor, admission.eventId, (ref) =>
                  runtime.taskRunStatusReader().inspect(ref, access),
                ),
            ),
          (error, eventId) => {
            console.warn(
              `Platform 事项执行 ${eventId ?? "队列"} 暂未确认：${error instanceof Error ? error.message : "未知错误"}`,
            );
          },
          Date.now,
          {
            inspectTaskSourceDestination: (admission, ref, access) => runtime.inspectTaskSourceDestination(admission, ref, access),
            reconcileTaskSourceEvent: (event, access) => runtime.reconcileTaskSourceEvent(event, access),
            deliverTaskSource: (event, admission, access) => runtime.deliverTaskSource(event, admission, access),
            stopTaskSource: (event, access) => runtime.stopTaskSource(event, access),
            prepare: (run, destination, access) => human.withSession(access, () => {}, actor => platform.prepareTaskSourceEvent(actor, run, destination, work.readWatchSource!)),
            check: (run, access) => human.withSession(access, () => {}, actor => platform.assertTaskSourceDelivery(actor, run)),
            attempt: (run, event, access) => human.withSession(access, () => {}, actor => platform.markTaskSourceDeliveryAttempt(actor, run, event)),
          },
        );
        activeAgent = {
          runtime,
          authority,
          resolveActor: authority.verifier(remaining).resolveActor,
          dispatcher,
        };
        return { authority, service, dispatcher };
      },
      async unbindRuntime(authority: RuntimePlatformAuthority) {
        if (activeAgent?.authority === authority) {
          await activeAgent.dispatcher.stop();
          work.bindRetirementRuntime(undefined);
          activeAgent.runtime.bindPlatformInputAuthority(undefined);
          activeAgent.runtime.bindPlatformReadAuthority(undefined);
          activeAgent.runtime.bindPlatformAgentScope(undefined);
          activeAgent.runtime.bindMessageAttachments(undefined);
          activeAgent = undefined;
        }
      },
      async close() {
        await cognitiveHost?.close();
        await activeAgent?.dispatcher.stop();
        activeAgent = undefined;
        await contentBrowser.close();
        await contentReader.close();
        await contentReaderOriginals.close();
        await contentMessageAttachments.close();
          await contentImages.close();
          await contentAvatars?.close();
        await uiPackages?.close();
        await contentStudio.close();
        await contentObjects.close();
        await platform.close();
      },
    };
  } catch (error) {
    await cognitiveHost?.close();
    await browser?.close();
    await reader?.close();
    await readerOriginals?.close();
    await messageAttachments?.close();
    await images?.close();
    await avatars?.close();
    await uiPackages?.close();
    await studio?.close();
    await objects?.close();
    await platform.close();
    throw error;
  }
}
