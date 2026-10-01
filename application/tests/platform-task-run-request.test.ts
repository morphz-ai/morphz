import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Application } from "../packages/application/src/application.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { PlatformWorkService } from "../packages/application/src/platform-work-service.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { localAccess } from "../packages/core/src/model.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { PlatformStore } from "../packages/platform/src/store.js";

test("Desktop and HTTP request one Platform task run without client-chosen Session", async () => {
  const tenantId = `tenant-${randomUUID()}`;
  const authority = new HumanPlatformAuthority(
    tenantId,
    (access) =>
      access.principalId === localAccess.principalId &&
      access.actantId === localAccess.actantId,
  );
  const platform = await PlatformStore.sqlite(
    ":memory:",
    authority.verifier({
      async resolveActor() {
        return null;
      },
      async resolveActant({ tenantId: scope, actantId }) {
        if (scope !== tenantId) return null;
        if (actantId === localAccess.actantId)
          return {
            principalId: localAccess.principalId,
            kind: "human" as const,
          };
        if (actantId === "morphz-agent")
          return { principalId: "morphz-service", kind: "agent" as const };
        return null;
      },
      async resolveProjectAgent({ tenantId: scope }) {
        return scope === tenantId
          ? { principalId: "morphz-service", actantId: "morphz-agent" }
          : null;
      },
      async verifyApplicationObject() {
        return false;
      },
    }),
  );
  const workspace = new WorkspaceStore(":memory:");
  const prepared: string[] = [];
  const validated: Array<[string | undefined, string | undefined]> = [];
  const runtime = {
    isConnected: true,
    as: <T>(_access: unknown, action: () => T) => action(),
    validateInference: async (model?: string, effort?: string) => {
      validated.push([model, effort]);
    },
    preparePlatformTaskSession: async (projectId: string) => {
      prepared.push(projectId);
      return "host-owned-task-session";
    },
  } as unknown as RuntimeBridge;
  const domain = {
    authority,
    service: new PlatformWorkService(platform, "single-host"),
  };
  const local = new LocalApplicationConnection(
    new Application(workspace, {
      runtime,
      platformWork: domain,
      platformTaskRuns: { authority, store: platform },
    }),
  );
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    await platform.provisionTenant(tenantId);
    const boot = (await local.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const spaces = (await local.call("spaces.ensure", undefined, options)) as {
      inboxId: string;
    };
    const plannedTaskId = randomUUID();
    await local.call(
      "tasks.create",
      {
        commandId: randomUUID(),
        taskId: plannedTaskId,
        projectId: spaces.inboxId,
        title: "Cancel before starting",
        assigneeId: "morphz-agent",
      },
      options,
    );
    await local.call(
      "tasks.revise",
      {
        commandId: randomUUID(),
        taskId: plannedTaskId,
        expectedRevision: 1,
        execution: "cancelled",
      },
      options,
    );
    assert.equal(
      (
        (await local.call(
          "tasks.version",
          { taskId: plannedTaskId },
          options,
        )) as {
          execution: string;
        }
      ).execution,
      "cancelled",
    );
    const taskId = randomUUID();
    await local.call(
      "tasks.create",
      {
        commandId: randomUUID(),
        taskId,
        projectId: spaces.inboxId,
        title: "Agent task",
        description: "Do the assigned work",
        assigneeId: "morphz-agent",
      },
      options,
    );
    const command = { commandId: randomUUID(), taskId, expectedRevision: 1 };
    const first = (await local.call("tasks.run-request", command, options)) as {
      taskId: string;
      runNumber: number;
      eventId: string;
    };
    assert.equal(first.taskId, taskId);
    assert.equal(first.runNumber, 1);
    assert.deepEqual(
      await local.call("tasks.run-request", command, options),
      first,
    );
    assert.deepEqual(prepared, [spaces.inboxId, spaces.inboxId]);
    const [admission] = await platform.pendingTaskRuns(tenantId);
    assert.equal(admission!.sessionId, "host-owned-task-session");
    assert.equal(
      admission!.request.intent,
      "Agent task\n\nDo the assigned work",
    );
    assert.equal(admission!.eventId, first.eventId);
    const pendingTaskId = randomUUID();
    await local.call(
      "tasks.create",
      {
        commandId: randomUUID(),
        taskId: pendingTaskId,
        projectId: spaces.inboxId,
        title: "Withdraw before Runtime receipt",
        assigneeId: "morphz-agent",
      },
      options,
    );
    const pendingAdmission = (await local.call(
      "tasks.run-request",
      {
        commandId: randomUUID(),
        taskId: pendingTaskId,
        expectedRevision: 1,
      },
      options,
    )) as { eventId: string };
    const pendingRequest = (await platform.pendingTaskRuns(tenantId)).find(
      (item) => item.eventId === pendingAdmission.eventId,
    )!;
    const pendingControl = {
      id: pendingTaskId,
      run: 1,
      revision: 1,
      action: "stop",
    };
    const pendingState = (await local.call(
      "task.control",
      pendingControl,
      options,
    )) as {
      runs: Array<{ stopRequested: boolean; record: unknown }>;
    };
    assert.equal(pendingState.runs[0]!.stopRequested, true);
    assert.equal(pendingState.runs[0]!.record, null);
    assert.deepEqual(
      await local.call("task.control", pendingControl, options),
      pendingState,
    );
    await platform.confirmTaskRun(tenantId, pendingAdmission.eventId, {
      schedule: {
        id: pendingRequest.request.id,
        thread_id: "pending-thread-one",
        revision: 1,
        status: "queued",
        not_before: pendingRequest.request.not_before,
        interval_seconds: null,
      },
      thread: {
        thread_id: "pending-thread-one",
        session_id: "host-owned-task-session",
        root_turn_id: `client-schedule-${pendingRequest.request.id}`,
        lifecycle: "open",
      },
    });
    const confirmedPending = (await local.call(
      "task.snapshot",
      pendingTaskId,
      options,
    )) as {
      runs: Array<{ stopRequested: boolean; record: unknown }>;
    };
    assert.equal(confirmedPending.runs[0]!.stopRequested, true);
    assert.ok(confirmedPending.runs[0]!.record);
    assert.equal((await platform.pendingTaskRunStops(tenantId)).length, 1);
    await assert.rejects(
      local.call(
        "tasks.run-request",
        { ...command, sessionId: "forged" },
        options,
      ),
      /请求格式无效/,
    );
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      runtime,
      platformWork: domain,
      platformTaskRuns: { authority, store: platform },
    });
    await new Promise<void>((resolve) =>
      server!.listen(port, "127.0.0.1", resolve),
    );
    const remote = new HttpApplicationClient(`http://127.0.0.1:${port}`);
    const remoteBoot = (await remote.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    assert.deepEqual(
      await remote.call("tasks.run-request", command, {
        identityGeneration: remoteBoot.csrfToken,
      }),
      first,
    );
    assert.equal((await platform.pendingTaskRuns(tenantId)).length, 1);
    await platform.confirmTaskRun(tenantId, admission!.eventId, {
      schedule: {
        id: admission!.request.id,
        thread_id: "task-thread-one",
        revision: 1,
        status: "queued",
        not_before: admission!.request.not_before,
        interval_seconds: null,
      },
      thread: {
        thread_id: "task-thread-one",
        session_id: admission!.sessionId,
        root_turn_id: `client-schedule-${admission!.request.id}`,
        lifecycle: "open",
      },
    });
    const stopping = (await local.call(
      "task.control",
      {
        id: taskId,
        run: 1,
        revision: 1,
        action: "stop",
      },
      options,
    )) as { runs: Array<{ stopRequested: boolean }> };
    assert.equal(stopping.runs[0]!.stopRequested, true);
    assert.equal((await platform.pendingTaskRunStops(tenantId)).length, 2);
    const remoteStopping = (await remote.call(
      "task.control",
      {
        id: taskId,
        run: 1,
        revision: 1,
        action: "stop",
      },
      { identityGeneration: remoteBoot.csrfToken },
    )) as {
      runs: Array<{ stopRequested: boolean }>;
    };
    assert.equal(remoteStopping.runs[0]!.stopRequested, true);
    assert.equal((await platform.pendingTaskRunStops(tenantId)).length, 2);
    const configuredTaskId = randomUUID();
    await local.call(
      "tasks.create",
      {
        commandId: randomUUID(),
        taskId: configuredTaskId,
        projectId: spaces.inboxId,
        title: "Scheduled Agent work",
        assigneeId: "morphz-agent",
      },
      options,
    );
    await local.call(
      "tasks.revise",
      {
        commandId: randomUUID(),
        taskId: configuredTaskId,
        expectedRevision: 1,
        modelId: "selected-model",
        reasoningEffort: "high",
        notBefore: "2026-10-02T12:00:00.000Z",
        everySeconds: 3600,
      },
      options,
    );
    const configured = (await remote.call(
      "tasks.run-request",
      {
        commandId: randomUUID(),
        taskId: configuredTaskId,
        expectedRevision: 2,
      },
      { identityGeneration: remoteBoot.csrfToken },
    )) as { eventId: string };
    const configuredAdmission = (await platform.pendingTaskRuns(tenantId)).find(
      (item) => item.eventId === configured.eventId,
    )!;
    assert.deepEqual(validated, [["selected-model", "high"]]);
    assert.equal(configuredAdmission.request.model_alias, "selected-model");
    assert.equal(configuredAdmission.request.reasoning_effort, "high");
    assert.equal(
      configuredAdmission.request.not_before,
      "2026-10-02T12:00:00.000Z",
    );
    assert.equal(configuredAdmission.request.interval_seconds, 3600);
  } finally {
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    );
    local.close();
    await platform.close();
    workspace.close();
  }
});
