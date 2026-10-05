/** UNIT: controlled Window and authority ports. This is not an actual iframe,
 * Host service, author server, Runtime or original-App acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cognitiveBrowserLimits,
  parseBrowserContext,
  parseBrowserMessage,
  type BrowserContext,
  type BrowserRequest,
} from "../packages/cognitive-app-sdk/src/browser-wire.js";
import {
  createCognitiveBrowserChannel,
  type CognitiveBrowserChannelPorts,
} from "../apps/web/src/host/cognitive-browser-channel.js";

const object = { objectId: "原件/😀", versionRef: "opaque/version:first" };
function context(): BrowserContext {
  return parseBrowserContext({
    definition: {
      format: "morphz-cognitive-app/v1",
      protocol: "morphz-domain/v1",
      id: "example.notes",
      version: "1.0.0",
      title: "Notes",
      description: "Controlled UNIT definition",
      icon: "document",
      harness: null,
      ui: { packageVersion: "1.0.0", sha256: "a".repeat(64) },
      operations: [
        {
          id: "read",
          title: "Read",
          description: "Read",
          effect: "read",
          scope: "project",
          inputSchema: { type: "null" },
          outputSchema: { type: "string" },
        },
        {
          id: "write",
          title: "Write",
          description: "Write",
          effect: "write",
          scope: "project",
          inputSchema: { type: "string" },
          outputSchema: { type: "string" },
        },
      ],
    },
    authority: {
      appId: "example.notes",
      version: "1.0.0",
      definitionHash: "b".repeat(64),
      instanceId: "instance",
      serviceId: "author/service",
      dataAuthorityId: "author/original",
    },
    view: {
      id: "view",
      revision: 1,
      bindingRevision: 1,
      active: true,
      state: { object },
    },
    ui: { compose: true },
    theme: { appearance: "dark", accent: "cyan" },
    presentation: { mode: "workspace", returnControl: null },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const write = (id = "original_command"): BrowserRequest => ({
  method: "invoke",
  operationId: "write",
  parameters: "body",
  resources: [],
  commandId: id,
});
function facts(commandId: string) {
  return {
    commandId,
    operationId: "write",
    effect: "write",
    state: "unknown",
    revision: 1,
    projectionState: "none",
    receiptRef: null,
    receiptHash: null,
    committedAt: null,
    objects: null,
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  };
}
function defaultResult(request: BrowserRequest, ctx: BrowserContext): unknown {
  switch (request.method) {
    case "ready":
      return ctx;
    case "invoke":
      return request.commandId === null
        ? {
            protocol: "morphz-domain/v1",
            authority: ctx.authority,
            operationId: request.operationId,
            result: "body",
          }
        : {
            kind: "command",
            commandId: request.commandId,
            command: facts(request.commandId),
          };
    case "readObject":
      return {
        protocol: "morphz-domain/v1",
        authority: ctx.authority,
        object: request.object,
        content: { format: "text", text: "private original" },
      };
    case "openObject":
      return { opened: true, object: request.object };
    case "compose":
      return { prepared: true };
    case "saveState":
      return { revision: request.expectedRevision + 1, state: request.state };
    case "commandStatus":
      return facts(request.commandId);
    case "recoverReceipt":
      return {
        kind: "command",
        commandId: request.commandId,
        command: facts(request.commandId),
      };
  }
}
async function fixture(
  overrides: Partial<Omit<CognitiveBrowserChannelPorts, "frame">> = {},
  ctx = context(),
) {
  const messages: ReturnType<typeof parseBrowserMessage>[] = [];
  const calls: BrowserRequest[] = [];
  const gates: BrowserContext[] = [];
  const frame = {
    postMessage(data: unknown, target: string) {
      assert.equal(target, "*");
      messages.push(parseBrowserMessage(data));
    },
  };
  const ports: CognitiveBrowserChannelPorts = {
    frame,
    current: () => true,
    authorize: async (scope) => {
      gates.push(structuredClone(scope));
    },
    request: async (request, scope) => {
      calls.push(request);
      return defaultResult(request, scope);
    },
    ...overrides,
  };
  const channel = createCognitiveBrowserChannel(ctx, ports);
  const send = (data: unknown, source: unknown = frame, origin = "null") =>
    channel.receive({ data, source, origin });
  // Author scripts may connect before the document's first load event.
  await send({ type: "morphz-cognitive-ui/v1:connect" });
  assert.equal(messages.length, 0);
  await channel.loaded();
  const init = messages.find((m) => m.type === "morphz-cognitive-ui/v1:init")!;
  assert.equal(init.type, "morphz-cognitive-ui/v1:init");
  if (init.type !== "morphz-cognitive-ui/v1:init")
    throw new Error("Expected initial context");
  const sendRequest = (
    request: unknown,
    requestId = crypto.randomUUID(),
    channelId = init.channel,
  ) =>
    send({
      type: "morphz-cognitive-ui/v1:request",
      channel: channelId,
      requestId,
      request,
    });
  return { channel, messages, calls, gates, frame, send, sendRequest, init };
}

test("UNIT channel: only the exact opaque frame can connect or call SDK8", async () => {
  const f = await fixture();
  const data = {
    type: "morphz-cognitive-ui/v1:request",
    channel: f.init.channel,
    requestId: crypto.randomUUID(),
    request: { method: "ready" },
  };
  let getter = 0;
  const hostile = Object.defineProperty({}, "type", {
    get() {
      getter++;
      throw new Error("secret");
    },
    enumerable: true,
  });
  await f.send(hostile, {}, "null");
  await f.send(data, f.frame, "https://attacker.invalid");
  await f.sendRequest(
    { method: "ready" },
    crypto.randomUUID(),
    crypto.randomUUID(),
  );
  await f.send(hostile);
  assert.equal(getter, 0);
  assert.equal(f.calls.length, 0);
  await f.sendRequest({ method: "ready" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:response");
  f.channel.retire();
});

test("UNIT channel: requests snapshot before authority awaits and errors retain only the original write ID", async () => {
  const held = deferred<void>();
  const started = deferred<void>();
  const received: BrowserRequest[] = [];
  let gateCount = 0;
  const f = await fixture({
    authorize: async () => {
      if (++gateCount === 2) {
        started.resolve();
        await held.promise;
      }
    },
    request: async (request) => {
      received.push(request);
      throw {
        code: "conflict",
        commandId: "forged",
        message: "credential/private-URL/body",
      };
    },
  });
  const original = write();
  const run = f.sendRequest(original);
  await started.promise;
  Object.assign(original, { parameters: "changed", commandId: "changed" });
  held.resolve();
  await run;
  assert.equal(received.length, 1);
  assert.equal(received[0]!.method, "invoke");
  assert.deepEqual(received[0], write());
  const result = f.messages.at(-1)!;
  assert.equal(result.type, "morphz-cognitive-ui/v1:response");
  if (result.type !== "morphz-cognitive-ui/v1:response" || result.ok)
    throw new Error("Expected failure");
  assert.deepEqual(result.error, {
    code: "conflict",
    commandId: "original_command",
  });
  assert.doesNotMatch(
    JSON.stringify(f.messages),
    /credential|forged|private-URL/,
  );
  f.channel.retire();
});

test("UNIT channel: inactive or compose-disabled contexts never dispatch commands", async () => {
  for (const active of [false, true]) {
    const ctx = context();
    const f = await fixture(
      {},
      { ...ctx, view: { ...ctx.view, active }, ui: { compose: false } },
    );
    await f.sendRequest(
      active ? { method: "compose", text: "draft", object } : write(),
    );
    assert.equal(f.calls.length, 0);
    const last = f.messages.at(-1)!;
    if (last.type !== "morphz-cognitive-ui/v1:response" || last.ok)
      throw new Error("Expected failure");
    assert.equal(last.error.code, "forbidden");
    f.channel.retire();
  }
});

test("UNIT channel: invalid operation/read command combinations keep the original ID without dispatch", async () => {
  const f = await fixture();
  await f.sendRequest({ ...write(), operationId: "absent" });
  await f.sendRequest({ ...write(), operationId: "read", parameters: null });
  assert.equal(f.calls.length, 0);
  for (const value of f.messages.slice(1)) {
    if (value.type !== "morphz-cognitive-ui/v1:response" || value.ok)
      throw new Error("Expected invalid response");
    assert.deepEqual(value.error, {
      code: "invalid",
      commandId: "original_command",
    });
  }
  f.channel.retire();
});

test("UNIT channel: private results are not disclosed if the post-read current authority gate rejects", async () => {
  let gateCount = 0;
  const f = await fixture({
    authorize: async () => {
      if (++gateCount === 3) throw { code: "forbidden" };
    },
  });
  await f.sendRequest({
    method: "invoke",
    operationId: "read",
    commandId: null,
    parameters: null,
    resources: [],
  });
  assert.equal(f.calls.length, 1);
  const value = f.messages.at(-1)!;
  if (value.type !== "morphz-cognitive-ui/v1:response" || value.ok)
    throw new Error("Expected failure");
  assert.deepEqual(value.error, { code: "forbidden" });
  assert.doesNotMatch(JSON.stringify(value), /body/);
  f.channel.retire();
});

test("UNIT channel: rebind, session retirement and second document load reject late results", async () => {
  for (const change of ["rebind", "session", "document"] as const) {
    const held = deferred<unknown>();
    const entered = deferred<void>();
    let current = true;
    const f = await fixture({
      current: () => current,
      request: async () => {
        entered.resolve();
        return held.promise;
      },
    });
    const run = f.sendRequest(write());
    await entered.promise;
    if (change === "rebind")
      await f.channel.updateContext({
        ...context(),
        view: { ...context().view, bindingRevision: 2 },
      });
    else if (change === "session") {
      current = false;
      await f.send({ type: "morphz-cognitive-ui/v1:connect" });
    } else await f.channel.loaded();
    held.resolve(defaultResult(write(), context()));
    await run;
    const responses = f.messages.filter(
      (m) => m.type === "morphz-cognitive-ui/v1:response",
    );
    assert.equal(responses.length, 1);
    if (
      responses[0]!.type !== "morphz-cognitive-ui/v1:response" ||
      responses[0]!.ok
    )
      throw new Error("Expected retirement");
    assert.deepEqual(responses[0]!.error, {
      code: "unavailable",
      commandId: "original_command",
    });
    assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
    const before = f.messages.length;
    await f.sendRequest(write("new_command"));
    assert.equal(f.messages.length, before);
  }
});

test("UNIT channel: hiding cancels old operations; foreground can resume only with a new current gate", async () => {
  const held = deferred<unknown>();
  const entered = deferred<void>();
  const f = await fixture({
    request: async () => {
      entered.resolve();
      return held.promise;
    },
  });
  const run = f.sendRequest(write());
  await entered.promise;
  await f.channel.updateContext({
    ...context(),
    view: { ...context().view, active: false },
  });
  held.resolve(defaultResult(write(), context()));
  await run;
  await f.channel.updateContext(context());
  assert.equal(
    f.messages.filter(
      (m) => m.type === "morphz-cognitive-ui/v1:response" && m.ok,
    ).length,
    0,
  );
  const denied = f.messages.find(
    (m) => m.type === "morphz-cognitive-ui/v1:response",
  )!;
  if (denied.type !== "morphz-cognitive-ui/v1:response" || denied.ok)
    throw new Error("Expected denial");
  assert.equal(denied.error.code, "forbidden");
  f.channel.retire();
});

test("UNIT channel: pending is exactly bounded, duplicate pending IDs do not dispatch twice, no automatic retry", async () => {
  const held = deferred<unknown>();
  const signals: AbortSignal[] = [];
  let count = 0;
  const f = await fixture({
    request: async (_request, _ctx, signal) => {
      count++;
      signals.push(signal);
      return held.promise;
    },
  });
  const firstId = crypto.randomUUID();
  const runs = [f.sendRequest(write("command_0"), firstId)];
  await Promise.resolve();
  await f.sendRequest(write("forged_duplicate"), firstId);
  for (let index = 1; index < cognitiveBrowserLimits.pending; index++)
    runs.push(f.sendRequest(write(`command_${index}`)));
  await f.sendRequest(write("seventeenth"));
  assert.equal(count, 16);
  const last = f.messages.at(-1)!;
  if (last.type !== "morphz-cognitive-ui/v1:response" || last.ok)
    throw new Error("Expected busy");
  assert.deepEqual(last.error, { code: "busy", commandId: "seventeenth" });
  f.channel.retire();
  held.resolve(undefined);
  await Promise.all(runs);
  assert.equal(count, 16);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("UNIT channel: 30-second expiry retires the document and preserves uncertain write IDs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = deferred<unknown>();
  const entered = deferred<void>();
  let signal: AbortSignal | undefined;
  const f = await fixture({
    request: async (_request, _ctx, abort) => {
      signal = abort;
      entered.resolve();
      return held.promise;
    },
  });
  const run = f.sendRequest(write());
  await entered.promise;
  t.mock.timers.tick(cognitiveBrowserLimits.deadlineMs - 1);
  assert.equal(
    f.messages.filter((m) => m.type === "morphz-cognitive-ui/v1:response")
      .length,
    0,
  );
  t.mock.timers.tick(1);
  assert.equal(signal!.aborted, true);
  const value = f.messages.find(
    (m) => m.type === "morphz-cognitive-ui/v1:response",
  )!;
  if (value.type !== "morphz-cognitive-ui/v1:response" || value.ok)
    throw new Error("Expected expiry");
  assert.deepEqual(value.error, {
    code: "unavailable",
    commandId: "original_command",
  });
  held.resolve(defaultResult(write(), context()));
  await run;
  assert.equal(
    f.messages.filter((m) => m.type === "morphz-cognitive-ui/v1:response")
      .length,
    1,
  );
});

test("UNIT channel: result-schema mismatch and exotic errors never expose private values or forged IDs", async () => {
  let errorReads = 0;
  const exotic = Object.defineProperty({}, "code", {
    get() {
      errorReads++;
      return "forbidden";
    },
  });
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE-FAILURE");
      },
    },
  );
  for (const raw of [
    { kind: "command", commandId: "forged", command: facts("forged") },
    exotic,
    proxy,
  ]) {
    const f = await fixture({
      request: async () => {
        if (raw === exotic || raw === proxy) throw raw;
        return raw;
      },
    });
    await f.sendRequest(write());
    const value = f.messages.at(-1)!;
    if (value.type !== "morphz-cognitive-ui/v1:response" || value.ok)
      throw new Error("Expected contract/error");
    assert.deepEqual(value.error, {
      code: raw === exotic || raw === proxy ? "unavailable" : "contract",
      commandId: "original_command",
    });
    f.channel.retire();
  }
  assert.equal(errorReads, 0);
});

test("UNIT channel: saved navigation keeps its exact opaque CAS and updates context after the final gate", async () => {
  const f = await fixture();
  const state = {
    object: { objectId: object.objectId, versionRef: "opaque/version:second" },
    view: "reader",
  };
  await f.sendRequest({ method: "saveState", expectedRevision: 1, state });
  const response = f.messages.find(
    (m) => m.type === "morphz-cognitive-ui/v1:response",
  )!;
  if (response.type !== "morphz-cognitive-ui/v1:response" || !response.ok)
    throw new Error("Expected exact save");
  assert.deepEqual(response.result, { revision: 2, state });
  assert.equal(f.gates.at(-1)!.view.revision, 2);
  assert.deepEqual(f.gates.at(-1)!.view.state, state);
  const next = f.messages.at(-1)!;
  if (next.type !== "morphz-cognitive-ui/v1:init")
    throw new Error("Expected updated same binding context");
  assert.equal(next.context.view.revision, 2);
  assert.deepEqual(next.context.view.state, state);
  assert.equal(next.channel, f.init.channel);
  f.channel.retire();
});

test("UNIT channel: an external revision change cancels the original operation rather than acknowledging latest", async () => {
  const held = deferred<unknown>();
  const entered = deferred<void>();
  const f = await fixture({
    request: async () => {
      entered.resolve();
      return held.promise;
    },
  });
  const run = f.sendRequest(write());
  await entered.promise;
  await f.channel.updateContext({
    ...context(),
    view: { ...context().view, revision: 2, state: { view: "other" } },
  });
  held.resolve(defaultResult(write(), context()));
  await run;
  const value = f.messages.find(
    (m) => m.type === "morphz-cognitive-ui/v1:response",
  )!;
  if (value.type !== "morphz-cognitive-ui/v1:response" || value.ok)
    throw new Error("Expected conflict");
  assert.deepEqual(value.error, {
    code: "conflict",
    commandId: "original_command",
  });
  f.channel.retire();
});

test("UNIT channel: initialization publishes only its authorized snapshot after a concurrent context update", async () => {
  const held = deferred<void>();
  const entered = deferred<void>();
  const authorized: BrowserContext[] = [];
  const messages: ReturnType<typeof parseBrowserMessage>[] = [];
  const frame = {
    postMessage(data: unknown) {
      messages.push(parseBrowserMessage(data));
    },
  };
  let count = 0;
  const channel = createCognitiveBrowserChannel(context(), {
    frame,
    current: () => true,
    authorize: async (scope) => {
      authorized.push(structuredClone(scope));
      if (++count === 1) {
        entered.resolve();
        await held.promise;
      }
    },
    request: async (request, scope) => defaultResult(request, scope),
  });
  await channel.receive({
    source: frame,
    origin: "null",
    data: { type: "morphz-cognitive-ui/v1:connect" },
  });
  const loading = channel.loaded();
  await entered.promise;
  const next = {
    ...context(),
    view: { ...context().view, revision: 2, state: { view: "new" } },
  };
  const updating = channel.updateContext(next);
  assert.equal(messages.length, 0);
  held.resolve();
  await Promise.all([loading, updating]);
  assert.deepEqual(
    authorized.map((value) => value.view.revision),
    [1, 2],
  );
  const init = messages[0]!;
  if (init.type !== "morphz-cognitive-ui/v1:init")
    throw new Error("Expected authorized new snapshot");
  assert.deepEqual(init.context.view, next.view);
  assert.equal(messages.length, 1);
  channel.retire();
});

test("UNIT channel: initialization shares the fixed deadline and cannot publish after expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = deferred<void>();
  const entered = deferred<void>();
  const messages: unknown[] = [];
  const frame = {
    postMessage(data: unknown) {
      messages.push(data);
    },
  };
  let signal: AbortSignal | undefined;
  const channel = createCognitiveBrowserChannel(context(), {
    frame,
    current: () => true,
    authorize: async (_scope, abort) => {
      signal = abort;
      entered.resolve();
      await held.promise;
    },
    request: async (request, scope) => defaultResult(request, scope),
  });
  await channel.receive({
    source: frame,
    origin: "null",
    data: { type: "morphz-cognitive-ui/v1:connect" },
  });
  const loading = channel.loaded();
  await entered.promise;
  t.mock.timers.tick(cognitiveBrowserLimits.deadlineMs);
  assert.equal(signal!.aborted, true);
  held.resolve();
  await loading;
  assert.equal(messages.length, 0);
  await channel.receive({
    source: frame,
    origin: "null",
    data: { type: "morphz-cognitive-ui/v1:connect" },
  });
  assert.equal(messages.length, 0);
});

test("UNIT channel: a successful own save cancels other old-revision operations without pretending rollback", async () => {
  const held = deferred<unknown>();
  const entered = deferred<void>();
  const f = await fixture({
    request: async (request, scope) => {
      if (request.method === "invoke") {
        entered.resolve();
        return held.promise;
      }
      return defaultResult(request, scope);
    },
  });
  const original = f.sendRequest(write());
  await entered.promise;
  await f.sendRequest({
    method: "saveState",
    expectedRevision: 1,
    state: { view: "next" },
  });
  held.resolve(defaultResult(write(), context()));
  await original;
  const responses = f.messages.filter(
    (message) => message.type === "morphz-cognitive-ui/v1:response",
  );
  assert.equal(responses.length, 2);
  const denied = responses.find(
    (message) =>
      message.type === "morphz-cognitive-ui/v1:response" && !message.ok,
  )!;
  if (denied.type !== "morphz-cognitive-ui/v1:response" || denied.ok)
    throw new Error("Expected old-revision cancellation");
  assert.deepEqual(denied.error, {
    code: "conflict",
    commandId: "original_command",
  });
  assert.equal(
    responses.filter(
      (message) =>
        message.type === "morphz-cognitive-ui/v1:response" && message.ok,
    ).length,
    1,
  );
  f.channel.retire();
});

test("UNIT channel: monotonic expiry rejects resolved operations before a delayed timer task can run", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = await fixture({
    request: async (request, scope) => {
      now += cognitiveBrowserLimits.deadlineMs;
      return defaultResult(request, scope);
    },
  });
  await f.sendRequest(write());
  const value = f.messages.find(
    (message) => message.type === "morphz-cognitive-ui/v1:response",
  )!;
  if (value.type !== "morphz-cognitive-ui/v1:response" || value.ok)
    throw new Error("Expected monotonic expiry");
  assert.deepEqual(value.error, {
    code: "unavailable",
    commandId: "original_command",
  });
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
});

test("UNIT channel: late resolved initialization cannot beat its monotonic deadline", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const messages: unknown[] = [];
  const frame = {
    postMessage(value: unknown) {
      messages.push(value);
    },
  };
  const channel = createCognitiveBrowserChannel(context(), {
    frame,
    current: () => true,
    authorize: async () => {
      now += cognitiveBrowserLimits.deadlineMs;
    },
    request: async (request, scope) => defaultResult(request, scope),
  });
  await channel.receive({
    source: frame,
    origin: "null",
    data: { type: "morphz-cognitive-ui/v1:connect" },
  });
  await channel.loaded();
  assert.equal(messages.length, 0);
});

test("UNIT channel: a failing current-state port retires safely without publishing its private cause", async () => {
  let fail = false;
  const f = await fixture({
    current: () => {
      if (fail) throw new Error("PRIVATE-CURRENT-CAUSE");
      return true;
    },
  });
  fail = true;
  await f.sendRequest(write());
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
  assert.doesNotMatch(JSON.stringify(f.messages), /PRIVATE-CURRENT-CAUSE/);
});

test("UNIT channel: semantically equal presentation does not reauthorize or republish a warm Document", async (t) => {
  const f = await fixture();
  t.after(() => f.channel.retire());
  const gates = f.gates.length;
  const messages = f.messages.length;
  const value = context();
  for (let index = 0; index < 3; index++)
    await f.channel.updatePresentation({
      theme: structuredClone(value.theme),
      presentation: structuredClone(value.presentation),
      active: value.view.active,
    });
  assert.equal(f.gates.length, gates);
  assert.equal(f.messages.length, messages);
});

for (const phase of ["mutation", "final-gate"] as const)
  test(`UNIT channel: latest presentation coalesces during held save ${phase}, then merges its exact acknowledged CAS`, async (t) => {
    const held = deferred<void>();
    const entered = deferred<void>();
    const authorized: number[] = [];
    let actualRevision = 1;
    let saves = 0;
    const state = { view: "remember", object };
    const f = await fixture({
      authorize: async (scope) => {
        authorized.push(scope.view.revision);
        if (phase === "final-gate" && scope.view.revision === 2) {
          entered.resolve();
          await held.promise;
        }
        if (scope.view.revision !== actualRevision) throw { code: "conflict" };
      },
      request: async (request, scope) => {
        assert.equal(request.method, "saveState");
        saves++;
        actualRevision = 2;
        if (phase === "mutation") {
          entered.resolve();
          await held.promise;
        }
        return defaultResult(request, scope);
      },
    });
    t.after(() => {
      held.resolve();
      f.channel.retire();
    });
    const saveId = crypto.randomUUID();
    const saving = f.sendRequest(
      { method: "saveState", expectedRevision: 1, state },
      saveId,
    );
    await entered.promise;
    const before = authorized.length;
    const coral = f.channel.updatePresentation({
      theme: { appearance: "light", accent: "coral" },
      presentation: context().presentation,
      active: true,
    });
    const iris = f.channel.updatePresentation({
      theme: { appearance: "light", accent: "iris" },
      presentation: context().presentation,
      active: true,
    });
    // The controlled store has already committed CAS2. No stale CAS1 read may
    // race the own-save result, even when a real theme update is requested.
    assert.equal(authorized.length, before);
    assert.equal(
      f.messages.some((m) => m.type === "morphz-cognitive-ui/v1:retire"),
      false,
    );
    held.resolve();
    await Promise.all([saving, coral, iris]);
    const response = f.messages.find(
      (m) =>
        m.type === "morphz-cognitive-ui/v1:response" && m.requestId === saveId,
    );
    assert.ok(response);
    if (response.type !== "morphz-cognitive-ui/v1:response" || !response.ok)
      throw new Error("Expected the original save's exact acknowledged result");
    assert.deepEqual(response.result, { revision: 2, state });
    const init = f.messages.at(-1)!;
    if (init.type !== "morphz-cognitive-ui/v1:init")
      throw new Error("Expected the same warm Document's presentation");
    assert.equal(init.channel, f.init.channel);
    assert.equal(init.context.view.revision, 2);
    assert.deepEqual(init.context.view.state, state);
    assert.deepEqual(init.context.theme, {
      appearance: "light",
      accent: "iris",
    });
    assert.deepEqual(authorized, [1, 1, 2, 2]);
    assert.equal(saves, 1);
    assert.equal(
      f.messages.some((m) => m.type === "morphz-cognitive-ui/v1:retire"),
      false,
    );
  });

test("UNIT channel: a save waits for already-inflight initialization rather than committing under its old CAS authorization", async (t) => {
  const held = deferred<void>();
  const entered = deferred<void>();
  const authorized: number[] = [];
  let actualRevision = 1;
  let gates = 0;
  let saves = 0;
  const f = await fixture({
    authorize: async (scope) => {
      authorized.push(scope.view.revision);
      if (++gates === 2) {
        entered.resolve();
        await held.promise;
      }
      if (scope.view.revision !== actualRevision) throw { code: "conflict" };
    },
    request: async (request, scope) => {
      assert.equal(request.method, "saveState");
      saves++;
      actualRevision = 2;
      return defaultResult(request, scope);
    },
  });
  t.after(() => {
    held.resolve();
    f.channel.retire();
  });
  const presenting = f.channel.updatePresentation({
    theme: { appearance: "light", accent: "coral" },
    presentation: context().presentation,
    active: true,
  });
  await entered.promise;
  const saveId = crypto.randomUUID();
  const saving = f.sendRequest(
    { method: "saveState", expectedRevision: 1, state: { view: "after" } },
    saveId,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(saves, 0, "The earlier exact-CAS gate must settle first");
  held.resolve();
  await Promise.all([presenting, saving]);
  assert.equal(saves, 1);
  const response = f.messages.find(
    (m) =>
      m.type === "morphz-cognitive-ui/v1:response" && m.requestId === saveId,
  );
  assert.ok(response);
  assert.equal(response.type, "morphz-cognitive-ui/v1:response");
  if (response.type !== "morphz-cognitive-ui/v1:response")
    throw new Error("Expected original save response");
  assert.equal(response.ok, true);
  assert.deepEqual(authorized, [1, 1, 1, 2]);
  assert.equal(
    f.messages.some((m) => m.type === "morphz-cognitive-ui/v1:retire"),
    false,
  );
});

test("UNIT channel: equal presentation still checks the real owner and rejects hostile own-data without invoking accessors", async () => {
  let getterReads = 0;
  for (const failure of ["accessor", "unknown", "owner"] as const) {
    let live = true;
    const f = await fixture({ current: () => live });
    const value = context();
    const projection = {
      theme: value.theme,
      presentation: value.presentation,
      active: true,
    };
    const raw =
      failure === "accessor"
        ? Object.defineProperty({ ...projection }, "active", {
            enumerable: true,
            get() {
              getterReads++;
              return true;
            },
          })
        : failure === "unknown"
          ? { ...projection, actor: "forged" }
          : projection;
    if (failure === "owner") live = false;
    await f.channel.updatePresentation(raw);
    assert.equal(f.gates.length, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
  }
  assert.equal(getterReads, 0);
});

test("UNIT channel: latest coalesced presentation may revert to the original theme without an extra CAS gate", async (t) => {
  const entered = deferred<void>();
  const held = deferred<void>();
  const f = await fixture({
    request: async (request, scope) => {
      entered.resolve();
      await held.promise;
      return defaultResult(request, scope);
    },
  });
  t.after(() => {
    held.resolve();
    f.channel.retire();
  });
  const saving = f.sendRequest({
    method: "saveState",
    expectedRevision: 1,
    state: { view: "remember" },
  });
  await entered.promise;
  await f.channel.updatePresentation({
    theme: { appearance: "light", accent: "coral" },
    presentation: context().presentation,
    active: true,
  });
  await f.channel.updatePresentation({
    theme: context().theme,
    presentation: context().presentation,
    active: true,
  });
  assert.equal(f.gates.length, 2);
  held.resolve();
  await saving;
  assert.deepEqual(
    f.gates.map((gate) => gate.view.revision),
    [1, 1, 2],
  );
  const init = f.messages.at(-1)!;
  if (init.type !== "morphz-cognitive-ui/v1:init")
    throw new Error("Expected actual acknowledged context");
  assert.equal(init.context.view.revision, 2);
  assert.deepEqual(init.context.theme, context().theme);
});

test("UNIT channel: visibility cancels a held save immediately; buffered UI cannot invent its unknown CAS or send a replacement", async (t) => {
  const entered = deferred<void>();
  const held = deferred<void>();
  let mutations = 0;
  const f = await fixture({
    request: async (request, scope) => {
      mutations++;
      entered.resolve();
      await held.promise;
      return defaultResult(request, scope);
    },
  });
  t.after(() => {
    held.resolve();
    f.channel.retire();
  });
  const saveId = crypto.randomUUID();
  const saving = f.sendRequest(
    { method: "saveState", expectedRevision: 1, state: { view: "held" } },
    saveId,
  );
  await entered.promise;
  await f.channel.updatePresentation({
    theme: { appearance: "light", accent: "iris" },
    presentation: context().presentation,
    active: false,
  });
  const denied = f.messages.find(
    (m) =>
      m.type === "morphz-cognitive-ui/v1:response" && m.requestId === saveId,
  );
  if (!denied || denied.type !== "morphz-cognitive-ui/v1:response" || denied.ok)
    throw new Error("Expected synchronous visibility cancellation");
  assert.deepEqual(denied.error, { code: "forbidden" });
  await f.sendRequest(write());
  assert.equal(mutations, 1);
  assert.deepEqual(
    f.gates.map((gate) => gate.view.revision),
    [1, 1],
  );
  held.resolve();
  await saving;
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
  assert.equal(
    f.messages.filter((m) => m.type === "morphz-cognitive-ui/v1:init").length,
    1,
    "No unconfirmed state, theme or foreground authority was published",
  );
});

test("UNIT channel: unknown save discards its coalesced projection and retires without retrying the mutation or guessing latest", async (t) => {
  const entered = deferred<void>();
  const held = deferred<void>();
  let mutations = 0;
  const f = await fixture({
    request: async () => {
      mutations++;
      entered.resolve();
      await held.promise;
      // A controlled lost reply, not evidence that the store did not commit.
      throw { code: "unavailable" };
    },
  });
  t.after(() => {
    held.resolve();
    f.channel.retire();
  });
  const saveId = crypto.randomUUID();
  const saving = f.sendRequest(
    { method: "saveState", expectedRevision: 1, state: { view: "unknown" } },
    saveId,
  );
  await entered.promise;
  await f.channel.updatePresentation({
    theme: { appearance: "light", accent: "coral" },
    presentation: context().presentation,
    active: true,
  });
  held.resolve();
  await saving;
  const result = f.messages.find(
    (m) =>
      m.type === "morphz-cognitive-ui/v1:response" && m.requestId === saveId,
  );
  if (!result || result.type !== "morphz-cognitive-ui/v1:response" || result.ok)
    throw new Error("Expected the original uncertain save error");
  assert.deepEqual(result.error, { code: "unavailable" });
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
  assert.deepEqual(
    f.gates.map((gate) => gate.view.revision),
    [1, 1],
  );
  assert.equal(mutations, 1);
});

test("UNIT channel: buffered presentation does not extend a visibility-cancelled save's original 30-second deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred<void>();
  const held = deferred<void>();
  const f = await fixture({
    request: async (request, scope) => {
      entered.resolve();
      await held.promise;
      return defaultResult(request, scope);
    },
  });
  t.after(() => {
    held.resolve();
    f.channel.retire();
  });
  const saving = f.sendRequest({
    method: "saveState",
    expectedRevision: 1,
    state: { view: "held" },
  });
  await entered.promise;
  await f.channel.updatePresentation({
    theme: context().theme,
    presentation: context().presentation,
    active: false,
  });
  t.mock.timers.tick(cognitiveBrowserLimits.deadlineMs - 1);
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:response");
  t.mock.timers.tick(1);
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
  held.resolve();
  await saving;
  assert.equal(
    f.messages.filter((m) => m.type === "morphz-cognitive-ui/v1:retire").length,
    1,
  );
});

test("UNIT channel: cancelled but unsettled saves still occupy the original bounded request window", async (t) => {
  const held = deferred<void>();
  const signals: AbortSignal[] = [];
  let mutations = 0;
  const f = await fixture({
    request: async (request, scope, signal) => {
      mutations++;
      signals.push(signal);
      await held.promise;
      return defaultResult(request, scope);
    },
  });
  t.after(() => {
    held.resolve();
    f.channel.retire();
  });
  const runs = Array.from({ length: cognitiveBrowserLimits.pending }, () =>
    f.sendRequest({
      method: "saveState",
      expectedRevision: 1,
      state: { view: "held" },
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mutations, cognitiveBrowserLimits.pending);
  const projection = {
    theme: context().theme,
    presentation: context().presentation,
  };
  await f.channel.updatePresentation({ ...projection, active: false });
  assert.ok(signals.every((signal) => signal.aborted));
  await f.channel.updatePresentation({ ...projection, active: true });
  await f.sendRequest({ method: "ready" });
  const busy = f.messages.at(-1)!;
  if (busy.type !== "morphz-cognitive-ui/v1:response" || busy.ok)
    throw new Error("Expected bounded occupied save capacity");
  assert.deepEqual(busy.error, { code: "busy" });
  assert.equal(mutations, cognitiveBrowserLimits.pending);
  held.resolve();
  await Promise.all(runs);
  assert.equal(f.messages.at(-1)!.type, "morphz-cognitive-ui/v1:retire");
});
