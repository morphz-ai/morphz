import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

const id = (value: number) => value.toString(16).padStart(64, "0");
const authority: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    const parts = credential.split(":");
    if (parts.length !== 3 || parts[0] !== "human") return null;
    const [, tenantId, principalId] = parts;
    if (!tenantId || !principalId) return null;
    return {
      tenantId,
      principalId,
      actantId: principalId,
      kind: "human" as const,
      runtimeInputId: null,
    };
  },
  async resolveActant({ actantId }) {
    if (actantId === "alice" || actantId === "bob")
      return { principalId: actantId, kind: "human" as const };
    return null;
  },
  async resolveProjectAgent() {
    return { principalId: "morphz-service", actantId: "morphz-agent" };
  },
  async verifyApplicationObject() {
    return false;
  },
};

async function exercise(store: PlatformStore) {
  await store.provisionTenant("tenant-a");
  await store.provisionTenant("tenant-b");
  const alice = { credential: "human:tenant-a:alice" };
  const bob = { credential: "human:tenant-a:bob" };
  const otherTenant = { credential: "human:tenant-b:alice" };
  await assert.rejects(
    store.readNotificationState({ credential: "invalid" }),
    /身份/,
  );
  assert.deepEqual(await store.readNotificationState(alice), {
    mode: "all",
    read: [],
    revision: 0,
  });
  const settings = {
    commandId: "mode-one",
    expectedRevision: 0,
    action: "settings" as const,
    mode: "off" as const,
    now: "2026-09-25T00:00:00.000Z",
  };
  assert.equal(await store.updateNotificationState(alice, settings), 1);
  assert.equal(await store.updateNotificationState(alice, settings), 1);
  assert.deepEqual(await store.readNotificationState(alice), {
    mode: "off",
    read: [],
    revision: 1,
  });
  for (const access of [bob, otherTenant])
    assert.deepEqual(await store.readNotificationState(access), {
      mode: "all",
      read: [],
      revision: 0,
    });
  await assert.rejects(
    store.updateNotificationState(alice, { ...settings, mode: "all" }),
    /另一项请求/,
  );
  await assert.rejects(
    store.updateNotificationState(alice, { ...settings, commandId: "stale" }),
    /已更新/,
  );
  assert.equal(
    await store.updateNotificationState(alice, {
      commandId: "read-one",
      expectedRevision: 1,
      action: "read",
      ids: [id(1), id(2)],
    }),
    2,
  );
  assert.equal(
    await store.updateNotificationState(alice, {
      commandId: "mode-two",
      expectedRevision: 2,
      action: "settings",
      mode: "all",
    }),
    3,
  );
  assert.equal(
    await store.updateNotificationState(alice, {
      commandId: "read-two",
      expectedRevision: 3,
      action: "read",
      ids: [id(2), id(3), id(3)],
    }),
    4,
  );
  assert.deepEqual(await store.readNotificationState(alice), {
    mode: "all",
    read: [id(1), id(2), id(3)],
    revision: 4,
  });
  await assert.rejects(
    store.updateNotificationState(alice, {
      commandId: "bad-id",
      expectedRevision: 4,
      action: "read",
      ids: ["not-a-hash"],
    }),
    /通知操作无效/,
  );

  await store.createProject(alice, {
    commandId: "project-command",
    projectId: "project-one",
    title: "测试项目",
  });
  await store.createTask(alice, {
    commandId: "task-command",
    taskId: "task-one",
    projectId: "project-one",
    title: "请处理",
    assigneeId: "alice",
  });
  const first = await store.notificationCandidates(alice);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.task_id, "task-one");
  assert.equal(first[0]?.entered_revision, 1);
  assert.deepEqual(await store.notificationCandidates(bob), []);
  assert.deepEqual(await store.notificationCandidates(otherTenant), []);
  await store.reviseTask(alice, {
    commandId: "title-command",
    taskId: "task-one",
    expectedRevision: 1,
    title: "更新标题",
  });
  assert.equal(
    (await store.notificationCandidates(alice))[0]?.entered_revision,
    1,
  );
  await store.reviseTask(alice, {
    commandId: "wait-command",
    taskId: "task-one",
    expectedRevision: 2,
    execution: "waiting",
  });
  assert.equal(
    (await store.notificationCandidates(alice))[0]?.entered_revision,
    3,
  );
  await store.reviseTask(alice, {
    commandId: "planned-command",
    taskId: "task-one",
    expectedRevision: 3,
    execution: "planned",
  });
  assert.equal(
    (await store.notificationCandidates(alice))[0]?.entered_revision,
    4,
  );
  await store.reviseTask(alice, {
    commandId: "wait-again-command",
    taskId: "task-one",
    expectedRevision: 4,
    execution: "waiting",
  });
  assert.equal(
    (await store.notificationCandidates(alice))[0]?.entered_revision,
    5,
  );
}

test("Platform SQLite 通知状态归属、CAS 与幂等", async () => {
  const store = await PlatformStore.sqlite(":memory:", authority);
  try {
    await exercise(store);
  } finally {
    await store.close();
  }
});

test("Platform SQLite 已读上限只清理最旧记录", async () => {
  const store = await PlatformStore.sqlite(":memory:", authority);
  try {
    await store.provisionTenant("tenant-a");
    const access = { credential: "human:tenant-a:alice" };
    for (let batch = 0; batch < 10; batch++)
      await store.updateNotificationState(access, {
        commandId: `read-batch-${batch}`,
        expectedRevision: batch,
        action: "read",
        ids: Array.from({ length: 200 }, (_, index) =>
          id(batch * 200 + index + 1),
        ),
      });
    await store.updateNotificationState(access, {
      commandId: "read-next",
      expectedRevision: 10,
      action: "read",
      ids: [id(2001)],
    });
    const current = await store.readNotificationState({
      credential: "human:tenant-a:alice",
    });
    assert.equal(current.read.length, 2000);
    assert.equal(current.read[0], id(2));
    assert.equal(current.read.at(-1), id(2001));
  } finally {
    await store.close();
  }
});

async function exerciseConcurrent(first: PlatformStore, second: PlatformStore) {
  await first.provisionTenant("tenant-a");
  const alice = { credential: "human:tenant-a:alice" };
  for (const expectedRevision of [0, 1]) {
    const settled = await Promise.allSettled([
      first.updateNotificationState(alice, {
        commandId: `first-${expectedRevision}`,
        expectedRevision,
        action: "settings",
        mode: "off",
      }),
      second.updateNotificationState(alice, {
        commandId: `second-${expectedRevision}`,
        expectedRevision,
        action: "settings",
        mode: "all",
      }),
    ]);
    assert.equal(
      settled.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      settled.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.match(
      String(
        (
          settled.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult
        ).reason,
      ),
      /通知状态已更新/,
    );
    assert.equal(
      (await first.readNotificationState(alice)).revision,
      expectedRevision + 1,
    );
  }
}

test("Platform SQLite 双连接不能用旧修订覆盖另一个通知操作", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-notify-sqlite-"));
  const filename = join(directory, "platform.sqlite");
  let first: PlatformStore | undefined;
  let second: PlatformStore | undefined;
  try {
    first = await PlatformStore.sqlite(filename, authority);
    second = await PlatformStore.sqlite(filename, authority);
    await exerciseConcurrent(first, second);
  } finally {
    await Promise.all([first?.close(), second?.close()]);
    rmSync(directory, { recursive: true });
  }
});

test(
  "Platform PostgreSQL 通知状态与 SQLite 同义",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await PlatformStore.postgres(
        { connectionString, schema },
        authority,
      );
      try {
        await exercise(store);
      } finally {
        await store.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Platform PostgreSQL 双连接不能用旧修订覆盖另一个通知操作",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let first: PlatformStore | undefined;
    let second: PlatformStore | undefined;
    try {
      first = await PlatformStore.postgres(
        { connectionString, schema },
        authority,
      );
      second = await PlatformStore.postgres(
        { connectionString, schema },
        authority,
      );
      await exerciseConcurrent(first, second);
    } finally {
      await Promise.all([first?.close(), second?.close()]);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
