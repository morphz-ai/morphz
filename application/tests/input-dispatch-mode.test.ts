import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { workInputRequest } from "../packages/application/src/session-io.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  newInputOperation,
  savedInputOperation,
  readSavedInputs,
  saveInputLocally,
} from "../apps/web/src/local-saved-inputs.js";
import {
  localAccess,
  operationSchema,
  type RecordedInput,
  type InputDispatchMode,
} from "../packages/core/src/model.js";

type Host = Awaited<ReturnType<typeof platformRuntimeHostFixture>>;
type Input = Extract<
  ReturnType<typeof operationSchema.parse>,
  { type: "record-input" }
>;
type Ledger = {
  deliveries: Array<{
    inputId: string;
    rootId: string | null;
    state: string;
    cancelRequested: boolean;
    request: {
      io_version: string;
      activation: Record<string, unknown>;
      client_message_id: string;
    };
  }>;
};

const operation = (dispatchMode?: InputDispatchMode): Input => ({
  type: "record-input",
  projectId: "first-project",
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "TEST 本次输入派发策略，不执行外部工作",
  targetActantId: "morphz-agent",
  ...(dispatchMode ? { dispatchMode } : {}),
});
const command = (dispatchMode?: InputDispatchMode) => ({
  commandId: randomUUID(),
  operation: operation(dispatchMode),
});
const delivery = (host: Host, inputId: string) =>
  (host.store.runtimeState() as Ledger).deliveries.find(
    (item) => item.inputId === inputId,
  )!;

test("新普通输入明确interrupt/parallel；定向补充仍parallel且无模式扩展", () => {
  const op = operation();
  const input: RecordedInput = {
    projectId: op.projectId,
    artifactId: op.artifactId,
    artifactRevision: op.artifactRevision,
    selection: op.selection,
    body: op.body,
    targetActantId: op.targetActantId,
    id: randomUUID(),
    author: localAccess,
    status: "recorded",
    createdAt: new Date().toISOString(),
  };
  assert.equal(workInputRequest(input).activation.dispatch_mode, "interrupt");
  assert.equal(
    workInputRequest({ ...input, dispatchMode: "parallel" }).activation
      .dispatch_mode,
    "parallel",
  );
  const supplemented = workInputRequest({
    ...input,
    dispatchMode: "interrupt",
    continuation: {
      mode: "supplement",
      inputId: randomUUID(),
      threadId: "TEST-original-thread",
      generation: 4,
    },
  });
  assert.equal(supplemented.activation.dispatch_mode, "parallel");
  assert.ok("input_destination" in supplemented.activation);
  assert.deepEqual(supplemented.activation.input_destination, {
    kind: "thread",
    thread_id: "TEST-original-thread",
    generation: 4,
  });
  for (const mode of ["follow_up", "queued", "stop", null])
    assert.equal(
      operationSchema.safeParse({ ...op, dispatchMode: mode }).success,
      false,
    );
  const parsed = operationSchema.parse(op);
  assert.ok(parsed.type === "record-input");
  assert.equal(parsed.dispatchMode, undefined);
});

test("Host新输入缺省interrupt，显式parallel持久；同命令换模式拒绝且不会停线程", async () => {
  const host = await platformRuntimeHostFixture();
  try {
    for (const mode of [undefined, "interrupt", "parallel"] as const) {
      const input = command(mode);
      const receipt = await host.session().platformMessage(input);
      const original = structuredClone(delivery(host, input.commandId));
      assert.equal(
        original.request.activation.dispatch_mode,
        mode ?? "interrupt",
      );
      assert.equal(original.request.client_message_id, input.commandId);
      assert.equal(original.cancelRequested, false);
      assert.deepEqual(await host.session().platformMessage(input), receipt);
      assert.deepEqual(delivery(host, input.commandId), original);
      await assert.rejects(
        host.session().platformMessage({
          ...input,
          operation: {
            ...input.operation,
            dispatchMode: mode === "parallel" ? "interrupt" : "parallel",
          },
        }),
        /操作标识已用于另一条输入/,
      );
      assert.deepEqual(delivery(host, input.commandId), original);
    }
    const beforeRestart = host.store.runtimeState();
    await host.reopen();
    assert.deepEqual(host.store.runtimeState(), beforeRestart);
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
});

for (const retainedMode of ["parallel", undefined] as const)
  test(`历史typed请求${retainedMode ?? "省略mode"}重启及命令重试不升级interrupt`, async () => {
    const host = await platformRuntimeHostFixture();
    try {
      const input = command();
      await host.session().platformMessage(input);
      // Isolated fixture simulates the exact persisted pre-upgrade envelope.
      const old = host.store.runtimeState() as Ledger;
      const retained = old.deliveries[0]!;
      if (retainedMode === undefined)
        delete retained.request.activation.dispatch_mode;
      else retained.request.activation.dispatch_mode = retainedMode;
      retained.rootId = "TEST-already-accepted-root";
      retained.state = "running";
      host.store.saveRuntimeState(old);
      const bytes = JSON.stringify(retained.request);
      await host.reopen();
      await host.session().platformMessage(input);
      assert.equal(
        JSON.stringify(delivery(host, input.commandId).request),
        bytes,
      );
      // Old locally saved commands are explicitly sent as historical parallel;
      // even equivalent explicit mode must retain an omitted transport field.
      await host.session().platformMessage({
        ...input,
        operation: savedInputOperation(input.operation),
      });
      assert.equal(
        JSON.stringify(delivery(host, input.commandId).request),
        bytes,
      );
      await assert.rejects(
        host.session().platformMessage({
          ...input,
          operation: { ...input.operation, dispatchMode: "interrupt" },
        }),
        /操作标识已用于另一条输入/,
      );
      assert.equal(delivery(host, input.commandId).rootId, retained.rootId);
      assert.equal(
        JSON.stringify(delivery(host, input.commandId).request),
        bytes,
      );
      assert.equal((host.store.runtimeState() as Ledger).deliveries.length, 1);
      host.assertNoLegacyData();
    } finally {
      await host.close();
    }
  });

test("同ID并发不同mode只有一个不可变入站；不新增LLM/取消/权限请求", async () => {
  const replies: ServerResponse[] = [];
  const calls: string[] = [];
  let ready!: () => void;
  const both = new Promise<void>((resolve) => (ready = resolve));
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/api/status") {
      response.writeHead(500);
      response.end("{}");
      return;
    }
    replies.push(response);
    if (replies.length === 2) ready();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "isolated-input-mode-test",
    namespace: randomUUID(),
  });
  try {
    const first = command("parallel");
    const second = {
      ...first,
      operation: { ...first.operation, dispatchMode: "interrupt" as const },
    };
    const outcomes = Promise.allSettled([
      host.session().platformMessage(first),
      host.session().platformMessage(second),
    ]);
    await both;
    for (const response of replies)
      response.end(JSON.stringify({ model: "TEST-model" }));
    const results = await outcomes;
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const index = results.findIndex((result) => result.status === "fulfilled");
    const original = structuredClone(delivery(host, first.commandId));
    assert.equal(
      original.request.activation.dispatch_mode,
      index === 0 ? "parallel" : "interrupt",
    );
    assert.equal((host.store.runtimeState() as Ledger).deliveries.length, 1);
    assert.equal(original.cancelRequested, false);
    assert.deepEqual(calls, ["GET /api/status", "GET /api/status"]);
    await host.reopen();
    await host.session().platformMessage(index === 0 ? first : second);
    assert.deepEqual(delivery(host, first.commandId), original);
    assert.equal(
      calls.length,
      2,
      "admitted retries do not add default/model requests",
    );
  } finally {
    for (const response of replies) if (!response.writableEnded) response.end();
    await host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("新输入先冻结mode；旧本机saved缺mode按parallel发送且原存储字节不改", () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  const op = operation();
  assert.equal(newInputOperation(op).dispatchMode, "interrupt");
  assert.equal(
    newInputOperation(operation("parallel")).dispatchMode,
    "parallel",
  );
  const entry = {
    commandId: randomUUID(),
    operation: op,
    createdAt: new Date().toISOString(),
  };
  saveInputLocally(storage, "TEST-identity", entry);
  const bytes = [...values.values()];
  const reopened = readSavedInputs(storage, "TEST-identity")[0]!;
  assert.equal(reopened.operation.dispatchMode, undefined);
  const sent = savedInputOperation(reopened.operation);
  assert.equal(sent.dispatchMode, "parallel");
  assert.equal(reopened.operation.dispatchMode, undefined);
  assert.deepEqual([...values.values()], bytes);
  assert.equal(
    savedInputOperation(operation("interrupt")).dispatchMode,
    "interrupt",
  );
  for (const prepare of [newInputOperation, savedInputOperation])
    assert.equal(
      prepare({
        ...op,
        dispatchMode: "interrupt",
        continuation: {
          mode: "supplement",
          inputId: randomUUID(),
          threadId: "TEST-thread",
          generation: 1,
        },
      }).dispatchMode,
      "parallel",
    );
});

test("现有HTTP及embedded消息通路持久同一mode；失效identity/schema不入站", async () => {
  const host = await platformRuntimeHostFixture();
  const embedded = new LocalApplicationConnection(host.application);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(host.store, {
    ...host.application.options,
    port,
    webRoot: "/nonexistent",
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const boot = await embedded.invoke({
      id: randomUUID(),
      method: "platform.bootstrap",
    });
    assert.equal(boot.ok, true);
    if (!boot.ok) throw new Error("fixture bootstrap failed");
    const generation = (boot.value as { csrfToken: string }).csrfToken;
    const input = command("parallel");
    const reply = await embedded.invoke({
      id: randomUUID(),
      method: "platform.message",
      params: input,
      identityGeneration: generation,
    });
    assert.equal(reply.ok, true);
    assert.equal(
      delivery(host, input.commandId).request.activation.dispatch_mode,
      "parallel",
    );
    const denied = await embedded.invoke({
      id: randomUUID(),
      method: "platform.message",
      params: command("interrupt"),
      identityGeneration: "TEST-stale",
    });
    assert.equal(denied.ok, false);
    const client = await PlatformClient.connect(
      new HttpApplicationClient(`http://127.0.0.1:${port}`),
    );
    for (const mode of [undefined, "parallel"] as const) {
      const httpInput = command(mode);
      await client.sendMessage({
        commandId: httpInput.commandId,
        projectId: host.projectId,
        body: httpInput.operation.body,
        ...(mode ? { dispatchMode: mode } : {}),
      });
      assert.equal(
        delivery(host, httpInput.commandId).request.activation.dispatch_mode,
        mode ?? "interrupt",
      );
    }
    const before = host.store.runtimeState();
    const origin = `http://127.0.0.1:${port}`;
    const invalid = await fetch(`${origin}/api/platform/messages`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Morphz-Token": client.boot.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...command(),
        operation: { ...operation(), dispatchMode: "follow_up" },
      }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(host.store.runtimeState(), before);
  } finally {
    embedded.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
  }
});

test("mode不扩大Human消息授权；foreign/Agent与改变补充范围均在outbox之前拒绝", async () => {
  const host = await platformRuntimeHostFixture();
  try {
    const before = host.store.runtimeState();
    for (const actor of [
      { principalId: "TEST-foreign", actantId: "TEST-foreign-human" },
      { principalId: "morphz-agent", actantId: "morphz-agent" },
    ])
      await assert.rejects(
        host.session(actor).platformMessage(command("interrupt")),
      );
    await assert.rejects(
      host.session().platformMessage({
        ...command("interrupt"),
        operation: {
          ...operation("interrupt"),
          continuation: {
            mode: "supplement",
            inputId: randomUUID(),
            threadId: "TEST-thread",
            generation: 1,
          },
        },
      }),
      /补充只能/,
    );
    assert.deepEqual(host.store.runtimeState(), before);
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
});
