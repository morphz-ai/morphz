import test from "node:test";
import assert from "node:assert/strict";
import { composeArtifactDrafts } from "../apps/web/src/composer-drafts.js";
import type { TextQuote } from "../packages/core/src/text-quotes.js";

type Draft = {
  body: string;
  selection: string;
  revision: number | null;
  model?: string;
  reasoningEffort?: "max" | "low";
  attachments?: { id: string }[];
  reading?: { location: string };
  page?: number;
  continuation?: unknown;
  continuationFailure?: "closed";
  pendingSupplement?: unknown;
  annotation?: boolean;
  taskResult?: unknown;
  scriptGeneration?: unknown;
  intent?: "document";
  textQuotes?: TextQuote[];
};
const empty: Draft = { body: "", selection: "", revision: null };
const key = "conversation:artifact";
const appKey = "conversation:application";

test("对象 compose 追加目标最新草稿，保留模型／max／附件与确切阅读版本", () => {
  const target: Draft = {
    ...empty,
    body: "未发送的正文",
    model: "target-route",
    reasoningEffort: "max",
    attachments: [{ id: "target-attachment" }],
    selection: "第4版选文",
    revision: 4,
    reading: { location: "exact-location" },
    page: 3,
  };
  const previous = {
    [key]: target,
    [appKey]: {
      ...empty,
      body: "来源应用草稿",
      model: "source-route",
      reasoningEffort: "low" as const,
    },
  };
  const result = composeArtifactDrafts(previous, key, empty, "应用补充", 9);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.drafts[key], {
    ...target,
    body: "未发送的正文\n应用补充",
  });
  assert.strictEqual(result.drafts[appKey], previous[appKey]);
  assert.deepEqual(previous[key], target);
});

test("目标不存在时只承接其合法 legacy 草稿，不复制来源 surface，不串命名会话", () => {
  const legacyKey = "project:artifact";
  const legacy: Draft = {
    ...empty,
    body: "旧目标正文",
    model: "legacy-route",
    reasoningEffort: "max",
    attachments: [{ id: "legacy-file" }],
    revision: 2,
  };
  const previous = {
    [legacyKey]: legacy,
    [appKey]: {
      ...empty,
      body: "应用正文",
      model: "source-route",
      reasoningEffort: "low" as const,
    },
  };
  const accepted = composeArtifactDrafts(
    previous,
    key,
    empty,
    "补充",
    8,
    legacyKey,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.deepEqual(accepted.drafts[key], {
    ...legacy,
    body: "旧目标正文\n补充",
  });
  assert.strictEqual(accepted.drafts[legacyKey], legacy);
  const named = composeArtifactDrafts(
    previous,
    "named:artifact",
    empty,
    "命名会话",
    8,
  );
  assert.equal(named.ok, true);
  if (named.ok)
    assert.deepEqual(named.drafts["named:artifact"], {
      ...empty,
      body: "命名会话",
      revision: 8,
    });
});

test("已存在的新 key 优先于 legacy，普通 hint／false 标记和共享引用保持", () => {
  const target: Draft = {
    ...empty,
    body: "最新正文",
    model: "new-route",
    reasoningEffort: "max",
    annotation: false,
    intent: "document",
    revision: 3,
  };
  const quotes: Draft = {
    ...empty,
    textQuotes: [
      {
        id: "shared-quote",
        text: "选文",
        comment: "评论",
        source: {
          kind: "surface",
          projectId: "project",
          applicationInstanceId: "application",
          title: "Fixture",
        },
      },
    ],
  };
  const previous = {
    [key]: target,
    "project:artifact": { ...empty, body: "旧正文", model: "old-route" },
    "conversation:quotes": quotes,
  };
  const result = composeArtifactDrafts(
    previous,
    key,
    empty,
    "新补充",
    10,
    "project:artifact",
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.drafts[key], {
      ...target,
      body: "最新正文\n新补充",
    });
    assert.strictEqual(result.drafts["conversation:quotes"], quotes);
  }
});

test("专用请求不能被对象 compose 静默改成普通输入，失败完全保留原草稿", () => {
  for (const binding of [
    { continuation: { inputId: "old-input" } },
    { continuationFailure: "closed" as const },
    { pendingSupplement: { commandId: "pending-command" } },
    { annotation: true },
    { taskResult: { taskId: "task", revision: 2 } },
    { scriptGeneration: { targetId: "script", baseRevision: 2 } },
  ]) {
    const previous = {
      [key]: {
        ...empty,
        body: "原请求",
        model: "target-route",
        reasoningEffort: "max" as const,
        ...binding,
      },
    };
    const before = structuredClone(previous);
    const result = composeArtifactDrafts(
      previous,
      key,
      empty,
      "普通应用文字",
      9,
    );
    assert.equal(result.ok, false, JSON.stringify(binding));
    if (!result.ok) assert.match(result.error, /原请求|原输入/);
    assert.deepEqual(previous, before);
  }
});

test("迟到读取以提交时最新目标值合并，不回滚更新后的正文／模型／effort", () => {
  const initial = {
    [key]: {
      ...empty,
      body: "读取前",
      model: "old-route",
      reasoningEffort: "low" as const,
    },
  };
  const latest = {
    ...initial,
    [key]: {
      ...initial[key],
      body: "读取中新增文字",
      model: "new-route",
      reasoningEffort: "max" as const,
      attachments: [{ id: "new-file" }],
    },
  };
  const result = composeArtifactDrafts(latest, key, empty, "读取后补充", 7);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(result.drafts[key], {
      ...latest[key],
      body: "读取中新增文字\n读取后补充",
      revision: 7,
    });
});

test("正文上限拒绝不截断；空追加不清空草稿；未绑定选文不猜成最新版本", () => {
  const previous = {
    [key]: {
      ...empty,
      body: "x".repeat(30000),
      reasoningEffort: "max" as const,
    },
  };
  const rejected = composeArtifactDrafts(previous, key, empty, "y", 9);
  assert.equal(rejected.ok, false);
  assert.equal(previous[key].body.length, 30000);
  const selection = { ...empty, body: "选文提问", selection: "旧选文" };
  const accepted = composeArtifactDrafts(
    { [key]: selection },
    key,
    empty,
    "",
    9,
  );
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.drafts[key], selection);
  for (const source of [
    { reading: { location: "exact-location" } },
    { page: 4 },
  ]) {
    const pinned = { ...empty, body: "旧来源草稿", ...source };
    const result = composeArtifactDrafts(
      { [key]: pinned },
      key,
      empty,
      "补充",
      9,
    );
    assert.equal(result.ok, true);
    if (result.ok)
      assert.deepEqual(result.drafts[key], {
        ...pinned,
        body: "旧来源草稿\n补充",
      });
  }
});
