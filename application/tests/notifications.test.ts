import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Notifications } from "../packages/application/src/notifications.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import {
  PlatformStore,
  type PlatformActor,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  contentSchema,
  localAccess,
  type AccessContext,
} from "../packages/core/src/model.js";
import { migrateNotificationsOnce } from "../scripts/migrate-notifications-once.js";
import { viewModelFixture } from "./view-model-fixture.js";

async function openNotifications(store: WorkspaceStore) {
  const tenantId = store.identity();
  let active = true;
  const human = new HumanPlatformAuthority(
    tenantId,
    (access) =>
      active &&
      [localAccess, { principalId: "other", actantId: "other-human" }].some(
        (human) =>
          human.actantId === access.actantId &&
          human.principalId === access.principalId,
      ),
  );
  const remaining: PlatformAuthorityVerifier = {
    async resolveActor() {
      return null;
    },
    async resolveActant({ actantId }) {
      if (actantId === localAccess.actantId)
        return { principalId: localAccess.principalId, kind: "human" as const };
      return null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "morphz-agent" };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const platform = await PlatformStore.sqlite(
    ":memory:",
    human.verifier(remaining),
  );
  await platform.provisionTenant(tenantId);
  const asHuman = <T>(
    access: AccessContext,
    work: (actor: PlatformActor) => Promise<T>,
  ) => human.withSession(access, () => {}, work);
  await asHuman(localAccess, (actor) =>
    platform.createProject(actor, {
      commandId: randomUUID(),
      projectId: "first-project",
      title: "测试项目",
    }),
  );
  return {
    platform,
    asHuman,
    service: new Notifications(platform, human),
    readPlatform: () =>
      human.withSession(
        localAccess,
        () => {},
        (actor) => platform.readNotificationState(actor),
      ),
    revoke() {
      active = false;
    },
  };
}

function seedHistoricalHumanTask(fixture: ReturnType<typeof viewModelFixture>) {
  const content = contentSchema.parse({
    kind: "task",
    description: "需要判断",
    assigneeId: localAccess.actantId,
    model: null,
    priority: "high",
    dueDate: null,
    assignment: "proposed",
    execution: "waiting",
    delivery: "none",
    resultIds: [],
  });
  if (content.kind !== "task") throw new Error("测试事项类型错误。");
  const createdAt = "2026-09-13T00:00:00.000Z";
  const artifactId = fixture.seedArtifact({
    projectId: "first-project",
    title: "私人事项",
    content,
    revision: 2,
    versions: [
      {
        revision: 1,
        title: "私人事项",
        content: { ...content, priority: "normal" },
        author: localAccess,
        createdAt,
      },
      {
        revision: 2,
        title: "私人事项",
        content,
        author: localAccess,
        createdAt,
      },
    ],
  }).id;
  return { artifactId, content };
}

async function createPlatformHumanTask(
  setup: Awaited<ReturnType<typeof openNotifications>>,
) {
  const taskId = randomUUID();
  await setup.asHuman(localAccess, (actor) =>
    setup.platform.createTask(actor, {
      commandId: randomUUID(),
      taskId,
      projectId: "first-project",
      title: "私人事项",
      description: "需要判断",
      assigneeId: localAccess.actantId,
    }),
  );
  await setup.asHuman(localAccess, (actor) =>
    setup.platform.reviseTask(actor, {
      commandId: randomUUID(),
      taskId,
      expectedRevision: 1,
      execution: "waiting",
    }),
  );
  return taskId;
}

test("通知候选从当前事项投影，偏好与已读只写 Platform", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const other = { principalId: "other", actantId: "other-human" };
  const setup = await openNotifications(store);
  const { platform, service, readPlatform } = setup;
  try {
    const artifactId = await createPlatformHumanTask(setup);
    const view = await service.snapshot(localAccess);
    assert.equal(view.unread, 1);
    assert.equal(view.revision, 0);
    assert.deepEqual((await service.snapshot(other)).items, []);
    await assert.rejects(
      service.control(other, {
        action: "read",
        ids: [view.items[0]!.id],
        commandId: randomUUID(),
        expectedRevision: 0,
      }),
      /无权访问/,
    );
    const read = {
      action: "read" as const,
      ids: [view.items[0]!.id],
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    assert.equal((await service.control(localAccess, read)).unread, 0);
    assert.equal((await service.control(localAccess, read)).revision, 1);
    assert.deepEqual((await readPlatform()).read, read.ids);
    const legacyKey =
      "notifications-" +
      createHash("sha256").update(localAccess.principalId).digest("hex");
    assert.equal(store.serviceState(legacyKey), null);
    await setup.asHuman(localAccess, (actor) =>
      platform.reviseTask(actor, {
        commandId: randomUUID(),
        taskId: artifactId,
        expectedRevision: 2,
        title: "文字修改后的事项",
      }),
    );
    await setup.asHuman(localAccess, (actor) =>
      platform.reviseTask(actor, {
        commandId: randomUUID(),
        taskId: artifactId,
        expectedRevision: 3,
        description: "更新了说明",
      }),
    );
    const after = await service.snapshot(localAccess);
    assert.equal(after.items[0]!.id, view.items[0]!.id);
    assert.equal(after.unread, 0);
    await setup.asHuman(localAccess, (actor) =>
      platform.reviseTask(actor, {
        commandId: randomUUID(),
        taskId: artifactId,
        expectedRevision: 4,
        execution: "planned",
      }),
    );
    await setup.asHuman(localAccess, (actor) =>
      platform.reviseTask(actor, {
        commandId: randomUUID(),
        taskId: artifactId,
        expectedRevision: 5,
        execution: "waiting",
      }),
    );
    const reentered = await service.snapshot(localAccess);
    assert.notEqual(reentered.items[0]!.id, view.items[0]!.id);
    assert.equal(reentered.unread, 1);
    const settings = {
      action: "settings" as const,
      mode: "off" as const,
      commandId: randomUUID(),
      expectedRevision: reentered.revision,
    };
    assert.equal((await service.control(localAccess, settings)).mode, "off");
    assert.equal((await service.snapshot(other)).mode, "all");
    await assert.rejects(
      service.control(localAccess, { ...settings, mode: "all" }),
      /另一项请求/,
    );
  } finally {
    await platform.close();
    store.close();
  }
});

test("通知修订冲突与身份撤销不会写入 Platform", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const setup = await openNotifications(store);
  const { platform, service, revoke } = setup;
  try {
    await createPlatformHumanTask(setup);
    const first = await service.snapshot(localAccess);
    await service.control(localAccess, {
      action: "settings",
      mode: "off",
      commandId: randomUUID(),
      expectedRevision: first.revision,
    });
    await assert.rejects(
      service.control(localAccess, {
        action: "settings",
        mode: "all",
        commandId: randomUUID(),
        expectedRevision: first.revision,
      }),
      /已更新/,
    );
    revoke();
    await assert.rejects(service.snapshot(localAccess), /身份已失效/);
  } finally {
    await platform.close();
    store.close();
  }
});

test("原版 Desktop 的通知偏好冷迁入 Platform，候选只来自新事项", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-notification-cutover-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    // A frozen legacy export for the explicit offline migration tool only.
    // No production legacy business writer is needed to create this sample.
    const fixture = viewModelFixture();
    const { artifactId, content } = seedHistoricalHumanTask(fixture);
    if (content.kind !== "task") throw new Error("测试事项类型错误。");
    const key =
      "notifications-" +
      createHash("sha256").update(localAccess.principalId).digest("hex");
    const oldRead = createHash("sha256")
      .update(
        JSON.stringify([
          artifactId,
          2,
          [
            "human",
            content.assignment,
            "waiting",
            localAccess.actantId,
            content.runRequested,
            "high",
          ],
        ]),
      )
      .digest("hex");
    const filename = join(directory, "workspace.sqlite");
    const old = new WorkspaceStore(filename, { mode: "transport" });
    old.saveServiceState(key, { mode: "off", read: [oldRead] });
    old.close();
    const legacyExport = new DatabaseSync(filename);
    try {
      legacyExport.exec(
        "CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)",
      );
      legacyExport
        .prepare("INSERT INTO workspace(id,body) VALUES(1,?)")
        .run(JSON.stringify(fixture.state));
    } finally {
      legacyExport.close();
    }
    host = await openEmbeddedApplication(directory, profile);
    const initial = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const current = (await host.connection.call(
      "notifications.read",
      undefined,
      {
        identityGeneration: initial.csrfToken,
      },
    )) as { mode: string; items: unknown[] };
    assert.equal(current.mode, "all");
    assert.deepEqual(current.items, []);
    await host.close();
    host = undefined;
    const untouched = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    });
    assert.deepEqual(untouched.serviceState(key), {
      mode: "off",
      read: [oldRead],
    });
    untouched.close();
    const migrated = await migrateNotificationsOnce(directory);
    assert.equal(migrated.migrated, 1);
    assert.ok(migrated.backupFile && existsSync(migrated.backupFile));
    assert.deepEqual(await migrateNotificationsOnce(directory), {
      migrated: 0,
      backupFile: null,
    });
    const oldAfter = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    });
    assert.equal(oldAfter.serviceState(key), null);
    oldAfter.close();
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const before = (await host.connection.call(
      "notifications.read",
      undefined,
      options,
    )) as { items: unknown[] };
    assert.deepEqual(before.items, []);
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await host.connection.call(
      "projects.create",
      { commandId: randomUUID(), projectId, title: "新事项项目" },
      options,
    );
    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    await host.connection.call(
      "tasks.create",
      {
        commandId: randomUUID(),
        taskId,
        projectId,
        title: "新平台事项",
        assigneeId: localAccess.actantId,
      },
      options,
    );
    const view = (await host.connection.call("notifications.read", undefined, {
      identityGeneration: boot.csrfToken,
    })) as {
      mode: string;
      revision: number;
      unread: number;
      items: { id: string; read: boolean }[];
    };
    assert.equal(view.mode, "off");
    assert.equal(view.revision, 1);
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0]?.read, false);
    assert.notEqual(view.items[0]?.id, oldRead);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
