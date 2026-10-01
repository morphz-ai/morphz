import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";
import { z } from "zod";
import { ManagedArtifactStore } from "../../managed-artifact-store/src/store.js";
import { readEmbeddedApplicationInstanceIds } from "./embedded-application-identity.js";

const databases = [
  "workspace.sqlite",
  "platform.sqlite",
  "browser.sqlite",
  "objects.sqlite",
  "script-studio.sqlite",
  "reader.sqlite",
] as const;
const applicationDatabases = [
  "browser.sqlite",
  "objects.sqlite",
  "script-studio.sqlite",
  "reader.sqlite",
] as const;
const identityFile = "application-instances.json";
const allowedFiles = new Set<string>([...databases, identityFile]);
const manifestSchema = z
  .object({
    format: z.literal("morphz-center-storage"),
    version: z.literal(2),
    createdAt: z.iso.datetime(),
    centerId: z.uuid(),
    files: z.array(
      z
        .object({
          name: z.string(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    readerStore: z
      .object({
        storeId: z.string(),
        backupInfoSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
    messageStore: z
      .object({
        storeId: z.string(),
        backupInfoSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable()
      .optional(),
    imageStore: z
      .object({
        storeId: z.string(),
        backupInfoSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable()
      .optional(),
    uiStore: z
      .object({
        storeId: z.string(),
        backupInfoSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

function regularFile(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`不是普通文件：${path}`);
}

function sha256(path: string) {
  regularFile(path);
  const hash = createHash("sha256");
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const block = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(descriptor, block, 0, block.length, null);
      if (!count) break;
      hash.update(block.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function syncFile(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function centerId(database: DatabaseSync) {
  const row = database
    .prepare("SELECT identity FROM center_metadata WHERE id = 1")
    .get() as { identity?: unknown } | undefined;
  return z.uuid().parse(row?.identity);
}

function integrity(database: DatabaseSync, name: string) {
  const result = database.prepare("PRAGMA integrity_check").get();
  if (Object.values(result ?? {})[0] !== "ok")
    throw new Error(`数据库完整性校验失败：${name}`);
  if (database.prepare("PRAGMA foreign_key_check").get())
    throw new Error(`数据库外键校验失败：${name}`);
}

function objectByteReferences(database: DatabaseSync) {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM object_version_bytes")
    .get() as { count: number };
  return Number(row.count);
}

function uiPackageReferences(database: DatabaseSync) {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='app_ui_packages'",
    )
    .get();
  if (!table) return 0;
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM app_ui_packages")
    .get() as { count: number };
  return Number(row.count);
}

function verifyUiPackageReferences(
  platform: DatabaseSync,
  store: DatabaseSync,
  tenantId: string,
  expectedStoreId: string,
) {
  if (!uiPackageReferences(platform)) return;
  for (const packageRow of platform
    .prepare(
      "SELECT installed_by_principal_id,store_id,artifact_id,artifact_revision,sha256,byte_length FROM app_ui_packages",
    )
    .iterate() as Iterable<{
    installed_by_principal_id: string;
    store_id: string;
    artifact_id: string;
    artifact_revision: number;
    sha256: string;
    byte_length: number;
  }>) {
    const version = store
      .prepare(
        `SELECT a.owner_tenant_id,a.owner_principal_id,a.deleted_at,
              v.sha256,v.byte_length,v.mime
         FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
        WHERE v.artifact_id=? AND v.revision=?`,
      )
      .get(packageRow.artifact_id, packageRow.artifact_revision) as
      | {
          owner_tenant_id: string;
          owner_principal_id: string;
          deleted_at: string | null;
          sha256: string;
          byte_length: number;
          mime: string;
        }
      | undefined;
    if (
      packageRow.store_id !== expectedStoreId ||
      !version ||
      version.owner_tenant_id !== tenantId ||
      version.owner_principal_id !== packageRow.installed_by_principal_id ||
      version.deleted_at ||
      version.sha256 !== packageRow.sha256 ||
      version.byte_length !== packageRow.byte_length ||
      version.mime !== "text/html;charset=utf-8"
    )
      throw new Error("已安装应用的字节版本与 Store 不一致，拒绝不完整备份。");
  }
}

function verifiedStoreVersion(
  store: DatabaseSync,
  artifactId: string,
  revision: number,
) {
  return store
    .prepare(
      `SELECT a.owner_tenant_id,a.deleted_at,v.sha256,v.byte_length,v.mime
       FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
      WHERE v.artifact_id=? AND v.revision=?`,
    )
    .get(artifactId, revision) as
    | {
        owner_tenant_id: string;
        deleted_at: string | null;
        sha256: string;
        byte_length: number;
        mime: string;
      }
    | undefined;
}

function verifyImageReferences(
  objects: DatabaseSync,
  store: DatabaseSync,
  expectedStoreId: string,
) {
  for (const reference of objects
    .prepare(
      `SELECT b.tenant_id,b.store_id,b.artifact_id,b.artifact_revision,
            b.sha256,b.byte_length,b.mime
       FROM object_version_bytes b JOIN objects o
         ON o.tenant_id=b.tenant_id AND o.object_id=b.object_id
      WHERE o.deleted_at IS NULL`,
    )
    .iterate() as Iterable<{
    tenant_id: string;
    store_id: string;
    artifact_id: string;
    artifact_revision: number;
    sha256: string;
    byte_length: number;
    mime: string;
  }>) {
    const version = verifiedStoreVersion(
      store,
      reference.artifact_id,
      reference.artifact_revision,
    );
    if (
      reference.store_id !== expectedStoreId ||
      !version ||
      version.deleted_at ||
      version.owner_tenant_id !== reference.tenant_id ||
      version.sha256 !== reference.sha256 ||
      version.byte_length !== reference.byte_length ||
      version.mime !== reference.mime
    )
      throw new Error(
        "Objects 原件的字节版本与图片 Store 不一致，拒绝不完整备份。",
      );
  }
}

function verifyReaderOriginalReferences(
  reader: DatabaseSync,
  store: DatabaseSync,
  expectedStoreId: string,
) {
  for (const reference of reader
    .prepare(
      `SELECT v.tenant_id,v.provider_id,v.object_ref,v.revision,
            v.sha256,v.byte_length
       FROM book_revisions v JOIN books b
         ON b.tenant_id=v.tenant_id AND b.book_id=v.book_id
      WHERE b.deleted_at IS NULL AND v.storage_kind='app_private'`,
    )
    .iterate() as Iterable<{
    tenant_id: string;
    provider_id: string;
    object_ref: string;
    revision: number;
    sha256: string;
    byte_length: number;
  }>) {
    const version = verifiedStoreVersion(
      store,
      reference.object_ref,
      reference.revision,
    );
    if (
      reference.provider_id !== expectedStoreId ||
      !version ||
      version.deleted_at ||
      version.owner_tenant_id !== reference.tenant_id ||
      version.sha256 !== reference.sha256 ||
      version.byte_length !== reference.byte_length
    )
      throw new Error(
        "Reader 书籍原件与阅读 Store 的字节版本不一致，拒绝不完整备份。",
      );
  }
}

function messageAttachmentReferences(database: DatabaseSync) {
  const state = database
    .prepare("SELECT body FROM runtime_state WHERE id=1")
    .get() as { body: string } | undefined;
  if (
    state &&
    (
      JSON.parse(state.body) as {
        deliveries?: Array<{ resourceUploads?: Array<{ assetId?: string }> }>;
      }
    ).deliveries?.some((delivery) =>
      delivery.resourceUploads?.some((upload) => upload.assetId),
    )
  )
    return true;
  for (const row of database
    .prepare("SELECT body FROM runtime_deliveries")
    .iterate() as Iterable<{ body: string }>) {
    const delivery = JSON.parse(row.body) as {
      resourceUploads?: Array<{ assetId?: string }>;
    };
    if (delivery.resourceUploads?.some((upload) => upload.assetId)) return true;
  }
  return false;
}

// Opening a WAL-mode backup even read-only can create -wal/-shm files. Inspect
// an isolated copy so the sealed backup remains exactly the manifest files.
function inspectBackupDatabase<T>(
  path: string,
  inspect: (database: DatabaseSync) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), "morphz-backup-check-"));
  try {
    const copy = join(directory, basename(path));
    copyFileSync(path, copy, constants.COPYFILE_EXCL);
    const database = new DatabaseSync(copy, { readOnly: true });
    try {
      return inspect(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function integrityOfBackup(path: string) {
  return inspectBackupDatabase(path, (database) => {
    integrity(database, basename(path));
    return basename(path) === "workspace.sqlite"
      ? centerId(database)
      : undefined;
  });
}

function dataFileNames(directory: string) {
  const names = databases.filter((name) => existsSync(join(directory, name)));
  if (!names.includes("workspace.sqlite"))
    throw new Error("中心数据库不存在，未创建备份。");
  const hasIdentity = existsSync(join(directory, identityFile));
  const hasAppDatabase = applicationDatabases.some((name) =>
    names.includes(name),
  );
  if (hasIdentity !== hasAppDatabase)
    throw new Error("认知应用私库与实例身份不成套，拒绝备份。");
  if (hasIdentity && !names.includes("platform.sqlite"))
    throw new Error(
      "当前中心没有 Platform SQLite 库；可能使用 PostgreSQL。backup:center 不能备份 PostgreSQL，拒绝生成不完整备份。",
    );
  if (hasIdentity && applicationDatabases.some((name) => !names.includes(name)))
    throw new Error("认知应用私库不完整，拒绝备份。");
  return hasIdentity ? [...names, identityFile] : [...names];
}

function verifyBinding(
  directory: string,
  id: string,
  names: readonly string[],
  sealedPackage = false,
) {
  if (!names.includes(identityFile)) return;
  return sealedPackage
    ? readEmbeddedApplicationInstanceIds(directory, id, inspectBackupDatabase)
    : readEmbeddedApplicationInstanceIds(directory, id);
}

/** Available catalog entries owned by this embedded instance must have their
 * originals. Other instances of the same app type remain external references;
 * this backup does not claim their private data. Keep this check outside
 * Platform: each application owns its own tables and migrations.
 */
function verifyContentReferences(
  databases: ReadonlyMap<string, DatabaseSync>,
  instances: NonNullable<ReturnType<typeof verifyBinding>>,
) {
  const platform = databases.get("platform.sqlite");
  if (!platform || !databases.has("objects.sqlite")) return;
  const origins = new Map<
    string,
    ReturnType<DatabaseSync["prepare"]> | undefined
  >(
    (
      [
        ["morphz.objects", "objects.sqlite", "objects", "object_id"],
        [
          "morphz.script-studio",
          "script-studio.sqlite",
          "script_productions",
          "production_id",
        ],
        ["morphz.reader", "reader.sqlite", "books", "book_id"],
      ] as const
    ).map(
      ([appId, databaseName, table, key]) =>
        [
          appId,
          databases
            .get(databaseName)
            ?.prepare(
              `SELECT deleted_at FROM ${table} WHERE tenant_id=? AND ${key}=?`,
            ),
        ] as const,
    ),
  );
  for (const entry of platform
    .prepare(
      `SELECT app_id,instance_id,tenant_id,app_object_id FROM content_entries
        WHERE deleted_at IS NULL AND availability='available'
          AND app_id IN ('morphz.objects','morphz.script-studio','morphz.reader')`,
    )
    .iterate() as Iterable<{
    app_id: string;
    instance_id: string;
    tenant_id: string;
    app_object_id: string;
  }>) {
    const expectedInstance =
      entry.app_id === "morphz.objects"
        ? instances.objects
        : entry.app_id === "morphz.script-studio"
          ? instances.scriptStudio
          : instances.reader;
    if (entry.instance_id !== expectedInstance) continue;
    const lookup = origins.get(entry.app_id);
    const original = lookup?.get(entry.tenant_id, entry.app_object_id) as
      { deleted_at: string | null } | undefined;
    if (!original || original.deleted_at)
      throw new Error(
        `内容目录中的 ${entry.app_id} 原件缺失或已删除，拒绝不完整备份。`,
      );
  }
}

// SQLite may create WAL sidecars when opening a sealed backup. Verify a small
// temporary copy, never mutate or append files to the backup package itself.
function inspectContentReferences(
  directory: string,
  names: readonly string[],
  instances: NonNullable<ReturnType<typeof verifyBinding>> | undefined,
) {
  if (!instances || !names.includes("platform.sqlite")) return;
  const scratch = mkdtempSync(join(tmpdir(), "morphz-content-check-"));
  const handles = new Map<string, DatabaseSync>();
  try {
    for (const name of databases) {
      if (!names.includes(name) || name === "workspace.sqlite") continue;
      const copy = join(scratch, name);
      copyFileSync(join(directory, name), copy, constants.COPYFILE_EXCL);
      handles.set(name, new DatabaseSync(copy, { readOnly: true }));
    }
    verifyContentReferences(handles, instances);
  } finally {
    for (const database of handles.values()) database.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function messageStoreId(tenantId: string) {
  return `store_messages_${createHash("sha256").update(tenantId).digest("hex").slice(0, 32)}`;
}

function imageStoreId(tenantId: string) {
  return `store_objects_images_${createHash("sha256").update(tenantId).digest("hex").slice(0, 24)}`;
}

function uiStoreId(tenantId: string) {
  return `store_ui_${createHash("sha256").update(tenantId).digest("hex").slice(0, 32)}`;
}

const backupAuthorizer = {
  authorize(): never {
    throw new Error("备份连接不提供业务操作授权。");
  },
};

/** A cold snapshot of this embedded center's relational stores and its Reader
 * original Store. The caller must stop every writer first; data_version also
 * catches intervening writes. Runtime and Client drafts remain separate.
 */
export async function backupCenterStorage(options: {
  sourceDirectory: string;
  backupDirectory: string;
  writersStopped: true;
}) {
  const { sourceDirectory, backupDirectory } = options;
  if (options.writersStopped !== true)
    throw new Error("备份前必须停止该中心的全部写入者。");
  if (!isAbsolute(sourceDirectory) || !isAbsolute(backupDirectory))
    throw new Error("备份源和目标必须是绝对路径。");
  if (resolve(sourceDirectory) === resolve(backupDirectory))
    throw new Error("备份目标不能是中心目录。");
  const names = dataFileNames(sourceDirectory);
  for (const name of names) regularFile(join(sourceDirectory, name));
  const sourceBindingHash = names.includes(identityFile)
    ? sha256(join(sourceDirectory, identityFile))
    : null;
  const handles = new Map<string, DatabaseSync>();
  let readerStore: ManagedArtifactStore | undefined;
  let readerManifest: DatabaseSync | undefined;
  let messageStore: ManagedArtifactStore | undefined;
  let messageManifest: DatabaseSync | undefined;
  let imageStore: ManagedArtifactStore | undefined;
  let imageManifest: DatabaseSync | undefined;
  let uiStore: ManagedArtifactStore | undefined;
  let uiManifest: DatabaseSync | undefined;
  let staging: string | undefined;
  try {
    for (const name of databases) {
      if (!names.includes(name)) continue;
      const db = new DatabaseSync(join(sourceDirectory, name), {
        readOnly: true,
      });
      handles.set(name, db);
      integrity(db, name);
    }
    const id = centerId(handles.get("workspace.sqlite")!);
    const instances = verifyBinding(sourceDirectory, id, names);
    if (instances) verifyContentReferences(handles, instances);
    const expectedReaderStoreId = instances
      ? `store_${instances.reader}`
      : null;
    const readerRoot = join(sourceDirectory, "reader-originals");
    const hasReaderStore = existsSync(readerRoot);
    if (hasReaderStore && !names.includes(identityFile))
      throw new Error("阅读原件 Store 缺少应用实例身份，拒绝备份。");
    if (names.includes("reader.sqlite")) {
      const count = handles
        .get("reader.sqlite")!
        .prepare("SELECT COUNT(*) AS count FROM reader_book_events")
        .get() as { count: number };
      if (Number(count.count) && !hasReaderStore)
        throw new Error(
          "书籍目录存在，但阅读原件 Store 缺失，拒绝不完整备份。",
        );
    }
    if (hasReaderStore) {
      if (!expectedReaderStoreId)
        throw new Error("阅读原件 Store 缺少应用实例身份，拒绝备份。");
      readerStore = await ManagedArtifactStore.sqlite({
        root: readerRoot,
        storeId: expectedReaderStoreId,
        authorizer: backupAuthorizer,
      });
      readerManifest = new DatabaseSync(join(readerRoot, "manifest.sqlite"), {
        readOnly: true,
      });
      if (names.includes("reader.sqlite"))
        verifyReaderOriginalReferences(
          handles.get("reader.sqlite")!,
          readerManifest,
          expectedReaderStoreId,
        );
    }
    const messageRoot = join(sourceDirectory, "message-attachments");
    const hasMessageStore = existsSync(messageRoot);
    if (
      !hasMessageStore &&
      messageAttachmentReferences(handles.get("workspace.sqlite")!)
    )
      throw new Error("消息投递引用了缺失的附件 Store，拒绝不完整备份。");
    if (hasMessageStore) {
      messageStore = await ManagedArtifactStore.sqlite({
        root: messageRoot,
        storeId: messageStoreId(id),
        authorizer: backupAuthorizer,
      });
      messageManifest = new DatabaseSync(join(messageRoot, "manifest.sqlite"), {
        readOnly: true,
      });
    }
    const imageRoot = join(sourceDirectory, "objects-images");
    const hasImageStore = existsSync(imageRoot);
    if (hasImageStore && !names.includes("objects.sqlite"))
      throw new Error("图片 Store 缺少 Objects 私库，拒绝不完整备份。");
    if (
      names.includes("objects.sqlite") &&
      !hasImageStore &&
      objectByteReferences(handles.get("objects.sqlite")!) > 0
    )
      throw new Error("Objects 原件引用了缺失的图片 Store，拒绝不完整备份。");
    if (hasImageStore) {
      imageStore = await ManagedArtifactStore.sqlite({
        root: imageRoot,
        storeId: imageStoreId(id),
        authorizer: backupAuthorizer,
      });
      imageManifest = new DatabaseSync(join(imageRoot, "manifest.sqlite"), {
        readOnly: true,
      });
      verifyImageReferences(
        handles.get("objects.sqlite")!,
        imageManifest,
        imageStoreId(id),
      );
    }
    const uiRoot = join(sourceDirectory, "ui-packages");
    const hasUiStore = existsSync(uiRoot);
    const uiReferences = names.includes("platform.sqlite")
      ? uiPackageReferences(handles.get("platform.sqlite")!)
      : 0;
    if (uiReferences && !hasUiStore)
      throw new Error("已安装应用引用了缺失的界面包 Store，拒绝不完整备份。");
    if (uiReferences) {
      uiStore = await ManagedArtifactStore.sqlite({
        root: uiRoot,
        storeId: uiStoreId(id),
        authorizer: backupAuthorizer,
      });
      uiManifest = new DatabaseSync(join(uiRoot, "manifest.sqlite"), {
        readOnly: true,
      });
      verifyUiPackageReferences(
        handles.get("platform.sqlite")!,
        uiManifest,
        id,
        uiStoreId(id),
      );
    }
    const versions = new Map(
      [...handles].map(([name, db]) => [
        name,
        Object.values(db.prepare("PRAGMA data_version").get() ?? {})[0],
      ]),
    );
    const readerManifestVersion = readerManifest
      ? Object.values(
          readerManifest.prepare("PRAGMA data_version").get() ?? {},
        )[0]
      : null;
    const messageManifestVersion = messageManifest
      ? Object.values(
          messageManifest.prepare("PRAGMA data_version").get() ?? {},
        )[0]
      : null;
    const imageManifestVersion = imageManifest
      ? Object.values(
          imageManifest.prepare("PRAGMA data_version").get() ?? {},
        )[0]
      : null;
    const uiManifestVersion = uiManifest
      ? Object.values(uiManifest.prepare("PRAGMA data_version").get() ?? {})[0]
      : null;
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    staging = join(backupDirectory, `.incomplete-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    const files: Array<{ name: string; sha256: string }> = [];
    for (const name of names) {
      const target = join(staging, name);
      const db = handles.get(name);
      if (db) await backup(db, target);
      else
        copyFileSync(
          join(sourceDirectory, name),
          target,
          constants.COPYFILE_EXCL,
        );
      chmodSync(target, 0o600);
      if (db) integrityOfBackup(target);
      syncFile(target);
      files.push({ name, sha256: sha256(target) });
    }
    const readerStoreBackup = readerStore
      ? await readerStore.backupTo(join(staging, "reader-originals"))
      : null;
    const messageStoreBackup = messageStore
      ? await messageStore.backupTo(join(staging, "message-attachments"))
      : null;
    const imageStoreBackup = imageStore
      ? await imageStore.backupTo(join(staging, "objects-images"))
      : null;
    const uiStoreBackup = uiStore
      ? await uiStore.backupTo(join(staging, "ui-packages"))
      : null;
    for (const [name, db] of handles) {
      if (
        Object.values(db.prepare("PRAGMA data_version").get() ?? {})[0] !==
        versions.get(name)
      )
        throw new Error("备份期间中心发生写入；请停止应用后重试。");
    }
    if (
      readerManifest &&
      Object.values(
        readerManifest.prepare("PRAGMA data_version").get() ?? {},
      )[0] !== readerManifestVersion
    )
      throw new Error("备份期间阅读原件 Store 发生写入；请停止应用后重试。");
    if (
      messageManifest &&
      Object.values(
        messageManifest.prepare("PRAGMA data_version").get() ?? {},
      )[0] !== messageManifestVersion
    )
      throw new Error("备份期间消息附件 Store 发生写入；请停止应用后重试。");
    if (
      imageManifest &&
      Object.values(
        imageManifest.prepare("PRAGMA data_version").get() ?? {},
      )[0] !== imageManifestVersion
    )
      throw new Error("备份期间图片 Store 发生写入；请停止应用后重试。");
    if (
      uiManifest &&
      Object.values(
        uiManifest.prepare("PRAGMA data_version").get() ?? {},
      )[0] !== uiManifestVersion
    )
      throw new Error("备份期间界面包 Store 发生写入；请停止应用后重试。");
    if (
      dataFileNames(sourceDirectory).join("\0") !== names.join("\0") ||
      (sourceBindingHash &&
        sourceBindingHash !== sha256(join(sourceDirectory, identityFile)))
    )
      throw new Error("备份期间中心文件发生变化；请停止应用后重试。");
    const manifest = manifestSchema.parse({
      format: "morphz-center-storage",
      version: 2,
      createdAt: new Date().toISOString(),
      centerId: id,
      files,
      readerStore: readerStoreBackup
        ? {
            storeId: readerStoreBackup.storeId,
            backupInfoSha256: sha256(
              join(staging, "reader-originals", "backup-info.json"),
            ),
          }
        : null,
      messageStore: messageStoreBackup
        ? {
            storeId: messageStoreBackup.storeId,
            backupInfoSha256: sha256(
              join(staging, "message-attachments", "backup-info.json"),
            ),
          }
        : null,
      imageStore: imageStoreBackup
        ? {
            storeId: imageStoreBackup.storeId,
            backupInfoSha256: sha256(
              join(staging, "objects-images", "backup-info.json"),
            ),
          }
        : null,
      uiStore: uiStoreBackup
        ? {
            storeId: uiStoreBackup.storeId,
            backupInfoSha256: sha256(
              join(staging, "ui-packages", "backup-info.json"),
            ),
          }
        : null,
    });
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    syncFile(join(staging, "manifest.json"));
    syncDirectory(staging);
    const destination = join(
      backupDirectory,
      `center-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    );
    renameSync(staging, destination);
    syncDirectory(backupDirectory);
    staging = undefined;
    return {
      destination,
      centerId: id,
      files: [
        ...names,
        ...(readerStoreBackup ? ["reader-originals"] : []),
        ...(messageStoreBackup ? ["message-attachments"] : []),
        ...(imageStoreBackup ? ["objects-images"] : []),
        ...(uiStoreBackup ? ["ui-packages"] : []),
      ],
    };
  } finally {
    readerManifest?.close();
    await readerStore?.close();
    messageManifest?.close();
    await messageStore?.close();
    imageManifest?.close();
    await imageStore?.close();
    uiManifest?.close();
    await uiStore?.close();
    for (const db of handles.values()) db.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

/** Refuses to overwrite an existing center. Always verify before publication. */
export async function restoreCenterStorage(options: {
  backupDirectory: string;
  destinationDirectory: string;
  writersStopped: true;
}) {
  const { backupDirectory, destinationDirectory } = options;
  if (options.writersStopped !== true)
    throw new Error("恢复前必须停止目标中心的全部写入者。");
  if (!isAbsolute(backupDirectory) || !isAbsolute(destinationDirectory))
    throw new Error("恢复源和目标必须是绝对路径。");
  if (resolve(backupDirectory) === resolve(destinationDirectory))
    throw new Error("恢复目标不能是备份目录。");
  if (existsSync(destinationDirectory))
    throw new Error("恢复目标已存在；只允许恢复到新目录。");
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8")),
  );
  const names = manifest.files.map((file) => file.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !allowedFiles.has(name)) ||
    readdirSync(backupDirectory).sort().join("\0") !==
      [
        ...names,
        "manifest.json",
        ...(manifest.readerStore ? ["reader-originals"] : []),
        ...(manifest.messageStore ? ["message-attachments"] : []),
        ...(manifest.imageStore ? ["objects-images"] : []),
        ...(manifest.uiStore ? ["ui-packages"] : []),
      ]
        .sort()
        .join("\0")
  )
    throw new Error(
      `备份文件清单无效：${readdirSync(backupDirectory).join(", ")}`,
    );
  if (dataFileNames(backupDirectory).join("\0") !== names.join("\0"))
    throw new Error("备份文件组合无效。");
  let restoredCenterId: string | undefined;
  for (const file of manifest.files) {
    const path = join(backupDirectory, file.name);
    if (sha256(path) !== file.sha256)
      throw new Error(`备份摘要不匹配：${file.name}`);
    if (file.name.endsWith(".sqlite"))
      restoredCenterId = integrityOfBackup(path) ?? restoredCenterId;
  }
  if (restoredCenterId !== manifest.centerId)
    throw new Error("备份中心身份不匹配。");
  const instances = verifyBinding(
    backupDirectory,
    manifest.centerId,
    names,
    true,
  );
  inspectContentReferences(backupDirectory, names, instances);
  const expectedReaderStoreId = instances ? `store_${instances.reader}` : null;
  if (manifest.readerStore) {
    if (
      !names.includes("reader.sqlite") ||
      !names.includes(identityFile) ||
      manifest.readerStore.storeId !== expectedReaderStoreId ||
      sha256(join(backupDirectory, "reader-originals", "backup-info.json")) !==
        manifest.readerStore.backupInfoSha256
    )
      throw new Error("阅读原件 Store 与中心备份身份或摘要不匹配。");
  } else if (names.includes("reader.sqlite")) {
    const references = inspectBackupDatabase(
      join(backupDirectory, "reader.sqlite"),
      (database) => {
        const row = database
          .prepare("SELECT COUNT(*) AS count FROM reader_book_events")
          .get() as { count: number };
        return Number(row.count);
      },
    );
    if (references) throw new Error("备份缺少已登记书籍的原件 Store。");
  }
  if (
    manifest.messageStore &&
    (manifest.messageStore.storeId !== messageStoreId(manifest.centerId) ||
      sha256(
        join(backupDirectory, "message-attachments", "backup-info.json"),
      ) !== manifest.messageStore.backupInfoSha256)
  )
    throw new Error("消息附件 Store 与中心备份身份或摘要不匹配。");
  if (!manifest.messageStore) {
    const references = inspectBackupDatabase(
      join(backupDirectory, "workspace.sqlite"),
      messageAttachmentReferences,
    );
    if (references) throw new Error("备份缺少已投递消息的附件 Store。");
  }
  if (
    manifest.imageStore &&
    (manifest.imageStore.storeId !== imageStoreId(manifest.centerId) ||
      sha256(join(backupDirectory, "objects-images", "backup-info.json")) !==
        manifest.imageStore.backupInfoSha256)
  )
    throw new Error("图片 Store 与中心备份身份或摘要不匹配。");
  if (manifest.imageStore && !names.includes("objects.sqlite"))
    throw new Error("备份的图片 Store 缺少 Objects 私库。");
  if (names.includes("objects.sqlite") && !manifest.imageStore) {
    const references = inspectBackupDatabase(
      join(backupDirectory, "objects.sqlite"),
      objectByteReferences,
    );
    if (references > 0) throw new Error("备份缺少已登记原件的图片 Store。");
  }
  if (
    manifest.uiStore &&
    (!names.includes("platform.sqlite") ||
      manifest.uiStore.storeId !== uiStoreId(manifest.centerId) ||
      sha256(join(backupDirectory, "ui-packages", "backup-info.json")) !==
        manifest.uiStore.backupInfoSha256)
  )
    throw new Error("界面包 Store 与中心备份身份或摘要不匹配。");
  if (names.includes("platform.sqlite") && !manifest.uiStore) {
    const references = inspectBackupDatabase(
      join(backupDirectory, "platform.sqlite"),
      uiPackageReferences,
    );
    if (references > 0) throw new Error("备份缺少已安装应用的界面包 Store。");
  }
  const staging = join(
    dirname(destinationDirectory),
    `.restore-${randomUUID()}`,
  );
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const name of names) {
      const target = join(staging, name);
      copyFileSync(
        join(backupDirectory, name),
        target,
        constants.COPYFILE_EXCL,
      );
      chmodSync(target, 0o600);
      syncFile(target);
    }
    if (manifest.readerStore) {
      const readerStore = await ManagedArtifactStore.restoreSqlite({
        root: join(staging, "reader-originals"),
        storeId: manifest.readerStore.storeId,
        authorizer: backupAuthorizer,
        backupDirectory: join(backupDirectory, "reader-originals"),
      });
      await readerStore.close();
      const reader = new DatabaseSync(join(staging, "reader.sqlite"), {
        readOnly: true,
      });
      const store = new DatabaseSync(
        join(staging, "reader-originals", "manifest.sqlite"),
        { readOnly: true },
      );
      try {
        verifyReaderOriginalReferences(
          reader,
          store,
          manifest.readerStore.storeId,
        );
      } finally {
        store.close();
        reader.close();
      }
    }
    if (manifest.messageStore) {
      const messageStore = await ManagedArtifactStore.restoreSqlite({
        root: join(staging, "message-attachments"),
        storeId: manifest.messageStore.storeId,
        authorizer: backupAuthorizer,
        backupDirectory: join(backupDirectory, "message-attachments"),
      });
      await messageStore.close();
    }
    if (manifest.imageStore) {
      const imageStore = await ManagedArtifactStore.restoreSqlite({
        root: join(staging, "objects-images"),
        storeId: manifest.imageStore.storeId,
        authorizer: backupAuthorizer,
        backupDirectory: join(backupDirectory, "objects-images"),
      });
      await imageStore.close();
      const objects = new DatabaseSync(join(staging, "objects.sqlite"), {
        readOnly: true,
      });
      const store = new DatabaseSync(
        join(staging, "objects-images", "manifest.sqlite"),
        { readOnly: true },
      );
      try {
        verifyImageReferences(objects, store, manifest.imageStore.storeId);
      } finally {
        store.close();
        objects.close();
      }
    }
    if (manifest.uiStore) {
      const uiStore = await ManagedArtifactStore.restoreSqlite({
        root: join(staging, "ui-packages"),
        storeId: manifest.uiStore.storeId,
        authorizer: backupAuthorizer,
        backupDirectory: join(backupDirectory, "ui-packages"),
      });
      await uiStore.close();
      const platform = new DatabaseSync(join(staging, "platform.sqlite"), {
        readOnly: true,
      });
      const store = new DatabaseSync(
        join(staging, "ui-packages", "manifest.sqlite"),
        { readOnly: true },
      );
      try {
        verifyUiPackageReferences(
          platform,
          store,
          manifest.centerId,
          manifest.uiStore.storeId,
        );
      } finally {
        store.close();
        platform.close();
      }
    }
    syncDirectory(staging);
    if (existsSync(destinationDirectory))
      throw new Error("恢复目标已存在；没有覆盖现有数据。");
    renameSync(staging, destinationDirectory);
    syncDirectory(dirname(destinationDirectory));
    return {
      destination: destinationDirectory,
      centerId: manifest.centerId,
      files: [
        ...names,
        ...(manifest.readerStore ? ["reader-originals"] : []),
        ...(manifest.messageStore ? ["message-attachments"] : []),
        ...(manifest.imageStore ? ["objects-images"] : []),
        ...(manifest.uiStore ? ["ui-packages"] : []),
      ],
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
