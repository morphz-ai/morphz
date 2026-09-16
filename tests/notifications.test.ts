import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { Notifications } from "../apps/service/src/notifications.js";
import { contentSchema, localAccess } from "../packages/core/src/model.js";
test("通知按身份与已读设置投影，文字及旧优先级修改不重复提醒", () => {
  const store = new WorkspaceStore(":memory:"),
    other = { principalId: "other", actantId: "other-human" };
  store.provisionMembers([
    { ...other, name: "另一位", projectIds: [], enabled: true },
  ]);
  const content = contentSchema.parse({
    kind: "task",
    description: "需要判断",
    assigneeId: "local-human",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "proposed",
    execution: "waiting",
    delivery: "none",
    resultIds: [],
  });
  try {
    const artifactId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "私人事项",
          content,
        },
      },
      localAccess,
    ).entityId;
    let notifications = new Notifications(store),
      view = notifications.snapshot(localAccess);
    assert.equal(view.unread, 1);
    assert.equal(notifications.snapshot(other).items.length, 0);
    assert.throws(
      () =>
        notifications.control(other, {
          action: "read",
          ids: [view.items[0]!.id],
        }),
      /无权访问/,
    );
    notifications.control(localAccess, {
      action: "read",
      ids: [view.items[0]!.id],
    });
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId,
          expectedRevision: 1,
          title: "文字修改后的事项",
          content,
        },
      },
      localAccess,
    );
    notifications = new Notifications(store);
    assert.equal(notifications.snapshot(localAccess).unread, 0);
    assert.equal(content.kind, "task");
    if (content.kind !== "task") assert.fail();
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId,
          expectedRevision: 2,
          title: "需要立即判断",
          content: { ...content, priority: "high" },
        },
      },
      localAccess,
    );
    const after = notifications.snapshot(localAccess);
    assert.equal(after.items[0]!.id, view.items[0]!.id);
    assert.equal(after.unread, 0);
    assert.equal("priority" in after.items[0]!, false);
    assert.throws(() =>
      notifications.control(localAccess, { action: "settings", mode: "high" }),
    );
    assert.equal(
      notifications.control(localAccess, { action: "settings", mode: "off" })
        .unread,
      0,
    );
    assert.equal(new Notifications(store).snapshot(localAccess).mode, "off");
    assert.equal(notifications.snapshot(other).mode, "all");
  } finally {
    store.close();
  }
});

const receipt = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const savedKey =
  "notifications-" +
  createHash("sha256").update(localAccess.principalId).digest("hex");

test("旧优先级通知的已读与待同步回执保留，真正阶段变化才再次提醒", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const content = contentSchema.parse({
      kind: "task",
      description: "TEST",
      assigneeId: localAccess.actantId,
      assignment: "proposed",
      execution: "waiting",
      model: null,
      dueDate: null,
      delivery: "none",
      resultIds: [],
    });
    if (content.kind !== "task") assert.fail();
    const id = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "TEST 旧已读",
          content,
        },
      },
      localAccess,
    ).entityId;
    const firstLegacy = receipt([
      id,
      1,
      [
        "human",
        content.assignment,
        "waiting",
        content.assigneeId,
        content.runRequested,
        content.priority,
      ],
    ]);
    for (const [index, priority] of (["high", "low"] as const).entries()) {
      store.execute(
        {
          commandId: randomUUID(),
          operation: {
            type: "revise-artifact",
            artifactId: id,
            expectedRevision: index + 1,
            title: "TEST 旧已读",
            content: { ...content, priority },
          },
        },
        localAccess,
      );
    }
    const secondLegacy = receipt([
      id,
      2,
      [
        "human",
        content.assignment,
        "waiting",
        content.assigneeId,
        content.runRequested,
        "high",
      ],
    ]);
    const notifications = new Notifications(store);
    const currentId = notifications.snapshot(localAccess).items[0]!.id;
    for (const oldId of [firstLegacy, secondLegacy]) {
      store.saveServiceState(savedKey, { mode: "all", read: [oldId] });
      assert.equal(notifications.snapshot(localAccess).unread, 0);
      store.saveServiceState(savedKey, { mode: "all", read: [] });
      assert.equal(
        notifications.control(localAccess, { action: "read", ids: [oldId] })
          .unread,
        0,
      );
      assert.deepEqual(
        (store.serviceState(savedKey) as { read: string[] }).read,
        [currentId],
      );
    }
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: id,
          expectedRevision: 3,
          title: "TEST 重新需要处理",
          content: { ...content, assignment: "accepted" },
        },
      },
      localAccess,
    );
    assert.equal(notifications.snapshot(localAccess).unread, 1);
    assert.notEqual(
      notifications.snapshot(localAccess).items[0]!.id,
      currentId,
    );
    assert.throws(
      () =>
        notifications.control(localAccess, {
          action: "read",
          ids: [secondLegacy],
        }),
      /无权访问/,
    );
  } finally {
    store.close();
  }
});

test("旧的仅高优先级偏好不被静默扩大，用户重新选择后才启用全部提醒", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    store.saveServiceState(savedKey, { mode: "high", read: [] });
    const notifications = new Notifications(store);
    const before = notifications.snapshot(localAccess);
    assert.equal(before.mode, "off");
    assert.equal(before.needsReview, true);
    assert.equal(before.unread, 0);
    assert.equal(
      (store.serviceState(savedKey) as { mode: string }).mode,
      "high",
    );
    notifications.control(localAccess, { action: "read", ids: [] });
    assert.equal(notifications.snapshot(localAccess).needsReview, true);
    const after = notifications.control(localAccess, {
      action: "settings",
      mode: "all",
    });
    assert.equal(after.mode, "all");
    assert.equal(after.needsReview, false);
    assert.equal(new Notifications(store).snapshot(localAccess).mode, "all");
  } finally {
    store.close();
  }
});
