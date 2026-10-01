import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { stateSchema, type Content } from "../packages/core/src/model.js";
import { PlatformStore } from "../packages/platform/src/store.js";

const oldStateSchema = z.object({
  mode: z.enum(["all", "off", "high"]).default("all"),
  read: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(2000)
    .default([]),
});
type NotificationState = {
  principalId: string;
  name: string;
  body: string;
  mode: "all" | "off";
  read: string[];
};

function currentReadIds(
  workspace: z.infer<typeof stateSchema>,
  principalId: string,
  saved: string[],
) {
  const projects = new Set(
    workspace.projects
      .filter((project) => project.members.includes(principalId))
      .map((project) => project.id),
  );
  const humans = workspace.actants.filter(
    (actant) => actant.kind === "human" && actant.principalId === principalId,
  );
  const oldToCurrent = new Map<string, string>();
  for (const artifact of workspace.artifacts) {
    if (!projects.has(artifact.projectId)) continue;
    for (const human of humans) {
      const phase = (content: Content) =>
        content.kind !== "task"
          ? null
          : content.assigneeId === human.id &&
              !["completed", "cancelled"].includes(content.execution) &&
              content.assignment !== "declined"
            ? [
                "human",
                content.assignment,
                content.execution === "waiting" ? "waiting" : "ready",
                content.assigneeId,
                content.runRequested,
              ]
            : content.delivery === "ready" &&
                artifact.createdBy.principalId === principalId
              ? ["delivery", content.runRequested, content.resultIds]
              : null;
      const current = phase(artifact.content);
      if (!current) continue;
      const signature = JSON.stringify(current);
      const versions = [];
      for (const version of [...artifact.versions].reverse()) {
        if (JSON.stringify(phase(version.content)) !== signature) break;
        versions.push(version);
      }
      versions.reverse();
      const entered = versions[0]?.revision ?? artifact.revision;
      const hash = (revision: number, value: unknown) =>
        createHash("sha256")
          .update(JSON.stringify([artifact.id, revision, value]))
          .digest("hex");
      const id = hash(entered, current);
      oldToCurrent.set(id, id);
      for (const version of versions) {
        if (version.content.kind !== "task") continue;
        oldToCurrent.set(
          hash(version.revision, [...current, version.content.priority]),
          id,
        );
      }
    }
  }
  return [
    ...new Set(
      saved
        .map((id) => oldToCurrent.get(id))
        .filter((id): id is string => !!id),
    ),
  ];
}

/** One-time offline cutover; no runtime fallback or ongoing dual write. */
export async function migrateNotificationsOnce(directory: string) {
  if (!isAbsolute(directory)) throw new Error("需要明确的绝对中心目录。");
  const workspaceFile = join(directory, "workspace.sqlite");
  const platformFile = join(directory, "platform.sqlite");
  if (!existsSync(workspaceFile)) throw new Error("旧工作区数据库不存在。");
  const source = new DatabaseSync(workspaceFile, { readOnly: true });
  let tenantId: string;
  let originalWorkspace: string;
  let states: NotificationState[];
  let backupFile: string;
  try {
    originalWorkspace = (
      source.prepare("SELECT body FROM workspace WHERE id=1").get() as {
        body: string;
      }
    ).body;
    const workspace = stateSchema.parse(JSON.parse(originalWorkspace));
    tenantId = (
      source
        .prepare("SELECT identity FROM center_metadata WHERE id=1")
        .get() as { identity: string }
    ).identity;
    const names = new Map(
      workspace.principals.map((principal) => [
        "notifications-" +
          createHash("sha256").update(principal.id).digest("hex"),
        principal.id,
      ]),
    );
    const rows = source
      .prepare(
        "SELECT name,body FROM service_state WHERE name LIKE 'notifications-%' ORDER BY name",
      )
      .all() as { name: string; body: string }[];
    states = rows.map((row) => {
      const principalId = names.get(row.name);
      if (!principalId)
        throw new Error("旧通知状态找不到所属身份；拒绝迁入不明数据。");
      const parsed = oldStateSchema.parse(JSON.parse(row.body));
      if (new Set(parsed.read).size !== parsed.read.length)
        throw new Error("旧通知已读记录重复。");
      return {
        principalId,
        name: row.name,
        body: row.body,
        mode: parsed.mode === "high" ? ("off" as const) : parsed.mode,
        read: currentReadIds(workspace, principalId, parsed.read),
      };
    });
    if (!states.length) return { migrated: 0, backupFile: null };
    const runtimeState = source
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string } | undefined;
    if (runtimeState) {
      const runtime = JSON.parse(runtimeState.body) as {
        deliveries?: { state?: string }[];
      };
      if (
        runtime.deliveries?.some((delivery) =>
          ["sending", "running"].includes(delivery.state ?? ""),
        )
      )
        throw new Error("仍有在途输入；先完成或停止执行，不迁移通知状态。");
    }
    backupFile = join(
      directory,
      `workspace-before-notifications-${randomUUID()}.sqlite`,
    );
    await backup(source, backupFile);
    chmodSync(backupFile, 0o600);
  } finally {
    source.close();
  }

  const initializer = await PlatformStore.sqlite(platformFile, {
    async resolveActor() {
      return null;
    },
    async resolveActant() {
      return null;
    },
    async resolveProjectAgent() {
      return null;
    },
    async verifyApplicationObject() {
      return false;
    },
  });
  try {
    await initializer.provisionTenant(tenantId);
  } finally {
    await initializer.close();
  }
  const target = new DatabaseSync(platformFile);
  try {
    target.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE",
    );
    try {
      const existingPreference = target.prepare(
        "SELECT mode,revision FROM notification_preferences WHERE tenant_id=? AND principal_id=?",
      );
      const existingReads = target.prepare(
        "SELECT notification_id FROM notification_reads WHERE tenant_id=? AND principal_id=? ORDER BY read_order",
      );
      const insertPreference = target.prepare(
        "INSERT INTO notification_preferences(tenant_id,principal_id,mode,revision,updated_at) VALUES(?,?,?,?,?)",
      );
      const insertRead = target.prepare(
        "INSERT INTO notification_reads(tenant_id,principal_id,notification_id,read_order) VALUES(?,?,?,?)",
      );
      const now = new Date().toISOString();
      for (const state of states) {
        const existing = existingPreference.get(tenantId, state.principalId) as
          { mode: string; revision: number } | undefined;
        const read = (
          existingReads.all(tenantId, state.principalId) as {
            notification_id: string;
          }[]
        ).map((row) => row.notification_id);
        if (existing) {
          if (
            existing.mode !== state.mode ||
            existing.revision !== 1 ||
            JSON.stringify(read) !== JSON.stringify(state.read)
          )
            throw new Error("Platform 通知状态已变化；拒绝覆盖或合并。");
          continue;
        }
        insertPreference.run(tenantId, state.principalId, state.mode, 1, now);
        for (const [index, id] of state.read.entries())
          insertRead.run(tenantId, state.principalId, id, index + 1);
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
  }

  const verified = new DatabaseSync(platformFile, { readOnly: true });
  try {
    for (const state of states) {
      const preference = verified
        .prepare(
          "SELECT mode,revision FROM notification_preferences WHERE tenant_id=? AND principal_id=?",
        )
        .get(tenantId, state.principalId) as
        { mode: string; revision: number } | undefined;
      const read = (
        verified
          .prepare(
            "SELECT notification_id FROM notification_reads WHERE tenant_id=? AND principal_id=? ORDER BY read_order",
          )
          .all(tenantId, state.principalId) as { notification_id: string }[]
      ).map((row) => row.notification_id);
      if (
        preference?.mode !== state.mode ||
        preference.revision !== 1 ||
        JSON.stringify(read) !== JSON.stringify(state.read)
      )
        throw new Error("Platform 通知状态校验失败；旧记录未清空。");
    }
  } finally {
    verified.close();
  }

  const old = new DatabaseSync(workspaceFile);
  try {
    old.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      const currentWorkspace = (
        old.prepare("SELECT body FROM workspace WHERE id=1").get() as {
          body: string;
        }
      ).body;
      if (currentWorkspace !== originalWorkspace)
        throw new Error("迁入期间工作区发生变化；保留旧通知记录。");
      const remove = old.prepare(
        "DELETE FROM service_state WHERE name=? AND body=?",
      );
      for (const state of states)
        if (remove.run(state.name, state.body).changes !== 1)
          throw new Error("旧通知状态发生变化；保留旧记录。");
      old.exec("COMMIT");
    } catch (error) {
      old.exec("ROLLBACK");
      throw error;
    }
  } finally {
    old.close();
  }
  return { migrated: states.length, backupFile };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3)
    throw new Error(
      "用法：tsx scripts/migrate-notifications-once.ts <已停止服务的中心绝对目录>",
    );
  const result = await migrateNotificationsOnce(directory);
  console.log(
    `已迁入 ${result.migrated} 份通知状态；备份：${result.backupFile ?? "无"}`,
  );
}
