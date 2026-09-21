import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { ConversationFeed } from "../packages/application/src/conversation-feed.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import type { ConversationStream } from "../packages/core/src/live-conversation.js";

test("一批实时回复只读取一次工作空间，下一批仍重新校验权限", (t) => {
  type Options = ConstructorParameters<typeof ConversationFeed>[0];
  let feedOptions!: Options;
  t.mock.method(
    ConversationFeed.prototype,
    "sync",
    async function (this: ConversationFeed) {
      feedOptions = (this as unknown as { options: Options }).options;
    },
  );
  const store = new WorkspaceStore(":memory:");
  const inputId = store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: "first-project",
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST 实时批次",
        targetActantId: "morphz-agent",
      },
    },
    localAccess,
  ).entityId;
  const config = {
    url: "http://127.0.0.1:1",
    namespace: "perf-test",
    token: "test",
  };
  new RuntimeBridge(store, config);
  const saved = store.runtimeState() as any;
  saved.sessions.session = {
    id: "session",
    projectId: "first-project",
    conversationId: "first-project",
    artifactId: null,
    cursor: 0,
    events: [],
  };
  saved.deliveries = Array.from({ length: 100 }, (_, i) => ({
    inputId,
    sessionId: "session",
    rootId: `root-${i}`,
    state: "completed",
    error: null,
    request: {},
  }));
  store.saveRuntimeState(saved);
  const bridge = new RuntimeBridge(store, config);
  let workspace = store.snapshot();
  const snapshot = t.mock.method(store, "snapshot", () =>
    structuredClone(workspace),
  );
  let received: ConversationStream = { connected: false, messages: [] };
  const close = bridge.observeConversation(
    { projectId: "first-project", conversationId: "first-project" },
    localAccess,
    (value) => {
      received = value;
    },
    () => {},
  );
  try {
    const messages: ConversationStream["messages"] = Array.from(
      { length: 100 },
      (_, i) => ({
        id: `reply-${i}`,
        rootId: `root-${i}`,
        inputId: null,
        projectId: "first-project",
        conversationId: "first-project",
        artifactId: null,
        kind: "reply",
        text: `TEST 回复 ${i}`,
        createdAt: "2026-09-21T00:00:00Z",
      }),
    );
    snapshot.mock.resetCalls();
    const start = performance.now();
    feedOptions.changed({ connected: true, messages });
    const reads = snapshot.mock.callCount();
    console.log(
      "MESSAGE_HOST_PERFORMANCE",
      JSON.stringify({
        messages: messages.length,
        snapshotReads: reads,
        elapsedMs: performance.now() - start,
      }),
    );
    assert.equal(received.messages.length, 100);
    assert.ok(received.messages.every((m) => m.inputId === inputId));
    assert.equal(
      reads,
      1,
      "a publication batch must not parse the entire workspace per message",
    );
    snapshot.mock.resetCalls();
    assert.deepEqual(feedOptions.sessions(), ["session"]);
    assert.equal(snapshot.mock.callCount(), 1);
    workspace = structuredClone(workspace);
    workspace.projects.find((p) => p.id === "first-project")!.members = [];
    assert.throws(() => feedOptions.authorize());
    feedOptions.changed({ connected: true, messages });
    assert.equal(
      received.messages.length,
      0,
      "fresh batch cannot expose revoked content",
    );
    assert.deepEqual(feedOptions.sessions(), []);
  } finally {
    close();
    store.close();
  }
});
