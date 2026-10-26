import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionControls } from "../packages/application/src/execution.js";

const scope = {
  projectId: "control-project",
  conversationId: "control-conversation",
  artifactId: null,
  inputId: "control-input",
  threadId: "selected-thread",
};
const binding = {
  sessionId: "original-session",
  contextId: "original-context",
  rootId: "original-root",
  threadId: scope.threadId,
};
const statePath =
  "/api/sessions/original-session/execution-records?limit=100&thread_id=selected-thread&metadata_only=true";
function records(thread: Record<string, unknown>) {
  return {
    session_id: binding.sessionId,
    context_id: binding.contextId,
    selected_thread_id: scope.threadId,
    source_root_id: binding.rootId,
    limit: 100,
    has_more_jobs: false,
    threads_truncated: false,
    jobs: [],
    threads: [
      {
        parent_thread_id: null,
        intent: null,
        phase: "waiting",
        created_at: "2026-10-26T00:00:00Z",
        updated_at: "2026-10-26T00:00:00Z",
        ...thread,
      },
    ],
  };
}

function peer(overrides: Record<string, unknown> = {}) {
  let thread = {
    id: scope.threadId,
    session_id: binding.sessionId,
    context_id: binding.contextId,
    root_turn_id: binding.rootId,
    lifecycle: "open",
    control_state: "active",
    revision: 7,
    generation: 3,
    ...overrides,
  };
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const controls = new ExecutionControls(
    async (path, method = "GET", body) => {
      calls.push({ path, method, ...(body === undefined ? {} : { body }) });
      if (method === "GET") {
        assert.equal(path, statePath);
        return records(thread);
      }
      const command = body as Record<string, unknown>;
      assert.equal(command.expected_revision, thread.revision);
      thread = {
        ...thread,
        revision: thread.revision + 1,
        control_state: command.action === "pause" ? "paused" : "active",
        ...(path.endsWith("/supersede")
          ? { generation: thread.generation + 1, intent: command.intent }
          : {}),
      };
      // The real ThreadMutation receipt has generation/revision and immutable
      // identity, but does not echo the corrected intent from the mailbox.
      const { intent: _intent, ...nativeThread } = thread as typeof thread & {
        intent?: unknown;
      };
      return { updated: true, thread: nativeThread };
    },
    () => binding,
  );
  return { controls, calls };
}

test("pause and resume preserve the exact original Thread and use its displayed revision", async () => {
  const { controls, calls } = peer();
  const paused = await controls.control({
    scope,
    action: { type: "pause-thread", threadId: scope.threadId, revision: 7 },
  });
  assert.deepEqual(paused, { accepted: true, status: "paused" });
  const resumed = await controls.control({
    scope,
    action: { type: "resume-thread", threadId: scope.threadId, revision: 8 },
  });
  assert.deepEqual(resumed, { accepted: true, status: "active" });
  assert.deepEqual(
    calls.map(({ path, method }) => ({ path, method })),
    [
      {
        path: statePath,
        method: "GET",
      },
      {
        path: "/api/contexts/original-context/threads/selected-thread",
        method: "POST",
      },
      {
        path: statePath,
        method: "GET",
      },
      {
        path: "/api/contexts/original-context/threads/selected-thread",
        method: "POST",
      },
    ],
  );
  assert.deepEqual(
    calls
      .filter((c) => c.method === "POST")
      .map((c) => {
        const body = c.body as Record<string, unknown>;
        return { action: body.action, revision: body.expected_revision };
      }),
    [
      { action: "pause", revision: 7 },
      { action: "resume", revision: 8 },
    ],
  );
});

test("new Thread controls reject sibling, stale revision and foreign source before mutation", async () => {
  const actions = ["pause-thread", "resume-thread", "supersede-thread"];
  for (const type of actions) {
    for (const change of [
      { action: { threadId: "sibling-thread" } },
      { action: { revision: 6 } },
      { thread: { session_id: "another-session" } },
      { thread: { root_turn_id: "another-input-root" } },
    ]) {
      const { controls, calls } = peer(change.thread);
      await assert.rejects(
        controls.control({
          scope,
          action: {
            type,
            threadId: scope.threadId,
            revision: 7,
            ...(type === "supersede-thread"
              ? { intent: "Correct this one branch" }
              : {}),
            ...change.action,
          },
        }),
      );
      assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    }
  }
});

test("supersede submits explicit revised intent and requires a new generation of the same Thread", async () => {
  const { controls, calls } = peer();
  const value = await controls.control({
    scope,
    action: {
      type: "supersede-thread",
      threadId: scope.threadId,
      revision: 7,
      intent: "  Only revise this branch; retain completed effects.  ",
    },
  });
  assert.deepEqual(value, { accepted: true, status: "active" });
  const write = calls.find((c) => c.method === "POST")!;
  assert.equal(
    write.path,
    "/api/contexts/original-context/threads/selected-thread/supersede",
  );
  assert.equal((write.body as Record<string, unknown>).expected_revision, 7);
  assert.equal(
    (write.body as Record<string, unknown>).intent,
    "Only revise this branch; retain completed effects.",
  );
  assert.equal(calls.length, 2);
});

test("a successful-looking response cannot report pause or supersede without their actual state transition", async () => {
  for (const type of ["pause-thread", "supersede-thread"] as const) {
    let writes = 0;
    const thread = {
      id: scope.threadId,
      session_id: binding.sessionId,
      context_id: binding.contextId,
      root_turn_id: binding.rootId,
      revision: 7,
      generation: 3,
      lifecycle: "open",
      control_state: "active",
    };
    const controls = new ExecutionControls(
      async (_path, method = "GET") => {
        if (method === "GET") return records(thread);
        writes++;
        return { updated: true, thread };
      },
      () => binding,
    );
    await assert.rejects(
      controls.control({
        scope,
        action: {
          type,
          threadId: scope.threadId,
          revision: 7,
          ...(type === "supersede-thread" ? { intent: "Revised work" } : {}),
        },
      }),
    );
    assert.equal(writes, 1);
  }
});
