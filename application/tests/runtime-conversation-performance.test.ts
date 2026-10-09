import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { ConversationFeed } from "../packages/application/src/conversation-feed.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import type { ConversationStream } from "../packages/core/src/live-conversation.js";
import { conversationRuntimeSchema } from "../packages/core/src/conversation.js";
import { forbidLegacySnapshot } from "./host-transport-invariant.js";

test("Platform 实时订阅从已保存游标开始，不重放整段历史", async (t) => {
  let requestedAfter = -1;
  t.mock.method(
    ConversationFeed.prototype as any,
    "update",
    async (
      _sessionId: string,
      connection: { cursor: number; ready: boolean },
    ) => {
      requestedAfter = connection.cursor;
      connection.ready = true;
    },
  );
  const feed = new ConversationFeed({
    sessions: () => ["session"],
    initialCursor: () => 438,
    url: "http://127.0.0.1:1",
    headers: () => ({}),
    request: async () => ({}),
    route: () => ({
      projectId: "project",
      conversationId: "conversation",
      artifactId: null,
      inputId: null,
      rootId: null,
    }),
    changed: () => {},
    authorize: () => {},
    failed: () => {},
  });
  try {
    await feed.sync();
    assert.equal(requestedAfter, 438);
  } finally {
    feed.close();
  }
});

/** Controlled Runtime Event reads; real transport store and Platform observer. */
async function platformObserverFixture(t: import("node:test").TestContext) {
  type Options = ConstructorParameters<typeof ConversationFeed>[0];
  let feedOptions!: Options;
  t.mock.method(
    ConversationFeed.prototype,
    "sync",
    async function (this: ConversationFeed) {
      feedOptions = (this as unknown as { options: Options }).options;
    },
  );
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const snapshot = forbidLegacySnapshot(store);
  const bridge = new RuntimeBridge(
    store,
    {
      url: "http://127.0.0.1:1",
      namespace: "perf-test",
      token: "test",
    },
    undefined,
    false,
  );
  let readable = true,
    authorizations = 0,
    rootReads = 0,
    publications = 0,
    failures = 0;
  let received: ConversationStream = { connected: false, messages: [] };
  let settle: (() => void) | undefined;
  let rootOverride: ((event: TimelineEvent) => Promise<unknown>) | undefined;
  bridge.bindPlatformReadAuthority(async () => {
    authorizations++;
    if (!readable) throw new Error("authorization revoked");
    return { personalDefault: false, projectIds: ["project"] };
  });
  const makePair = (sessionId: string, index: number) => {
    const at = new Date(
      Date.parse("2026-09-30T00:00:00Z") + index,
    ).toISOString();
    return timelinePair(
      bridge,
      sessionId,
      index,
      at,
      at,
      at,
      "TEST 回复 " + index,
    );
  };
  const runtime = bridge as unknown as {
    request: (path: string) => Promise<unknown>;
  };
  t.mock.method(runtime, "request", async (path: string) => {
    const url = new URL(path, "http://localhost");
    const sessionId = url.pathname.split("/")[3]!;
    if (url.pathname.endsWith("/timeline"))
      return { entries: [], next_before: null };
    if (url.pathname.endsWith("/events"))
      return { latest_sequence: 438, events: [] };
    const root = /^root-(\d+)$/.exec(url.pathname.split("/").at(-1)!);
    assert.ok(root, "Only exact root Event reads are permitted: " + path);
    rootReads++;
    const event = makePair(sessionId, Number(root[1]))[0]!.event;
    return rootOverride ? rootOverride(event) : { event };
  });
  const close = await bridge.observePlatformConversation(
    { projectId: "project", conversationId: "conversation" },
    localAccess,
    (value) => {
      received = value;
      publications++;
      settle?.();
    },
    () => {
      failures++;
      settle?.();
    },
  );
  const publish = async (messages: ConversationStream["messages"]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        settle = resolve;
        timer = setTimeout(
          () => reject(new Error("Publication did not settle")),
          2000,
        );
        feedOptions.changed({ connected: true, messages });
      });
      return received;
    } finally {
      clearTimeout(timer);
      settle = undefined;
    }
  };
  const messages = (start: number, count: number) =>
    Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        id: "reply-" + index,
        rootId: "root-" + index,
        inputId: null,
        projectId: "project",
        conversationId: "conversation",
        artifactId: null,
        kind: "reply" as const,
        text: "TEST 回复 " + index,
        createdAt: new Date(
          Date.parse("2026-09-30T00:00:00Z") + index,
        ).toISOString(),
      };
    });
  return {
    feed: feedOptions,
    bridge,
    publish,
    messages,
    metrics: () => ({
      authorizations,
      rootReads,
      publications,
      failures,
      snapshotReads: snapshot.calls(),
    }),
    revoke: () => {
      readable = false;
    },
    rootEvent: (index: number) =>
      makePair(feedOptions.sessions()[0]!, index)[0]!.event,
    overrideRoot: (value: typeof rootOverride) => {
      rootOverride = value;
    },
    async close() {
      close();
      await bridge.stop();
      snapshot.restore();
      store.close();
    },
  };
}

test("Platform 实时批次不解析工作空间，来源复用仍逐批核验权限", async (t) => {
  const f = await platformObserverFixture(t);
  try {
    const batch = f.messages(0, 100);
    const before = f.metrics();
    const start = performance.now();
    const received = await f.publish(batch);
    console.log(
      "MESSAGE_HOST_PERFORMANCE",
      JSON.stringify({
        messages: batch.length,
        snapshotReads: f.metrics().snapshotReads,
        rootReads: f.metrics().rootReads - before.rootReads,
        authorizationReads: f.metrics().authorizations - before.authorizations,
        elapsedMs: performance.now() - start,
      }),
    );
    assert.equal(received.messages.length, 100);
    assert.deepEqual(
      received.messages.map((m) => m.inputId),
      Array.from({ length: 100 }, (_, i) => "input-" + i),
    );
    assert.equal(f.metrics().snapshotReads, 0);
    assert.equal(f.metrics().rootReads, 100);
    assert.equal(f.metrics().authorizations - before.authorizations, 2);
    const cached = f.metrics();
    await f.publish(batch);
    assert.equal(f.metrics().rootReads, cached.rootReads);
    assert.equal(f.metrics().authorizations - cached.authorizations, 2);
    assert.equal(f.feed.initialCursor?.(f.feed.sessions()[0]!), 438);
    f.revoke();
    await assert.rejects(
      async () => f.feed.authorize(),
      /authorization revoked/,
    );
    await f.publish(batch);
    assert.equal(
      f.metrics().publications,
      2,
      "Revoked permission must not publish another batch",
    );
    assert.equal(f.metrics().rootReads, cached.rootReads);
    assert.equal(f.metrics().failures, 1);
    assert.equal(f.metrics().snapshotReads, 0);
  } finally {
    await f.close();
  }
});

test("实时根来源缓存有界，淘汰后按需重读而不保存消息历史", async (t) => {
  const f = await platformObserverFixture(t);
  try {
    for (const start of [0, 100, 200]) await f.publish(f.messages(start, 100));
    assert.equal(f.metrics().rootReads, 300);
    const reread = await f.publish(f.messages(0, 1));
    assert.equal(
      f.metrics().rootReads,
      301,
      "The oldest root must be evicted after 200 newer roots",
    );
    assert.equal(reread.messages[0]?.inputId, "input-0");
    await f.publish(f.messages(299, 1));
    assert.equal(f.metrics().rootReads, 301, "Recent source stays cached");
    assert.equal(f.metrics().snapshotReads, 0);
  } finally {
    await f.close();
  }
});

test("迟到的根读取缺失不能抹掉 WebSocket 已取得的新来源", async (t) => {
  const f = await platformObserverFixture(t);
  let requested!: () => void, resolveRoot!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  f.overrideRoot(() => {
    requested();
    return new Promise((resolve) => {
      resolveRoot = resolve;
    });
  });
  try {
    const pending = f.publish(f.messages(7, 1));
    await started;
    const event = f.rootEvent(7);
    f.feed.onEvent?.(f.feed.sessions()[0]!, event);
    resolveRoot({ event: { ...event, id: "mismatched-root" } });
    assert.equal((await pending).messages.length, 0);
    f.overrideRoot(undefined);
    const received = await f.publish(f.messages(7, 1));
    assert.equal(received.messages[0]?.inputId, "input-7");
    assert.equal(
      f.metrics().rootReads,
      1,
      "A delayed miss must retain the newer authoritative Event",
    );
  } finally {
    await f.close();
  }
});

type TimelineEvent = {
  id: string;
  sequence: number;
  timestamp: string;
  topic: string;
  payload: Record<string, unknown>;
};
type TimelineFixtureEntry = {
  entry_id: string;
  visible_at: string;
  visible_at_micros: number;
  root_turn_id: string;
  attempt_id: string | null;
  display_kind: "input" | "reply" | "progress" | "error";
  final_event: boolean;
  event: TimelineEvent;
  root_event: TimelineEvent | null;
};
function storedData(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number")
    return { type: "number", value: String(value) };
  if (Array.isArray(value))
    return { type: "array", value: value.map(storedData) };
  if (typeof value === "object")
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, storedData(item)]),
      ),
    };
  throw new TypeError("Unsupported fixture Data value");
}
function timelinePair(
  bridge: RuntimeBridge,
  sessionId: string,
  index: number,
  inputAt: string,
  firstVisibleAt: string,
  finalAt: string,
  finalText: string,
  sourceProjectId = "project",
): TimelineFixtureEntry[] {
  const inputId = "input-" + index;
  const rootId = "root-" + index;
  const attemptId = "attempt-" + index;
  const source = {
    projectId: sourceProjectId,
    conversationId: "conversation",
    targetActantId: "morphz-agent",
    author: localAccess,
    createdAt: inputAt,
    body: inputId,
    sharedDefault: false,
  };
  const root: TimelineEvent = {
    id: rootId,
    sequence: index * 2 + 1,
    timestamp: inputAt,
    topic: "chat/user_message",
    payload: {
      session_id: sessionId,
      root_turn_id: rootId,
      client_message_id: inputId,
      principal_id: bridge.principalId(localAccess.principalId),
      session_io: {
        request: {
          client_message_id: inputId,
          client_metadata: storedData({
            kind: "morphz.platform-input",
            version: 1,
            source,
          }),
          message: {
            content: {
              encoding: "json",
              value: storedData({
                input_id: inputId,
                workspace_id: source.projectId,
                author_actant_id: source.author.actantId,
              }),
            },
          },
        },
      },
    },
  };
  const reply: TimelineEvent = {
    id: "reply-" + index,
    sequence: index * 2 + 2,
    timestamp: finalAt,
    topic: "chat/reply",
    payload: {
      session_id: sessionId,
      root_turn_id: rootId,
      attempt_id: attemptId,
      text: finalText,
    },
  };
  return [
    {
      entry_id: inputId,
      visible_at: inputAt,
      visible_at_micros: Date.parse(inputAt) * 1000,
      root_turn_id: rootId,
      attempt_id: null,
      display_kind: "input",
      final_event: false,
      event: root,
      root_event: null,
    },
    {
      entry_id: "publication:" + attemptId,
      visible_at: firstVisibleAt,
      visible_at_micros: Date.parse(firstVisibleAt) * 1000,
      root_turn_id: rootId,
      attempt_id: attemptId,
      display_kind: "reply",
      final_event: true,
      event: reply,
      root_event: root,
    },
  ];
}
function timelineBridge(
  store: WorkspaceStore,
  makeEntries: (
    bridge: RuntimeBridge,
    sessionId: string,
  ) => TimelineFixtureEntry[],
) {
  const bridge = new RuntimeBridge(store, {
    url: "http://127.0.0.1:1",
    namespace: "timeline-performance-test",
    token: "test",
  });
  bridge.bindPlatformReadAuthority(async () => ({
    personalDefault: false,
    projectIds: ["project"],
  }));
  let fetches = 0;
  let largestResponse = 0;
  const request = bridge as unknown as {
    request: (path: string) => Promise<unknown>;
  };
  request.request = async (path) => {
    assert.ok(path.startsWith("/api/sessions/") && path.includes("/timeline?"));
    fetches++;
    const url = new URL(path, "http://localhost");
    const sessionId = url.pathname.split("/")[3]!;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const beforeMicros = Number(
      url.searchParams.get("before_time_micros") ?? Infinity,
    );
    const beforeId = url.searchParams.get("before_entry_id") ?? "";
    const sorted = makeEntries(bridge, sessionId)
      .filter(
        (entry) =>
          entry.visible_at_micros < beforeMicros ||
          (entry.visible_at_micros === beforeMicros &&
            entry.entry_id < beforeId),
      )
      .sort(
        (a, b) =>
          b.visible_at_micros - a.visible_at_micros ||
          b.entry_id.localeCompare(a.entry_id),
      )
      .slice(0, limit);
    largestResponse = Math.max(largestResponse, sorted.length);
    const oldest = sorted.at(-1);
    return {
      entries: sorted.reverse(),
      next_before:
        sorted.length === limit && oldest
          ? {
              visible_at_micros: oldest.visible_at_micros,
              entry_id: oldest.entry_id,
            }
          : null,
    };
  };
  return {
    bridge,
    metrics: () => ({ fetches, largestResponse }),
  };
}

test("持久进度恢复真实分支身份，公共契约不剥掉threadId且未知旧记录不猜归属", async () => {
  const store = new WorkspaceStore(":memory:");
  const stamp = "2026-10-09T00:00:00.000Z";
  let hasThreadIdentity = true;
  const { bridge } = timelineBridge(store, (value, sessionId) => {
    const entries = timelinePair(
      value,
      sessionId,
      0,
      stamp,
      stamp,
      stamp,
      "原始进度",
    );
    const progress = entries[1]!;
    progress.entry_id = "TEST-original-progress";
    progress.attempt_id = null;
    progress.display_kind = "progress";
    progress.event.topic = "chat/progress";
    if (hasThreadIdentity)
      progress.event.payload.thread_id = "TEST-original-thread";
    return entries;
  });
  try {
    const history = await bridge.platformConversationHistory(
      { projectId: "project", conversationId: "conversation" },
      localAccess,
    );
    const runtime = conversationRuntimeSchema.parse(history.runtime);
    assert.equal(runtime.messages[0]!.threadId, "TEST-original-thread");
    assert.equal(runtime.messages[0]!.kind, "progress");
    assert.equal(runtime.messages[0]!.text, "原始进度");
    assert.equal(runtime.messages[0]!.rootId, "root-0");
    const { threadId: _threadId, ...legacy } = runtime.messages[0]!;
    assert.equal(
      conversationRuntimeSchema.parse({ ...runtime, messages: [legacy] })
        .messages[0]!.threadId,
      undefined,
    );
    hasThreadIdentity = false;
    const oldHistory = await bridge.platformConversationHistory(
      { projectId: "project", conversationId: "conversation" },
      localAccess,
    );
    assert.equal(oldHistory.runtime.messages[0]!.threadId, undefined);
    assert.equal(oldHistory.runtime.messages[0]!.text, "原始进度");
  } finally {
    store.close();
  }
});

test("历史分页读取 Runtime 索引，不写 Host 本机消息副本", async (t) => {
  const store = new WorkspaceStore(":memory:");
  const count = 200;
  const start = Date.parse("2026-09-28T00:00:00.000Z");
  const { bridge, metrics } = timelineBridge(store, (value, sessionId) =>
    Array.from({ length: count }, (_, index) => {
      const at = new Date(start + index * 1000).toISOString();
      return timelinePair(
        value,
        sessionId,
        index,
        at,
        new Date(start + index * 1000 + 200).toISOString(),
        new Date(start + index * 1000 + 300).toISOString(),
        "回复 " + index,
      );
    }).flat(),
  );
  const save = t.mock.method(store, "saveRuntimeState");
  try {
    const scope = { projectId: "project", conversationId: "conversation" };
    const first = await bridge.platformConversationHistory(scope, localAccess);
    assert.equal(first.inputs.length + first.runtime.messages.length, 100);
    assert.ok(first.nextCursor);
    const second = await bridge.platformConversationHistory(
      scope,
      localAccess,
      {
        before: first.nextCursor!,
      },
    );
    assert.equal(second.inputs.length + second.runtime.messages.length, 100);
    assert.equal(
      new Set(
        [...first.inputs, ...second.inputs]
          .map((item) => item.id)
          .concat(
            [...first.runtime.messages, ...second.runtime.messages].map(
              (item) => item.id,
            ),
          ),
      ).size,
      200,
    );
    assert.equal(save.mock.callCount(), 0);
    assert.equal(metrics().largestResponse, 100);
    assert.deepEqual(
      (await bridge.platformConversationHistory(scope, localAccess)).runtime
        .messages,
      first.runtime.messages,
    );
    assert.equal(save.mock.callCount(), 0);
  } finally {
    store.close();
  }
});

test("大量不可见 Runtime 消息不会使一次历史翻页无界扫描", async () => {
  const store = new WorkspaceStore(":memory:");
  const start = Date.parse("2026-09-28T00:00:00.000Z");
  const { bridge, metrics } = timelineBridge(store, (value, sessionId) => [
    ...timelinePair(
      value,
      sessionId,
      0,
      new Date(start).toISOString(),
      new Date(start + 200).toISOString(),
      new Date(start + 300).toISOString(),
      "可见回复",
    ),
    ...Array.from({ length: 450 }, (_, index) => {
      const at = start + (index + 1) * 1000;
      return timelinePair(
        value,
        sessionId,
        index + 1,
        new Date(at).toISOString(),
        new Date(at + 200).toISOString(),
        new Date(at + 300).toISOString(),
        "已撤权项目回复",
        "revoked-project",
      );
    }).flat(),
  ]);
  try {
    const scope = { projectId: "project", conversationId: "conversation" };
    const sessionId = (
      bridge as unknown as {
        objectSessionId: (
          projectId: string,
          conversationId: string,
          sharedDefault: boolean,
        ) => string;
      }
    ).objectSessionId(scope.projectId, scope.conversationId, false);
    (
      bridge as unknown as {
        state: { deliveries: unknown[] };
      }
    ).state.deliveries.push({
      inputId: "pending-old",
      sessionId,
      rootId: null,
      state: "queued",
      error: null,
      cancelRequested: false,
      request: {},
      platformSource: {
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        targetActantId: "morphz-agent",
        author: localAccess,
        createdAt: new Date(start + 500).toISOString(),
        body: "待投递输入",
        sharedDefault: false,
      },
    });
    const first = await bridge.platformConversationHistory(scope, localAccess, {
      limit: 2,
    });
    assert.equal(first.inputs.length + first.runtime.messages.length, 0);
    assert.ok(first.nextCursor, "未扫描的旧记录必须有可继续使用的游标");
    assert.ok(metrics().fetches <= 8, "单次请求最多读取八个 Runtime 页");

    const second = await bridge.platformConversationHistory(
      scope,
      localAccess,
      { before: first.nextCursor!, limit: 2 },
    );
    assert.deepEqual(
      second.inputs.map((input) => input.id),
      ["pending-old"],
    );
    assert.deepEqual(
      second.runtime.messages.map((message) => message.text),
      ["可见回复"],
    );
    assert.ok(second.nextCursor);
    const third = await bridge.platformConversationHistory(scope, localAccess, {
      before: second.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(
      third.inputs.map((input) => input.id),
      ["input-0"],
    );
    assert.equal(third.nextCursor, null);
  } finally {
    store.close();
  }
});

test("有界历史按首次显示时间分页，迟到回复不插回旧输入", async () => {
  const store = new WorkspaceStore(":memory:");
  const start = Date.parse("2026-09-28T00:00:00.000Z");
  const { bridge } = timelineBridge(store, (value, sessionId) => [
    ...timelinePair(
      value,
      sessionId,
      0,
      new Date(start + 1000).toISOString(),
      new Date(start + 3000).toISOString(),
      new Date(start + 4000).toISOString(),
      "迟到的回复",
    ),
    ...timelinePair(
      value,
      sessionId,
      1,
      new Date(start + 2000).toISOString(),
      new Date(start + 2500).toISOString(),
      new Date(start + 2600).toISOString(),
      "较新的回复",
    ).slice(0, 1),
  ]);
  try {
    const scope = { projectId: "project", conversationId: "conversation" };
    const latest = await bridge.platformConversationHistory(
      scope,
      localAccess,
      {
        limit: 2,
      },
    );
    assert.deepEqual(
      latest.runtime.messages.map((message) => message.text),
      ["迟到的回复"],
    );
    assert.deepEqual(
      latest.inputs.map((input) => input.id),
      ["input-1"],
    );
    assert.ok(latest.nextCursor);
    const earlier = await bridge.platformConversationHistory(
      scope,
      localAccess,
      {
        before: latest.nextCursor!,
        limit: 2,
      },
    );
    assert.deepEqual(
      earlier.inputs.map((input) => input.id),
      ["input-0"],
    );
    assert.deepEqual(earlier.runtime.messages, []);
    assert.equal(earlier.nextCursor, null);
  } finally {
    store.close();
  }
});

test("历史游标保留微秒精度，同一毫秒内不漏消息", async () => {
  const store = new WorkspaceStore(":memory:");
  const epoch = Date.parse("2026-09-28T00:00:00Z") * 1000;
  const { bridge } = timelineBridge(store, (value, sessionId) => {
    const pair = timelinePair(
      value,
      sessionId,
      0,
      "2026-09-28T00:00:00.123456Z",
      "2026-09-28T00:00:00.123789Z",
      "2026-09-28T00:00:00.124000Z",
      "同一毫秒内的回复",
    );
    pair[0]!.visible_at_micros = epoch + 123456;
    pair[1]!.visible_at_micros = epoch + 123789;
    return pair;
  });
  try {
    const scope = { projectId: "project", conversationId: "conversation" };
    const latest = await bridge.platformConversationHistory(
      scope,
      localAccess,
      {
        limit: 1,
      },
    );
    assert.equal(latest.runtime.messages[0]?.text, "同一毫秒内的回复");
    assert.ok(latest.nextCursor);
    const earlier = await bridge.platformConversationHistory(
      scope,
      localAccess,
      {
        before: latest.nextCursor!,
        limit: 1,
      },
    );
    assert.deepEqual(
      earlier.inputs.map((item) => item.id),
      ["input-0"],
    );
    assert.equal(earlier.nextCursor, null);
  } finally {
    store.close();
  }
});

test("长历史分页有界，流式首次显示时间与最终正文共用一个发布 ID", async () => {
  const store = new WorkspaceStore(":memory:");
  const count = 130;
  const start = Date.parse("2026-09-28T00:00:00.000Z");
  const { bridge, metrics } = timelineBridge(store, (value, sessionId) =>
    Array.from({ length: count }, (_, index) => {
      const at = start + index * 1000;
      return timelinePair(
        value,
        sessionId,
        index,
        new Date(at).toISOString(),
        new Date(at + 200).toISOString(),
        new Date(at + 300).toISOString(),
        "回复 " + index + " 阶段 1",
      );
    }).flat(),
  );
  try {
    const seen: Array<{ id: string; createdAt: string }> = [];
    let before: { createdAt: string; id: string } | undefined;
    for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
      const page = await bridge.platformConversationHistory(
        { projectId: "project", conversationId: "conversation" },
        localAccess,
        { limit: 37, ...(before ? { before } : {}) },
      );
      assert.ok(page.inputs.length + page.runtime.messages.length <= 37);
      for (const message of page.runtime.messages)
        assert.match(message.text, /阶段 1$/);
      seen.push(
        ...page.inputs.map(({ id, createdAt }) => ({ id, createdAt })),
        ...page.runtime.messages.map(({ id, createdAt }) => ({
          id,
          createdAt,
        })),
      );
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    assert.equal(seen.length, count * 2);
    assert.equal(new Set(seen.map(({ id }) => id)).size, count * 2);
    for (let index = 0; index < count; index++) {
      assert.ok(seen.some(({ id }) => id === "input-" + index));
      assert.ok(
        seen.some(
          ({ id, createdAt }) =>
            id === "publication:attempt-" + index &&
            createdAt === new Date(start + index * 1000 + 200).toISOString(),
        ),
      );
    }
    assert.equal(metrics().largestResponse, 100);
  } finally {
    store.close();
  }
});
