import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBrowserContext,
  parseBrowserMessage,
  type BrowserRequest,
} from "../packages/cognitive-app-sdk/src/browser-wire.js";
import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../packages/core/src/cognitive-app-view-api.js";
import {
  createCognitiveBrowserRouter,
  type CognitiveBrowserRouterPorts,
} from "../apps/web/src/host/cognitive-browser-router.js";
import { createCognitiveBrowserChannel } from "../apps/web/src/host/cognitive-browser-channel.js";
import { viewSubmission } from "./fixtures/cognitive-app-view-service-fixture.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

const object = { objectId: "原件/ 😀\n", versionRef: "opaque/00001:α" };
const presentation = {
  active: true,
  theme: { appearance: "dark", accent: "iris" },
  presentation: { mode: "workspace", returnControl: null },
} as const;
const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function source(): CognitiveAppViewUi {
  const { definition, manifest } = viewSubmission();
  definition.operations.push({
    ...definition.operations[0]!,
    id: "notes.create",
    effect: "write",
  });
  const now = "2026-10-05T00:00:00Z";
  return parseCognitiveAppViewResponse("readUi", {
    definition,
    manifest,
    authority: {
      appId: definition.id,
      version: definition.version,
      definitionHash: "a".repeat(64),
      instanceId: "instance",
      serviceId: "author/service",
      dataAuthorityId: "author/original",
    },
    view: {
      id: "view",
      workspaceId: "project",
      applicationId: definition.id,
      applicationVersion: definition.version,
      revision: 1,
      state: { object },
      status: "open",
      createdAt: now,
      updatedAt: now,
    },
    binding: {
      appId: definition.id,
      version: definition.version,
      instanceId: "instance",
      serviceId: "author/service",
      dataAuthorityId: "author/original",
      viewId: "view",
      projectId: "project",
      connectionId: "connection",
      revision: 1,
      viewRevision: 1,
      createdAt: now,
      updatedAt: now,
    },
    grantRevision: 1,
    connectionRevision: 1,
  });
}
function facts(commandId: string) {
  return {
    commandId,
    operationId: "notes.create",
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
/** UNIT business/owner ports. No author server or actual draft/navigation is
 * claimed by these tests. The later dual-SQL cases use actual view authority. */
function unit(initial = source()) {
  let current = structuredClone(initial);
  const calls: Array<{ method: string; parameters: Record<string, unknown> }> =
    [];
  const owners: Array<{ method: string; request: unknown }> = [];
  const control: {
    gate?: () => Promise<void>;
    business?: (
      method: string,
      parameters: Record<string, unknown>,
    ) => Promise<unknown>;
    open?: CognitiveBrowserRouterPorts["openObject"];
    compose?: CognitiveBrowserRouterPorts["compose"];
    save?: (parameters: Record<string, unknown>) => unknown;
  } = {};
  const ports: CognitiveBrowserRouterPorts = {
    async call(method, parameters, options) {
      assert.ok(options.signal);
      const params = parameters as Record<string, unknown>;
      calls.push({ method, parameters: structuredClone(params) });
      if (method === "cognitive-app-views.read-ui") {
        await control.gate?.();
        assert.equal(params.viewId, current.view.id);
        assert.equal(params.expectedViewRevision, current.view.revision);
        assert.equal(params.expectedBindingRevision, current.binding.revision);
        return structuredClone(current);
      }
      if (method === "cognitive-app-views.save") {
        if (control.save) return control.save(params);
        current = parseCognitiveAppViewResponse("readUi", {
          ...current,
          view: {
            ...current.view,
            revision: current.view.revision + 1,
            state: params.state,
          },
          binding: {
            ...current.binding,
            viewRevision: current.view.revision + 1,
          },
        });
        return {
          receipt: {
            viewId: current.view.id,
            viewRevision: current.view.revision,
            bindingRevision: current.binding.revision,
          },
          replayed: false,
        };
      }
      if (control.business) return control.business(method, params);
      if (method === "cognitive-apps.read-object")
        return {
          protocol: "morphz-domain/v1",
          authority: current.authority,
          object: params.object,
          kind: "document",
          title: "Original",
          content: { format: "text", text: "private original" },
        };
      if (method === "cognitive-apps.command-status")
        return facts(String(params.commandId));
      if (method === "cognitive-apps.recover" || params.commandId !== null)
        return {
          kind: "command",
          commandId: params.commandId,
          command: facts(String(params.commandId)),
        };
      return {
        protocol: "morphz-domain/v1",
        authority: current.authority,
        operationId: params.operationId,
        result: "private original",
      };
    },
    async openObject(request, abort) {
      owners.push({ method: "openObject", request: structuredClone(request) });
      return control.open
        ? control.open(request, abort)
        : { opened: true, object: request.object };
    },
    async compose(request, abort) {
      owners.push({ method: "compose", request: structuredClone(request) });
      return control.compose
        ? control.compose(request, abort)
        : { prepared: true };
    },
  };
  const router = createCognitiveBrowserRouter(initial, ports);
  return {
    router,
    context: router.context(presentation),
    calls,
    owners,
    control,
    current: () => current,
    change: (update: (previous: CognitiveAppViewUi) => CognitiveAppViewUi) => {
      current = update(current);
    },
  };
}
const write = (): BrowserRequest => ({
  method: "invoke",
  operationId: "notes.create",
  parameters: null,
  resources: [],
  commandId: "original_write",
});

test("UNIT router maps exactly eight SDK methods to fixed Human services and original owner ports", async () => {
  const f = unit();
  const requests: BrowserRequest[] = [
    { method: "ready" },
    {
      method: "invoke",
      operationId: "notes.list",
      parameters: null,
      resources: [],
      commandId: null,
    },
    write(),
    { method: "readObject", object, maxBytes: 1024 },
    { method: "openObject", object },
    { method: "compose", text: "未发送的要求", object },
    { method: "commandStatus", commandId: "original_write" },
    { method: "recoverReceipt", commandId: "original_write" },
    {
      method: "saveState",
      expectedRevision: 1,
      state: { object, view: "reader" },
    },
  ];
  for (const request of requests)
    await f.router.request(request, f.context, signal());
  const business = f.calls.filter(
    ({ method }) => !method.startsWith("cognitive-app-views."),
  );
  assert.deepEqual(
    business.map(({ method }) => method),
    [
      "cognitive-apps.invoke",
      "cognitive-apps.invoke",
      "cognitive-apps.read-object",
      "cognitive-apps.command-status",
      "cognitive-apps.recover",
    ],
  );
  for (const { parameters } of business) {
    assert.equal(parameters.projectId, "project");
    assert.equal(parameters.appId, "example.notes");
    assert.equal(parameters.version, "1.0.0");
    assert.equal(parameters.connectionId, "connection");
    assert.equal(parameters.expectedDefinitionHash, "a".repeat(64));
    assert.equal("method" in parameters, false);
    assert.equal("actor" in parameters, false);
  }
  assert.equal(business[0]!.parameters.commandId, null);
  assert.equal(business[1]!.parameters.commandId, "original_write");
  assert.equal(business[3]!.parameters.commandId, "original_write");
  assert.equal(business[4]!.parameters.commandId, "original_write");
  assert.equal("expectedGrantRevision" in business[3]!.parameters, false);
  assert.deepEqual(
    f.owners.map(({ method }) => method),
    ["openObject", "compose"],
  );
  const save = f.calls.filter(
    ({ method }) => method === "cognitive-app-views.save",
  );
  assert.equal(save.length, 1);
  assert.match(String(save[0]!.parameters.commandId), /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.current().view.state.object, object);
});

test("UNIT router fixes authority before await and never changes opaque request refs", async () => {
  const initial = source(),
    f = unit(initial),
    wait = deferred();
  f.control.gate = () => wait.promise;
  const request = {
    method: "readObject" as const,
    object: { ...object },
    maxBytes: 1024,
  };
  const pending = f.router.request(request, f.context, signal());
  request.object.versionRef = "head";
  Reflect.set(initial.authority, "dataAuthorityId", "changed");
  Reflect.set(f.context.view.state.object!, "versionRef", "changed by caller");
  wait.resolve();
  await pending;
  assert.deepEqual(
    f.calls.find(({ method }) => method === "cognitive-apps.read-object")!
      .parameters.object,
    object,
  );
});

test("UNIT router rejects inactive, retargeted, forged definition and ungranted compose without work", async () => {
  const f = unit();
  for (const context of [
    { ...f.context, view: { ...f.context.view, active: false } },
    {
      ...f.context,
      authority: { ...f.context.authority, serviceId: "different" },
    },
    {
      ...f.context,
      authority: { ...f.context.authority, definitionHash: "c".repeat(64) },
    },
    { ...f.context, view: { ...f.context.view, bindingRevision: 2 } },
    {
      ...f.context,
      definition: { ...f.context.definition, description: "forged" },
    },
  ])
    await assert.rejects(
      f.router.request(write(), parseBrowserContext(context), signal()),
      { code: "forbidden" },
    );
  assert.equal(f.calls.length, 0);
  const denied = source();
  denied.manifest.permissions = [];
  const other = unit(denied);
  await assert.rejects(
    other.router.request(
      { method: "compose", text: "not permitted" },
      other.context,
      signal(),
    ),
    { code: "forbidden" },
  );
  assert.equal(other.calls.length, 0);
});

test("UNIT router current target revisions, authority and navigation are real post-await gates", async () => {
  for (const changed of [
    "grant",
    "connection",
    "authority",
    "state",
  ] as const) {
    const f = unit();
    f.change((previous) => ({
      ...previous,
      ...(changed === "grant" ? { grantRevision: 2 } : {}),
      ...(changed === "connection" ? { connectionRevision: 2 } : {}),
      ...(changed === "authority"
        ? {
            authority: {
              ...previous.authority,
              definitionHash: "d".repeat(64),
            },
          }
        : {}),
      ...(changed === "state"
        ? {
            view: {
              ...previous.view,
              state: { object: { ...object, versionRef: "head" } },
            },
          }
        : {}),
    }));
    await assert.rejects(f.router.request(write(), f.context, signal()), {
      code: "conflict",
    });
    assert.equal(
      f.calls.some(({ method }) => method === "cognitive-apps.invoke"),
      false,
    );
  }
});

test("UNIT router discards a private original after revocation, with no second invoke", async () => {
  const f = unit();
  f.control.business = async () => {
    f.change((current) => ({ ...current, grantRevision: 2 }));
    return {
      protocol: "morphz-domain/v1",
      authority: f.context.authority,
      operationId: "notes.list",
      result: "PRIVATE",
    };
  };
  await assert.rejects(
    f.router.request(
      {
        method: "invoke",
        operationId: "notes.list",
        parameters: null,
        resources: [],
        commandId: null,
      },
      f.context,
      signal(),
    ),
    { code: "conflict" },
  );
  assert.equal(
    f.calls.filter(({ method }) => method === "cognitive-apps.invoke").length,
    1,
  );
});

test("UNIT router keeps original write identity and rejects Agent, legacy and malformed output carriers", async () => {
  for (const result of [
    {
      ok: true,
      result: {
        kind: "command",
        commandId: "original_write",
        command: facts("original_write"),
      },
    },
    { value: "legacy" },
    {
      kind: "command",
      commandId: "replacement",
      command: facts("replacement"),
    },
  ]) {
    const f = unit();
    f.control.business = async () => result;
    await assert.rejects(f.router.request(write(), f.context, signal()), {
      code: "contract",
    });
    assert.equal(
      f.calls.filter(({ method }) => method === "cognitive-apps.invoke").length,
      1,
    );
  }
});

test("UNIT router original save CAS acknowledges only original receipt and state, never current head", async () => {
  const f = unit();
  const request = {
    method: "saveState" as const,
    expectedRevision: 1,
    state: { object: { ...object }, view: "reader" },
  };
  const saved = await f.router.request(request, f.context, signal());
  assert.deepEqual(saved, { revision: 2, state: request.state });
  const next = parseBrowserContext({
    ...f.context,
    view: { ...f.context.view, revision: 2, state: request.state },
  });
  await f.router.request({ method: "ready" }, next, signal());
  const stale = unit();
  stale.control.save = () => ({
    receipt: { viewId: "view", viewRevision: 12, bindingRevision: 1 },
    replayed: false,
  });
  await assert.rejects(stale.router.request(request, stale.context, signal()), {
    code: "contract",
  });
  const mismatch = unit();
  await assert.rejects(
    mismatch.router.request(
      { ...request, expectedRevision: 2 },
      mismatch.context,
      signal(),
    ),
    { code: "conflict" },
  );
  assert.equal(mismatch.calls.length, 0);
});

test("UNIT router detached owner originals cannot mutate fixed request or return another object", async () => {
  const f = unit();
  f.control.open = async (request) => {
    Reflect.set(request.object, "versionRef", "changed");
    return { opened: true, object: request.object };
  };
  await assert.rejects(
    f.router.request({ method: "openObject", object }, f.context, signal()),
    { code: "contract" },
  );
  assert.deepEqual(f.context.view.state.object, object);
  assert.deepEqual(f.current().view.state.object, object);
  f.control.compose = async (request) => {
    request.source.view.state = { view: "mutated owner" };
    return { prepared: true };
  };
  assert.deepEqual(
    await f.router.request(
      { method: "compose", text: "plain draft" },
      f.context,
      signal(),
    ),
    { prepared: true },
  );
  const owner = f.owners.at(-1)!.request as { object?: unknown };
  assert.equal(Object.hasOwn(owner, "object"), false);
  assert.deepEqual(f.current().view.state.object, object);
});

test("UNIT router abort during authorization or work discards late result and never resends", async () => {
  for (const at of ["gate", "work"]) {
    const f = unit(),
      wait = deferred(),
      controller = new AbortController();
    if (at === "gate") f.control.gate = () => wait.promise;
    else
      f.control.business = async () => {
        await wait.promise;
        return {
          kind: "command",
          commandId: "original_write",
          command: facts("original_write"),
        };
      };
    const pending = f.router.request(write(), f.context, controller.signal);
    if (at === "work")
      while (!f.calls.some(({ method }) => method === "cognitive-apps.invoke"))
        await new Promise<void>((done) => setImmediate(done));
    controller.abort();
    wait.resolve();
    await assert.rejects(pending, { code: "unavailable" });
    assert.equal(
      f.calls.filter(({ method }) => method === "cognitive-apps.invoke").length,
      at === "gate" ? 0 : 1,
    );
  }
});

test("UNIT router final authorization await cannot release an original after revoke or abort", async () => {
  for (const failure of ["revoke", "abort"]) {
    const f = unit(),
      entered = deferred(),
      wait = deferred();
    const controller = new AbortController();
    let gates = 0;
    f.control.gate = async () => {
      if (++gates === 2) {
        entered.resolve();
        await wait.promise;
      }
    };
    const pending = f.router.request(
      { method: "readObject", object, maxBytes: 1024 },
      f.context,
      controller.signal,
    );
    await entered.promise;
    if (failure === "revoke")
      f.change((current) => ({ ...current, grantRevision: 2 }));
    else controller.abort();
    wait.resolve();
    await assert.rejects(pending, {
      code: failure === "revoke" ? "conflict" : "unavailable",
    });
    assert.equal(
      f.calls.filter(({ method }) => method === "cognitive-apps.read-object")
        .length,
      1,
    );
    assert.equal(gates, 2);
  }
});

test("UNIT router rejects accessors before first authorization await", async () => {
  const f = unit();
  let access = 0;
  const raw = {
    method: "readObject",
    object,
    get maxBytes() {
      access++;
      return 1024;
    },
  };
  await assert.rejects(
    f.router.request(raw as BrowserRequest, f.context, signal()),
  );
  assert.equal(access, 0);
  assert.equal(f.calls.length, 0);
});

test("UNIT composed channel and router publish their own saved CAS, then gate the exact new context", async () => {
  const f = unit();
  const messages: ReturnType<typeof parseBrowserMessage>[] = [];
  const frame = {
    postMessage(message: unknown, targetOrigin: string) {
      assert.equal(targetOrigin, "*");
      messages.push(parseBrowserMessage(message));
    },
  };
  const channel = createCognitiveBrowserChannel(f.context, {
    frame,
    current: () => true,
    authorize: f.router.authorize,
    request: f.router.request,
  });
  await channel.receive({
    source: frame,
    origin: "null",
    data: { type: "morphz-cognitive-ui/v1:connect" },
  });
  await channel.loaded();
  const init = messages[0]!;
  assert.equal(init.type, "morphz-cognitive-ui/v1:init");
  if (init.type !== "morphz-cognitive-ui/v1:init")
    throw new Error("Missing init");
  const state = { object: { ...object }, view: "reader" };
  const requestId = crypto.randomUUID();
  await channel.receive({
    source: frame,
    origin: "null",
    data: {
      type: "morphz-cognitive-ui/v1:request",
      channel: init.channel,
      requestId,
      request: { method: "saveState", expectedRevision: 1, state },
    },
  });
  const saved = messages.find(
    (m) =>
      m.type === "morphz-cognitive-ui/v1:response" && m.requestId === requestId,
  )!;
  assert.equal(saved.type, "morphz-cognitive-ui/v1:response");
  if (saved.type !== "morphz-cognitive-ui/v1:response")
    throw new Error("Missing save");
  assert.equal(saved.ok, true);
  if (saved.ok) assert.deepEqual(saved.result, { revision: 2, state });
  const updated = messages.at(-1)!;
  assert.equal(updated.type, "morphz-cognitive-ui/v1:init");
  if (updated.type !== "morphz-cognitive-ui/v1:init")
    throw new Error("Missing updated init");
  assert.equal(updated.channel, init.channel);
  assert.equal(updated.context.view.revision, 2);
  assert.deepEqual(updated.context.view.state, state);
  assert.equal(
    f.calls.filter(({ method }) => method === "cognitive-app-views.save")
      .length,
    1,
  );
  channel.retire();
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`${backend}: router uses actual Human views/readUi, original SQL CAS and exact bound owner source`, async () => {
    await withViewTransport(backend, async (f) => {
      const receipt = await f.client.call(
        "cognitive-app-views.launch",
        f.launch,
        { identityGeneration: f.httpCsrf },
      );
      const ui = await f.client.call(
        "cognitive-app-views.read-ui",
        {
          viewId: receipt.receipt.viewId,
          expectedViewRevision: receipt.receipt.viewRevision,
          expectedBindingRevision: receipt.receipt.bindingRevision,
        },
        { identityGeneration: f.httpCsrf },
      );
      const ownerRequests: CognitiveAppViewUi[] = [];
      const router = createCognitiveBrowserRouter(ui, {
        call: (method, params, options) =>
          f.client.call(method, params, {
            ...options,
            identityGeneration: f.httpCsrf,
          }),
        openObject: async () => {
          throw new Error(
            "This fixture does not implement a real navigation owner.",
          );
        },
        compose: async ({ source }) => {
          ownerRequests.push(source);
          return { prepared: true };
        },
      });
      const context = router.context(presentation);
      assert.deepEqual(
        await router.request({ method: "ready" }, context, signal()),
        context,
      );
      assert.deepEqual(
        await router.request(
          { method: "compose", text: "CONTROLLED OWNER ACK" },
          context,
          signal(),
        ),
        { prepared: true },
      );
      assert.deepEqual(ownerRequests, [ui]);
      const state = { view: "exact-navigation" };
      const saved = await router.request(
        { method: "saveState", expectedRevision: context.view.revision, state },
        context,
        signal(),
      );
      assert.deepEqual(saved, { revision: context.view.revision + 1, state });
      const actual = await f.client.call(
        "cognitive-app-views.read",
        { viewId: ui.view.id },
        { identityGeneration: f.httpCsrf },
      );
      assert.equal(actual.view.revision, context.view.revision + 1);
      assert.deepEqual(actual.view.state, state);
      const next = parseBrowserContext({
        ...context,
        view: { ...context.view, revision: actual.view.revision, state },
      });
      await router.request({ method: "ready" }, next, signal());
      await f.platform.changeCognitiveAppGrant(
        { credential: "setup-bob" },
        {
          appId: ui.definition.id,
          version: ui.definition.version,
          state: "disabled",
          expectedRevision: 1,
        },
      );
      await assert.rejects(
        router.request(
          { method: "compose", text: "must not reach owner" },
          next,
          signal(),
        ),
      );
      assert.equal(ownerRequests.length, 1);
      const commands = await f.q.all(
        "SELECT command_id FROM cognitive_app_commands",
        [],
      );
      assert.equal(commands.length, 0);
    });
  });
}
