import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  applicationCall,
  RequestError,
} from "../apps/web/src/application-transport.js";
import { UnsentOperationError } from "../apps/web/src/data/operation-delivery.js";
import {
  taskContentSchema,
  type Operation,
} from "../packages/core/src/model.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import {
  withOperationHttp,
  operationHuman,
  otherOperationHuman,
} from "./fixtures/operation-delivery-http.js";
type Context = Parameters<Parameters<typeof withOperationHttp>[1]>[0];
const document = (
  projectId: string,
  title = "TEST 原文",
): Extract<Operation, { type: "create-artifact" }> => ({
  type: "create-artifact",
  projectId,
  title,
  content: { kind: "document", markdown: "完整确切原文" },
});
const task = (
  projectId: string,
): Extract<Operation, { type: "create-artifact" }> => ({
  type: "create-artifact",
  projectId,
  title: "TEST 真实事项",
  content: taskContentSchema.parse({
    kind: "task",
    description: "原描述",
    assigneeId: operationHuman.actantId,
    model: null,
    dueDate: null,
    assignment: "proposed",
    execution: "planned",
    delivery: "none",
    resultIds: [],
  }),
});
const pending = (context: Context, operation: Operation) => {
  const found = [...context.rows].flatMap(([key, text]) => {
    const value = JSON.parse(text) as {
      commandId?: string;
      operation?: Operation;
      applicationInstanceId?: string;
    } | null;
    return value?.operation &&
      JSON.stringify(value.operation) === JSON.stringify(operation)
      ? [{ key, command: value }]
      : [];
  });
  assert.equal(
    found.length,
    1,
    "one exact whole pending command in captured storage scope",
  );
  return found[0]!;
};
const commandId = (request: unknown) => {
  assert.ok(request && typeof request === "object" && "commandId" in request);
  return request.commandId;
};

test(
  "actual Client project/document/interactive/task CRUD uses exact IDs and revisions, off-head source and original unsent qualification",
  { timeout: 90000 },
  async () => {
    await withOperationHttp("crud-cas", async (context) => {
      const projectCommand = randomUUID(),
        project = await context.client.execute(
          { type: "create-project", title: "TEST durable project" },
          false,
          undefined,
          projectCommand,
        );
      assert.equal(project.entityId, projectCommand);
      const objectId = randomUUID(),
        created = await context.client.execute(
          document(project.entityId),
          false,
          undefined,
          objectId,
        );
      assert.equal(
        context.sql().objects.find((row) => row.object_id === objectId)!
          .head_revision,
        1,
      );
      assert.equal(
        context
          .sql()
          .objectReceipts.filter((row) => row.command_id === objectId).length,
        1,
      );
      const source = await PlatformClient.connect({ call: applicationCall });
      for (let n = 0; n < 52; n++)
        await source.createDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: project.entityId,
          title: "TEST newer " + n,
          markdown: "newer head",
        });
      await context.client.refresh();
      assert.equal(
        context.client
          .getSnapshot()!
          .workspace.artifacts.some((row) => row.id === created.entityId),
        false,
        "off-head object is not replaced by current limited Boot publication",
      );
      await context.client.execute({
        type: "revise-artifact",
        artifactId: created.entityId,
        expectedRevision: 1,
        title: "第二版",
        content: { kind: "document", markdown: "第二版确切原文" },
      });
      const reread = await context.client.resolveArtifact(created.entityId);
      assert.equal(reread?.revision, 2);
      assert.equal(reread?.content.kind, "document");
      assert.equal(
        context.sql().versions.filter((row) => row.object_id === objectId)
          .length,
        2,
      );
      const tableId = randomUUID(),
        table = await context.client.execute(
          {
            type: "create-artifact",
            projectId: project.entityId,
            title: "TEST table",
            content: emptyInteractive,
          },
          false,
          undefined,
          tableId,
        );
      const tableRead = await context.client.resolveArtifact(table.entityId);
      assert.equal(tableRead?.content.kind, "interactive");
      await context.client.execute({
        type: "revise-artifact",
        artifactId: table.entityId,
        expectedRevision: 1,
        title: "TEST table",
        content: {
          ...emptyInteractive,
          rows: [{ id: "first", cells: { name: "真实记录" } }],
        },
      });
      assert.equal(
        context.sql().objects.find((row) => row.object_id === tableId)!
          .head_revision,
        2,
      );
      const taskId = randomUUID(),
        createdTask = await context.client.execute(
          task(project.entityId),
          false,
          undefined,
          taskId,
        );
      assert.equal(createdTask.entityId, taskId);
      assert.equal(
        context.sql().tasks.find((row) => row.task_id === taskId)!.revision,
        1,
      );
      const invalid = task(project.entityId);
      assert.equal(invalid.content.kind, "task");
      const unsentId = randomUUID();
      await assert.rejects(
        context.client.execute(
          { ...invalid, content: { ...invalid.content, priority: "high" } },
          false,
          undefined,
          unsentId,
        ),
        (error) =>
          error instanceof UnsentOperationError &&
          error.message === "此事项包含尚未接通的初始状态或关联；未创建事项。",
      );
      assert.equal(
        context.sql().tasks.some((row) => row.task_id === unsentId),
        false,
      );
      assert.equal(
        context
          .sql()
          .platformReceipts.some((row) => row.command_id === unsentId),
        false,
      );
      assert.equal(
        context.sql().projects.some((row) => row.project_id === projectCommand),
        true,
      );
    });
  },
);

test(
  "actual app commit with controlled 500/409 lost reply retains whole ID/instance payload across same-window remount and creates no duplicate",
  { timeout: 90000 },
  async () => {
    await withOperationHttp("lost-receipts", async (context) => {
      const project = await context.client.execute({
        type: "create-project",
        title: "TEST lost replies",
      });
      const operation = document(project.entityId),
        externalId = randomUUID(),
        instanceId = "existing-caller-instance";
      context.interceptNext("/api/platform/documents", 500);
      await assert.rejects(
        context.client.execute(operation, true, instanceId, externalId),
        (error) =>
          error instanceof RequestError &&
          error.status === 500 &&
          error.message === "TEST controlled reply after real commit",
      );
      const saved = pending(context, operation);
      assert.deepEqual(saved.command, {
        commandId: externalId,
        operation,
        applicationInstanceId: instanceId,
      });
      assert.equal(
        context.sql().objects.filter((row) => row.object_id === externalId)
          .length,
        1,
      );
      assert.equal(
        context
          .sql()
          .objectReceipts.filter((row) => row.command_id === externalId).length,
        1,
      );
      await context.remount();
      const receipt = await context.client.execute(
        operation,
        true,
        instanceId,
        externalId,
      );
      assert.equal(receipt.commandId, externalId);
      assert.equal(context.rows.get(saved.key), "null");
      const requests = context.reads.filter(
        (row) =>
          row.path === "/api/platform/documents" && row.method === "POST",
      );
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]!.body, requests[1]!.body);
      const next = await context.client.execute({
        ...operation,
        title: "TEST different new action",
      });
      assert.notEqual(next.commandId, externalId);
      const script: Operation = {
          type: "script-command",
          command: {
            action: "create-production",
            projectId: project.entityId,
            title: "TEST app-owned script",
          },
        },
        scriptId = randomUUID();
      context.interceptNext("/api/platform/scripts", 409);
      await assert.rejects(
        context.client.execute(script, false, undefined, scriptId),
        (error) => error instanceof RequestError && error.status === 409,
      );
      const savedScript = pending(context, script);
      assert.equal(savedScript.command.commandId, scriptId);
      assert.equal(
        context
          .sql()
          .scriptReceipts.filter((row) => row.command_id === scriptId).length,
        1,
      );
      assert.equal(
        (await context.client.execute(script, false, undefined, scriptId))
          .entityId,
        scriptId,
      );
      assert.equal(context.rows.get(savedScript.key), "null");
      assert.equal(
        context
          .sql()
          .scriptReceipts.filter((row) => row.command_id === scriptId).length,
        1,
      );
      // Real wrong-app qualification uses the same class passed from the retained
      // dispatcher into Object's leaf, not an error message classifier.
      const entry = context.client
        .getSnapshot()!
        .scriptLibrary.find((value) => value.id === scriptId);
      assert(entry);
      const before = context.sql().objectReceipts.length;
      await assert.rejects(
        context.client.execute({
          type: "annotate",
          artifactId: entry.contentId,
          artifactRevision: 1,
          quote: "",
          body: "wrong app",
        }),
        (error) =>
          error instanceof UnsentOperationError &&
          error.message === "所选内容不是可批注的原件，未保存批注。",
      );
      assert.equal(context.sql().objectReceipts.length, before);
    });
  },
);

test(
  "actual definitive task CAS/permission rejection clears pending while successful commit clear failure and controlled refresh failure preserve original behavior",
  { timeout: 90000 },
  async () => {
    await withOperationHttp("definitive-and-storage", async (context) => {
      const project = await context.client.execute({
          type: "create-project",
          title: "TEST definitive",
        }),
        createdTask = await context.client.execute(task(project.entityId));
      const stale: Operation = {
          type: "arrange-task",
          taskId: createdTask.entityId,
          expectedRevision: 99,
          changes: { execution: "waiting" },
        },
        staleId = randomUUID();
      await assert.rejects(
        context.client.execute(stale, false, undefined, staleId),
        (error) => error instanceof RequestError && error.status === 409,
      );
      assert.equal(
        context.sql().tasks.find((row) => row.task_id === createdTask.entityId)!
          .revision,
        1,
      );
      assert.equal(
        context
          .sql()
          .platformReceipts.some((row) => row.command_id === staleId),
        false,
      );
      assert.equal(
        [...context.rows.values()].some((text) => {
          const value = JSON.parse(text);
          return value?.commandId === staleId;
        }),
        false,
      );
      await context.login(true);
      const forbidden = task(project.entityId),
        forbiddenId = randomUUID();
      await assert.rejects(
        context.client.execute(forbidden, false, undefined, forbiddenId),
        (error) => error instanceof RequestError && error.status === 403,
      );
      assert.equal(
        context.sql().tasks.some((row) => row.task_id === forbiddenId),
        false,
      );
      assert.equal(
        [...context.rows.values()].some((text) => {
          const value = JSON.parse(text);
          return value?.commandId === forbiddenId;
        }),
        false,
      );
      await context.login();
      const operation = document(project.entityId, "TEST storage failed"),
        external = randomUUID();
      context.failNextClear();
      await assert.rejects(
        context.client.execute(operation, false, undefined, external),
        { message: "TEST committed pending clear failed" },
      );
      const saved = pending(context, operation);
      assert.equal(saved.command.commandId, external);
      assert.equal(
        context.sql().objects.filter((row) => row.object_id === external)
          .length,
        1,
      );
      await context.client.execute(operation, false, undefined, external);
      assert.equal(
        context
          .sql()
          .objectReceipts.filter((row) => row.command_id === external).length,
        1,
      );
      assert.equal(context.rows.get(saved.key), "null");
      const refreshId = randomUUID();
      context.interceptNext("/api/platform/runtime-navigation", 500);
      const committed = await context.client.execute(
        document(project.entityId, "TEST refresh false"),
        false,
        undefined,
        refreshId,
      );
      assert.equal(
        committed.commandId,
        refreshId,
        "actual Client refresh false does not convert receipt into failure",
      );
      assert.equal(
        context.reads.some(
          (row) =>
            row.path === "/api/platform/runtime-navigation" &&
            row.returnedStatus === 500,
        ),
        true,
        "controlled actual refresh request was reached, not an unused interceptor",
      );
      assert.equal(
        context
          .sql()
          .objectReceipts.filter((row) => row.command_id === refreshId).length,
        1,
      );
      await context.client.refresh();
    });
  },
);

test(
  "actual committed late200 rejects exact HTTP epoch408, keeps old principal scope, retries same whole command once and awaits an existing refresh",
  { timeout: 90000 },
  async () => {
    await withOperationHttp("late-epoch-refresh", async (context) => {
      const project = await context.client.execute({
          type: "create-project",
          title: "TEST late epoch",
        }),
        operation = document(project.entityId),
        external = randomUUID(),
        instance = "caller-instance";
      const held = context.holdNext("/api/platform/documents"),
        request = context.client.execute(operation, true, instance, external);
      const rejected = assert.rejects(
        request,
        (error) =>
          error instanceof RequestError &&
          error.status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await held.reached;
        assert.equal(
          context.sql().objects.filter((row) => row.object_id === external)
            .length,
          1,
        );
        const saved = pending(context, operation);
        await context.login(true);
        held.release();
        await rejected;
        assert.equal(
          context.client.getSnapshot()!.principalId,
          otherOperationHuman.principalId,
        );
        assert.notEqual(context.rows.get(saved.key), "null");
        assert.ok(saved.key.includes(":" + operationHuman.principalId + ":"));
        await context.login();
        const receipt = await context.client.execute(
          operation,
          true,
          instance,
          external,
        );
        assert.equal(receipt.commandId, external);
        assert.equal(context.rows.get(saved.key), "null");
        assert.equal(
          context
            .sql()
            .objectReceipts.filter((row) => row.command_id === external).length,
          1,
        );
        const posts = context.reads.filter(
          (row) =>
            row.path === "/api/platform/documents" && row.method === "POST",
        );
        assert.deepEqual(posts[0]!.body, posts[1]!.body);
        assert.equal(commandId(posts[0]!.body), external);
      } finally {
        held.release();
        await rejected;
      }
      const readHold = context.holdNext("/api/platform/runtime-navigation"),
        refresh = context.client.refresh();
      try {
        await readHold.reached;
        let settled = false;
        const nextId = randomUUID(),
          mutation = context.client
            .execute(
              {
                type: "create-project",
                title: "TEST waits for existing refresh",
              },
              false,
              undefined,
              nextId,
            )
            .finally(() => {
              settled = true;
            });
        const deadline = Date.now() + 5000;
        while (
          !context.sql().projects.some((row) => row.project_id === nextId)
        ) {
          assert.ok(
            Date.now() < deadline,
            "actual mutation commits while old refresh is held",
          );
          await new Promise<void>((done) => setTimeout(done, 5));
        }
        assert.equal(settled, false);
        readHold.release();
        await refresh;
        assert.equal((await mutation).commandId, nextId);
        assert.equal(
          context.client.getSnapshot()!.principalId,
          operationHuman.principalId,
        );
      } finally {
        readHold.release();
        await refresh;
      }
    });
  },
);
