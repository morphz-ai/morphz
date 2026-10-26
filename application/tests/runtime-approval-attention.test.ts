import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import { approvalFingerprint } from "../packages/application/src/execution.js";

async function fixture() {
  const f = await platformRuntimeHostFixture();
  const { dialogueId } = await f.session().ensurePlatformSpaces();
  await f.session().platformMessage({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: f.projectId,
      conversationId: dialogueId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST original input outside the latest history page",
      targetActantId: "morphz-agent",
    },
  });
  const bridge = f.runtime as any;
  const delivery = bridge.state.deliveries[0];
  delivery.rootId = "original-root";
  const context = `mw-context-${bridge.config.namespace}`;
  bridge.state.connected = true;
  const binding = {
    id: "child",
    sessionId: delivery.sessionId,
    contextId: context,
    rootId: "scheduled-root",
    projectId: delivery.platformSource.projectId,
    conversationId: delivery.platformSource.conversationId,
    inputId: delivery.inputId,
    title: "TEST scheduled child",
    lifecycle: "open",
    phase: "runnable",
    revision: 1,
    updatedAt: "2026-10-25T06:04:21Z",
  };
  const approval = {
    requested_at: "2026-10-25T06:04:21Z",
    request: {
      approval_id: "pending-approval",
      session_id: delivery.sessionId,
      context_id: context,
      root_turn_id: binding.rootId,
      thread_id: binding.id,
      justification: "TEST bounded directory approval",
      action: { command: "TEST only" },
      requested: { filesystem_write: ["/TEST"] },
    },
  };
  const reads: string[] = [];
  bridge.request = async (path: string, method = "GET") => {
    assert.equal(method, "GET", "attention discovery must never mutate work");
    reads.push(path);
    if (path === "/api/approvals") return { approvals: [approval] };
    if (path.includes("/execution-records?")) {
      const query = new URL(path, "http://test").searchParams;
      assert.equal(query.get("thread_id"), binding.id);
      assert.equal(query.get("limit"), "100");
      if (query.has("include_descendants")) {
        assert.equal(query.get("include_descendants"), "true");
        assert.deepEqual(JSON.parse(query.get("root_turn_ids")!), [
          delivery.rootId,
        ]);
      } else assert.equal(query.get("metadata_only"), "true");
      return {
        session_id: delivery.sessionId,
        context_id: context,
        selected_thread_id: binding.id,
        source_root_id: delivery.rootId,
        limit: 100,
        has_more_jobs: false,
        threads_truncated: false,
        jobs: [],
        threads: [
          {
            id: binding.id,
            session_id: delivery.sessionId,
            context_id: context,
            root_turn_id: binding.rootId,
            parent_thread_id: "parent",
            generation: 1,
            revision: 1,
            lifecycle: binding.lifecycle,
            control_state: "active",
            phase: binding.phase,
            created_at: binding.updatedAt,
            updated_at: binding.updatedAt,
            intent: binding.title,
          },
        ],
      };
    }
    if (path.includes("/timeline?"))
      return { entries: [], has_more: false, next_before: null };
    throw new Error(`Unexpected non-bounded read: ${path}`);
  };
  return { f, bridge, delivery, binding, approval, reads, dialogueId };
}

test("scheduled child approval is visible in navigation even when its original input is not on screen", async () => {
  const x = await fixture();
  try {
    x.bridge.state.threadBindings[x.binding.id] = x.binding;
    await x.bridge.refreshAttention();
    const attention = x.f.runtime.platformNavigationSnapshot(localAccess, [
      x.f.projectId,
    ]).runtime.attention!;
    assert.equal(attention.available, true);
    assert.equal(attention.approvals.length, 1);
    assert.deepEqual(attention.approvals[0]!.scope, {
      projectId: x.f.projectId,
      conversationId: x.dialogueId,
      artifactId: null,
      inputId: x.delivery.inputId,
      threadId: "child",
    });
    assert.equal(
      attention.approvals[0]!.approval.fingerprint,
      approvalFingerprint(x.approval),
    );
    assert.deepEqual(x.reads, ["/api/approvals"]);
    assert.equal(
      x.f.runtime.platformNavigationSnapshot(localAccess, ["unrelated"]).runtime
        .attention!.approvals.length,
      0,
    );
    assert.equal(
      x.f.runtime.platformNavigationSnapshot(
        { principalId: "other-human", actantId: "other-actant" },
        [x.f.projectId],
      ).runtime.attention!.approvals.length,
      0,
    );
  } finally {
    await x.f.close();
  }
});

test("an approval outside the bounded activity inventory gets one exact metadata proof, never a history scan", async () => {
  const x = await fixture();
  try {
    await x.bridge.refreshAttention();
    assert.equal(x.bridge.attention.approvals.length, 1);
    assert.equal(x.reads.length, 2);
    await x.bridge.refreshAttention();
    assert.equal(x.bridge.attention.approvals.length, 1);
    assert.equal(
      x.reads.filter((path) => path.includes("execution-records")).length,
      1,
    );
  } finally {
    await x.f.close();
  }
});

test("mismatched current Thread identity never becomes an actionable approval or a confirmed empty inbox", async () => {
  const x = await fixture();
  try {
    x.binding.rootId = "different-root";
    await x.bridge.refreshAttention();
    assert.equal(x.bridge.attention.approvals.length, 0);
    assert.equal(x.bridge.attention.available, false);
  } finally {
    await x.f.close();
  }
});

test("reading a newest or older history page does not erase an authorized pending approval", async () => {
  const x = await fixture();
  try {
    x.bridge.state.threadBindings[x.binding.id] = x.binding;
    await x.bridge.refreshAttention();
    for (const page of [
      { limit: 2 },
      {
        limit: 2,
        before: { createdAt: "2026-10-26T00:00:00Z", id: "newer-input" },
      },
    ]) {
      const history = await x.f.runtime.platformConversationHistory(
        { projectId: x.f.projectId, conversationId: x.dialogueId },
        localAccess,
        page,
      );
      assert.equal(
        history.inputs.length,
        0,
        "accepted old input is outside this page",
      );
      assert.equal(history.runtime.attention!.approvals.length, 1);
      assert.equal(
        history.runtime.attention!.approvals[0]!.scope.inputId,
        x.delivery.inputId,
      );
    }
    assert.equal(
      x.reads.filter((path) => path.includes("/timeline?")).length,
      2,
    );
  } finally {
    await x.f.close();
  }
});

test("a failed approval read retains the last exact request, disclosed as unavailable", async () => {
  const x = await fixture();
  try {
    x.bridge.state.threadBindings[x.binding.id] = x.binding;
    await x.bridge.refreshAttention();
    x.bridge.request = async () => {
      throw new Error("TEST transport unavailable");
    };
    await x.bridge.refreshAttention();
    const attention = x.f.runtime.platformNavigationSnapshot(localAccess, [
      x.f.projectId,
    ]).runtime.attention!;
    assert.equal(attention.available, false);
    assert.equal(attention.approvals.length, 1);
    assert.equal(
      attention.approvals[0]!.approval.fingerprint,
      approvalFingerprint(x.approval),
    );
  } finally {
    await x.f.close();
  }
});

test("an endpoint/identity change during the exact proof cannot publish the old request or source binding", async () => {
  const x = await fixture();
  try {
    const read = x.bridge.request;
    x.bridge.request = async (path: string, method?: string) => {
      const value = await read(path, method);
      if (path.includes("execution-records"))
        x.bridge.config = {
          ...x.bridge.config,
          namespace: "different-identity",
        };
      return value;
    };
    await x.bridge.refreshAttention();
    assert.equal(x.bridge.attention.available, false);
    assert.equal(x.bridge.attention.approvals.length, 0);
    assert.equal(x.bridge.state.threadBindings[x.binding.id], undefined);
  } finally {
    await x.f.close();
  }
});

test("a discovered child approval still uses the original Human command, fresh owner proof and exact fingerprint", async () => {
  const x = await fixture();
  try {
    await x.bridge.refreshAttention();
    const entry = x.bridge.attention.approvals[0];
    const read = x.bridge.request;
    const writes: unknown[] = [];
    x.bridge.request = async (
      path: string,
      method?: string,
      body?: unknown,
    ) => {
      if (method === "POST") {
        assert.equal(path, "/api/approvals/pending-approval");
        writes.push(body);
        return { accepted: true };
      }
      return read(path, method);
    };
    await x.f.session().executionControl({
      scope: entry.scope,
      action: {
        type: "allow-once",
        approvalId: x.approval.request.approval_id,
        fingerprint: entry.approval.fingerprint,
      },
    });
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { decision: string }).decision, "allow_once");
    await assert.rejects(
      x.f.session().executionControl({
        scope: entry.scope,
        action: {
          type: "allow-once",
          approvalId: x.approval.request.approval_id,
          fingerprint: "stale-fingerprint",
        },
      }),
    );
    assert.equal(writes.length, 1);
  } finally {
    await x.f.close();
  }
});
