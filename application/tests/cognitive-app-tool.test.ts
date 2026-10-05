import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  cognitiveAppToolSchema,
  parseCognitiveAppToolRequest,
} from "../packages/core/src/cognitive-app-tool.js";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";

const target = {
  appId: "example.notes",
  version: "1.0.0",
  connectionId: "connection",
};
const write = () => ({
  action: "invoke",
  ...target,
  mode: "command",
  operationId: "notes.create",
  parameters: { title: "Exact", markdown: "Normal\u0000 business JSON" },
  resources: [],
});

test("canonical and compatibility Host manifests stay within unchanged Runtime UTF-8 limits with headroom", () => {
  for (const tool of workToolDefinitions) {
    assert.ok(
      Buffer.byteLength(tool.description, "utf8") <= 15800,
      `${tool.name} must retain description headroom below Rust's 16000-byte cap`,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(tool.parameters), "utf8") <= 262144,
    );
    assert.doesNotMatch(tool.description, /notes\.create|PRIVATE-ORIGINAL/);
  }
});

test("six finite cognitive tool schemas contain no identity, management or mutable endpoint", () => {
  assert.deepEqual(
    cognitiveAppToolSchema.options.map((schema) => schema.shape.action.value),
    ["list", "describe", "invoke", "read-object", "status", "recover"],
  );
  const json = z.toJSONSchema(cognitiveAppToolSchema, { io: "input" });
  assert.doesNotMatch(
    JSON.stringify(json),
    /projectId|principalId|credential|endpoint|baseUrl|hostBinding|tenantId|sourceInputId/,
  );
  for (const action of ["install", "grant", "connect", "connection-state"])
    assert.throws(() => parseCognitiveAppToolRequest({ action }));
  for (const extra of [
    { commandId: "model-write-id" },
    { projectId: "project" },
    { source: "input" },
    { credential: "secret" },
    { actor: {} },
    { url: "http://example.com" },
  ])
    assert.throws(() => parseCognitiveAppToolRequest({ ...write(), ...extra }));
  assert.equal(parseCognitiveAppToolRequest({ action: "list" }).action, "list");
  assert.throws(() =>
    parseCognitiveAppToolRequest({ action: "list", limit: 51 }),
  );
});

test("own-data guard is before schema access, rejects getters/toJSON without executing them", () => {
  let count = 0;
  const getter = () => {
    count++;
    throw new Error("caller-secret");
  };
  const nested = Object.defineProperty({}, "title", {
    enumerable: true,
    get: getter,
  });
  const root = Object.defineProperty({}, "action", {
    enumerable: true,
    get: getter,
  });
  const serialization = { ...write(), toJSON: getter };
  for (const candidate of [
    root,
    { ...write(), parameters: nested },
    serialization,
  ])
    assert.throws(() => parseCognitiveAppToolRequest(candidate));
  assert.equal(count, 0);
  assert.throws(() => parseCognitiveAppToolRequest(Object.create(write())));
});

test("parsed requests are independent snapshots and preserve exact opaque refs/business JSON", () => {
  const input = {
    ...write(),
    parameters: { title: "emoji 😀\n", markdown: "Raw\u0000business JSON" },
    resources: [{ objectId: "folder/原件:😀", versionRef: "v:opaque/zero-00" }],
  };
  const parsed = parseCognitiveAppToolRequest(input);
  input.parameters.title = "changed";
  input.resources[0]!.versionRef = "other";
  assert.equal(parsed.action, "invoke");
  if (parsed.action === "invoke") {
    assert.deepEqual(parsed.parameters, {
      title: "emoji 😀\n",
      markdown: "Raw\u0000business JSON",
    });
    assert.deepEqual(parsed.resources, [
      { objectId: "folder/原件:😀", versionRef: "v:opaque/zero-00" },
    ]);
  }
  for (const action of ["status", "recover"])
    assert.equal(
      parseCognitiveAppToolRequest({
        action,
        ...target,
        commandId: "original-command",
      }).action,
      action,
    );
  for (const versionRef of [1, "unsafe\u0000version", "unpaired\ud800"])
    assert.throws(() =>
      parseCognitiveAppToolRequest({
        action: "read-object",
        ...target,
        object: { objectId: "opaque/id", versionRef },
        maxBytes: 32,
      }),
    );
});

test("wire, business value and resources retain existing fixed UTF-8/depth/size budgets", () => {
  assert.throws(() =>
    parseCognitiveAppToolRequest({
      ...write(),
      parameters: "汉".repeat(100000),
    }),
  );
  assert.throws(() =>
    parseCognitiveAppToolRequest({
      ...write(),
      resources: Array.from({ length: 33 }, (_, index) => ({
        objectId: `id-${index}`,
        versionRef: "ref",
      })),
    }),
  );
  assert.throws(() =>
    parseCognitiveAppToolRequest({
      ...write(),
      resources: [
        { objectId: "same", versionRef: "v1" },
        { objectId: "same", versionRef: "v2" },
      ],
    }),
  );
  assert.throws(() =>
    parseCognitiveAppToolRequest({ ...write(), parameters: Number.NaN }),
  );
  const cycle: { value?: unknown } = {};
  cycle.value = cycle;
  assert.throws(() =>
    parseCognitiveAppToolRequest({ ...write(), parameters: cycle }),
  );
  let deep: unknown = null;
  for (let count = 0; count < 35; count++) deep = { value: deep };
  assert.throws(() =>
    parseCognitiveAppToolRequest({ ...write(), parameters: deep }),
  );
});
