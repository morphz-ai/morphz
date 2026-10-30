import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeScheduleControls } from "../packages/application/src/runtime-schedule-controls.js";

const source = {
  sessionId: "s",
  contextId: "c",
  threadId: "t",
  rootId: "r",
  sourceTurnId: "input-root",
  principalId: "human",
};
const scope = {
  projectId: "p",
  conversationId: "conversation",
  artifactId: null,
  inputId: "input",
  threadId: "t",
};
const record = {
  id: "timer",
  thread_id: "t",
  source_turn_id: "input-root",
  revision: 4,
  status: "queued",
  not_before: "2026-12-01T00:00:00Z",
  interval_seconds: null,
};
const thread = {
  id: "t",
  session_id: "s",
  context_id: "c",
  root_turn_id: "r",
  initiating_principal_id: "human",
};

test("native Schedule controls preserve IDs, use scoped CAS, and preserve pause when rescheduling", async () => {
  let current = { ...record };
  const writes: Array<{ path: string; body: unknown }> = [];
  const controls = new RuntimeScheduleControls(
    async (path, method = "GET", body) => {
      if (path.endsWith("/threads/t")) return { snapshot: { thread } };
      assert.equal(path, "/api/sessions/s/schedules/timer");
      if (method === "GET") return current;
      const command = body as Record<string, unknown>;
      assert.equal(command.expected_revision, current.revision);
      writes.push({ path, body });
      current = {
        ...current,
        revision: current.revision + 1,
        ...(command.action === "reschedule"
          ? {
              not_before: String(command.not_before),
              interval_seconds: command.interval_seconds as null,
            }
          : {
              status: {
                pause: "paused",
                resume: "queued",
                cancel: "cancelled",
              }[String(command.action)]!,
            }),
      };
      return current;
    },
    source,
  );
  for (const action of ["pause", "reschedule", "resume", "cancel"] as const) {
    const value = await controls.control({
      scope,
      scheduleId: "timer",
      revision: current.revision,
      action,
      ...(action === "reschedule"
        ? { notBefore: "2026-12-02T01:00:00+01:00", intervalSeconds: null }
        : {}),
    });
    assert.equal(
      value.status,
      {
        pause: "paused",
        reschedule: "paused",
        resume: "queued",
        cancel: "cancelled",
      }[action],
    );
  }
  assert.equal(writes.length, 4);
  assert.ok(
    writes.every(({ body }) => !JSON.stringify(body).includes("model")),
  );
});

test("stale, foreign, dispatched, malformed and changed-identity schedules never mutate", async () => {
  for (const change of [
    { revision: 5 },
    { thread_id: "sibling" },
    { source_turn_id: "other-input" },
    { status: "dispatched" },
  ]) {
    let writes = 0;
    const controls = new RuntimeScheduleControls(
      async (path, method = "GET") => {
        if (method === "POST") writes++;
        return path.includes("/threads/")
          ? { snapshot: { thread } }
          : { ...record, ...change };
      },
      source,
    );
    await assert.rejects(
      controls.control({
        scope,
        scheduleId: "timer",
        revision: 4,
        action: "pause",
      }),
    );
    assert.equal(writes, 0);
  }
  for (const change of [
    { context_id: "foreign" },
    { initiating_principal_id: "other" },
    { root_turn_id: "other-root" },
  ]) {
    let writes = 0;
    const controls = new RuntimeScheduleControls(
      async (path, method = "GET") => {
        if (method === "POST") writes++;
        return path.includes("/threads/")
          ? { snapshot: { thread: { ...thread, ...change } } }
          : record;
      },
      source,
    );
    await assert.rejects(
      controls.control({
        scope,
        scheduleId: "timer",
        revision: 4,
        action: "pause",
      }),
    );
    assert.equal(writes, 0);
  }
});

test("a successful HTTP response without the requested Schedule transition is uncertain, never success", async () => {
  let writes = 0;
  const controls = new RuntimeScheduleControls(async (path, method = "GET") => {
    if (method === "POST") writes++;
    return path.includes("/threads/") ? { snapshot: { thread } } : record;
  }, source);
  await assert.rejects(
    controls.control({
      scope,
      scheduleId: "timer",
      revision: 4,
      action: "pause",
    }),
    /回执/,
  );
  assert.equal(writes, 1);
});
