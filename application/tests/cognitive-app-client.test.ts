import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createCognitiveAppClient,
  cognitiveAppCatalogLimits,
  type CognitiveAppTransport,
} from "../apps/web/src/cognitive-app-client.js";
import {
  ApplicationRequestError,
  cognitiveAppApplicationRoute,
} from "../packages/core/src/application-api.js";
import type {
  CognitiveAppCatalogDto,
  CognitiveAppRequestMap,
} from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";

// Presentation UNIT: the callback below is controlled. Actual identity,
// authorization, SQLite/PostgreSQL and HTTP acceptance are separate Host gates.
const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const at = "2026-10-05T00:00:00.000Z";
const hash = "a".repeat(64);
const icon = "data:image/png;base64," + "A".repeat(180000 - 22);
const target = {
  appId: definition.id,
  version: definition.version,
  connectionId: "connection",
  projectId: "project",
};
const authority = {
  appId: definition.id,
  version: definition.version,
  definitionHash: hash,
  instanceId: "instance",
  serviceId: "service/original",
  dataAuthorityId: "data/original",
};
const grant = {
  appId: definition.id,
  version: definition.version,
  state: "active" as const,
  revision: 1,
  consentedAt: at,
  updatedAt: at,
};
const connection = (id = "connection") => ({
  appId: definition.id,
  instanceId: "instance",
  serviceId: authority.serviceId,
  dataAuthorityId: authority.dataAuthorityId,
  connectionId: id,
  state: "active" as const,
  revision: 1,
  createdAt: at,
  updatedAt: at,
});
const metadata = (number = 1, withIcon = false) => ({
  appId: definition.id,
  version: `1.0.${number}`,
  definitionHash: hash,
  title: `Notes ${number}`,
  description: "Author's original metadata",
  icon: "book" as const,
  ...(withIcon ? { iconImage: icon } : {}),
  registeredAt: at,
  installationState: "active" as const,
  harness: null,
  ui: null,
  grant: null,
});
const page = (
  versions: CognitiveAppCatalogDto["versions"] = [],
  connections: CognitiveAppCatalogDto["connections"] = [],
  nextVersionsAfter: string | null = null,
  nextConnectionsAfter: string | null = null,
): CognitiveAppCatalogDto => ({
  versions,
  connections,
  nextVersionsAfter,
  nextConnectionsAfter,
});
const facts = (commandId = "command") => ({
  commandId,
  operationId: "notes.create",
  effect: "write" as const,
  state: "unknown" as const,
  revision: 3,
  projectionState: "none" as const,
  receiptRef: null,
  receiptHash: null,
  committedAt: null,
  objects: null,
  createdAt: at,
  updatedAt: at,
});
const command = (commandId = "command") => ({
  kind: "command" as const,
  commandId,
  command: facts(commandId),
});
const read = {
  protocol: "morphz-domain/v1" as const,
  authority,
  operationId: "notes.list",
  result: { items: [] },
};
const object = { objectId: "note/原件", versionRef: "opaque-v1 / 原件 " };
const objectRead = {
  protocol: "morphz-domain/v1" as const,
  authority,
  object,
  kind: "note",
  title: "Original",
  content: { format: "text" as const, text: "Original content" },
};
const invoke: CognitiveAppRequestMap["invoke"] = {
  ...target,
  operationId: "notes.list",
  parameters: {},
  resources: [],
  commandId: null,
};
const write: CognitiveAppRequestMap["invoke"] = {
  ...invoke,
  operationId: "notes.create",
  commandId: "command",
};
const status = { ...target, commandId: "command" };
const rejected = (code: string, commandId?: string) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.code, code);
  assert.equal(error.commandId, commandId);
  return true;
};

test("Cognitive client uses the ten fixed logical operations and existing public DTOs", async () => {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    list: page(),
    describe: { definition, definitionHash: hash, grantRevision: 1 },
    install: {
      appId: definition.id,
      version: definition.version,
      definitionHash: hash,
    },
    grant,
    connect: connection(),
    connectionState: connection(),
    invoke: read,
    readObject: objectRead,
    commandStatus: facts(),
    recover: command(),
  };
  const signal = new AbortController().signal;
  const transport: CognitiveAppTransport = async (method, _params, actual) => {
    calls.push(method);
    assert.equal(actual, signal);
    const route = cognitiveAppApplicationRoute(method);
    return route ? responses[route.method] : undefined;
  };
  const client = createCognitiveAppClient(transport);
  assert.deepEqual(await client.list({ limit: 100 }, signal), page());
  const described = await client.describe(
    { appId: definition.id, version: definition.version, projectId: "project" },
    signal,
  );
  assert.equal(described.grantRevision, 1);
  assert.deepEqual(
    await client.install({ definition }, signal),
    responses.install,
  );
  assert.deepEqual(
    await client.grant(
      {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
      },
      signal,
    ),
    grant,
  );
  assert.deepEqual(
    await client.connect(
      {
        appId: definition.id,
        version: definition.version,
        connectionId: "connection",
        expectedRevision: 0,
        serviceId: authority.serviceId,
        dataAuthorityId: authority.dataAuthorityId,
      },
      signal,
    ),
    connection(),
  );
  assert.deepEqual(
    await client.connectionState(
      {
        appId: definition.id,
        version: definition.version,
        connectionId: "connection",
        expectedRevision: 1,
        state: "active",
      },
      signal,
    ),
    connection(),
  );
  assert.deepEqual(await client.invoke(invoke, signal), read);
  assert.deepEqual(
    await client.readObject({ ...target, object, maxBytes: 100 }, signal),
    objectRead,
  );
  assert.deepEqual(await client.commandStatus(status, signal), facts());
  assert.deepEqual(await client.recover(status, signal), command());
  assert.deepEqual(calls, [
    "cognitive-apps.list",
    "cognitive-apps.describe",
    "cognitive-apps.install",
    "cognitive-apps.grant",
    "cognitive-apps.connect",
    "cognitive-apps.connection-state",
    "cognitive-apps.invoke",
    "cognitive-apps.read-object",
    "cognitive-apps.command-status",
    "cognitive-apps.recover",
  ]);
});

test("Cognitive client management description remains a distinct exact request/response mode", async () => {
  const response = {
    mode: "registered-management" as const,
    definition,
    definitionHash: hash,
    registeredAt: at,
    installationState: "disabled" as const,
    grant: null,
  };
  const request = {
    mode: "registered-management" as const,
    appId: definition.id,
    version: definition.version,
    expectedDefinitionHash: hash,
  };
  const client = createCognitiveAppClient(async () => response);
  const result = await client.describe(request);
  assert.equal(result.mode, "registered-management");
  assert.equal(result.grant, null);
  assert.equal(result.installationState, "disabled");
  await assert.rejects(
    client.describe({
      appId: definition.id,
      version: definition.version,
      projectId: "project",
    }),
    rejected("contract"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => ({
      definition,
      definitionHash: hash,
      grantRevision: 1,
    })).describe(request),
    rejected("contract"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => ({
      ...response,
      definitionHash: "b".repeat(64),
    })).describe(request),
    rejected("contract"),
  );
});

test("Cognitive client retains the Core million-byte UI install carrier rather than applying a 512 KiB wire guard", async () => {
  const html = "\u0001".repeat(1_000_000);
  const input: CognitiveAppRequestMap["install"] = {
    commandId: "ui-install",
    definition: {
      ...definition,
      ui: { packageVersion: definition.version, sha256: hash },
    },
    manifest: {
      format: "morphz-app/v1",
      id: definition.id,
      version: definition.version,
      title: definition.title,
      description: definition.description,
      icon: definition.icon,
      permissions: ["input.compose"],
      harness: null,
      ui: { type: "sandbox", html },
    },
  };
  let calls = 0;
  const result = await createCognitiveAppClient(async (method, params) => {
    calls++;
    assert.equal(method, "cognitive-apps.install");
    assert.ok("manifest" in params && params.manifest);
    assert.equal(params.manifest.ui.type, "sandbox");
    if (params.manifest.ui.type === "sandbox")
      assert.equal(params.manifest.ui.html, html);
    return {
      appId: definition.id,
      version: definition.version,
      definitionHash: hash,
    };
  }).install(input);
  assert.equal(calls, 1);
  assert.equal(result.definitionHash, hash);
});

test("Cognitive client snapshots strict inputs before transport and never executes accessors", async () => {
  let getterCalls = 0,
    networkCalls = 0;
  const client = createCognitiveAppClient(async () => {
    networkCalls++;
    return read;
  });
  for (const invalid of [
    { ...invoke, principalId: "not-authority" },
    Object.defineProperty({ ...invoke }, "parameters", {
      enumerable: true,
      get() {
        getterCalls++;
        return {};
      },
    }),
    {
      ...invoke,
      parameters: {
        get body() {
          getterCalls++;
          return "private";
        },
      },
    },
    {
      ...invoke,
      parameters: {
        toJSON() {
          getterCalls++;
          return {};
        },
      },
    },
    Object.create(invoke),
  ])
    await assert.rejects(
      client.call("invoke", invalid as typeof invoke),
      rejected("invalid"),
    );
  assert.equal(getterCalls, 0);
  assert.equal(networkCalls, 0);
  let captured: unknown;
  let release!: (value: unknown) => void;
  const held = createCognitiveAppClient((_method, params) => {
    captured = params;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const input = {
    ...invoke,
    parameters: { nested: ["original"] },
    resources: [{ ...object }],
  };
  const pending = held.invoke(input);
  input.parameters.nested[0] = "changed";
  input.resources[0]!.versionRef = "changed";
  assert.deepEqual(captured, {
    ...invoke,
    parameters: { nested: ["original"] },
    resources: [object],
  });
  release(read);
  await pending;
});

test("Cognitive client rejects malformed/secret/late response carriers without reading getters", async () => {
  let getters = 0;
  for (const response of [
    { ...read, hostBindingId: "private" },
    { ...read, authority: { ...authority, credential: "private" } },
    Object.defineProperty({ ...read }, "result", {
      enumerable: true,
      get() {
        getters++;
        return {};
      },
    }),
    {
      ...read,
      result: {
        get secret() {
          getters++;
          return "private";
        },
      },
    },
  ])
    await assert.rejects(
      createCognitiveAppClient(async () => response).invoke(invoke),
      rejected("contract"),
    );
  assert.equal(getters, 0);
  const response = {
    ...objectRead,
    content: { format: "json" as const, value: { body: ["original"] } },
  };
  const result = await createCognitiveAppClient(
    async () => response,
  ).readObject({ ...target, object, maxBytes: 100 });
  response.content.value.body[0] = "changed";
  assert.deepEqual(result.content, {
    format: "json",
    value: { body: ["original"] },
  });
});

test("Cognitive client preserves original write identity and rejects mismatched acknowledgements", async () => {
  const accepted = await createCognitiveAppClient(async () => command()).invoke(
    write,
  );
  assert.deepEqual(accepted, command());
  for (const response of [
    read,
    command("different"),
    { ...command(), command: { ...facts(), operationId: "notes.other" } },
  ]) {
    await assert.rejects(
      createCognitiveAppClient(async () => response).invoke(write),
      rejected("contract", "command"),
    );
  }
  await assert.rejects(
    createCognitiveAppClient(async () => command()).invoke(invoke),
    rejected("contract"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => facts("different")).commandStatus(
      status,
    ),
    rejected("contract", "command"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => command("different")).recover(status),
    rejected("contract", "command"),
  );
  const original = new ApplicationRequestError(
    409,
    "Current access changed.",
    "conflict",
    "command",
  );
  await assert.rejects(
    createCognitiveAppClient(async () => {
      throw original;
    }).invoke(write),
    (error: unknown) => error === original,
  );
});

test("Cognitive client keeps exact opaque object identity and actual requested UTF-8 byte limit", async () => {
  for (const response of [
    { ...objectRead, object: { ...object, versionRef: "new-head" } },
    { ...objectRead, authority: { ...authority, appId: "other.app" } },
    { ...objectRead, content: { format: "text", text: "中".repeat(34) } },
    { ...objectRead, object: { ...object, versionRef: 1 } },
  ])
    await assert.rejects(
      createCognitiveAppClient(async () => response).readObject({
        ...target,
        object,
        maxBytes: 100,
      }),
      rejected("contract"),
    );
  await assert.rejects(
    createCognitiveAppClient(async () => objectRead).readObject({
      ...target,
      expectedDefinitionHash: "b".repeat(64),
      object,
      maxBytes: 100,
    }),
    rejected("contract"),
  );
  assert.equal(
    (
      await createCognitiveAppClient(async () => objectRead).readObject({
        ...target,
        object,
        maxBytes: 100,
      })
    ).object.versionRef,
    object.versionRef,
  );
});

test("Cognitive client does not accept install/grant/connection responses from another exact target", async () => {
  const install = {
    mode: "register-installed" as const,
    commandId: "register",
    appId: definition.id,
    version: definition.version,
    definitionHash: hash,
  };
  await assert.rejects(
    createCognitiveAppClient(async () => ({
      appId: definition.id,
      version: definition.version,
      definitionHash: "b".repeat(64),
    })).install(install),
    rejected("contract", "register"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => ({
      ...grant,
      appId: "other.app",
    })).grant({
      appId: definition.id,
      version: definition.version,
      state: "active",
      expectedRevision: 0,
    }),
    rejected("contract"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => connection("other")).connectionState({
      appId: definition.id,
      version: definition.version,
      connectionId: "connection",
      state: "active",
      expectedRevision: 1,
    }),
    rejected("contract"),
  );
});

test("Cognitive client cancelled or late operations do not disclose results or retry writes", async () => {
  const cancelled = new AbortController();
  cancelled.abort("not a disclosed cancellation detail");
  let calls = 0;
  const client = createCognitiveAppClient(async () => {
    calls++;
    return command();
  });
  await assert.rejects(
    client.invoke(write, cancelled.signal),
    rejected("cancelled", "command"),
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  let release!: (value: unknown) => void;
  const pending = createCognitiveAppClient((_method, _params, signal) => {
    calls++;
    assert.equal(signal, controller.signal);
    return new Promise((resolve) => {
      release = resolve;
    });
  }).invoke(write, controller.signal);
  controller.abort("private reason");
  await assert.rejects(pending, rejected("cancelled", "command"));
  release(command());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("Cognitive allCatalog finishes both streams across short pages and preserves metadata", async () => {
  const calls: unknown[] = [];
  const responses = [
    page([metadata(1)], [connection("c1")], "v1", "c1"),
    page([metadata(2)], [connection("c2")], null, "c2"),
    page([], [connection("c3")]),
  ];
  const client = createCognitiveAppClient(async (method, params) => {
    assert.equal(method, "cognitive-apps.list");
    calls.push(params);
    return responses.shift();
  });
  assert.deepEqual(
    await client.allCatalog({ limit: 100, appId: definition.id }),
    {
      versions: [metadata(1), metadata(2)],
      connections: [connection("c1"), connection("c2"), connection("c3")],
    },
  );
  assert.deepEqual(calls, [
    { limit: 100, appId: definition.id },
    { limit: 100, appId: definition.id, versionsAfter: "v1" },
    { limit: 100, appId: definition.id, connectionsAfter: "c2" },
  ]);
});

test("Cognitive allCatalog continues versions after connections reach EOF without restarting either stream", async () => {
  const calls: unknown[] = [];
  const responses = [
    page([metadata(1)], [connection("c1")], "v1", null),
    page([metadata(2)], [], "v2", null),
    page([metadata(3)]),
  ];
  const result = await createCognitiveAppClient(async (_method, params) => {
    calls.push(params);
    return responses.shift();
  }).allCatalog();
  assert.equal(result.versions.length, 3);
  assert.equal(result.connections.length, 1);
  assert.deepEqual(calls, [
    { limit: 100 },
    { limit: 100, versionsAfter: "v1" },
    { limit: 100, versionsAfter: "v2" },
  ]);
});

test("Cognitive allCatalog supports an initially empty stream and an empty terminal page", async () => {
  const responses = [page([], [connection("c1")], null, "c1"), page()];
  assert.deepEqual(
    await createCognitiveAppClient(async () => responses.shift()).allCatalog(),
    { versions: [], connections: [connection("c1")] },
  );
  assert.deepEqual(
    await createCognitiveAppClient(async () => page()).allCatalog(),
    { versions: [], connections: [] },
  );
});

test("Cognitive list validates the actual filter and requested per-stream limit", async () => {
  const client = createCognitiveAppClient(async () =>
    page([metadata(1), metadata(2)]),
  );
  await assert.rejects(client.list({ limit: 1 }), rejected("contract"));
  await assert.rejects(
    client.list({ limit: 100, appId: "other.app" }),
    rejected("contract"),
  );
  await assert.rejects(
    createCognitiveAppClient(async () => page([], [connection()])).list({
      limit: 100,
      appId: "other.app",
    }),
    rejected("contract"),
  );
});

test("Cognitive allCatalog retains one hundred maximum original icons across byte-short pages", async () => {
  let offset = 0;
  const result = await createCognitiveAppClient(async () => {
    const versions = [metadata(++offset, true), metadata(++offset, true)];
    return page(versions, [], offset < 100 ? `v${offset}` : null);
  }).allCatalog();
  assert.equal(offset, 100);
  assert.equal(result.versions.length, 100);
  assert.ok(
    result.versions.every(
      (item) =>
        item.iconImage === icon && item.ui === null && item.grant === null,
    ),
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 480 * 1024,
  );
});

test("Cognitive allCatalog rejects duplicate identities even if body/hash/app changes", async () => {
  for (const responses of [
    [
      page([metadata(1)], [], "v1"),
      page([{ ...metadata(1), definitionHash: "b".repeat(64) }]),
    ],
    [
      page([], [connection("c1")], null, "c1"),
      page([], [{ ...connection("c1"), appId: "other.app" }]),
    ],
    [page([metadata(1), metadata(1)])],
    [page([], [connection("c1"), connection("c1")])],
  ])
    await assert.rejects(
      createCognitiveAppClient(async () => responses.shift()).allCatalog(),
      rejected("contract"),
    );
});

test("Cognitive allCatalog rejects nonprogress, cursor cycles and restarted EOF streams", async () => {
  for (const responses of [
    [page([], [], "v1")],
    [page([metadata(1)], [], "v1"), page([metadata(2)], [], "v1")],
    [
      page([metadata(1)], [], "v1"),
      page([metadata(2)], [], "v2"),
      page([metadata(3)], [], "v1"),
    ],
    [
      page([metadata(1)], [connection("c1")], null, "c1"),
      page([metadata(2)], [connection("c2")]),
    ],
    [page([metadata(1)], [], "v1"), page([], [], "v2")],
  ])
    await assert.rejects(
      createCognitiveAppClient(async () => responses.shift()).allCatalog(),
      rejected("contract"),
    );
});

test("Cognitive allCatalog strict options snapshot rejects borrowed cursors, identity and accessors", async () => {
  let calls = 0,
    getters = 0;
  const client = createCognitiveAppClient(async () => {
    calls++;
    return page();
  });
  for (const options of [
    { versionsAfter: "previous-page" },
    { connectionsAfter: "previous-page" },
    { principalId: "borrowed" },
    Object.defineProperty({}, "appId", {
      enumerable: true,
      get() {
        getters++;
        return definition.id;
      },
    }),
    { limit: 101 },
  ])
    await assert.rejects(
      client.allCatalog(options as Parameters<typeof client.allCatalog>[0]),
      rejected("invalid"),
    );
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});

test("Cognitive allCatalog fails rather than publishing a partial or stale aggregate", async () => {
  const error = new ApplicationRequestError(
    409,
    "Cursor access changed.",
    "conflict",
  );
  let calls = 0;
  await assert.rejects(
    createCognitiveAppClient(async () => {
      if (++calls === 1) return page([metadata(1)], [], "v1");
      throw error;
    }).allCatalog(),
    (actual: unknown) => actual === error,
  );
  assert.equal(calls, 2);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    createCognitiveAppClient(async () => {
      calls++;
      controller.abort();
      return page([metadata(1)], [], "v1");
    }).allCatalog({}, controller.signal),
    rejected("cancelled"),
  );
  assert.equal(calls, 1);
});

test("Cognitive allCatalog page budget is finite without assuming count-based EOF", async () => {
  let calls = 0;
  await assert.rejects(
    createCognitiveAppClient(async () =>
      page([metadata(++calls)], [], `v${calls}`),
    ).allCatalog(),
    rejected("unavailable"),
  );
  assert.equal(calls, cognitiveAppCatalogLimits.pages);
});

test("Cognitive allCatalog entry budget is finite and never truncates a completed response", async () => {
  let count = 0;
  await assert.rejects(
    createCognitiveAppClient(async () => {
      const items = Array.from({ length: 100 }, () => metadata(++count));
      return page(items, [], `v${count}`);
    }).allCatalog(),
    rejected("unavailable"),
  );
  assert.ok(count > cognitiveAppCatalogLimits.entries);
  assert.ok(count <= cognitiveAppCatalogLimits.entries + 100);
});

test("Cognitive allCatalog UTF-8 total budget retains original icons or explicitly fails", async () => {
  let count = 0;
  await assert.rejects(
    createCognitiveAppClient(async () =>
      page([metadata(++count, true), metadata(++count, true)], [], `v${count}`),
    ).allCatalog(),
    rejected("unavailable"),
  );
  assert.ok(count * icon.length > cognitiveAppCatalogLimits.bytes);
  assert.ok(count < cognitiveAppCatalogLimits.entries);
});
