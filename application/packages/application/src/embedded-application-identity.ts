import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const identityName = "application-instances.json";
const common = {
  tenantId: z.uuid(),
  objects: z.string().regex(/^objects_[0-9a-f]{32}$/),
  scriptStudio: z.string().regex(/^script_[0-9a-f]{32}$/),
};
const bindingSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), ...common }).strict(),
  z
    .object({
      version: z.literal(2),
      phase: z.enum(["initializing", "active"]),
      ...common,
    })
    .strict(),
]);
type Binding = z.infer<typeof bindingSchema>;

const domains = [
  {
    kind: "objects",
    name: "objects.sqlite",
    marker: "objects_schema_version",
    appId: "morphz.objects",
  },
  {
    kind: "scriptStudio",
    name: "script-studio.sqlite",
    marker: "script_schema_version",
    appId: "morphz.script-studio",
  },
  {
    kind: "reader",
    name: "reader.sqlite",
    marker: "reader_schema_version",
    appId: "morphz.reader",
  },
  {
    kind: "browser",
    name: "browser.sqlite",
    marker: "browser_schema_version",
    appId: "morphz.browser",
  },
] as const;

export type EmbeddedApplicationInstanceIds = Record<
  (typeof domains)[number]["kind"],
  string
>;

function ids(binding: Binding): EmbeddedApplicationInstanceIds {
  const pair = [binding.objects, binding.scriptStudio];
  const derived = (kind: "reader" | "browser") =>
    `${kind}_${createHash("sha256")
      .update(JSON.stringify(kind === "reader" ? pair : [...pair, "browser"]))
      .digest("hex")
      .slice(0, 32)}`;
  return {
    objects: binding.objects,
    scriptStudio: binding.scriptStudio,
    reader: derived("reader"),
    browser: derived("browser"),
  };
}

function readBinding(directory: string, tenantId: string): Binding {
  const file = join(directory, identityName);
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 1024 ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw new Error("认知应用实例身份文件权限无效。");
  const descriptor = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > 1024 ||
      (process.platform !== "win32" && opened.mode & 0o077)
    )
      throw new Error("认知应用实例身份文件已变化。");
    const binding = bindingSchema.parse(
      JSON.parse(readFileSync(descriptor, "utf8")),
    );
    if (binding.tenantId !== tenantId)
      throw new Error("认知应用实例身份不属于当前租户。");
    return binding;
  } finally {
    closeSync(descriptor);
  }
}

function syncFile(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fileInfo(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type DatabaseInspection = (
  path: string,
  inspect: (database: DatabaseSync) => void,
) => void;

const inspectDatabase: DatabaseInspection = (path, inspect) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    inspect(database);
  } finally {
    database.close();
  }
};

function assertDomains(
  directory: string,
  binding: Binding,
  requireComplete: boolean,
  inspect: DatabaseInspection = inspectDatabase,
) {
  const instanceIds = ids(binding);
  for (const domain of domains) {
    const path = join(directory, domain.name);
    const info = fileInfo(path);
    if (!info) {
      if (!requireComplete) continue;
      throw new Error(
        `认知应用实例身份对应的私库缺失：${domain.name}；拒绝创建空私库覆盖原件。`,
      );
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error(`认知应用私库不是受管的私有真实文件：${domain.name}。`);
    inspect(path, (database) => {
      const tables = new Set(
        (
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all() as Array<{ name: string }>
        ).map((table) => table.name),
      );
      if (!tables.has(domain.marker)) {
        if (!requireComplete && !tables.size) return;
        throw new Error(`认知应用私库缺少原应用结构：${domain.name}。`);
      }
      if (tables.has("morphz_app_binding")) {
        const rows = database
          .prepare(
            "SELECT tenant_id,app_id,instance_id FROM morphz_app_binding",
          )
          .all() as Array<{
          tenant_id: string;
          app_id: string;
          instance_id: string;
        }>;
        if (
          rows.length !== 1 ||
          rows[0]!.tenant_id !== binding.tenantId ||
          rows[0]!.app_id !== domain.appId ||
          rows[0]!.instance_id !== instanceIds[domain.kind]
        )
          throw new Error(`认知应用私库不属于当前实例：${domain.name}。`);
      } else if (binding.version === 2 && binding.phase === "active") {
        throw new Error(
          `认知应用私库缺少实例绑定：${domain.name}；拒绝使用替换库。`,
        );
      }
    });
  }
}

/** Pure validation for backup/restore. It never creates a missing identity or
 * private database. An initializing deployment is not a complete backup set.
 */
export function readEmbeddedApplicationInstanceIds(
  directory: string,
  tenantId: string,
  inspect: DatabaseInspection = inspectDatabase,
): EmbeddedApplicationInstanceIds {
  const binding = readBinding(directory, tenantId);
  if (binding.version === 2 && binding.phase !== "active")
    throw new Error("认知应用实例初始化尚未完成，拒绝作为完整原件使用。");
  assertDomains(directory, binding, true, inspect);
  return ids(binding);
}

/** The binding is created before first use; pending means no app has served a
 * request yet. Legacy v1 deployments require every original to still exist.
 */
export function embeddedApplicationInstanceIds(
  directory: string,
  tenantId: string,
): EmbeddedApplicationInstanceIds {
  const file = join(directory, identityName);
  if (fileInfo(file)) {
    const binding = readBinding(directory, tenantId);
    assertDomains(
      directory,
      binding,
      binding.version === 1 || binding.phase === "active",
    );
    return ids(binding);
  }
  if (domains.some((domain) => fileInfo(join(directory, domain.name))))
    throw new Error("认知应用私库缺少实例身份；拒绝登记为新实例。");
  const binding: Binding = {
    version: 2,
    phase: "initializing",
    tenantId,
    objects: `objects_${randomUUID().replaceAll("-", "")}`,
    scriptStudio: `script_${randomUUID().replaceAll("-", "")}`,
  };
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(binding), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    syncFile(temporary);
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return embeddedApplicationInstanceIds(directory, tenantId);
    }
    syncDirectory(directory);
  } finally {
    unlinkSync(temporary);
  }
  return ids(binding);
}

/** Stamp all four app-owned SQLite databases before their Platform routes are
 * published. Partial stamping is retryable; the identity becomes active last.
 */
export function sealEmbeddedApplicationInstances(
  directory: string,
  tenantId: string,
  expected: EmbeddedApplicationInstanceIds,
) {
  const binding = readBinding(directory, tenantId);
  const actual = ids(binding);
  if (domains.some((domain) => actual[domain.kind] !== expected[domain.kind]))
    throw new Error("认知应用实例身份在启动期间发生变化。");
  assertDomains(directory, binding, true);
  if (binding.version === 2 && binding.phase === "active") return;
  for (const domain of domains) {
    const database = new DatabaseSync(join(directory, domain.name));
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`CREATE TABLE IF NOT EXISTS morphz_app_binding (
          tenant_id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          instance_id TEXT NOT NULL
        )`);
        const rows = database
          .prepare(
            "SELECT tenant_id,app_id,instance_id FROM morphz_app_binding",
          )
          .all() as Array<{
          tenant_id: string;
          app_id: string;
          instance_id: string;
        }>;
        if (!rows.length)
          database
            .prepare(
              "INSERT INTO morphz_app_binding(tenant_id,app_id,instance_id) VALUES(?,?,?)",
            )
            .run(tenantId, domain.appId, expected[domain.kind]);
        else if (
          rows.length !== 1 ||
          rows[0]!.tenant_id !== tenantId ||
          rows[0]!.app_id !== domain.appId ||
          rows[0]!.instance_id !== expected[domain.kind]
        )
          throw new Error(`认知应用私库不属于当前实例：${domain.name}。`);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }
  const file = join(directory, identityName);
  const temporary = `${file}.${randomUUID()}`;
  const active: Binding = {
    version: 2,
    phase: "active",
    tenantId,
    objects: binding.objects,
    scriptStudio: binding.scriptStudio,
  };
  writeFileSync(temporary, JSON.stringify(active), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    syncFile(temporary);
    const current = readBinding(directory, tenantId);
    if (
      current.version !== binding.version ||
      current.tenantId !== binding.tenantId ||
      current.objects !== binding.objects ||
      current.scriptStudio !== binding.scriptStudio ||
      (current.version === 2 &&
        binding.version === 2 &&
        current.phase !== binding.phase)
    )
      throw new Error("认知应用实例身份在封存期间发生变化。");
    renameSync(temporary, file);
    syncDirectory(directory);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
