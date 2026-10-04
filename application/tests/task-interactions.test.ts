import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactSchema,
  initialWorkspace,
  taskContentSchema,
} from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { taskRuntimeSchema } from "../packages/core/src/task-runtime.js";
import type { Boot } from "../apps/web/src/client.js";
import {
  createTaskInteractions,
  type TaskInteractionPorts,
} from "../apps/web/src/data/task-interactions.js";
import { createFixedTaskInteractions } from "./fixtures/task-interactions-9122ad28.js";

const factories = [createFixedTaskInteractions, createTaskInteractions];
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const now = "2026-10-04T00:00:00.000Z";
function boot(): Boot {
  const content = taskContentSchema.parse({
    kind: "task",
    description: "",
    assigneeId: "morphz-agent",
    model: null,
    dueDate: null,
    assignment: "accepted",
    execution: "active",
    delivery: "none",
    resultIds: [],
    runRequested: 1,
  });
  const task = artifactSchema.parse({
    id: "task",
    projectId: "project",
    title: "事项",
    revision: 1,
    content,
    createdBy: { principalId: "human", actantId: "actor" },
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        revision: 1,
        projectId: "project",
        title: "事项",
        content,
        author: { principalId: "human", actantId: "actor" },
        createdAt: now,
      },
    ],
    source: null,
  });
  return {
    centerId: "center",
    principalId: "human",
    actantId: "actor",
    csrfToken: "identity",
    workspace: { ...initialWorkspace(now), artifacts: [task] },
    scriptLibrary: [],
    outputs: [],
    scriptOutputs: [],
    runtime: disconnectedRuntime,
    activityByProject: {},
    taskRuns: {},
    localSavedInputIds: [],
    localInputSubmissions: {},
    capabilities: {
      runtime: true,
      teamAuthentication: false,
      conversationOnFirstInput: true,
      directedInput: true,
      localFiles: false,
      agentDirectories: false,
      modelSettings: false,
      taskCompletion: true,
      browserBookmarks: false,
    },
  };
}
function harness(factory: typeof createTaskInteractions) {
  const current = { current: boot() as Boot | null },
    taskRuntimeReads = { current: new Map<string, number>() },
    taskRuntimeReadGeneration = { current: 0 };
  const calls: Array<{
      method: string;
      params: unknown;
      signal?: AbortSignal;
      identity?: string;
      pending: ReturnType<typeof deferred>;
    }> = [],
    publishes: Boot[] = [];
  const request = (
    method: string,
    params: unknown,
    signal?: AbortSignal,
    identity?: string,
  ) => {
    const pending = deferred();
    calls.push({ method, params, signal, identity, pending });
    return pending.promise;
  };
  const source = {
    boot: { csrfToken: "identity" },
    taskHead: (id: string, signal?: AbortSignal) =>
      request("taskHead", id, signal),
    allTaskResponses: (id: string, signal?: AbortSignal) =>
      request("allTaskResponses", id, signal),
  } as unknown as NonNullable<TaskInteractionPorts["platform"]["current"]>;
  const platform = { current: source as typeof source | null };
  const commands = factory({
    current,
    platform,
    taskRuntimeReads,
    taskRuntimeReadGeneration,
    call: (method, params, options) =>
      request(method, params, options?.signal, options?.identityGeneration),
    publishBoot: (value) => {
      assert.equal(current.current, value, "current is published before React");
      publishes.push(value);
    },
  });
  return {
    commands,
    current,
    platform,
    calls,
    publishes,
    taskRuntimeReads,
    taskRuntimeReadGeneration,
  };
}
test("construction only borrows original refs and direct commands", () => {
  for (const factory of factories) {
    const denied = {
      get current(): never {
        throw new Error("constructor ref read");
      },
    };
    const commands = factory({
      current: denied,
      platform: denied,
      taskRuntimeReads: denied,
      taskRuntimeReadGeneration: denied,
      call: () => {
        throw new Error("constructor I/O");
      },
      publishBoot: () => {
        throw new Error("constructor publish");
      },
    });
    assert.deepEqual(Object.keys(commands), [
      "verifyArtifact",
      "taskRuntime",
      "taskResponses",
    ]);
  }
});
test("all four paths keep original methods, args, identity, deadlines and response source mapping", async () => {
  const timeout = AbortSignal.timeout,
    deadlines: number[] = [];
  AbortSignal.timeout = (ms) => {
    deadlines.push(ms);
    return timeout(ms);
  };
  try {
    for (const factory of factories) {
      const h = harness(factory),
        verify = h.commands.verifyArtifact("outside-page");
      assert.equal(h.calls[0]!.method, "taskHead");
      assert.equal(h.calls[0]!.params, "outside-page");
      h.calls[0]!.pending.resolve({});
      assert.equal(await verify, undefined);
      for (const control of [
        undefined,
        { run: 1, revision: 7, action: "pause" as const },
      ]) {
        const signal = new AbortController().signal,
          pending = h.commands.taskRuntime("task", control, { signal });
        const call = h.calls.at(-1)!;
        assert.equal(call.method, control ? "task.control" : "task.snapshot");
        assert.deepEqual(
          call.params,
          control ? { id: "task", ...control } : "task",
        );
        assert.equal(call.identity, "identity");
        assert.notEqual(call.signal, signal);
        call.pending.resolve({ approvalCount: control ? 2 : 1 });
        assert.equal((await pending).approvalCount, control ? 2 : 1);
      }
      const responses = h.commands.taskResponses("task");
      assert.equal(h.calls.at(-1)!.method, "allTaskResponses");
      h.calls.at(-1)!.pending.resolve([
        {
          id: "response",
          taskId: "task",
          taskRevision: 4,
          body: "答复",
          authorPrincipalId: "author",
          authorActantId: "author-actant",
          createdAt: now,
        },
      ]);
      assert.deepEqual(await responses, [
        {
          id: "response",
          taskId: "task",
          taskRevision: 4,
          body: "答复",
          author: { principalId: "author", actantId: "author-actant" },
          createdAt: now,
        },
      ]);
      assert.equal(h.publishes.length, 2);
      assert.equal(h.taskRuntimeReads.current.size, 0);
    }
    assert.deepEqual(
      deadlines,
      [8000, 12000, 12000, 12000, 8000, 12000, 12000, 12000],
    );
  } finally {
    AbortSignal.timeout = timeout;
  }
});
test("missing identity/source and source-CSRF mismatch fail before transport", async () => {
  for (const factory of factories)
    for (const missing of ["identity", "source", "mismatch"] as const) {
      const h = harness(factory);
      if (missing === "identity") h.current.current = null;
      if (missing === "source") h.platform.current = null;
      if (missing === "mismatch")
        h.platform.current!.boot.csrfToken = "different";
      await assert.rejects(
        h.commands.verifyArtifact("task"),
        /身份已变化，事项未读取/,
      );
      await assert.rejects(
        h.commands.taskResponses("task"),
        /身份已变化，无法读取事项回应/,
      );
      if (missing === "identity")
        await assert.rejects(h.commands.taskRuntime("task"), /应用尚未就绪/);
      assert.equal(h.calls.length, 0);
    }
});
test("head verifies completion identity, responses intentionally retain the old captured-source completion policy", async () => {
  for (const factory of factories) {
    const h = harness(factory),
      verified = h.commands.verifyArtifact("task"),
      responses = h.commands.taskResponses("task");
    h.current.current = null;
    h.calls[0]!.pending.resolve({});
    h.calls[1]!.pending.resolve([]);
    await assert.rejects(verified, /身份已变化，事项未读取/);
    assert.deepEqual(
      await responses,
      [],
      "no new post-await guard or protected generation",
    );
    assert.equal(h.publishes.length, 0);
  }
});
for (const change of [
  "retired",
  "csrf",
  "center",
  "human",
  "actant",
  "task-removed",
  "project",
  "revision",
  "run",
  "assignee",
  "observer",
  "same-refresh",
] as const) {
  test(
    "Runtime completion after " +
      change +
      " keeps original return-versus-publication contract",
    async () => {
      const results: unknown[] = [];
      for (const factory of factories) {
        const h = harness(factory),
          pending = h.commands.taskRuntime("task", undefined, {
            isCurrent: () => change !== "observer",
          });
        if (change === "retired") h.current.current = null;
        else {
          const next = structuredClone(h.current.current!);
          h.current.current = next;
          if (change === "csrf") next.csrfToken = "next";
          if (change === "center") next.centerId = "next";
          if (change === "human") next.principalId = "next";
          if (change === "actant") next.actantId = "next";
          if (change === "task-removed") next.workspace.artifacts = [];
          const task = next.workspace.artifacts[0];
          if (task) {
            if (change === "project") task.projectId = "next";
            if (change === "revision") task.revision++;
            assert.equal(task.content.kind, "task");
            if (task.content.kind === "task") {
              if (change === "run") task.content.runRequested++;
              if (change === "assignee") task.content.assigneeId = "next";
            }
          }
        }
        h.calls[0]!.pending.resolve({ approvalCount: 3 });
        const value = await pending;
        assert.deepEqual(value, taskRuntimeSchema.parse({ approvalCount: 3 }));
        assert.equal(h.publishes.length, change === "same-refresh" ? 1 : 0);
        assert.equal(h.taskRuntimeReads.current.size, 0);
        results.push(value);
      }
      assert.deepEqual(results[0], results[1]);
    },
  );
}
test("same-task response ordering never overwrites newer control or deletes its generation; distinct task IDs do not compete", async () => {
  for (const factory of factories) {
    const h = harness(factory),
      old = h.commands.taskRuntime("task"),
      next = h.commands.taskRuntime("task", {
        run: 1,
        revision: 2,
        action: "stop",
      });
    h.calls[0]!.pending.resolve({ approvalCount: 1 });
    await old;
    assert.equal(h.taskRuntimeReads.current.get("task"), 2);
    assert.equal(h.publishes.length, 0);
    h.calls[1]!.pending.resolve({ approvalCount: 2 });
    await next;
    assert.equal(h.current.current!.taskRuns.task!.approvalCount, 2);
    const newer = h.commands.taskRuntime("task"),
      other = h.commands.taskRuntime("other");
    h.calls[3]!.pending.resolve({ approvalCount: 9 });
    await other;
    assert.equal(h.taskRuntimeReads.current.get("task"), 3);
    h.calls[2]!.pending.resolve({ approvalCount: 3 });
    await newer;
    assert.equal(h.current.current!.taskRuns.task!.approvalCount, 3);
    assert.equal(h.publishes.length, 2);
    assert.equal(h.taskRuntimeReads.current.size, 0);
  }
});
test("parse precedes aborted-signal failure; transport errors and equal projections retain cleanup and publish ordering", async () => {
  for (const factory of factories)
    for (const failure of [
      "parse",
      "abort",
      "transport",
      "equal",
      "publish",
    ] as const) {
      const h = harness(factory),
        controller = new AbortController(),
        marker = new Error("original transport");
      if (failure === "equal")
        h.current.current!.taskRuns.task = taskRuntimeSchema.parse({});
      const pending = h.commands.taskRuntime("task", undefined, {
        signal: controller.signal,
      });
      if (failure === "parse" || failure === "abort") controller.abort();
      if (failure === "transport") h.calls[0]!.pending.reject(marker);
      else
        h.calls[0]!.pending.resolve(
          failure === "parse" ? { runs: "invalid" } : {},
        );
      if (failure === "parse")
        await assert.rejects(pending, { name: "ZodError" });
      else if (failure === "abort")
        await assert.rejects(pending, { name: "AbortError" });
      else if (failure === "transport")
        await assert.rejects(pending, (error) => error === marker);
      else await pending;
      assert.equal(h.publishes.length, failure === "publish" ? 1 : 0);
      assert.equal(h.taskRuntimeReads.current.size, 0);
    }
});
