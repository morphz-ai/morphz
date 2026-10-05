import { z } from "zod";
import {
  CognitiveAppProtocolError,
  domainProtocol,
  isPortableText,
  parseOperationResources,
  parseProtocolValue,
  parseWireJson,
  type JsonValue,
  type OperationDefinition,
  type OperationResourceReference,
  type OperationScope,
} from "./protocol.js";

// This is the author wire contract, not authentication, transport or a dispatcher.
export const domainWireLimits = Object.freeze({
  bytes: 512 * 1024,
  depth: 40,
  nodes: 32768,
  receiptSummaryBytes: 64 * 1024,
  objectReadBytes: 256 * 1024,
} as const);
type Effect = OperationDefinition["effect"];
const internalId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const portableText = z.string().refine(isPortableText, {
  error: "Persistent text must contain no NUL or unpaired UTF-16 surrogate.",
});
const opaque = portableText.min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+$/);
const timestamp = z.string().max(64).pipe(z.iso.datetime());
const kind = portableText
  .min(1)
  .max(100)
  .refine((value) => value.trim().length > 0);
const title = portableText
  .min(1)
  .max(180)
  .refine((value) => value.trim().length > 0);
const definitionShape = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    version,
    definitionHash: hash,
  })
  .strict();
const authorityShape = definitionShape
  .extend({
    instanceId: internalId,
    serviceId: opaque,
    dataAuthorityId: opaque,
  })
  .strict();
export type DomainDefinitionReference = Readonly<
  z.infer<typeof definitionShape>
>;
export type DomainAuthorityReference = Readonly<z.infer<typeof authorityShape>>;

const humanSourceShape = z.object({ kind: z.literal("human") }).strict();
const agentSourceShape = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("input"),
      inputId: internalId,
      humanActantId: internalId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("task-run"),
      sessionId: internalId,
      scheduleId: internalId,
      eventId: internalId,
      sourceInputId: internalId.nullable(),
      humanActantId: internalId,
    })
    .strict(),
]);
const actorFields = {
  tenantId: internalId,
  principalId: internalId,
  actantId: internalId,
};
const actorShape = z.discriminatedUnion("kind", [
  z
    .object({
      ...actorFields,
      kind: z.literal("human"),
      source: humanSourceShape,
    })
    .strict(),
  z
    .object({
      ...actorFields,
      kind: z.literal("agent"),
      source: agentSourceShape,
    })
    .strict(),
]);
export type DomainActor = Readonly<z.infer<typeof actorShape>>;
const resourceShape = z
  .object({ objectId: opaque, versionRef: opaque })
  .strict();
const resourceArrayShape = z.array(resourceShape).max(32);
const commandShape = z
  .object({ commandId: internalId, requestHash: hash })
  .strict();
const delegationFields = {
  issuer: opaque,
  expiresAt: timestamp,
  authority: authorityShape,
  actor: actorShape,
  projectId: internalId,
};
const invocationDelegationShape = z
  .object({
    ...delegationFields,
    purpose: z.literal("invoke"),
    operationId: opaque,
    resources: resourceArrayShape,
    command: commandShape.nullable(),
  })
  .strict();
const objectDelegationShape = z
  .object({
    ...delegationFields,
    purpose: z.literal("object-read"),
    resource: resourceShape,
  })
  .strict();
const recoveryDelegationShape = z
  .object({
    ...delegationFields,
    purpose: z.literal("receipt-recovery"),
    originalOperationId: opaque,
    originalResources: resourceArrayShape,
    historicalAdmission: commandShape,
  })
  .strict();
export type InvocationDelegation = Readonly<
  z.infer<typeof invocationDelegationShape>
>;
export type ObjectReadDelegation = Readonly<
  z.infer<typeof objectDelegationShape>
>;
export type ReceiptRecoveryDelegation = Readonly<
  z.infer<typeof recoveryDelegationShape>
>;

const describeRequestShape = z
  .object({
    protocol: z.literal(domainProtocol),
    definition: definitionShape,
  })
  .strict();
const describeResponseShape = describeRequestShape
  .extend({
    serviceId: opaque,
    dataAuthorityId: opaque,
  })
  .strict();
const invokeRequestShape = z
  .object({
    protocol: z.literal(domainProtocol),
    delegation: invocationDelegationShape,
    parameters: z.unknown(),
  })
  .strict();
const objectReadRequestShape = z
  .object({
    protocol: z.literal(domainProtocol),
    delegation: objectDelegationShape,
    object: resourceShape,
    maxBytes: z.number().int().min(1).max(domainWireLimits.objectReadBytes),
  })
  .strict();
const receiptReadRequestShape = z
  .object({
    protocol: z.literal(domainProtocol),
    delegation: recoveryDelegationShape,
  })
  .strict();
export type DomainDescribeRequest = Readonly<
  z.infer<typeof describeRequestShape>
>;
export type DomainDescribeResponse = Readonly<
  z.infer<typeof describeResponseShape>
>;
export type DomainInvokeRequest = Readonly<
  Omit<z.infer<typeof invokeRequestShape>, "parameters">
> & { readonly parameters: JsonValue };
export type DomainObjectReadRequest = Readonly<
  z.infer<typeof objectReadRequestShape>
>;
export type DomainReceiptReadRequest = Readonly<
  z.infer<typeof receiptReadRequestShape>
>;

const receiptBindingShape = z
  .object({
    authority: authorityShape,
    actor: actorShape,
    projectId: internalId,
    operationId: opaque,
    ...commandShape.shape,
  })
  .strict();
export type DomainReceiptBinding = Readonly<
  z.infer<typeof receiptBindingShape>
>;
const summaryShape = resourceShape.extend({ kind, title }).strict();
export type DomainObjectSummary = Readonly<z.infer<typeof summaryShape>>;
const reasonShape = z
  .object({ code: kind, message: portableText.max(500) })
  .strict();
const receiptFields = {
  protocol: z.literal(domainProtocol),
  binding: receiptBindingShape,
};
const committedShape = z
  .object({
    ...receiptFields,
    status: z.literal("committed"),
    receiptId: opaque,
    committedAt: timestamp,
    result: z.unknown(),
    objects: z.array(summaryShape).max(32),
  })
  .strict();
const receiptShape = z.discriminatedUnion("status", [
  committedShape,
  z
    .object({
      ...receiptFields,
      status: z.literal("rejected"),
      receiptId: opaque,
      reason: reasonShape,
    })
    .strict(),
  z
    .object({
      ...receiptFields,
      status: z.literal("unknown"),
      reason: reasonShape,
    })
    .strict(),
]);
export type DomainCommittedReceipt = Readonly<
  Omit<z.infer<typeof committedShape>, "result">
> & { readonly result: JsonValue };
export type DomainReceipt =
  | DomainCommittedReceipt
  | Exclude<z.infer<typeof receiptShape>, { status: "committed" }>;
const readResultShape = z
  .object({
    protocol: z.literal(domainProtocol),
    authority: authorityShape,
    operationId: opaque,
    result: z.unknown(),
  })
  .strict();
export type DomainReadResult = Readonly<
  Omit<z.infer<typeof readResultShape>, "result">
> & { readonly result: JsonValue };
export type DomainReadBinding = Pick<
  DomainReceiptBinding,
  "authority" | "operationId"
>;
const objectContentShape = z.discriminatedUnion("format", [
  z.object({ format: z.literal("json"), value: z.unknown() }).strict(),
  z.object({ format: z.literal("markdown"), text: z.string() }).strict(),
  z.object({ format: z.literal("text"), text: z.string() }).strict(),
]);
const objectReadResponseShape = z
  .object({
    protocol: z.literal(domainProtocol),
    authority: authorityShape,
    object: resourceShape,
    kind,
    title,
    content: objectContentShape,
  })
  .strict();
export type DomainObjectReadResponse = Readonly<
  Omit<z.infer<typeof objectReadResponseShape>, "content">
> & {
  readonly content:
    | { readonly format: "json"; readonly value: JsonValue }
    | { readonly format: "markdown" | "text"; readonly text: string };
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CognitiveAppProtocolError(message);
}
/** Deterministic UTF-16 key order, finite JS numbers, no locale or numeric coercion.
 * This is not a promise of the entire RFC 8785 or arbitrary-precision JSON.
 */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`)
    .join(",")}}`;
}

/** Fixed-budget deterministic JSON bytes only; hashing and authentication are external. */
export function canonicalJsonBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonical(parseWireJson(input)));
}
function match(actual: unknown, expected: unknown, label: string) {
  check(
    canonical(parseWireJson(actual)) === canonical(parseWireJson(expected)),
    `${label} does not match the exact request binding.`,
  );
}
function uniqueObjects(objects: readonly OperationResourceReference[]) {
  check(
    new Set(objects.map((object) => object.objectId)).size === objects.length,
    "Object IDs must be unique, including across different versions.",
  );
}

export function parseDomainActor(input: unknown): DomainActor {
  parseWireJson(input);
  return actorShape.parse(input);
}
export function parseDomainAuthority(input: unknown): DomainAuthorityReference {
  parseWireJson(input);
  return authorityShape.parse(input);
}
export function parseDescribeRequest(input: unknown): DomainDescribeRequest {
  parseWireJson(input);
  return describeRequestShape.parse(input);
}
export function parseDescribeResponse(
  input: unknown,
  expected?: DomainDescribeRequest,
): DomainDescribeResponse {
  parseWireJson(input);
  const response = describeResponseShape.parse(input);
  if (expected)
    match(
      response.definition,
      parseDescribeRequest(expected).definition,
      "Definition",
    );
  return response;
}

/** Effect/scope come from the accepted immutable operation, not wire parameters. */
export function parseInvokeRequest(
  input: unknown,
  effect: Effect,
  scope: OperationScope,
): DomainInvokeRequest {
  z.enum(["read", "write", "execute"]).parse(effect);
  parseWireJson(input);
  const request = invokeRequestShape.parse(input);
  check(
    (effect === "read") === (request.delegation.command === null),
    "Read operations have no command; write/execute require commandId and requestHash.",
  );
  parseOperationResources(scope, request.delegation.resources);
  return { ...request, parameters: parseProtocolValue(request.parameters) };
}

/** Returns facts claimed by the service; authentication and ACL remain external. */
export function parseDomainReceipt(
  input: unknown,
  expected?: DomainReceiptBinding,
): DomainReceipt {
  parseWireJson(input);
  const receipt = receiptShape.parse(input);
  if (expected) {
    parseWireJson(expected);
    match(receipt.binding, receiptBindingShape.parse(expected), "Receipt");
  }
  if (receipt.status === "rejected")
    check(
      receipt.reason.code !== "not_seen",
      "not_seen is only an unknown reason, not proof of rejection.",
    );
  if (receipt.status !== "committed") return receipt;
  uniqueObjects(receipt.objects);
  check(
    new TextEncoder().encode(JSON.stringify(receipt.objects)).byteLength <=
      domainWireLimits.receiptSummaryBytes,
    "Receipt summaries exceed their UTF-8 byte budget.",
  );
  // Output-schema failure is separate from an otherwise validated committed fact.
  return { ...receipt, result: parseProtocolValue(receipt.result) };
}

export function parseInvokeResponse(
  input: unknown,
  effect: "read",
  expected?: DomainReadBinding,
): DomainReadResult;
export function parseInvokeResponse(
  input: unknown,
  effect: "write" | "execute",
  expected?: DomainReceiptBinding,
): DomainReceipt;
export function parseInvokeResponse(
  input: unknown,
  effect: Effect,
  expected?: DomainReadBinding | DomainReceiptBinding,
): DomainReadResult | DomainReceipt;
export function parseInvokeResponse(
  input: unknown,
  effect: Effect,
  expected?: DomainReadBinding | DomainReceiptBinding,
): DomainReadResult | DomainReceipt {
  z.enum(["read", "write", "execute"]).parse(effect);
  if (effect !== "read")
    return parseDomainReceipt(
      input,
      expected as DomainReceiptBinding | undefined,
    );
  parseWireJson(input);
  const response = readResultShape.parse(input);
  if (expected) {
    parseWireJson(expected);
    const binding = z
      .object({ authority: authorityShape, operationId: opaque })
      .strict()
      .parse(expected);
    match(
      { authority: response.authority, operationId: response.operationId },
      binding,
      "Read result",
    );
  }
  return { ...response, result: parseProtocolValue(response.result) };
}

export function parseObjectReadRequest(
  input: unknown,
): DomainObjectReadRequest {
  parseWireJson(input);
  const request = objectReadRequestShape.parse(input);
  match(request.object, request.delegation.resource, "Exact object");
  return request;
}
export function parseObjectReadResponse(
  input: unknown,
  expected?: DomainObjectReadRequest,
): DomainObjectReadResponse {
  parseWireJson(input);
  const response = objectReadResponseShape.parse(input);
  const request = expected ? parseObjectReadRequest(expected) : null;
  if (request) {
    match(response.authority, request.delegation.authority, "Object authority");
    match(response.object, request.object, "Exact object");
  }
  const content =
    response.content.format === "json"
      ? {
          format: "json" as const,
          value: parseProtocolValue(response.content.value),
        }
      : response.content;
  const contentBytes = new TextEncoder().encode(
    content.format === "json" ? JSON.stringify(content.value) : content.text,
  ).byteLength;
  check(
    contentBytes <= (request?.maxBytes ?? domainWireLimits.objectReadBytes),
    "Exact object content exceeds its UTF-8 byte budget.",
  );
  return { ...response, content };
}

/** Historical admission is an explicit purpose, never a new Human invocation. */
export function parseReceiptReadRequest(
  input: unknown,
): DomainReceiptReadRequest {
  parseWireJson(input);
  const request = receiptReadRequestShape.parse(input);
  parseOperationResources("project", request.delegation.originalResources);
  return request;
}

/** Semantic bytes only. The caller computes a hash and persists it with commandId.
 * Issuer/expiry and the independent command/hash pair are intentionally excluded.
 */
export function canonicalInvokeIdentityBytes(
  input: unknown,
  effect: Effect,
  scope: OperationScope,
): Uint8Array {
  const request = parseInvokeRequest(input, effect, scope);
  const { authority, actor, projectId, operationId, resources } =
    request.delegation;
  const identity = {
    protocol: request.protocol,
    authority,
    actor,
    projectId,
    operationId,
    parameters: request.parameters,
    resources,
  };
  return canonicalJsonBytes(identity);
}
