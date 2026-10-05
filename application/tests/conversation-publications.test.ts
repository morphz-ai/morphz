import test from "node:test";
import assert from "node:assert/strict";
import { conversationMessages } from "../apps/web/src/conversation-read.js";
import {
  mergePlatformHistories,
  readHistoryHead,
} from "../apps/web/src/data/conversation-history.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { initialWorkspace } from "../packages/core/src/model.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";

const scope = { projectId: "first-project", conversationId: "first-project" };
const inputId = "TEST-ping-input",
  rootId = "TEST-ping-root",
  attempt = "TEST-ping-attempt";
const visibleAt = "2026-10-05T03:38:56.380581Z";
const base = {
  ...scope,
  id: "",
  inputId,
  rootId,
  artifactId: null,
  publicationKey: attempt,
  kind: "reply" as const,
  text: "pong，我在。",
  createdAt: visibleAt,
} satisfies LiveMessage;
// The accepted Runtime timeline exposes the saved public prefix under stream:
// without a streaming flag, then replaces it with a canonical publication row.
const partial = {
  ...base,
  id: `stream:${attempt}`,
  sequence: 6888,
  incomplete: false,
  truncated: false,
};
const final = { ...base, id: `publication:${attempt}`, sequence: 6892 };
const state = initialWorkspace("2026-10-05T03:38:42.184955Z");
const input: PlatformHistory["inputs"][number] = {
  ...scope,
  id: inputId,
  body: "ping",
  createdAt: "2026-10-05T03:38:42.184955Z",
  author: { principalId: "human", actantId: "human" },
  targetActantId: "morphz-agent",
};
function page(
  messages: PlatformHistory["runtime"]["messages"],
): PlatformHistory {
  return {
    inputs: [input],
    scriptOutputs: [],
    nextCursor: null,
    runtime: { ...disconnectedRuntime, messages },
  };
}
function renderMessages(history: PlatformHistory, live: LiveMessage[] = []) {
  return conversationMessages(
    state,
    scope.conversationId,
    history.runtime,
    live,
    false,
  );
}

test("formal publication replaces the cached public-output row instead of rendering two pongs", () => {
  const merged = mergePlatformHistories(page([final]), page([partial]));
  assert.deepEqual(merged.runtime.messages, [final]);
  assert.deepEqual(renderMessages(merged, [final]), [final]);
  assert.equal(merged.runtime.messages[0]?.createdAt, visibleAt);
  assert.equal(merged.runtime.messages[0]?.id, `publication:${attempt}`);
});

test("actual changed-history-head reuse replaces saved prefixes while retaining loaded older rows and cursor", async () => {
  const older = {
    ...base,
    id: "older-independent",
    publicationKey: undefined,
    inputId: "older-input",
    rootId: "older-root",
    text: "原来加载的历史",
    createdAt: "2026-10-04T00:00:00Z",
  };
  const cached = {
    ...page([older, partial]),
    nextCursor: { id: "older-cursor", createdAt: "2026-10-03T00:00:00Z" },
  };
  const head = readHistoryHead(async () => page([final]), scope, "v2", {
    scope,
    version: "v1",
    value: cached,
  });
  assert.equal(head.kind, "read");
  const merged = await head.pending;
  assert.deepEqual(merged.runtime.messages, [older, final]);
  assert.deepEqual(merged.nextCursor, cached.nextCursor);
  assert.equal(
    renderMessages(merged, [final]).filter(
      (message) => message.text === base.text,
    ).length,
    1,
  );
  // Explicit older-page pagination keeps its original cursor, independently of
  // the current head's cursor, while using the same publication reconciliation.
  const paged = mergePlatformHistories(page([final]), cached);
  assert.deepEqual(paged.nextCursor, cached.nextCursor);
  assert.deepEqual(paged.runtime.messages, [older, final]);
});

test("main exchange reconciles cached, live and disconnected prefixes in either replay order", () => {
  for (const prefix of [
    partial,
    { ...partial, streaming: true },
    { ...partial, streaming: false },
  ])
    for (const live of [[prefix, final], [final, prefix], [prefix], []]) {
      assert.deepEqual(renderMessages(page([final]), live), [final]);
      assert.deepEqual(renderMessages(page([partial, final]), live), [final]);
    }
});

test("same publication's formal error replaces its public prefix without hiding a real independent reply", () => {
  const error = { ...final, kind: "error" as const, text: "真实最终错误" };
  const another = {
    ...final,
    id: "publication:another-attempt",
    publicationKey: "another-attempt",
  };
  const merged = mergePlatformHistories(
    page([error, another]),
    page([partial]),
  );
  assert.deepEqual(merged.runtime.messages, [another, error]);
  assert.deepEqual(renderMessages(merged, [{ ...partial, streaming: false }]), [
    another,
    error,
  ]);
});

test("same prose from independent attempts and scopes remains distinct; missing source never guessed", () => {
  const variants: Array<LiveMessage & { kind: "reply" }> = [
    { ...partial, publicationKey: "other-attempt", id: "stream:other-attempt" },
    { ...partial, inputId: "other-input" },
    { ...partial, rootId: "other-root" },
    { ...partial, inputId: null },
    { ...partial, rootId: null },
    { ...partial, publicationKey: undefined },
  ];
  for (const prefix of variants) {
    assert.deepEqual(renderMessages(page([final]), [prefix]), [final, prefix]);
    assert.equal(
      mergePlatformHistories(page([final]), page([prefix])).runtime.messages
        .length,
      2,
    );
  }
  // Scope protection is also exercised before a reader filters other projects.
  for (const prefix of [
    { ...partial, projectId: "other-project" },
    { ...partial, conversationId: "other-conversation" },
    { ...partial, conversationId: undefined },
  ])
    assert.equal(
      mergePlatformHistories(page([final]), page([prefix])).runtime.messages
        .length,
      2,
    );
  const branchFinal = { ...final, threadId: "final-thread" };
  const otherBranch = {
    ...partial,
    threadId: "other-thread",
    streaming: false,
  };
  assert.deepEqual(renderMessages(page([]), [branchFinal, otherBranch]), [
    branchFinal,
    otherBranch,
  ]);
});

test("a public prefix survives without a canonical terminal row; tools and actual progress are not removed", () => {
  assert.deepEqual(renderMessages(page([partial])), [partial]);
  const rawReply = { ...final, id: "un-normalized-event" };
  assert.deepEqual(renderMessages(page([rawReply]), [partial]), [
    rawReply,
    partial,
  ]);
  const progress = {
    ...final,
    kind: "progress" as const,
    id: "progress-event",
    text: "仍在进行的独立行动",
  };
  const tool = {
    ...base,
    kind: "tool" as const,
    id: "tool:call-one",
    text: "",
    tool: { name: "真实工具", arguments: "{}", status: "success" },
  };
  assert.deepEqual(renderMessages(page([final, progress]), [tool]), [
    final,
    progress,
    tool,
  ]);
});
