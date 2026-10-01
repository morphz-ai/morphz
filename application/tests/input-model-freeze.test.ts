import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { workInputRequest } from "../packages/application/src/session-io.js";
import { localAccess, type RecordedInput } from "../packages/core/src/model.js";

type Ledger = {
  deliveries: {
    inputId: string;
    request: ReturnType<typeof workInputRequest>;
  }[];
};

test("new input freezes the live Runtime default; command retries keep the admitted model", async () => {
  let current = "sol";
  let statusCode = 200;
  let defaultReads = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/status") {
      defaultReads++;
      response.writeHead(statusCode);
      response.end(JSON.stringify({ model: current }));
    } else if (request.url === "/api/runtime/inference") {
      response.end(
        JSON.stringify({
          model: current,
          model_options: ["sol", "astra"].map((id) => ({ id, label: id })),
        }),
      );
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "isolated-model-test",
    namespace: randomUUID(),
  });
  const command = (model?: string) => ({
    commandId: randomUUID(),
    operation: {
      type: "record-input" as const,
      projectId: fixture.projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "隔离默认模型验证",
      targetActantId: "morphz-agent",
      ...(model ? { model } : {}),
    },
  });
  const ledger = () => fixture.store.runtimeState() as Ledger;
  const requestFor = (id: string) =>
    ledger().deliveries.find((item) => item.inputId === id)!.request;
  try {
    const first = command();
    await fixture.session().platformMessage(first);
    assert.equal(requestFor(first.commandId).activation.model_alias, "sol");
    const original = structuredClone(requestFor(first.commandId));
    const readsAtAdmission = defaultReads;

    current = "astra";
    await fixture.session().platformMessage(first);
    assert.equal(defaultReads, readsAtAdmission);
    assert.deepEqual(requestFor(first.commandId), original);
    const second = command();
    await fixture.session().platformMessage(second);
    assert.equal(requestFor(second.commandId).activation.model_alias, "astra");

    const explicit = command("sol");
    statusCode = 503;
    const readsBeforeExplicit = defaultReads;
    await fixture.session().platformMessage(explicit);
    assert.equal(defaultReads, readsBeforeExplicit);
    assert.equal(requestFor(explicit.commandId).activation.model_alias, "sol");
    await assert.rejects(
      fixture.session().platformMessage({
        ...first,
        operation: { ...first.operation, model: "astra" },
      }),
      /操作标识已用于另一条输入/,
    );
    assert.deepEqual(requestFor(first.commandId), original);

    await fixture.reopen();
    const readsBeforeRetry = defaultReads;
    await fixture.session().platformMessage(first);
    assert.equal(defaultReads, readsBeforeRetry);
    assert.deepEqual(requestFor(first.commandId), original);

    const beforeFailure = fixture.store.runtimeState();
    await assert.rejects(fixture.session().platformMessage(command()));
    assert.deepEqual(fixture.store.runtimeState(), beforeFailure);
    statusCode = 200;
    current = "";
    await assert.rejects(
      fixture.session().platformMessage(command()),
      /无法确认默认模型.*草稿已保留/,
    );
    assert.deepEqual(fixture.store.runtimeState(), beforeFailure);
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a retained request without a model alias retries unchanged", async () => {
  // Seed a pre-fix envelope in an isolated Host ledger. Its unavailable Runtime
  // makes any accidental attempt to acquire today's default fail this retry.
  const fixture = await platformRuntimeHostFixture();
  try {
    const input: RecordedInput = {
      id: randomUUID(),
      projectId: fixture.projectId,
      conversationId: fixture.projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "已保存的隔离请求",
      author: localAccess,
      targetActantId: "morphz-agent",
      status: "recorded",
      model: "sol",
      createdAt: new Date().toISOString(),
    };
    await fixture.runtime.as(localAccess, () =>
      fixture.runtime.enqueuePlatformInput(input),
    );
    const state = fixture.store.runtimeState() as Ledger;
    delete state.deliveries[0]!.request.activation.model_alias;
    fixture.store.saveRuntimeState(state);
    await fixture.reopen();
    const previous = fixture.store.runtimeState();
    delete input.model;
    await fixture.runtime.as(localAccess, () =>
      fixture.runtime.enqueuePlatformInput(input),
    );
    assert.deepEqual(fixture.store.runtimeState(), previous);
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});

test("concurrent command admission keeps the first frozen default and one delivery", async () => {
  const responses: ServerResponse[] = [];
  let bothRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    bothRequested = resolve;
  });
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/status");
    response.setHeader("Content-Type", "application/json");
    responses.push(response);
    if (responses.length === 2) bothRequested();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "isolated-concurrent-model-test",
    namespace: randomUUID(),
  });
  try {
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "record-input" as const,
        projectId: fixture.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "同一原始输入",
        targetActantId: "morphz-agent",
      },
    };
    const first = fixture.session().platformMessage(command);
    const second = fixture.session().platformMessage(command);
    await requested;
    responses[0]!.end(JSON.stringify({ model: "sol" }));
    const receipt = await Promise.race([first, second]);
    responses[1]!.end(JSON.stringify({ model: "astra" }));
    assert.deepEqual(await Promise.all([first, second]), [receipt, receipt]);
    const ledger = fixture.store.runtimeState() as Ledger;
    assert.equal(ledger.deliveries.length, 1);
    assert.equal(ledger.deliveries[0]!.request.activation.model_alias, "sol");
    await fixture.reopen();
    assert.deepEqual(fixture.store.runtimeState(), ledger);
  } finally {
    for (const response of responses)
      if (!response.writableEnded) response.end();
    await fixture.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("supplement activation never acquires a new model or reasoning override", () => {
  const input: RecordedInput = {
    id: randomUUID(),
    projectId: "isolated-project",
    conversationId: "isolated-project",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "补充当前工作",
    author: localAccess,
    targetActantId: "morphz-agent",
    status: "recorded",
    reasoningEffort: "high",
    continuation: {
      mode: "supplement",
      inputId: randomUUID(),
      threadId: "original-thread",
      generation: 1,
    },
    createdAt: new Date().toISOString(),
  };
  const request = JSON.parse(JSON.stringify(workInputRequest(input, "sol")));
  assert.deepEqual(request.activation, {
    mode: "evaluate",
    dispatch_mode: "parallel",
    input_destination: {
      kind: "thread",
      thread_id: "original-thread",
      generation: 1,
    },
  });
});
