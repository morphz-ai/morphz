import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cognitiveAppFormat,
  domainProtocol,
  jsonSchemaDialect,
  parseCognitiveAppDefinition,
  parseOperationResources,
  parseOperationSchema,
  validateOperationValue,
  CognitiveAppProtocolError,
  protocolLimits,
  type JsonSchema,
} from "../packages/cognitive-app-sdk/src/protocol.js";

const objectSchema = {
  type: "object",
  properties: { text: { type: "string", minLength: 1, maxLength: 10 } },
  required: ["text"],
  additionalProperties: false,
} as const;

test("the author protocol has only its installed Zod dependency, with immutable security budgets", () => {
  const source = readFileSync(
    new URL("../packages/cognitive-app-sdk/src/protocol.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    [
      ...source.matchAll(
        /\bimport\s+(?:(?:[^;]*?)\s+from\s+)?["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]),
    ["zod"],
  );
  assert.doesNotMatch(source, /\b(?:import|require)\s*\(/);
  assert.doesNotMatch(source, /\bexport\s+(?:\*|\{[^}]*\})\s+from\s/);
  assert.doesNotMatch(
    source,
    /\b(?:process|Buffer|XMLHttpRequest|WebSocket)\b/,
  );
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(source, /\b(?:window|document)\s*[.[]/);
  assert.equal(Object.isFrozen(protocolLimits), true);
  assert.deepEqual(protocolLimits, {
    definitionBytes: 262144,
    schemaBytes: 16384,
    schemaDepth: 16,
    schemaProperties: 128,
    enumValues: 128,
    operations: 128,
    resources: 32,
    resourceBytes: 32768,
    referenceLength: 200,
    valueBytes: 262144,
    valueDepth: 32,
    valueNodes: 16384,
  });
});
function definition() {
  return {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: "example.notebook",
    version: "1.0.0",
    title: "Notebook",
    description: "An independent application definition, not an installation.",
    icon: "document",
    harness: null,
    ui: null,
    operations: [
      {
        id: "notes.create",
        title: "Create a note",
        description: "Create an authorized project note.",
        effect: "write",
        scope: "project",
        inputSchema: objectSchema,
        outputSchema: {
          type: "object",
          properties: {
            objectId: { type: "string", minLength: 1 },
            versionRef: { type: "string", minLength: 1 },
          },
          required: ["objectId", "versionRef"],
          additionalProperties: false,
        },
      },
    ],
  };
}

test("author definition is standalone and headless, with exact optional GUI and Harness references", () => {
  assert.equal(cognitiveAppFormat, "morphz-cognitive-app/v1");
  assert.equal(domainProtocol, "morphz-domain/v1");
  assert.equal(
    jsonSchemaDialect,
    "https://json-schema.org/draft/2020-12/schema",
  );
  const headless = parseCognitiveAppDefinition(definition());
  assert.equal(headless.ui, null);
  assert.equal(headless.harness, null);
  assert.equal(headless.operations[0]?.scope, "project");
  assert.deepEqual(
    parseCognitiveAppDefinition({
      ...definition(),
      harness: { id: "opaque harness", version: "1" },
    }).harness,
    { id: "opaque harness", version: "1" },
  );
  const withUi = parseCognitiveAppDefinition({
    ...definition(),
    harness: { id: "example.notebook", version: "1.0.0" },
    ui: { packageVersion: "1.0.0", sha256: "a".repeat(64) },
    iconImage: "data:image/png;base64,AA==",
  });
  assert.deepEqual(withUi.harness, {
    id: "example.notebook",
    version: "1.0.0",
  });
  assert.deepEqual(withUi.ui, {
    packageVersion: "1.0.0",
    sha256: "a".repeat(64),
  });
});

test("definition rejects duplicate operation IDs, invalid metadata and undeclared authority", () => {
  const first = definition().operations[0]!;
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      operations: [first, first],
    }),
  );
  for (const extra of [
    { endpoint: "https://example.invalid" },
    { credential: "not-a-credential" },
    { handler: "module.js" },
    { permissions: ["network"] },
    { principalId: "human" },
    { approved: true },
  ])
    assert.throws(() =>
      parseCognitiveAppDefinition({ ...definition(), ...extra }),
    );
  assert.throws(() =>
    parseCognitiveAppDefinition({ ...definition(), protocol: "other/v1" }),
  );
  const { protocol: _protocol, ...withoutProtocol } = definition();
  assert.throws(() => parseCognitiveAppDefinition(withoutProtocol));
  for (const version of ["latest", "^1.0.0", "1.0", "1.0.0-beta"])
    assert.throws(() =>
      parseCognitiveAppDefinition({ ...definition(), version }),
    );
  for (const ui of [
    { packageVersion: "latest", sha256: "a".repeat(64) },
    { packageVersion: "1.0.1", sha256: "a".repeat(64) },
    { packageVersion: "1.0.0", sha256: "A".repeat(64) },
    { packageVersion: "1.0.0", sha256: "sha256:" + "a".repeat(64) },
    {
      packageVersion: "1.0.0",
      sha256: "a".repeat(64),
      html: "<p>not here</p>",
    },
  ])
    assert.throws(() => parseCognitiveAppDefinition({ ...definition(), ui }));
  assert.throws(() =>
    parseCognitiveAppDefinition({ ...definition(), icon: "arbitrary" }),
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      iconImage: "data:image/svg+xml;base64,AA==",
    }),
  );
});

test("exact app and UI versions are bounded before numeric-triplet validation", () => {
  const version = "1".repeat(96) + ".0.0";
  assert.equal(version.length, 100);
  assert.equal(
    parseCognitiveAppDefinition({ ...definition(), version }).version,
    version,
  );
  const tooLong = "1".repeat(100000) + ".0.0";
  assert.throws(() =>
    parseCognitiveAppDefinition({ ...definition(), version: tooLong }),
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      ui: { packageVersion: tooLong, sha256: "a".repeat(64) },
    }),
  );
});

test("operation descriptors are strict and bounded, not transport or handler declarations", () => {
  const first = definition().operations[0]!;
  for (const extra of [
    { endpoint: "https://example.invalid" },
    { handler: "execute" },
    { actor: "human" },
    { permission: "all" },
  ])
    assert.throws(() =>
      parseCognitiveAppDefinition({
        ...definition(),
        operations: [{ ...first, ...extra }],
      }),
    );
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      operations: [{ ...first, effect: "approve" }],
    }),
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      operations: [{ ...first, scope: "workspace" }],
    }),
  );
  const operations = Array.from({ length: 128 }, (_, index) => ({
    ...first,
    id: `notes.op-${index}`,
  }));
  assert.equal(
    parseCognitiveAppDefinition({ ...definition(), operations }).operations
      .length,
    128,
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      operations: [...operations, { ...first, id: "notes.last" }],
    }),
  );
});

test("exact object resources keep opaque string versions and scope-specific cardinality", () => {
  assert.deepEqual(parseOperationResources("project", []), []);
  const resources = [
    { objectId: "opaque/object:α", versionRef: "opaque:version/2" },
  ];
  assert.deepEqual(parseOperationResources("objects", resources), resources);
  assert.throws(() => parseOperationResources("objects", []));
  assert.deepEqual(parseOperationResources("project", resources), resources);
  const unnormalized = [
    { objectId: "  opaque object  ", versionRef: "  opaque version  " },
  ];
  assert.deepEqual(
    parseOperationResources("objects", unnormalized),
    unnormalized,
  );
  assert.throws(() =>
    parseOperationResources("objects", [resources[0], resources[0]]),
  );
  assert.throws(() =>
    parseOperationResources("objects", [
      resources[0],
      { ...resources[0], versionRef: "another:opaque/version" },
    ]),
  );
  for (const resource of [
    { objectId: "object", versionRef: 2 },
    { objectId: "object", versionRef: "" },
    { objectId: "object", versionRef: "v", actor: "human" },
    { objectId: "x".repeat(201), versionRef: "v" },
  ])
    assert.throws(() => parseOperationResources("objects", [resource]));
  const full = Array.from({ length: 32 }, (_, index) => ({
    objectId: `o${index}`,
    versionRef: "v".repeat(200),
  }));
  assert.equal(parseOperationResources("objects", full).length, 32);
  assert.throws(() =>
    parseOperationResources("objects", [
      ...full,
      { objectId: "o32", versionRef: "v" },
    ]),
  );
});

test("string lengths use Unicode code points and numeric validation never coerces", () => {
  const schema = { type: "string", minLength: 2, maxLength: 2 } as const;
  assert.equal(validateOperationValue(schema, "😀文"), "😀文");
  assert.throws(() => validateOperationValue(schema, "😀"));
  assert.throws(() => validateOperationValue(schema, "😀文x"));
  assert.equal(
    validateOperationValue({ type: "number", minimum: 0, maximum: 2 }, 1.5),
    1.5,
  );
  assert.equal(
    validateOperationValue({ type: "integer", minimum: -1, maximum: 2 }, 2),
    2,
  );
  for (const value of ["1", 1.5, -2, 3, NaN, Infinity])
    assert.throws(() =>
      validateOperationValue(
        { type: "integer", minimum: -1, maximum: 2 },
        value,
      ),
    );
  assert.equal(validateOperationValue({ type: "boolean" }, false), false);
  assert.equal(validateOperationValue({ type: "null" }, null), null);
  assert.throws(() => validateOperationValue({ type: "boolean" }, 0));
  assert.throws(() => validateOperationValue({ type: "null" }, {}));
});

test("nested object and array constraints, required fields and every enum are enforced", () => {
  const schema = {
    type: "object",
    properties: {
      rows: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["new", "done"] },
            count: { type: "integer", minimum: 1 },
          },
          required: ["status", "count"],
          additionalProperties: false,
        },
      },
      optional: { type: "string", maxLength: 1 },
    },
    required: ["rows"],
    additionalProperties: false,
  } as const;
  const valid = { rows: [{ status: "done", count: 1 }] };
  assert.deepEqual(validateOperationValue(schema, valid), valid);
  for (const value of [
    {},
    { rows: [] },
    { rows: [valid.rows[0], valid.rows[0], valid.rows[0]] },
    { rows: [{ status: "other", count: 1 }] },
    { rows: [{ status: "new", count: 0 }] },
    { rows: [{ status: "new" }] },
    { rows: [{ status: "new", count: 1, other: true }] },
    { ...valid, optional: "xx" },
    { ...valid, unknown: null },
  ])
    assert.throws(() => validateOperationValue(schema, value));
});

test("business field names remain literal data and never infer forbidden authority", () => {
  const schema = {
    type: "object",
    properties: {
      principalId: { type: "string" },
      projectId: { type: "string" },
      endpoint: { type: "string" },
    },
    required: ["principalId"],
    additionalProperties: false,
  } as const;
  const input = {
    principalId: "a label in the author's business record",
    projectId: "a data value",
    endpoint: "text, not a transport binding",
  };
  assert.deepEqual(validateOperationValue(schema, input), input);
  const first = definition().operations[0]!;
  assert.equal(
    parseCognitiveAppDefinition({
      ...definition(),
      operations: [{ ...first, inputSchema: schema }],
    }).operations[0]?.inputSchema.type,
    "object",
  );
});

test("structured enums compare complete JSON values, independent of object key order", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "string" } },
    additionalProperties: false,
    enum: [{ a: 1, b: "x" }],
  } as const;
  assert.deepEqual(validateOperationValue(schema, { b: "x", a: 1 }), {
    b: "x",
    a: 1,
  });
  assert.throws(() => validateOperationValue(schema, { a: 1, b: "y" }));
  assert.throws(() => validateOperationValue(schema, { a: 1, b: "x", c: 2 }));
  assert.deepEqual(
    validateOperationValue(
      { type: "array", items: { type: "integer" }, enum: [[1, 2]] },
      [1, 2],
    ),
    [1, 2],
  );
  assert.throws(() =>
    validateOperationValue(
      { type: "array", items: { type: "integer" }, enum: [[1, 2]] },
      [2, 1],
    ),
  );
  assert.throws(() =>
    validateOperationValue(
      { type: "string", enum: ["long"], maxLength: 2 },
      "long",
    ),
  );
});

test("every unsupported keyword and reference is rejected even beside an enum", () => {
  for (const keyword of [
    "$ref",
    "$defs",
    "$id",
    "pattern",
    "format",
    "default",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "uniqueItems",
    "prefixItems",
    "unevaluatedProperties",
    "patternProperties",
  ])
    assert.throws(() =>
      parseOperationSchema({
        type: "string",
        enum: ["ok"],
        [keyword]: "unsupported",
      }),
    );
  assert.throws(() =>
    parseOperationSchema({
      type: "object",
      properties: { nested: { type: "string", $ref: "#/properties/nested" } },
      additionalProperties: false,
    }),
  );
  assert.throws(() =>
    parseOperationSchema({
      type: "object",
      properties: { nested: { type: "string", $schema: jsonSchemaDialect } },
      additionalProperties: false,
    }),
  );
  assert.equal(
    parseOperationSchema({ type: "string", $schema: jsonSchemaDialect }).type,
    "string",
  );
  assert.throws(() =>
    parseOperationSchema({
      type: "string",
      $schema: "https://json-schema.org/draft-07/schema#",
    }),
  );
});

test("schema keyword types, enum types and required property names are strict", () => {
  for (const schema of [
    { type: ["string", "null"] },
    { type: "any" },
    { type: "string", minimum: 0 },
    { type: "number", maxLength: 1 },
    { type: "string", minLength: -1 },
    { type: "array", items: { type: "string" }, minItems: 1.5 },
    { type: "array" },
    { type: "object", properties: {} },
    { type: "object", properties: {}, additionalProperties: true },
    {
      type: "object",
      properties: {},
      required: ["missing"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "a"],
      additionalProperties: false,
    },
    { type: "string", enum: [] },
    { type: "string", enum: [1] },
    { type: "integer", enum: [1.5] },
    { type: "boolean", enum: [0] },
    { type: "null", enum: [{}] },
    { type: "object", properties: {}, additionalProperties: false, enum: [[]] },
    { type: "string", enum: ["same", "same"] },
    {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      additionalProperties: false,
      enum: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    },
    { type: "string", minLength: 3, maxLength: 2 },
    { type: "number", minimum: 3, maximum: 2 },
    { type: "array", items: { type: "null" }, minItems: 2, maxItems: 1 },
  ])
    assert.throws(() => parseOperationSchema(schema));
});

test("schema depth is root=1 and property and enum budgets are finite", () => {
  function nested(depth: number): JsonSchema {
    return depth === 1
      ? { type: "null" }
      : { type: "array", items: nested(depth - 1) };
  }
  assert.equal(parseOperationSchema(nested(16)).type, "array");
  assert.throws(() => parseOperationSchema(nested(17)));
  const properties = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [`p${index}`, { type: "null" }]),
  );
  assert.equal(
    parseOperationSchema({
      type: "object",
      properties,
      additionalProperties: false,
    }).type,
    "object",
  );
  assert.throws(() =>
    parseOperationSchema({
      type: "object",
      properties: { ...properties, extra: { type: "null" } },
      additionalProperties: false,
    }),
  );
  assert.throws(() =>
    parseOperationSchema({
      type: "object",
      properties: {
        nested: { type: "object", properties, additionalProperties: false },
      },
      additionalProperties: false,
    }),
  );
  const values = Array.from({ length: 128 }, (_, index) => index);
  assert.equal(
    parseOperationSchema({ type: "integer", enum: values }).type,
    "integer",
  );
  assert.throws(() =>
    parseOperationSchema({ type: "integer", enum: [...values, 128] }),
  );
});

test("schema and definition limits count actual UTF-8 bytes independently", () => {
  const schema = { type: "string", description: "" };
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  assert.equal(
    parseOperationSchema({ ...schema, description: "x".repeat(16384 - bytes) })
      .type,
    "string",
  );
  assert.throws(() =>
    parseOperationSchema({ ...schema, description: "x".repeat(16385 - bytes) }),
  );
  assert.throws(() =>
    parseOperationSchema({ ...schema, description: "文".repeat(6000) }),
  );
  const first = definition().operations[0]!;
  const operations = Array.from({ length: 128 }, (_, index) => ({
    ...first,
    id: `notes.op-${index}`,
    inputSchema: { type: "string", description: "文".repeat(650) },
  }));
  assert.ok(
    new TextEncoder().encode(JSON.stringify({ ...definition(), operations }))
      .byteLength > 262144,
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({ ...definition(), operations }),
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({
      ...definition(),
      operations: [
        {
          ...first,
          inputSchema: { type: "string", description: "文".repeat(6000) },
        },
      ],
    }),
  );
});

test("non-JSON values cannot disappear, run accessors or transform themselves before validation", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let getterRead = false,
    toJsonCalled = false;
  const accessor = Object.defineProperty({}, "text", {
    enumerable: true,
    get() {
      getterRead = true;
      return "ok";
    },
  });
  const transformer = {
    text: "ok",
    toJSON() {
      toJsonCalled = true;
      return { text: "ok" };
    },
  };
  const hole = Array(1);
  const withSymbol = { text: "ok", [Symbol("hidden")]: true };
  for (const value of [
    undefined,
    () => "ok",
    Symbol("x"),
    1n,
    NaN,
    Infinity,
    new Date(),
    new Map(),
    { text: undefined },
    { text: () => "ok" },
    hole,
    cyclic,
    accessor,
    transformer,
    withSymbol,
  ])
    assert.throws(() =>
      validateOperationValue(
        { type: "object", properties: {}, additionalProperties: false },
        value,
      ),
    );
  assert.equal(getterRead, false);
  assert.equal(toJsonCalled, false);
  assert.throws(() =>
    parseOperationSchema({ type: "string", description: undefined }),
  );
  assert.throws(() => parseOperationSchema(cyclic), CognitiveAppProtocolError);
  assert.throws(
    () => parseCognitiveAppDefinition(cyclic),
    CognitiveAppProtocolError,
  );
  assert.throws(() =>
    parseCognitiveAppDefinition({ ...definition(), operations: [undefined] }),
  );
  const shared = { type: "string" };
  assert.equal(
    parseOperationSchema({
      type: "object",
      properties: { first: shared, second: shared },
      additionalProperties: false,
    }).type,
    "object",
  );
});

test("actual operation values have independent UTF-8, depth and aggregate-node budgets", () => {
  const schema = { type: "string" };
  const full = "x".repeat(262142);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(full)).byteLength,
    262144,
  );
  assert.equal(validateOperationValue(schema, full), full);
  assert.throws(
    () => validateOperationValue(schema, full + "x"),
    /UTF-8 budget/,
  );
  assert.throws(
    () => validateOperationValue(schema, "文".repeat(90000)),
    /UTF-8 budget/,
  );
  const wide = Array.from({ length: 16383 }, () => null);
  assert.equal(
    (
      validateOperationValue(
        { type: "array", items: { type: "null" } },
        wide,
      ) as readonly unknown[]
    ).length,
    16383,
  );
  assert.throws(
    () =>
      validateOperationValue({ type: "array", items: { type: "null" } }, [
        ...wide,
        null,
      ]),
    /node budget/,
  );
  function deep(depth: number): unknown {
    let value: unknown = null;
    for (let index = 1; index < depth; index++) value = [value];
    return value;
  }
  // The independent data guard accepts depth 32 before the narrower schema rejects this type.
  assert.throws(
    () => validateOperationValue({ type: "null" }, deep(32)),
    /value must match null/,
  );
  assert.throws(
    () => validateOperationValue({ type: "null" }, deep(33)),
    /depth budget/,
  );
  // Definition/schema inspection is iterative, so even malicious deep JSON cannot overflow serialization.
  assert.throws(
    () => parseOperationSchema(deep(20000)),
    CognitiveAppProtocolError,
  );
  assert.throws(
    () => parseCognitiveAppDefinition(deep(140000)),
    CognitiveAppProtocolError,
  );
});

test("resource identities fit the admission ledger's exact UTF-8 budget without truncation", () => {
  const resources = Array.from({ length: 32 }, (_, index) => ({
    objectId: String(index).padEnd(200, "x"),
    versionRef: "x".repeat(200),
  }));
  const byteSize = () =>
    new TextEncoder().encode(JSON.stringify(resources)).byteLength;
  let remaining = 32768 - byteSize();
  for (const resource of resources) {
    for (const field of ["objectId", "versionRef"] as const) {
      for (
        let index = 2;
        index < resource[field].length && remaining > 0;
        index++
      ) {
        const character = remaining >= 2 ? "界" : "\n";
        resource[field] =
          resource[field].slice(0, index) +
          character +
          resource[field].slice(index + 1);
        remaining -= character === "界" ? 2 : 1;
      }
    }
  }
  assert.equal(remaining, 0);
  assert.equal(byteSize(), 32768);
  assert.deepEqual(parseOperationResources("objects", resources), resources);
  const above = resources.map((resource) => ({ ...resource }));
  const last = above.at(-1)!;
  last.versionRef = "\n" + last.versionRef.slice(1);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(above)).byteLength,
    32769,
  );
  assert.throws(
    () => parseOperationResources("objects", above),
    CognitiveAppProtocolError,
  );
  assert.equal(byteSize(), 32768);
});
