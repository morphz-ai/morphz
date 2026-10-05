import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCognitiveAppRequest,
  parseCognitiveAppCatalog,
  parseCognitiveAppDescription,
  parseCognitiveAppCommandResult,
  parseCognitiveAppReadResult,
} from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";

const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const at = "2026-10-05T00:00:00.000Z",
  hash = "a".repeat(64);
const target = {
  projectId: "project",
  appId: definition.id,
  version: definition.version,
  connectionId: "connection",
};
const invoke = {
  ...target,
  operationId: "notes.list",
  parameters: {},
  resources: [],
  commandId: null,
};
const grant = {
  appId: definition.id,
  version: definition.version,
  state: "active",
  revision: 1,
  consentedAt: at,
  updatedAt: at,
};
const facts = {
  commandId: "command",
  operationId: "notes.create",
  effect: "write",
  state: "unknown",
  revision: 3,
  projectionState: "none",
  receiptRef: null,
  receiptHash: null,
  committedAt: null,
  objects: null,
  createdAt: at,
  updatedAt: at,
};
test("public requests have no caller authority/route/time and keep nullable explicit stable command identity", () => {
  assert.deepEqual(parseCognitiveAppRequest("invoke", invoke), invoke);
  assert.throws(() =>
    parseCognitiveAppRequest("invoke", { ...invoke, commandId: undefined }),
  );
  for (const field of [
    "tenantId",
    "principalId",
    "actor",
    "source",
    "authority",
    "endpoint",
    "baseUrl",
    "credential",
    "hostBindingId",
    "now",
    "verifiedUi",
  ])
    assert.throws(() =>
      parseCognitiveAppRequest("invoke", { ...invoke, [field]: "forbidden" }),
    );
  assert.throws(() =>
    parseCognitiveAppRequest("connectionState", {
      appId: definition.id,
      version: definition.version,
      connectionId: "connection",
      expectedRevision: 1,
      state: "disabled",
      now: at,
    }),
  );
  assert.throws(() => parseCognitiveAppRequest("list", { limit: 101 }));
  assert.throws(() =>
    parseCognitiveAppRequest("list", {
      limit: 1,
      versionsAfter: "not+base64url",
    }),
  );
});
test("safe synchronous request snapshots never execute getters/toJSON or retain nested caller data", () => {
  let calls = 0;
  for (const input of [
    Object.defineProperty({ ...invoke }, "parameters", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    }),
    {
      ...invoke,
      parameters: {
        toJSON() {
          calls++;
          return {};
        },
      },
    },
    Object.create({ operationId: "notes.list" }),
  ])
    assert.throws(() => parseCognitiveAppRequest("invoke", input));
  assert.equal(calls, 0);
  const input = {
    ...invoke,
    parameters: { nested: ["original"] },
    resources: [{ objectId: "original", versionRef: "原件版本 " }],
  };
  const parsed = parseCognitiveAppRequest("invoke", input);
  input.parameters.nested[0] = "mutated";
  input.resources[0]!.versionRef = "changed";
  assert.deepEqual(parsed.parameters, { nested: ["original"] });
  assert.equal(parsed.resources[0]!.versionRef, "原件版本 ");
});
test("headless and exact UI installation are distinct; valid million-byte escaped HTML remains accepted", () => {
  assert.deepEqual(parseCognitiveAppRequest("install", { definition }), {
    definition,
  });
  for (const extra of [
    { commandId: "unused" },
    { manifest: {} },
    { endpoint: "https://not-public" },
  ])
    assert.throws(() =>
      parseCognitiveAppRequest("install", { definition, ...extra }),
    );
  const uiDefinition = {
    ...definition,
    ui: { packageVersion: definition.version, sha256: hash },
  };
  const manifest = {
    format: "morphz-app/v1",
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    harness: null,
    permissions: [],
    ui: { type: "sandbox", html: "\u0001".repeat(1_000_000) },
  };
  const result = parseCognitiveAppRequest("install", {
    definition: uiDefinition,
    manifest,
    commandId: "stable_ui_install",
  });
  assert.ok("definition" in result);
  assert.equal(result.manifest?.ui.type, "sandbox");
  assert.equal(
    result.manifest?.ui.type === "sandbox" ? result.manifest.ui.html.length : 0,
    1_000_000,
  );
  assert.throws(() =>
    parseCognitiveAppRequest("install", {
      definition: uiDefinition,
      manifest: {
        ...manifest,
        ui: { type: "sandbox", html: "中".repeat(333334) },
      },
      commandId: "install",
    }),
  );
  assert.throws(() =>
    parseCognitiveAppRequest("install", { definition: uiDefinition, manifest }),
  );
});
test("metadata catalog and exact description are separate, finite, and refuse leaked private/full-definition fields", () => {
  const meta = {
    appId: definition.id,
    version: definition.version,
    definitionHash: hash,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    harness: null,
    ui: null,
    grant,
    registeredAt: at,
    installationState: "active",
  };
  const catalog = {
    versions: [meta],
    connections: [],
    nextVersionsAfter: null,
    nextConnectionsAfter: null,
  };
  assert.deepEqual(parseCognitiveAppCatalog(catalog), catalog);
  const iconImage = "data:image/png;base64,AAAA";
  assert.deepEqual(
    parseCognitiveAppCatalog({ ...catalog, versions: [{ ...meta, iconImage }] })
      .versions[0],
    { ...meta, iconImage },
  );
  for (const field of [
    "definition",
    "operations",
    "iconImage",
    "installedByPrincipalId",
    "hostBindingId",
  ])
    assert.throws(() =>
      parseCognitiveAppCatalog({
        ...catalog,
        versions: [{ ...meta, [field]: "not-public" }],
      }),
    );
  assert.throws(() =>
    parseCognitiveAppCatalog({
      ...catalog,
      versions: [{ ...meta, grant: { ...grant, version: "2.0.0" } }],
    }),
  );
  assert.deepEqual(
    parseCognitiveAppDescription({
      definition,
      definitionHash: hash,
      grantRevision: 1,
    }),
    { definition, definitionHash: hash, grantRevision: 1 },
  );
  assert.throws(() =>
    parseCognitiveAppDescription({
      definition,
      definitionHash: hash,
      grantRevision: 1,
      actor: { principalId: "alice" },
    }),
  );
});
test("one hundred worst-sized metadata entries and connections fit the declared catalog budget without truncation", () => {
  const versions = Array.from({ length: 100 }, (_, index) => ({
    appId: `example.app${index}`,
    version: "1.0.0",
    definitionHash: hash,
    title: "中".repeat(100),
    description: "中".repeat(500),
    icon: "book",
    registeredAt: at,
    installationState: "active",
    harness: { id: "中".repeat(100), version: "中".repeat(100) },
    ui: { packageVersion: "1.0.0", sha256: hash },
    grant: { ...grant, appId: `example.app${index}`, version: "1.0.0" },
  }));
  const connections = Array.from({ length: 100 }, (_, index) => ({
    appId: `example.app${index}`,
    instanceId: "i".repeat(100),
    serviceId: "中".repeat(200),
    dataAuthorityId: "中".repeat(200),
    connectionId: `conn${index}`,
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  }));
  const catalog = {
    versions,
    connections,
    nextVersionsAfter: "a".repeat(1024),
    nextConnectionsAfter: "b".repeat(1024),
  };
  assert.ok(
    new TextEncoder().encode(JSON.stringify(catalog)).byteLength <= 512 * 1024,
  );
  assert.equal(parseCognitiveAppCatalog(catalog).versions.length, 100);
});
test("public command results preserve observed-vs-durable facts without inventing terminal state or deliveries", () => {
  const observed = {
    receiptId: "receipt",
    receiptHash: hash,
    committedAt: at,
    objects: [],
  };
  const result = {
    kind: "command",
    commandId: "command",
    command: facts,
    hostIssue: "receipt-storage",
    persistence: "pending",
    observedCommitted: observed,
    result: { actual: "author" },
  };
  assert.deepEqual(parseCognitiveAppCommandResult(result), result);
  for (const altered of [
    { ...result, persistence: undefined },
    { ...result, command: { ...facts, state: "committed" } },
    { ...result, contentIds: ["fake"] },
    { ...result, authority: {} },
  ])
    assert.throws(() => parseCognitiveAppCommandResult(altered));
  assert.throws(() =>
    parseCognitiveAppCommandResult({
      kind: "command",
      commandId: "command",
      command: facts,
      result: { unconfirmed: "invented" },
    }),
  );
  assert.throws(() =>
    parseCognitiveAppCommandResult({
      ...result,
      observedCommitted: {
        ...observed,
        objects: [
          { objectId: "o", versionRef: "v", kind: "note", title: "n" },
          { objectId: "o", versionRef: "v2", kind: "note", title: "n" },
        ],
      },
    }),
  );
});
test("read replies remain the real pure domain wire rather than command facts", () => {
  const read = {
    protocol: "morphz-domain/v1",
    authority: {
      appId: definition.id,
      version: definition.version,
      definitionHash: hash,
      instanceId: "instance",
      serviceId: "service",
      dataAuthorityId: "data",
    },
    operationId: "notes.list",
    result: [],
  };
  assert.deepEqual(parseCognitiveAppReadResult(read), read);
  assert.throws(() => parseCognitiveAppReadResult({ ...read, command: null }));
});
test("public core schema has no Node/Platform/Host runtime imports or authority construction", () => {
  const source = readFileSync(
    new URL("../packages/core/src/cognitive-app-api.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:node:|platform\/|application\/|storage\/)/,
  );
  assert.doesNotMatch(
    source,
    /\b(?:process|Buffer|fetch|XMLHttpRequest|WebSocket)\b/,
  );
});
