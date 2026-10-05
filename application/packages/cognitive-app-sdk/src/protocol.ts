import { z } from "zod";

// Author wire data only. This module installs nothing and grants no authority.
export const cognitiveAppFormat = "morphz-cognitive-app/v1" as const;
export const domainProtocol = "morphz-domain/v1" as const;
export const jsonSchemaDialect =
  "https://json-schema.org/draft/2020-12/schema" as const;
export const protocolLimits = Object.freeze({
  definitionBytes: 256 * 1024,
  schemaBytes: 16 * 1024,
  schemaDepth: 16,
  schemaProperties: 128,
  enumValues: 128,
  operations: 128,
  resources: 32,
  referenceLength: 200,
  valueBytes: 256 * 1024,
  valueDepth: 32,
  valueNodes: 16384,
} as const);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type SchemaMetadata = {
  readonly $schema?: typeof jsonSchemaDialect;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
};
/** Deliberately finite 2020-12 subset, not a general JSON Schema evaluator. */
export type JsonSchema = SchemaMetadata &
  (
    | {
        readonly type: "string";
        readonly minLength?: number;
        readonly maxLength?: number;
      }
    | {
        readonly type: "number" | "integer";
        readonly minimum?: number;
        readonly maximum?: number;
      }
    | { readonly type: "boolean" | "null" }
    | {
        readonly type: "array";
        readonly items: JsonSchema;
        readonly minItems?: number;
        readonly maxItems?: number;
      }
    | {
        readonly type: "object";
        readonly properties: Readonly<Record<string, JsonSchema>>;
        readonly required?: readonly string[];
        readonly additionalProperties: false;
      }
  );
export type OperationScope = "project" | "objects";
export type OperationDefinition = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly effect: "read" | "write" | "execute";
  readonly scope: OperationScope;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
};
export type OperationResourceReference = {
  readonly objectId: string;
  readonly versionRef: string;
};
export type CognitiveAppDefinition = {
  readonly format: typeof cognitiveAppFormat;
  readonly protocol: typeof domainProtocol;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly icon: "layers" | "document" | "globe" | "code" | "book" | "film";
  readonly iconImage?: string;
  readonly harness: { readonly id: string; readonly version: string } | null;
  readonly ui: {
    readonly packageVersion: string;
    readonly sha256: string;
  } | null;
  readonly operations: readonly OperationDefinition[];
};

export class CognitiveAppProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CognitiveAppProtocolError";
  }
}
function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new CognitiveAppProtocolError(message);
}
const own = (object: object, key: string) => Object.hasOwn(object, key);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Inspect own data without serializing containers or invoking accessors/toJSON.
 * UTF-8 accounting equals JSON.stringify for accepted data; nodes count every
 * actual value (including the root), not property-name strings.
 */
function requireJson(
  value: unknown,
  budget: { bytes: number; label: string; depth?: number; nodes?: number },
): asserts value is JsonValue {
  const active = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; leaving?: boolean }> = [
    { value, depth: 1 },
  ];
  let bytes = 0,
    nodes = 0;
  const addBytes = (count: number) => {
    bytes += count;
    requireCondition(
      bytes <= budget.bytes,
      `${budget.label} exceeds its ${budget.bytes}-byte UTF-8 budget.`,
    );
  };
  const scalarBytes = (scalar: null | boolean | number | string) =>
    new TextEncoder().encode(JSON.stringify(scalar)).byteLength;
  while (stack.length) {
    const item = stack.pop()!;
    const current = item.value;
    if (item.leaving) {
      active.delete(current as object);
      continue;
    }
    nodes++;
    requireCondition(
      budget.nodes === undefined || nodes <= budget.nodes,
      `${budget.label} exceeds its JSON node budget.`,
    );
    requireCondition(
      budget.depth === undefined || item.depth <= budget.depth,
      `${budget.label} exceeds its JSON depth budget (root=1).`,
    );
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      addBytes(scalarBytes(current));
      continue;
    }
    if (typeof current === "number") {
      requireCondition(
        Number.isFinite(current),
        "JSON numbers must be finite.",
      );
      addBytes(scalarBytes(current));
      continue;
    }
    requireCondition(
      typeof current === "object" && current !== null,
      "Only JSON values are supported.",
    );
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    requireCondition(
      array
        ? prototype === Array.prototype
        : prototype === Object.prototype || prototype === null,
      "Only plain JSON objects and arrays are supported.",
    );
    requireCondition(!active.has(current), "JSON cycles are not supported.");
    active.add(current);
    stack.push({ value: current, depth: item.depth, leaving: true });
    addBytes(2);
    if (array) addBytes(Math.max(0, current.length - 1));
    const keys = Reflect.ownKeys(current);
    if (array)
      requireCondition(
        keys.length === current.length + 1,
        "JSON arrays must be dense and have no extra properties.",
      );
    else addBytes(Math.max(0, keys.length - 1));
    for (const key of keys) {
      requireCondition(
        typeof key === "string",
        "JSON symbol keys are not supported.",
      );
      if (array && key === "length") continue;
      if (!array) addBytes(scalarBytes(key) + 1);
      if (array)
        requireCondition(
          /^(0|[1-9]\d*)$/.test(key) && Number(key) < current.length,
          "JSON arrays must contain only indexed items.",
        );
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      requireCondition(
        descriptor.enumerable && own(descriptor, "value"),
        "JSON must contain only enumerable own data properties.",
      );
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}
function sameJson(left: JsonValue, right: JsonValue): boolean {
  const pairs: Array<readonly [JsonValue, JsonValue]> = [[left, right]];
  while (pairs.length) {
    const [a, b] = pairs.pop()!;
    if (a === b) continue;
    if (
      a === null ||
      b === null ||
      typeof a !== "object" ||
      typeof b !== "object"
    )
      return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
        return false;
      for (let index = 0; index < a.length; index++)
        pairs.push([a[index]!, b[index]!]);
    } else {
      const first = a as { readonly [key: string]: JsonValue };
      const second = b as { readonly [key: string]: JsonValue };
      const keys = Object.keys(first);
      if (keys.length !== Object.keys(second).length) return false;
      for (const key of keys) {
        if (!own(second, key)) return false;
        pairs.push([first[key]!, second[key]!]);
      }
    }
  }
  return true;
}
function matchesType(type: string, value: unknown) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return record(value);
    default:
      return false;
  }
}
const metadataKeys = ["type", "$schema", "title", "description", "enum"];
const typeKeys: Record<string, readonly string[]> = {
  string: ["minLength", "maxLength"],
  number: ["minimum", "maximum"],
  integer: ["minimum", "maximum"],
  boolean: [],
  null: [],
  array: ["items", "minItems", "maxItems"],
  object: ["properties", "required", "additionalProperties"],
};

/** Reject every unsupported keyword, including those adjacent to an enum. */
export function parseOperationSchema(input: unknown): JsonSchema {
  requireJson(input, { bytes: protocolLimits.schemaBytes, label: "Schema" });
  let propertyCount = 0;
  function visit(value: unknown, depth: number, path: string) {
    requireCondition(
      depth <= protocolLimits.schemaDepth,
      `${path}: schema depth exceeds 16 (root=1).`,
    );
    requireCondition(record(value), `${path}: schema must be an object.`);
    const type = value.type;
    requireCondition(
      typeof type === "string" && own(typeKeys, type),
      `${path}: unsupported or missing schema type.`,
    );
    const allowed = new Set([...metadataKeys, ...typeKeys[type]!]);
    for (const key of Object.keys(value))
      requireCondition(
        allowed.has(key),
        `${path}: unsupported schema keyword ${key}.`,
      );
    if (own(value, "$schema"))
      requireCondition(
        depth === 1 && value.$schema === jsonSchemaDialect,
        `${path}: $schema is allowed only at the root with the canonical 2020-12 URI.`,
      );
    for (const key of ["title", "description"])
      if (own(value, key))
        requireCondition(
          typeof value[key] === "string",
          `${path}: ${key} must be a string.`,
        );
    if (own(value, "enum")) {
      requireCondition(
        Array.isArray(value.enum) &&
          value.enum.length > 0 &&
          value.enum.length <= protocolLimits.enumValues,
        `${path}: enum must contain 1..128 values.`,
      );
      const values = value.enum as JsonValue[];
      for (let index = 0; index < values.length; index++) {
        requireCondition(
          matchesType(type, values[index]),
          `${path}: enum value must match ${type}.`,
        );
        requireCondition(
          !values
            .slice(0, index)
            .some((prior) => sameJson(prior, values[index]!)),
          `${path}: duplicate enum value.`,
        );
      }
    }
    const bounded = (minimum: string, maximum: string, integer: boolean) => {
      for (const key of [minimum, maximum])
        if (own(value, key))
          requireCondition(
            typeof value[key] === "number" &&
              Number.isFinite(value[key]) &&
              (!integer || (Number.isInteger(value[key]) && value[key] >= 0)),
            `${path}: invalid ${key}.`,
          );
      if (own(value, minimum) && own(value, maximum))
        requireCondition(
          (value[minimum] as number) <= (value[maximum] as number),
          `${path}: minimum exceeds maximum.`,
        );
    };
    if (type === "string") bounded("minLength", "maxLength", true);
    if (type === "number" || type === "integer")
      bounded("minimum", "maximum", false);
    if (type === "array") {
      bounded("minItems", "maxItems", true);
      requireCondition(
        own(value, "items"),
        `${path}: array items schema is required.`,
      );
      visit(value.items, depth + 1, `${path}.items`);
    }
    if (type === "object") {
      requireCondition(
        record(value.properties),
        `${path}: object properties are required.`,
      );
      requireCondition(
        value.additionalProperties === false,
        `${path}: additionalProperties must be false.`,
      );
      const keys = Object.keys(value.properties);
      propertyCount += keys.length;
      requireCondition(
        propertyCount <= protocolLimits.schemaProperties,
        `${path}: cumulative schema properties exceed 128.`,
      );
      if (own(value, "required")) {
        requireCondition(
          Array.isArray(value.required) &&
            value.required.every(
              (key) =>
                typeof key === "string" && own(value.properties as object, key),
            ),
          `${path}: required must name declared properties.`,
        );
        requireCondition(
          new Set(value.required).size === value.required.length,
          `${path}: duplicate required property.`,
        );
      }
      for (const key of keys)
        visit(value.properties[key], depth + 1, `${path}.properties.${key}`);
    }
  }
  visit(input, 1, "$schema");
  return input as JsonSchema;
}

/** Pure validation: preserve the actual value, with no defaults or coercion. */
export function validateOperationValue(
  schemaInput: unknown,
  value: unknown,
): JsonValue {
  const schema = parseOperationSchema(schemaInput);
  requireJson(value, {
    bytes: protocolLimits.valueBytes,
    label: "Value",
    depth: protocolLimits.valueDepth,
    nodes: protocolLimits.valueNodes,
  });
  function visit(current: JsonSchema, actual: JsonValue, path: string) {
    requireCondition(
      matchesType(current.type, actual),
      `${path}: value must match ${current.type}.`,
    );
    if (current.enum)
      requireCondition(
        current.enum.some((allowed) => sameJson(allowed, actual)),
        `${path}: value is not in enum.`,
      );
    switch (current.type) {
      case "string": {
        const length = [...(actual as string)].length;
        requireCondition(
          current.minLength === undefined || length >= current.minLength,
          `${path}: string is too short.`,
        );
        requireCondition(
          current.maxLength === undefined || length <= current.maxLength,
          `${path}: string is too long.`,
        );
        break;
      }
      case "number":
      case "integer":
        requireCondition(
          current.minimum === undefined ||
            (actual as number) >= current.minimum,
          `${path}: number is below minimum.`,
        );
        requireCondition(
          current.maximum === undefined ||
            (actual as number) <= current.maximum,
          `${path}: number is above maximum.`,
        );
        break;
      case "array": {
        const items = actual as readonly JsonValue[];
        requireCondition(
          current.minItems === undefined || items.length >= current.minItems,
          `${path}: array is too short.`,
        );
        requireCondition(
          current.maxItems === undefined || items.length <= current.maxItems,
          `${path}: array is too long.`,
        );
        items.forEach((item, index) =>
          visit(current.items, item, `${path}[${index}]`),
        );
        break;
      }
      case "object": {
        const object = actual as { readonly [key: string]: JsonValue };
        for (const key of current.required ?? [])
          requireCondition(
            own(object, key),
            `${path}: missing required property ${key}.`,
          );
        for (const key of Object.keys(object)) {
          requireCondition(
            own(current.properties, key),
            `${path}: undeclared property ${key}.`,
          );
          visit(current.properties[key]!, object[key]!, `${path}.${key}`);
        }
        break;
      }
    }
  }
  visit(schema, value, "$value");
  return value;
}

const name = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.trim().length > 0);
const exactVersion = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+$/);
const reference = z.string().min(1).max(protocolLimits.referenceLength);
const operationShape = z
  .object({
    id: reference,
    title: name,
    description: z.string().max(500),
    effect: z.enum(["read", "write", "execute"]),
    scope: z.enum(["project", "objects"]),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
  })
  .strict();
const definitionShape = z
  .object({
    format: z.literal(cognitiveAppFormat),
    protocol: z.literal(domainProtocol),
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    version: exactVersion,
    title: name,
    description: z.string().max(500),
    icon: z.enum(["layers", "document", "globe", "code", "book", "film"]),
    iconImage: z
      .string()
      .max(180000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
      .optional(),
    harness: z.object({ id: name, version: name }).strict().nullable(),
    ui: z
      .object({
        packageVersion: exactVersion,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    operations: z.array(operationShape).max(protocolLimits.operations),
  })
  .strict();

/** The definition's version identity is declaration data, not an installation. */
export function parseCognitiveAppDefinition(
  input: unknown,
): CognitiveAppDefinition {
  requireJson(input, {
    bytes: protocolLimits.definitionBytes,
    label: "Definition",
  });
  const definition = definitionShape.parse(input);
  requireCondition(
    new Set(definition.operations.map((operation) => operation.id)).size ===
      definition.operations.length,
    "Operation IDs must be unique.",
  );
  requireCondition(
    definition.ui === null ||
      definition.ui.packageVersion === definition.version,
    "UI packageVersion must equal the cognitive application version in v1.",
  );
  return {
    ...definition,
    operations: definition.operations.map((operation) => ({
      ...operation,
      inputSchema: parseOperationSchema(operation.inputSchema),
      outputSchema: parseOperationSchema(operation.outputSchema),
    })),
  };
}

/** Explicit resources do not prove existence, ownership or authorization. */
export function parseOperationResources(
  scope: OperationScope,
  input: unknown,
): readonly OperationResourceReference[] {
  z.enum(["project", "objects"]).parse(scope);
  requireJson(input, {
    bytes: protocolLimits.definitionBytes,
    label: "Resources",
  });
  const resources = z
    .array(z.object({ objectId: reference, versionRef: reference }).strict())
    .max(protocolLimits.resources)
    .parse(input);
  requireCondition(
    scope !== "objects" || resources.length > 0,
    "Objects scope requires explicit resources.",
  );
  requireCondition(
    new Set(resources.map((resource) => resource.objectId)).size ===
      resources.length,
    "Resource object IDs must be unique.",
  );
  return resources;
}
