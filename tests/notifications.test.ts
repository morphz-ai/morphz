import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { Notifications } from "../apps/service/src/notifications.js";
import { contentSchema, localAccess } from "../packages/core/src/model.js";
test("事项通知按身份、优先级与已读设置投影，普通文字修改不重复提醒", () => {
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
    view = notifications.control(localAccess, {
      action: "settings",
      mode: "high",
    });
    assert.equal(view.unread, 1);
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
