import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { executionThreadsWithWait } from "../packages/application/src/execution-wait-projection.js";
import { runtimeExecutionRecordsSchema } from "../packages/application/src/execution-thread-tree.js";
import { executionSnapshotSchema } from "../packages/core/src/execution.js";
import { localAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
const stamp = "2026-10-24T01:00:00Z";
function fixture() {
  const thread = (id: string, parent: string | null) => ({
    id,
    session_id: "TEST-session",
    context_id: "TEST-context",
    root_turn_id: `root-${id}`,
    parent_thread_id: parent,
    generation: 3,
    revision: 7,
    lifecycle: "open",
    control_state: "active",
    phase: "waiting",
    created_at: stamp,
    updated_at: stamp,
    intent: `TEST ${id}`,
    wait_head: {
      thread_id: id,
      generation: 3,
      revision: 7,
      kinds: id === "primary" ? ["thread_group"] : [],
      resources: [] as string[],
      resources_truncated: false,
      until: null as string | null,
    },
  });
  return {
    session_id: "TEST-session",
    context_id: "TEST-context",
    selected_thread_id: "primary",
    source_root_id: "TEST-input",
    limit: 100,
    has_more_jobs: false,
    threads_truncated: false,
    jobs: [],
    threads: [thread("primary", null), thread("child", "primary")],
  };
}
const forbidden = async () => {
  throw Error(
    "No Context directory, history or per-Thread fallback read is authorized",
  );
};
test("an exact native execution page carries primary and child waits with zero enrichment reads", async () => {
  const raw = fixture(),
    records = runtimeExecutionRecordsSchema.parse(raw);
  const view = await executionThreadsWithWait(forbidden, records);
  assert.deepEqual(view[0]!.waitKinds, ["thread_group"]);
  assert.deepEqual(view[1]!.waitKinds, []);
  assert.equal(view[0]!.title, "TEST primary");
});
test("native resource/timer/approval summaries preserve explicit identities and truncation without rebuilding dependency history", async () => {
  const raw = fixture();
  raw.threads[0]!.wait_head = {
    ...raw.threads[0]!.wait_head,
    kinds: ["permission", "resource", "timer"],
    resources: ["model_provider:test:capacity"],
    resources_truncated: true,
    until: stamp,
  };
  const [parent] = await executionThreadsWithWait(
    forbidden,
    runtimeExecutionRecordsSchema.parse(raw),
  );
  assert.deepEqual(parent!.waitKinds, ["permission", "resource", "timer"]);
  assert.deepEqual(parent!.waitResources, ["model_provider:test:capacity"]);
  assert.equal(parent!.waitUntil, stamp);
});
test("foreign or stale native wait coordinates remain unknown instead of borrowing another execution's reason", async () => {
  for (const patch of [
    { thread_id: "foreign" },
    { generation: 2 },
    { revision: 6 },
  ]) {
    const raw = fixture();
    Object.assign(raw.threads[0]!.wait_head, patch);
    const [parent] = await executionThreadsWithWait(
      forbidden,
      runtimeExecutionRecordsSchema.parse(raw),
    );
    assert.equal(parent!.waitKinds, undefined);
  }
  const raw = fixture();
  delete (raw.threads[0] as any).wait_head;
  assert.equal(
    (
      await executionThreadsWithWait(
        forbidden,
        runtimeExecutionRecordsSchema.parse(raw),
      )
    )[0]!.waitKinds,
    undefined,
  );
});
test("running, runnable, paused and terminal facts are never rewritten by a wait summary", async () => {
  for (const patch of [
    { phase: "running" },
    { phase: "runnable" },
    { control_state: "paused" },
    { lifecycle: "completed" },
  ]) {
    const raw = fixture();
    Object.assign(raw.threads[0]!, patch);
    const [parent] = await executionThreadsWithWait(
      forbidden,
      runtimeExecutionRecordsSchema.parse(raw),
    );
    assert.equal(parent!.waitKinds, undefined);
  }
});
test("wait headers have an independent row and byte bound", () => {
  const raw = fixture();
  raw.threads[0]!.wait_head.resources = Array.from(
    { length: 33 },
    (_, i) => `resource-${i}`,
  );
  assert.equal(runtimeExecutionRecordsSchema.safeParse(raw).success, false);
  raw.threads[0]!.wait_head.resources = ["x".repeat(513)];
  assert.equal(runtimeExecutionRecordsSchema.safeParse(raw).success, false);
});
test("real Host selected and read-only inspectors use native wait metadata and recheck a grant revoked during that read", async () => {
  const host = await platformRuntimeHostFixture();
  try {
    const { dialogueId } = await host.session().ensurePlatformSpaces();
    await host.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: host.projectId,
        conversationId: dialogueId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST bounded wait metadata",
        targetActantId: "morphz-agent",
      },
    });
    const internal = host.runtime as any;
    internal.state.connected = true;
    internal.refreshActivity = async () => {
      throw Error("No overview read");
    };
    const delivery = internal.state.deliveries[0];
    delivery.rootId = "TEST-input";
    const sessionId = delivery.sessionId,
      contextId = internal.contextId(host.projectId);
    const raw = fixture();
    const records = {
      ...raw,
      session_id: sessionId,
      context_id: contextId,
      threads: raw.threads.map((t) => ({
        ...t,
        session_id: sessionId,
        context_id: contextId,
        initiating_principal_id: localAccess.principalId,
      })),
    };
    for (const t of records.threads)
      internal.state.threadBindings[t.id] = {
        id: t.id,
        projectId: delivery.platformSource.projectId,
        conversationId: delivery.platformSource.conversationId,
        inputId: delivery.inputId,
        sessionId,
        rootId: t.root_turn_id,
        title: t.intent,
        phase: t.phase,
        lifecycle: t.lifecycle,
        revision: t.revision,
        updatedAt: stamp,
      };
    const authorize = internal.authorizePlatformRead.bind(host.runtime);
    let revoked = false,
      revokeDuringRead = false;
    const calls: string[] = [];
    host.runtime.bindPlatformReadAuthority(async (...args: any[]) => {
      assert.equal(revoked, false, "TEST grant revoked during native read");
      return authorize(...args);
    });
    internal.request = async (path: string, method?: string) => {
      assert.ok(!method || method === "GET");
      calls.push(path);
      if (path.split("?")[0] === "/api/approvals") return { approvals: [] };
      assert.ok(path.includes("/execution-records?"), path);
      const query = new URL(path, "http://test.invalid").searchParams;
      const selected = query.get("thread_id");
      const ids = query.has("thread_ids")
        ? JSON.parse(query.get("thread_ids")!)
        : null;
      const threads = selected
        ? query.has("include_descendants")
          ? records.threads
          : records.threads.slice(0, 1)
        : ids
          ? records.threads.filter((t) => ids.includes(t.id))
          : records.threads;
      if (revokeDuringRead) revoked = true;
      return {
        ...records,
        selected_thread_id: selected,
        source_root_id: selected ? records.source_root_id : null,
        threads,
      };
    };
    const reference = {
      runtime: { sessionId, contextId },
      threadId: "primary",
      artifactId: null,
    } as const;
    const viewer = await host.runtime.platformExecutionRead(
      reference,
      localAccess,
      () => {},
    );
    const direct = executionSnapshotSchema.parse(await viewer.snapshot());
    assert.deepEqual(direct.threads![0]!.waitKinds, ["thread_group"]);
    const selected = await host.session().executionSnapshot({
      projectId: host.projectId,
      conversationId: dialogueId,
      artifactId: null,
      inputId: delivery.inputId,
      threadId: "primary",
    });
    assert.deepEqual(selected.threads![0]!.waitKinds, ["thread_group"]);
    assert.equal(
      calls.filter((path) => path.includes("/scheduler")).length,
      0,
      "opening one Thread must not read 200 siblings",
    );
    revokeDuringRead = true;
    await assert.rejects(
      host.session().executionSnapshot({
        projectId: host.projectId,
        conversationId: dialogueId,
        artifactId: null,
        inputId: delivery.inputId,
        threadId: "primary",
      }),
      /grant revoked/,
    );
  } finally {
    await host.close();
  }
});
