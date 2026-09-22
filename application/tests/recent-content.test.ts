import test from "node:test";
import assert from "node:assert/strict";
import {
  contentVisits,
  visitContent,
  recentContent,
  contentVisitTime,
} from "../apps/web/src/recent-content.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { contentEntries } from "../packages/core/src/content.js";
import { localAccess } from "../packages/core/src/model.js";

test("最近打开按实际访问顺序去重、有界，不把时间回拨当作旧访问", () => {
  let visits = visitContent([], "a", 3000);
  visits = visitContent(visits, "b", 4000);
  visits = visitContent(visits, "a", 2000);
  assert.deepEqual(visits, [
    { artifactId: "a", openedAt: 2000 },
    { artifactId: "b", openedAt: 4000 },
  ]);
  for (let i = 0; i < 120; i++) visits = visitContent(visits, `id-${i}`, i + 1);
  assert.equal(visits.length, 100);
  assert.equal(visits[0]!.artifactId, "id-119");
  assert.equal(visits[99]!.artifactId, "id-20");
});

test("旧版没有打开记录就为空，损坏偏好不生成假内容或使日期渲染崩溃", () => {
  for (const value of [undefined, null, {}, "a", 5])
    assert.deepEqual(contentVisits(value), []);
  assert.deepEqual(
    contentVisits([
      null,
      { artifactId: "", openedAt: 10 },
      { artifactId: "a", openedAt: "100" },
      { artifactId: "a", openedAt: -1 },
      { artifactId: "a", openedAt: Infinity },
      { artifactId: "a", openedAt: 1e20 },
      { artifactId: "a", openedAt: 100, title: "不保存标题" },
      { artifactId: "a", openedAt: 200 },
    ]),
    [{ artifactId: "a", openedAt: 100 }],
  );
  assert.match(
    contentVisitTime(new Date("2024-01-02T03:04:00Z").getTime()),
    /2024/,
  );
});

test("最近打开只显示当前有权访问的本空间内容，移动与改名跟随原对象，不写入对象", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const ids = ["原文", "未打开的新文档"].map(
      (title) =>
        store.execute(
          {
            commandId: crypto.randomUUID(),
            operation: {
              type: "create-artifact",
              projectId: "first-project",
              title,
              content: { kind: "document", markdown: "正文" },
            },
          },
          localAccess,
        ).entityId,
    );
    const before = store.snapshot();
    const visits = [
      { artifactId: "无权限或已不存在", openedAt: 3 },
      { artifactId: ids[0]!, openedAt: 2 },
    ];
    assert.equal(
      recentContent([], contentEntries(before), "first-project").length,
      0,
    );
    assert.deepEqual(
      recentContent(visits, contentEntries(before), "first-project").map(
        (v) => v.entry.value.id,
      ),
      [ids[0]],
    );
    assert.equal(
      recentContent(visits, contentEntries(before), "another").length,
      0,
    );
    const original = before.artifacts.find((a) => a.id === ids[0])!;
    const moved = { ...original, projectId: "another", title: "当前名称" };
    assert.equal(
      recentContent(
        visits,
        [{ kind: "artifact", value: moved }],
        "first-project",
      ).length,
      0,
    );
    assert.equal(
      recentContent(visits, [{ kind: "artifact", value: moved }], "another")[0]!
        .entry.value.title,
      "当前名称",
    );
    const understanding = {
      ...original,
      content: {
        kind: "document" as const,
        markdown: "状态",
        understanding: {
          frameId: "f",
          frameRevision: 1,
          mindVersion: 1,
          sources: [],
        },
      },
    };
    assert.equal(
      recentContent(
        visits,
        contentEntries({ ...before, artifacts: [understanding] }),
        "first-project",
      ).length,
      0,
    );
    assert.deepEqual(store.snapshot(), before);
  } finally {
    store.close();
  }
});
