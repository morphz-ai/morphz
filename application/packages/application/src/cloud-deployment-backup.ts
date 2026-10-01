import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { Pool } from "pg";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ManagedArtifactStore } from "../../managed-artifact-store/src/store.js";
import type { S3ByteLocation } from "../../managed-artifact-store/src/s3-bytes.js";
import {
  postgresApplicationInstanceIds,
  type PostgresApplicationDomains,
} from "./application-domains-host.js";
import { profileAvatarArtifactId } from "./profile-avatar-service.js";

const schemaPattern = /^[a-z][a-z0-9_]{0,62}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const relationNames = [
  "platform",
  "objects",
  "scriptStudio",
  "reader",
  "browser",
] as const;
const storeNames = ["ui", "reader", "images", "avatars"] as const;
type RelationName = (typeof relationNames)[number];
type StoreName = (typeof storeNames)[number];

export type CloudApplicationStorage = {
  tenantId: string;
  platform: { connectionString: string; schema: string };
  applications: PostgresApplicationDomains;
  stores: {
    connectionString: string;
    schemas: Record<Exclude<StoreName, "avatars">, string> & { avatars?: string };
    bytes: S3ByteLocation;
  };
  s3Client?: S3Client;
};

const manifestSchema = z
  .object({
    format: z.literal("morphz-cloud-application-storage"),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    tenantId: z.uuid(),
    deploymentId: z.string().min(1).max(100),
    relations: z
      .array(
        z
          .object({
            name: z.enum(relationNames),
            schema: z.string().regex(schemaPattern),
            sha256: z.string().regex(digestPattern),
            byteLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .length(relationNames.length),
    stores: z
      .array(
        z
          .object({
            name: z.enum(storeNames),
            schema: z.string().regex(schemaPattern),
            storeId: z.string().min(1),
            backupInfoSha256: z.string().regex(digestPattern),
          })
          .strict(),
      )
      .min(3).max(4),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
function configuredStores(location: CloudApplicationStorage): StoreName[] {
  return storeNames.filter(name => !!location.stores.schemas[name]);
}

function validateLocation(location: CloudApplicationStorage) {
  z.uuid().parse(location.tenantId);
  postgresApplicationInstanceIds(location.tenantId, location.applications);
  if (!location.platform.connectionString || !location.stores.connectionString)
    throw new Error("云部署关系存储连接缺失。");
  const schemas = [
    location.platform.schema,
    ...Object.values(location.applications.schemas),
    ...Object.values(location.stores.schemas),
  ];
  if (schemas.some((schema) => !schemaPattern.test(schema)))
    throw new Error("云部署 PostgreSQL schema 名称无效。");
  const schemasByDatabase = new Map<string, Set<string>>();
  const domains = [
    ...relationNames.map((name) => relation(location, name)),
    ...configuredStores(location).map((name) => ({
      connectionString: location.stores.connectionString,
      schema: location.stores.schemas[name]!,
    })),
  ];
  for (const domain of domains) {
    const parsed = new URL(domain.connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol))
      throw new Error("云备份 PostgreSQL 连接必须使用 URL。");
    const database = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
    const existing = schemasByDatabase.get(database) ?? new Set<string>();
    if (existing.has(domain.schema))
      throw new Error("同一 PostgreSQL 数据库内不能复用领域 schema。");
    existing.add(domain.schema);
    schemasByDatabase.set(database, existing);
  }
}

type ByteReference = {
  store_id: string;
  artifact_id: string;
  artifact_revision: number | string;
  sha256: string;
  byte_length: number | string;
  mime: string | null;
  owner_principal_id: string | null;
};

/** Available entries owned by the app instances in this deployment must still
 * have their originals. Other instances of the same built-in app type, like
 * third-party entries, remain external references rather than backed-up data.
 */
export async function verifyCloudContentReferences(
  location: Pick<
    CloudApplicationStorage,
    "tenantId" | "platform" | "applications"
  >,
) {
  const instances = postgresApplicationInstanceIds(
    location.tenantId,
    location.applications,
  );
  const originals = {
    "morphz.objects": {
      instanceId: instances.objects,
      connectionString: location.applications.connectionStrings.objects,
      schema: location.applications.schemas.objects,
      table: "objects",
      key: "object_id",
    },
    "morphz.script-studio": {
      instanceId: instances.scriptStudio,
      connectionString: location.applications.connectionStrings.scriptStudio,
      schema: location.applications.schemas.scriptStudio,
      table: "script_productions",
      key: "production_id",
    },
    "morphz.reader": {
      instanceId: instances.reader,
      connectionString: location.applications.connectionStrings.reader,
      schema: location.applications.schemas.reader,
      table: "books",
      key: "book_id",
    },
  } as const;
  const catalog = new Pool({
    connectionString: location.platform.connectionString,
    max: 1,
  });
  const applicationPools = new Map<keyof typeof originals, Pool>();
  try {
    let afterContentId = "";
    for (;;) {
      const entries = await catalog.query<{
        content_id: string;
        app_id: keyof typeof originals;
        instance_id: string;
        app_object_id: string;
      }>(
        `SELECT content_id,app_id,instance_id,app_object_id
           FROM "${location.platform.schema}".content_entries
          WHERE tenant_id=$1 AND deleted_at IS NULL AND availability='available'
            AND app_id=ANY($2::text[]) AND content_id>$3
          ORDER BY content_id LIMIT 500`,
        [location.tenantId, Object.keys(originals), afterContentId],
      );
      if (!entries.rows.length) break;
      for (const [appId, origin] of Object.entries(originals) as Array<
        [keyof typeof originals, (typeof originals)[keyof typeof originals]]
      >) {
        const relevant = entries.rows.filter((entry) => entry.app_id === appId);
        if (!relevant.length) continue;
        const local = relevant.filter(
          (entry) => entry.instance_id === origin.instanceId,
        );
        if (!local.length) continue;
        let applicationPool = applicationPools.get(appId);
        if (!applicationPool) {
          applicationPool = new Pool({
            connectionString: origin.connectionString,
            max: 1,
          });
          applicationPools.set(appId, applicationPool);
        }
        const found = await applicationPool.query<{ object_id: string }>(
          `SELECT ${origin.key} AS object_id FROM "${origin.schema}".${origin.table}
            WHERE tenant_id=$1 AND ${origin.key}=ANY($2::text[]) AND deleted_at IS NULL`,
          [location.tenantId, local.map((entry) => entry.app_object_id)],
        );
        const present = new Set(found.rows.map((row) => row.object_id));
        if (local.some((entry) => !present.has(entry.app_object_id)))
          throw new Error(`云内容目录中的 ${appId} 原件缺失或已删除。`);
      }
      afterContentId = entries.rows.at(-1)!.content_id;
      if (entries.rows.length < 500) break;
    }
  } finally {
    await Promise.all([
      catalog.end(),
      ...Array.from(applicationPools.values(), (pool) => pool.end()),
    ]);
  }
}

async function verifyByteReferences(location: CloudApplicationStorage) {
  const sources = [
    {
      name: "已安装界面包",
      connectionString: location.platform.connectionString,
      schema: location.platform.schema,
      table: "app_ui_packages",
      keys: ["app_id", "package_version"],
      columns:
        "store_id,artifact_id,artifact_revision,sha256,byte_length,'text/html;charset=utf-8' AS mime,installed_by_principal_id AS owner_principal_id",
      store: "ui" as const,
    },
    {
      name: "图片原件",
      connectionString: location.applications.connectionStrings.objects,
      schema: location.applications.schemas.objects,
      table: "object_version_bytes",
      keys: ["object_id", "object_revision"],
      columns:
        "store_id,artifact_id,artifact_revision,sha256,byte_length,mime,'objects-image-service' AS owner_principal_id",
      store: "images" as const,
    },
    {
      name: "阅读原件",
      connectionString: location.applications.connectionStrings.reader,
      schema: location.applications.schemas.reader,
      table: "book_revisions",
      keys: ["book_id", "revision"],
      columns:
        "provider_id AS store_id,object_ref AS artifact_id,revision AS artifact_revision,sha256,byte_length,NULL AS mime,NULL AS owner_principal_id",
      store: "reader" as const,
      filter: "storage_kind='app_private'",
    },
  ];
  for (const source of sources) {
    const references = new Pool({
      connectionString: source.connectionString,
      max: 1,
    });
    const manifests = new Pool({
      connectionString: location.stores.connectionString,
      max: 1,
    });
    try {
      let cursor: [string, string] | undefined;
      for (;;) {
        const filter = [
          source.filter,
          cursor ? `(${source.keys.join(",")}) > ($1,$2)` : null,
        ]
          .filter(Boolean)
          .join(" AND ");
        const rows = await references.query<
          ByteReference & { cursor_a: string; cursor_b: string }
        >(
          `SELECT ${source.columns},${source.keys[0]}::text AS cursor_a,${source.keys[1]}::text AS cursor_b FROM "${source.schema}".${source.table}${filter ? ` WHERE ${filter}` : ""} ORDER BY ${source.keys.join(",")} LIMIT 500`,
          cursor ?? [],
        );
        if (!rows.rows.length) break;
        const ids = rows.rows.map((row) => row.artifact_id);
        const revisions = rows.rows.map((row) => String(row.artifact_revision));
        const versions = await manifests.query<
          ByteReference & { owner_tenant_id: string; deleted_at: string | null }
        >(
          `SELECT v.artifact_id,v.revision AS artifact_revision,v.sha256,v.byte_length,v.mime,a.owner_tenant_id,a.owner_principal_id,a.deleted_at
             FROM "${location.stores.schemas[source.store]}".artifact_versions v
             JOIN "${location.stores.schemas[source.store]}".artifacts a ON a.artifact_id=v.artifact_id
             JOIN unnest($1::text[],$2::bigint[]) AS requested(artifact_id,revision)
               ON requested.artifact_id=v.artifact_id AND requested.revision=v.revision`,
          [ids, revisions],
        );
        const byVersion = new Map(
          versions.rows.map((row) => [
            `${row.artifact_id}\0${row.artifact_revision}`,
            row,
          ]),
        );
        for (const row of rows.rows) {
          const version = byVersion.get(
            `${row.artifact_id}\0${row.artifact_revision}`,
          );
          if (
            row.store_id !== storeId(location, source.store) ||
            !version ||
            version.owner_tenant_id !== location.tenantId ||
            version.deleted_at !== null ||
            version.sha256 !== row.sha256 ||
            String(version.byte_length) !== String(row.byte_length) ||
            (row.mime !== null && version.mime !== row.mime) ||
            (row.owner_principal_id !== null &&
              version.owner_principal_id !== row.owner_principal_id)
          )
            throw new Error(
              `${source.name}引用的 Store 字节版本不完整，拒绝成套备份或恢复。`,
            );
        }
        const last = rows.rows.at(-1)!;
        cursor = [last.cursor_a, last.cursor_b];
        if (rows.rows.length < 500) break;
      }
    } finally {
      await references.end();
      await manifests.end();
    }
  }
  await verifyCloudAvatarReferences(location);
}

async function verifyCloudAvatarReferences(location: CloudApplicationStorage) {
  const platform = new Pool({ connectionString: location.platform.connectionString, max: 1 });
  const manifests = new Pool({ connectionString: location.stores.connectionString, max: 1 });
  try {
    const present = await platform.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [`${location.platform.schema}.profile_avatar_versions`]);
    if (!present.rows[0]?.relation) return;
    let cursor: [string, string, string] | undefined;
    for (;;) {
      const rows = await platform.query<Record<string, unknown>>(`SELECT * FROM "${location.platform.schema}".profile_avatar_versions WHERE tenant_id=$1 AND original_store_id IS NOT NULL ${cursor ? "AND (subject_kind,subject_id,revision)>($2,$3,$4)" : ""} ORDER BY subject_kind,subject_id,revision LIMIT 500`, [location.tenantId, ...(cursor ?? [])]);
      if (!rows.rows.length) break;
      if (!location.stores.schemas.avatars) throw new Error("头像引用存在但云头像 Store 未配置，拒绝不完整备份或恢复。");
      for (const row of rows.rows) {
        for (const variant of ["original", "poster"] as const) {
          const reference = await manifests.query<Record<string, unknown>>(`SELECT a.owner_tenant_id,a.owner_principal_id,a.deleted_at,v.sha256,v.byte_length,v.mime FROM "${location.stores.schemas.avatars}".artifact_versions v JOIN "${location.stores.schemas.avatars}".artifacts a ON a.artifact_id=v.artifact_id WHERE v.artifact_id=$1 AND v.revision=$2`, [row[variant + "_artifact_id"], row[variant + "_revision"]]);
          const version = reference.rows[0];
          const expectedId = profileAvatarArtifactId(location.tenantId, row.subject_kind as "human" | "agent", String(row.subject_id), variant, String(row[variant + "_sha256"]));
          if (row[variant + "_store_id"] !== storeId(location, "avatars") || row[variant + "_artifact_id"] !== expectedId || String(row[variant + "_revision"]) !== "1" || !version || version.owner_tenant_id !== location.tenantId || version.owner_principal_id !== "profile-avatar-service" || version.deleted_at !== null || version.sha256 !== row[variant + "_sha256"] || String(version.byte_length) !== String(row[variant + "_byte_length"]) || version.mime !== row[variant + "_mime"]) throw new Error("头像原件或静态预览版本不完整，拒绝成套备份或恢复。");
        }
      }
      const last = rows.rows.at(-1)!; cursor = [String(last.subject_kind), String(last.subject_id), String(last.revision)];
      if (rows.rows.length < 500) break;
    }
  } finally { await platform.end(); await manifests.end(); }
}

function relation(location: CloudApplicationStorage, name: RelationName) {
  return name === "platform"
    ? location.platform
    : {
        connectionString: location.applications.connectionStrings[name],
        schema: location.applications.schemas[name],
      };
}

function storeId(location: CloudApplicationStorage, name: StoreName) {
  const tenantHash = createHash("sha256")
    .update(location.tenantId)
    .digest("hex");
  if (name === "ui") return `store_ui_${tenantHash.slice(0, 32)}`;
  if (name === "images")
    return `store_objects_images_${tenantHash.slice(0, 24)}`;
  if (name === "avatars") return `store_profile_avatars_${tenantHash.slice(0, 24)}`;
  return `store_${postgresApplicationInstanceIds(location.tenantId, location.applications).reader}`;
}

function storeLocation(location: CloudApplicationStorage, name: StoreName) {
  return {
    ...location.stores.bytes,
    prefix: `${location.stores.bytes.prefix}/${location.tenantId}/${name}`,
  };
}

function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new Error("备份目录必须是绝对路径。");
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error("备份目录必须是私有的真实目录。");
}

function fsync(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function fileDigest(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("备份成员不是普通文件。");
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength))
      throw new Error("备份成员超过安全整数范围。");
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function postgresCli(connectionString: string) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("云备份 PostgreSQL 连接必须使用 URL。");
  if (
    [...url.searchParams.keys()].some((key) =>
      key.toLowerCase().includes("password"),
    )
  )
    throw new Error("PostgreSQL 密码不能放在 URL 查询参数中。");
  const password = decodeURIComponent(url.password);
  url.password = "";
  return { dbname: url.toString(), password };
}

async function runPostgresTool(
  binary: string,
  connectionString: string,
  args: string[],
) {
  const { dbname, password } = postgresCli(connectionString);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(binary, [...args, `--dbname=${dbname}`], {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.resume();
    child.once("error", () => rejectPromise(new Error(`${binary} 无法启动。`)));
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `${binary} 未完成（退出码 ${code ?? "未知"}）；检查客户端版本、连接和目标 schema。`,
          ),
        );
    });
  });
}

async function oneTenant(location: CloudApplicationStorage) {
  const pool = new Pool({
    connectionString: location.platform.connectionString,
    max: 1,
  });
  try {
    const rows = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM "${location.platform.schema}".tenants LIMIT 2`,
    );
    if (rows.rows.length !== 1 || rows.rows[0]!.tenant_id !== location.tenantId)
      throw new Error(
        "当前备份单位必须只包含指定中心；共享多租户 schema 需要另行按部署备份。",
      );
  } finally {
    await pool.end();
  }
  for (const kind of [
    "objects",
    "scriptStudio",
    "reader",
    "browser",
  ] as const) {
    const appPool = new Pool({
      connectionString: location.applications.connectionStrings[kind],
      max: 1,
    });
    try {
      const schema = location.applications.schemas[kind];
      const rows = await appPool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM "${schema}".morphz_app_binding LIMIT 2`,
      );
      if (
        rows.rows.length !== 1 ||
        rows.rows[0]!.tenant_id !== location.tenantId
      )
        throw new Error(
          "认知应用私库包含其他中心或缺少部署绑定，拒绝单中心备份。",
        );
    } finally {
      await appPool.end();
    }
  }
}

function archiveName(name: RelationName) {
  return `${name}.dump`;
}

async function openCloudStore(
  location: CloudApplicationStorage,
  name: StoreName,
  stagingRoot: string,
) {
  return ManagedArtifactStore.cloud({
    root: join(stagingRoot, name),
    storeId: storeId(location, name),
    connectionString: location.stores.connectionString,
    schema: location.stores.schemas[name]!,
    bytes: storeLocation(location, name),
    ...(location.s3Client ? { s3Client: location.s3Client } : {}),
    authorizer: {
      async authorize() {
        throw new Error("备份维护操作不能以用户身份读写 Artifact。");
      },
    },
  });
}

/** A stopped-writer snapshot of one cloud application center. Runtime and
 * Host-local deliveries are separate authorities and are never implied here.
 */
export async function backupCloudApplicationStorage(options: {
  location: CloudApplicationStorage;
  backupRoot: string;
  stagingRoot: string;
  writersStopped: true;
  pgDumpPath?: string;
}) {
  if (options.writersStopped !== true)
    throw new Error("必须先停止云部署写入者才能做成套备份。");
  validateLocation(options.location);
  privateDirectory(options.backupRoot);
  privateDirectory(options.stagingRoot);
  await oneTenant(options.location);
  await verifyCloudContentReferences(options.location);
  await verifyByteReferences(options.location);
  const stage = mkdtempSync(join(options.backupRoot, ".cloud-backup-"));
  const destination = join(
    options.backupRoot,
    `cloud-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  try {
    const relations: Manifest["relations"] = [];
    for (const name of relationNames) {
      const source = relation(options.location, name);
      const path = join(stage, archiveName(name));
      closeSync(openSync(path, "wx", 0o600));
      await runPostgresTool(
        options.pgDumpPath ?? "pg_dump",
        source.connectionString,
        [
          "--format=custom",
          "--no-owner",
          "--no-acl",
          `--schema=${source.schema}`,
          `--file=${path}`,
        ],
      );
      const digest = await fileDigest(path);
      relations.push({ name, schema: source.schema, ...digest });
    }
    const stores: Manifest["stores"] = [];
    for (const name of configuredStores(options.location)) {
      const service = await openCloudStore(
        options.location,
        name,
        options.stagingRoot,
      );
      try {
        const directory = join(stage, name);
        await service.backupTo(directory);
        const digest = await fileDigest(join(directory, "backup-info.json"));
        stores.push({
          name,
          schema: options.location.stores.schemas[name]!,
          storeId: service.storeId,
          backupInfoSha256: digest.sha256,
        });
      } finally {
        await service.close();
      }
    }
    const manifest: Manifest = {
      format: "morphz-cloud-application-storage",
      version: 1,
      createdAt: new Date().toISOString(),
      tenantId: options.location.tenantId,
      deploymentId: options.location.applications.deploymentId,
      relations,
      stores,
    };
    const marker = join(stage, "backup-manifest.json");
    writeFileSync(marker, JSON.stringify(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    fsync(marker);
    fsync(stage);
    renameSync(stage, destination);
    fsync(options.backupRoot);
    return { destination, manifest };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function readManifest(directory: string) {
  privateDirectory(directory);
  const path = join(directory, "backup-manifest.json");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024)
    throw new Error("云备份完成标记无效。");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (
    new Set(manifest.relations.map((row) => row.name)).size !==
      relationNames.length ||
    new Set(manifest.stores.map((row) => row.name)).size !== manifest.stores.length ||
    ["ui", "reader", "images"].some(name => !manifest.stores.some(row => row.name === name))
  )
    throw new Error("云备份缺少必需的关系域或对象 Store。");
  return manifest;
}

/** Restore never overwrites a schema or object prefix. On any failure the
 * target deployment remains offline for inspection, not a fallback source.
 */
export async function restoreCloudApplicationStorage(options: {
  location: CloudApplicationStorage;
  backupDirectory: string;
  stagingRoot: string;
  writersStopped: true;
  pgRestorePath?: string;
}) {
  if (options.writersStopped !== true)
    throw new Error("必须先停止目标云部署写入者才能恢复。");
  validateLocation(options.location);
  privateDirectory(options.stagingRoot);
  const manifest = readManifest(options.backupDirectory);
  if (manifest.stores.map(row => row.name).sort().join(",") !== configuredStores(options.location).sort().join(",")) throw new Error("云备份对象 Store 集合与恢复配置不匹配。");
  if (
    manifest.tenantId !== options.location.tenantId ||
    manifest.deploymentId !== options.location.applications.deploymentId
  )
    throw new Error("云备份中心或认知应用部署身份不匹配。");
  for (const entry of manifest.relations) {
    if (entry.schema !== relation(options.location, entry.name).schema)
      throw new Error("云备份关系域 schema 与恢复配置不匹配。");
    const digest = await fileDigest(
      join(options.backupDirectory, archiveName(entry.name)),
    );
    if (
      digest.sha256 !== entry.sha256 ||
      digest.byteLength !== entry.byteLength
    )
      throw new Error("云备份关系归档摘要损坏。");
  }
  for (const entry of manifest.stores) {
    if (
      entry.schema !== options.location.stores.schemas[entry.name] ||
      entry.storeId !== storeId(options.location, entry.name)
    )
      throw new Error("云备份 Store 身份与恢复配置不匹配。");
    const digest = await fileDigest(
      join(options.backupDirectory, entry.name, "backup-info.json"),
    );
    if (digest.sha256 !== entry.backupInfoSha256)
      throw new Error("云备份 Store 完成标记损坏。");
    await ManagedArtifactStore.verifyBackup({
      backupDirectory: join(options.backupDirectory, entry.name),
      storeId: entry.storeId,
    });
  }
  const targets = [
    ...relationNames.map((name) => relation(options.location, name)),
    ...configuredStores(options.location).map((name) => ({
      connectionString: options.location.stores.connectionString,
      schema: options.location.stores.schemas[name]!,
    })),
  ];
  for (const target of targets) {
    const pool = new Pool({
      connectionString: target.connectionString,
      max: 1,
    });
    try {
      const found = await pool.query(
        "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1",
        [target.schema],
      );
      if (found.rowCount)
        throw new Error("云恢复目标 schema 已存在；拒绝覆盖或复用原部署。");
    } finally {
      await pool.end();
    }
  }
  const ownsClient = !options.location.s3Client;
  const s3 =
    options.location.s3Client ??
    new S3Client({
      region: options.location.stores.bytes.region,
      ...(options.location.stores.bytes.endpoint
        ? { endpoint: options.location.stores.bytes.endpoint }
        : {}),
      forcePathStyle: options.location.stores.bytes.forcePathStyle ?? false,
    });
  try {
    for (const name of configuredStores(options.location)) {
      const bytes = storeLocation(options.location, name);
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bytes.bucket,
          Prefix: `${bytes.prefix}/`,
          MaxKeys: 1,
        }),
      );
      if (listed.Contents?.length)
        throw new Error("云恢复目标对象 prefix 已包含字节；拒绝覆盖。");
    }
  } finally {
    if (ownsClient) s3.destroy();
  }
  for (const entry of manifest.relations) {
    const target = relation(options.location, entry.name);
    await runPostgresTool(
      options.pgRestorePath ?? "pg_restore",
      target.connectionString,
      [
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        join(options.backupDirectory, archiveName(entry.name)),
      ],
    );
  }
  const pool = new Pool({
    connectionString: options.location.stores.connectionString,
    max: 1,
  });
  try {
    for (const entry of manifest.stores)
      await pool.query(`CREATE SCHEMA "${entry.schema}"`);
  } finally {
    await pool.end();
  }
  for (const entry of manifest.stores) {
    const service = await ManagedArtifactStore.restoreCloud({
      root: join(options.stagingRoot, entry.name),
      storeId: entry.storeId,
      connectionString: options.location.stores.connectionString,
      schema: entry.schema,
      bytes: storeLocation(options.location, entry.name),
      ...(options.location.s3Client
        ? { s3Client: options.location.s3Client }
        : {}),
      authorizer: {
        async authorize() {
          throw new Error("备份恢复操作不能以用户身份读写 Artifact。");
        },
      },
      backupDirectory: join(options.backupDirectory, entry.name),
    });
    await service.close();
  }
  await oneTenant(options.location);
  await verifyCloudContentReferences(options.location);
  await verifyByteReferences(options.location);
  return { tenantId: manifest.tenantId, restoredAt: new Date().toISOString() };
}
