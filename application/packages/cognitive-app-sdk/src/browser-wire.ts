import { z } from "zod";
import {
  CognitiveAppProtocolError,
  isPortableText,
  parseCognitiveAppDefinition,
  parseOperationResources,
  parseProtocolValue,
  parseWireJson,
  validateOperationValue,
  type CognitiveAppDefinition,
  type JsonValue,
  type OperationResourceReference,
} from "./protocol.js";
import {
  canonicalJsonBytes,
  parseDomainAuthority,
  parseInvokeResponse,
  parseObjectReadResponse,
  type DomainAuthorityReference,
  type DomainObjectReadResponse,
  type DomainObjectSummary,
  type DomainReadResult,
} from "./domain-wire.js";

/** Pure UI wire only. Valid data is not an authorization or completion proof. */
export const cognitiveBrowserProtocol = "morphz-cognitive-ui/v1" as const;
export const cognitiveBrowserLimits = Object.freeze({
  pending: 16,
  deadlineMs: 30_000,
} as const);
export const cognitiveBrowserCommandStates = Object.freeze([
  "admitted",
  "dispatching",
  "unknown",
  "committed",
  "rejected",
  "cancelled",
] as const);
export type BrowserCommandState =
  (typeof cognitiveBrowserCommandStates)[number];
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const opaque = z.string().min(1).max(200).refine(isPortableText);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const timestamp = z.string().max(64).pipe(z.iso.datetime());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resource = z.object({ objectId: opaque, versionRef: opaque }).strict();
const navigation = z
  .object({
    object: resource.optional(),
    view: z.string().max(100).refine(isPortableText).optional(),
  })
  .strict();
export type BrowserNavigationState = {
  readonly object?: OperationResourceReference;
  readonly view?: string;
};
const contextShape = z
  .object({
    definition: z.unknown(),
    authority: z.unknown(),
    view: z
      .object({
        id,
        revision,
        bindingRevision: revision,
        active: z.boolean(),
        state: navigation,
      })
      .strict(),
    ui: z.object({ compose: z.boolean() }).strict(),
    theme: z
      .object({
        appearance: z.enum(["system", "light", "dark"]),
        accent: z.enum(["cyan", "iris", "coral", "mono"]),
      })
      .strict(),
    presentation: z
      .object({
        mode: z.enum(["workspace", "immersive"]),
        returnControl: z
          .object({
            left: z.number().finite().min(0),
            top: z.number().finite().min(0),
            width: z.number().finite().min(0),
            height: z.number().finite().min(0),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type BrowserContext = {
  readonly definition: CognitiveAppDefinition;
  readonly authority: DomainAuthorityReference;
  readonly view: Readonly<
    Omit<z.infer<typeof contextShape>["view"], "state">
  > & { readonly state: BrowserNavigationState };
  readonly ui: Readonly<z.infer<typeof contextShape>["ui"]>;
  readonly theme: Readonly<z.infer<typeof contextShape>["theme"]>;
  readonly presentation: {
    readonly mode: "workspace" | "immersive";
    readonly returnControl: Readonly<
      NonNullable<z.infer<typeof contextShape>["presentation"]["returnControl"]>
    > | null;
  };
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CognitiveAppProtocolError(message);
}
function detached(input: unknown): unknown {
  return JSON.parse(JSON.stringify(parseWireJson(input)));
}
export function parseBrowserNavigationState(
  input: unknown,
): BrowserNavigationState {
  return navigation.parse(detached(input));
}
function same(actual: unknown, expected: unknown) {
  check(
    new TextDecoder().decode(canonicalJsonBytes(actual)) ===
      new TextDecoder().decode(canonicalJsonBytes(expected)),
    "Browser response does not match its original scope.",
  );
}
export function parseBrowserContext(input: unknown): BrowserContext {
  const context = contextShape.parse(detached(input));
  const definition = parseCognitiveAppDefinition(context.definition);
  const authority = parseDomainAuthority(context.authority);
  check(
    definition.ui !== null,
    "A cognitive browser view requires its exact optional UI definition.",
  );
  check(
    definition.id === authority.appId &&
      definition.version === authority.version,
    "Browser context definition differs from its fixed authority.",
  );
  return { ...context, definition, authority };
}

const requestShape = z.discriminatedUnion("method", [
  z.object({ method: z.literal("ready") }).strict(),
  z
    .object({
      method: z.literal("invoke"),
      operationId: opaque,
      parameters: z.unknown(),
      resources: z.array(resource).max(32),
      commandId: id.nullable(),
    })
    .strict(),
  z
    .object({
      method: z.literal("readObject"),
      object: resource,
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
  z.object({ method: z.literal("openObject"), object: resource }).strict(),
  z
    .object({
      method: z.literal("compose"),
      text: z.string().max(30_000),
      object: resource.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("saveState"),
      expectedRevision: revision,
      state: navigation,
    })
    .strict(),
  z.object({ method: z.literal("commandStatus"), commandId: id }).strict(),
  z.object({ method: z.literal("recoverReceipt"), commandId: id }).strict(),
]);
type RequestShape = z.infer<typeof requestShape>;
export type BrowserRequest =
  | Exclude<RequestShape, { method: "invoke" }>
  | {
      readonly method: "invoke";
      readonly operationId: string;
      readonly parameters: JsonValue;
      readonly resources: readonly OperationResourceReference[];
      readonly commandId: string | null;
    };
export type BrowserMethod = BrowserRequest["method"];
export type BrowserRequestFor<M extends BrowserMethod> = Extract<
  BrowserRequest,
  { method: M }
>;
function requestWire(input: unknown): BrowserRequest {
  const request = requestShape.parse(detached(input));
  return request.method === "invoke"
    ? {
        ...request,
        parameters: parseProtocolValue(request.parameters),
        resources: parseOperationResources("project", request.resources),
      }
    : request;
}
export function parseBrowserRequest(
  input: unknown,
  context: BrowserContext,
): BrowserRequest {
  const request = requestWire(input);
  if (request.method !== "invoke") return request;
  const operation = context.definition.operations.find(
    (item) => item.id === request.operationId,
  );
  check(operation, "Operation is absent from the exact browser definition.");
  check(
    (operation.effect === "read") === (request.commandId === null),
    "Read requires commandId:null; write/execute require an explicit original commandId.",
  );
  return {
    ...request,
    parameters: validateOperationValue(
      operation.inputSchema,
      request.parameters,
    ),
    resources: parseOperationResources(operation.scope, request.resources),
  };
}

const summary = resource
  .extend({
    kind: z
      .string()
      .min(1)
      .max(100)
      .refine(isPortableText)
      .refine((value) => value.trim().length > 0),
    title: z
      .string()
      .min(1)
      .max(180)
      .refine(isPortableText)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
const summaries = z.array(summary).max(32);
const factsShape = z
  .object({
    commandId: id,
    operationId: opaque,
    effect: z.enum(["write", "execute"]),
    state: z.enum(cognitiveBrowserCommandStates),
    revision,
    projectionState: z.enum(["none", "pending", "projected"]),
    receiptRef: opaque.nullable(),
    receiptHash: hash.nullable(),
    committedAt: timestamp.nullable(),
    objects: summaries.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
/** Bounded projection of the existing ledger; no owner/source/connection secrets. */
export type BrowserCommandFacts = Readonly<
  Omit<z.infer<typeof factsShape>, "objects">
> & { readonly objects: readonly DomainObjectSummary[] | null };
const commandResultShape = z
  .object({
    kind: z.literal("command"),
    commandId: id,
    command: factsShape,
    result: z.unknown().optional(),
    contractIssue: z.literal("invalid-output").optional(),
    hostIssue: z
      .enum(["receipt-storage", "projection-pending", "unconfirmed"])
      .optional(),
    contentIds: z.array(id).max(32).optional(),
    observedCommitted: z
      .object({
        receiptId: opaque,
        receiptHash: hash,
        committedAt: timestamp,
        objects: summaries,
      })
      .strict()
      .optional(),
    persistence: z.literal("pending").optional(),
  })
  .strict();
export type BrowserCommandResult = Readonly<
  Omit<z.infer<typeof commandResultShape>, "result" | "command">
> & { readonly command: BrowserCommandFacts; readonly result?: JsonValue };
export type BrowserResultMap = {
  ready: BrowserContext;
  invoke: DomainReadResult | BrowserCommandResult;
  readObject: DomainObjectReadResponse;
  /** A received acknowledgement of actual original publication. Navigation may
   * destroy the source Document, so delivery/continuation is not guaranteed. */
  openObject: {
    readonly opened: true;
    readonly object: OperationResourceReference;
  };
  compose: { readonly prepared: true };
  saveState: {
    readonly revision: number;
    readonly state: BrowserNavigationState;
  };
  commandStatus: BrowserCommandFacts;
  recoverReceipt: BrowserCommandResult;
};
function validateSummaries(objects: readonly DomainObjectSummary[]) {
  check(
    new Set(objects.map((object) => object.objectId)).size === objects.length,
    "Receipt summaries contain duplicate object IDs.",
  );
  check(
    new TextEncoder().encode(JSON.stringify(objects)).byteLength <= 64 * 1024,
    "Receipt summaries exceed their fixed budget.",
  );
}
export function parseBrowserCommandFacts(input: unknown): BrowserCommandFacts {
  const command = factsShape.parse(detached(input));
  const hasReceipt =
    command.receiptRef !== null && command.receiptHash !== null;
  if (command.state === "committed") {
    check(
      hasReceipt &&
        command.committedAt !== null &&
        command.objects !== null &&
        command.projectionState !== "none",
      "Committed ledger facts require their verified receipt and projection state.",
    );
    validateSummaries(command.objects);
  } else if (command.state === "rejected") {
    check(
      hasReceipt &&
        command.committedAt === null &&
        command.objects === null &&
        command.projectionState === "none",
      "Rejected facts must not imply an object commit.",
    );
  } else {
    check(
      command.receiptRef === null &&
        command.receiptHash === null &&
        command.committedAt === null &&
        command.objects === null &&
        command.projectionState === "none",
      "Unresolved/cancelled facts must not manufacture a receipt or commit.",
    );
  }
  return command;
}
function commandResult(
  input: unknown,
  commandId: string,
  context: BrowserContext,
): BrowserCommandResult {
  const response = commandResultShape.parse(detached(input));
  const command = parseBrowserCommandFacts(response.command);
  check(
    response.commandId === commandId && command.commandId === commandId,
    "Command result differs from the original command.",
  );
  const operation = context.definition.operations.find(
    (item) => item.id === command.operationId,
  );
  check(
    operation && operation.effect === command.effect,
    "Command is outside the exact view operation definition.",
  );
  if (response.observedCommitted) {
    validateSummaries(response.observedCommitted.objects);
    check(
      response.persistence === "pending" &&
        response.hostIssue === "receipt-storage",
      "Observed author commit must retain its unconfirmed Host persistence.",
    );
    check(
      command.state === "admitted" ||
        command.state === "dispatching" ||
        command.state === "unknown",
      "Unconfirmed author commit cannot replace an existing terminal ledger fact.",
    );
  } else
    check(
      response.persistence === undefined,
      "Pending persistence requires its separately observed committed fact.",
    );
  if (response.hostIssue === "projection-pending")
    check(
      command.state === "committed" && command.projectionState === "pending",
      "Pending projection cannot manufacture a committed command.",
    );
  if (response.hostIssue === "receipt-storage")
    check(
      response.observedCommitted !== undefined,
      "Receipt-storage requires its separately observed author fact.",
    );
  if (response.contentIds !== undefined)
    check(
      command.state === "committed" && command.projectionState === "projected",
      "Catalog deliveries require the actual completed Host projection.",
    );
  if (response.result !== undefined || response.contractIssue !== undefined)
    check(
      command.state === "committed" || response.observedCommitted !== undefined,
      "Output belongs only to an actual durable or separately observed author commit.",
    );
  const { result: rawResult, ...facts } = response;
  if (rawResult !== undefined) {
    const result = parseProtocolValue(rawResult);
    if (response.contractIssue !== "invalid-output")
      validateOperationValue(operation.outputSchema, result);
    return { ...facts, command, result };
  }
  return { ...facts, command };
}

export function parseBrowserResult<M extends BrowserMethod>(
  request: BrowserRequestFor<M>,
  input: unknown,
  context: BrowserContext,
): BrowserResultMap[M];
export function parseBrowserResult(
  request: BrowserRequest,
  input: unknown,
  context: BrowserContext,
): BrowserResultMap[BrowserMethod];
export function parseBrowserResult(
  request: BrowserRequest,
  input: unknown,
  context: BrowserContext,
): BrowserResultMap[BrowserMethod] {
  const raw = detached(input);
  switch (request.method) {
    case "ready": {
      const next = parseBrowserContext(raw);
      same(next.authority, context.authority);
      same(next.definition, context.definition);
      check(
        next.view.id === context.view.id &&
          next.view.bindingRevision === context.view.bindingRevision,
        "Ready cannot retarget an existing browser instance.",
      );
      return next;
    }
    case "invoke": {
      const operation = context.definition.operations.find(
        (item) => item.id === request.operationId,
      );
      check(operation, "Operation is absent from the exact definition.");
      if (operation.effect === "read") {
        check(request.commandId === null, "Read has no command.");
        const response = parseInvokeResponse(raw, "read", {
          authority: context.authority,
          operationId: request.operationId,
        });
        validateOperationValue(operation.outputSchema, response.result);
        return response;
      }
      check(
        request.commandId !== null,
        "Write requires its original command ID.",
      );
      const response = commandResult(raw, request.commandId, context);
      check(
        response.command.operationId === request.operationId &&
          response.command.effect === operation.effect,
        "Command result belongs to another operation.",
      );
      return response;
    }
    case "readObject": {
      const response = parseObjectReadResponse(raw);
      same(response.authority, context.authority);
      same(response.object, request.object);
      check(
        new TextEncoder().encode(
          response.content.format === "json"
            ? JSON.stringify(response.content.value)
            : response.content.text,
        ).byteLength <= request.maxBytes,
        "Object exceeds the requested bounded read.",
      );
      return response;
    }
    case "openObject": {
      const response = z
        .object({ opened: z.literal(true), object: resource })
        .strict()
        .parse(raw);
      same(response.object, request.object);
      return response;
    }
    case "compose":
      return z
        .object({ prepared: z.literal(true) })
        .strict()
        .parse(raw);
    case "saveState": {
      const response = z
        .object({ revision, state: navigation })
        .strict()
        .parse(raw);
      check(
        response.revision === request.expectedRevision + 1,
        "Saved view revision must acknowledge its exact CAS.",
      );
      same(response.state, request.state);
      return response;
    }
    case "commandStatus": {
      const command = parseBrowserCommandFacts(raw);
      check(
        command.commandId === request.commandId,
        "Status belongs to another command.",
      );
      const operation = context.definition.operations.find(
        (item) => item.id === command.operationId,
      );
      check(
        operation && operation.effect === command.effect,
        "Status is outside the exact view definition.",
      );
      return command;
    }
    case "recoverReceipt":
      return commandResult(raw, request.commandId, context);
  }
}

export const browserHostErrorCodes = Object.freeze([
  "invalid",
  "forbidden",
  "not_found",
  "conflict",
  "busy",
  "unavailable",
  "contract",
] as const);
export type BrowserHostErrorCode = (typeof browserHostErrorCodes)[number];
const errorShape = z
  .object({ code: z.enum(browserHostErrorCodes), commandId: id.optional() })
  .strict();
const messageShape = z.union([
  z.object({ type: z.literal(`${cognitiveBrowserProtocol}:connect`) }).strict(),
  z
    .object({
      type: z.literal(`${cognitiveBrowserProtocol}:init`),
      channel: uuid,
      context: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal(`${cognitiveBrowserProtocol}:retire`),
      channel: uuid,
    })
    .strict(),
  z
    .object({
      type: z.literal(`${cognitiveBrowserProtocol}:request`),
      channel: uuid,
      requestId: uuid,
      request: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal(`${cognitiveBrowserProtocol}:response`),
      channel: uuid,
      requestId: uuid,
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal(`${cognitiveBrowserProtocol}:response`),
      channel: uuid,
      requestId: uuid,
      ok: z.literal(false),
      error: errorShape,
    })
    .strict(),
]);
export type BrowserMessage =
  | Exclude<
      z.infer<typeof messageShape>,
      { type: "morphz-cognitive-ui/v1:init" | "morphz-cognitive-ui/v1:request" }
    >
  | {
      readonly type: "morphz-cognitive-ui/v1:init";
      readonly channel: string;
      readonly context: BrowserContext;
    }
  | {
      readonly type: "morphz-cognitive-ui/v1:request";
      readonly channel: string;
      readonly requestId: string;
      readonly request: BrowserRequest;
    };
export function parseBrowserMessage(input: unknown): BrowserMessage {
  const message = messageShape.parse(detached(input));
  if (message.type === "morphz-cognitive-ui/v1:init")
    return { ...message, context: parseBrowserContext(message.context) };
  if (message.type === "morphz-cognitive-ui/v1:request")
    return { ...message, request: requestWire(message.request) };
  return message;
}
