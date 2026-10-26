import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionControls,
  approvalFingerprint,
} from "../packages/application/src/execution.js";
import {
  approvalSchema,
  executionControlSchema,
  reusableApprovalScopes,
} from "../packages/core/src/execution.js";

const scope = { projectId: "p", artifactId: null, threadId: "t" };
const binding = {
  sessionId: "s",
  contextId: "c",
  rootId: "r",
  threadId: "t",
  principalId: "human",
};
function approval() {
  return approvalSchema.parse({
    requested_at: "2026-10-26T00:00:00Z",
    request: {
      approval_id: "a",
      session_id: "s",
      context_id: "c",
      thread_id: "t",
      root_turn_id: "r",
      justification: "TEST bounded access",
      action: {},
      requested: { network: true },
      lease_offer: {
        principal_id: "human",
        agent_id: "agent",
        session_id: "s",
        thread_id: "t",
        scope: "objective",
        scope_id: "goal",
        target_id: "local",
        capability: "shell",
        capabilities: ["network"],
        requested: { network: true },
        policy_digest: "digest",
        expires_at: "2099-01-01T00:00:00Z",
      },
    },
  });
}

test("explicit Objective and Session approvals retain the complete boundary fingerprint and native scoped receipt", async () => {
  for (const type of ["allow-objective", "allow-session"] as const) {
    const current = approval();
    const writes: unknown[] = [];
    const controls = new ExecutionControls(
      async (path, method, body) => {
        if (!method) return { approvals: [current] };
        assert.equal(path, "/api/approvals/a");
        writes.push(body);
        return {
          accepted: true,
          approval_id: "a",
          scope: type === "allow-objective" ? "objective" : "session",
        };
      },
      () => binding,
    );
    const result = await controls.control({
      scope,
      action: {
        type,
        approvalId: "a",
        fingerprint: approvalFingerprint(current),
      },
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(
      (writes[0] as { decision: string }).decision,
      type.replace("-", "_"),
    );
    assert.equal(writes.length, 1);
  }
});

test("changed offer, expired offer, wrong Human or absent reusable boundary reject before approval", async () => {
  for (const change of ["changed", "expired", "owner", "absent"] as const) {
    const current = approval(),
      original = approvalFingerprint(current);
    if (change === "changed")
      current.request.lease_offer!.policy_digest = "changed";
    if (change === "expired")
      current.request.lease_offer!.expires_at = "2020-01-01T00:00:00Z";
    if (change === "owner") current.request.lease_offer!.principal_id = "other";
    if (change === "absent") delete current.request.lease_offer;
    let writes = 0;
    const controls = new ExecutionControls(
      async (_path, method) => {
        if (method) writes++;
        return { approvals: [current] };
      },
      () => binding,
    );
    await assert.rejects(
      controls.control({
        scope,
        action: {
          type: "allow-session",
          approvalId: "a",
          fingerprint:
            change === "changed" ? original : approvalFingerprint(current),
        },
      }),
    );
    assert.equal(writes, 0);
  }
});

test("no offer cannot become Full Access; Thread or nearby goal does not prove Objective supervision", () => {
  const current = approval();
  current.request.lease_offer!.scope = "thread";
  assert.deepEqual(reusableApprovalScopes(current), ["session"]);
  for (const type of ["allow-all", "full-access", "allow-thread"])
    assert.equal(
      executionControlSchema.safeParse({
        scope,
        action: {
          type,
          approvalId: "a",
          fingerprint: approvalFingerprint(current),
        },
      }).success,
      false,
    );
});

test("reusable approval needs the exact scoped receipt, not accepted alone", async () => {
  const current = approval();
  const controls = new ExecutionControls(
    async (_path, method) =>
      method ? { accepted: true } : { approvals: [current] },
    () => binding,
  );
  await assert.rejects(
    controls.control({
      scope,
      action: {
        type: "allow-session",
        approvalId: "a",
        fingerprint: approvalFingerprint(current),
      },
    }),
    /回执/,
  );
});
