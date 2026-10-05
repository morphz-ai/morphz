import { z } from "zod";
import {
  domainProtocol,
  isPortableText,
  parseCognitiveAppDefinition,
  parseOperationResources,
  parseProtocolValue,
  parseUiInstallJson,
  parseWireJson,
  type CognitiveAppDefinition,
  type JsonValue,
  type OperationResourceReference,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  parseDomainAuthority,
  type DomainReadResult,
  type DomainObjectReadResponse,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import {
  parseBrowserCommandFacts,
  type BrowserCommandFacts,
  type BrowserCommandResult,
} from "../../cognitive-app-sdk/src/browser-wire.js";
import {
  applicationManifestSchema,
  type ApplicationManifest,
} from "./applications.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const appId = z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/);
const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(200).refine(isPortableText);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const timestamp = z.string().max(64).pipe(z.iso.datetime());
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const consent = z.object({
  appId,
  version,
  expectedDefinitionHash: hash.optional(),
  expectedGrantRevision: revision.optional(),
});
const target = consent.extend({
  projectId: id,
  connectionId: id,
  expectedConnectionRevision: revision.optional(),
});
const resource = z.object({ objectId: opaque, versionRef: opaque }).strict();
const commandTarget = z
  .object({
    projectId: id,
    appId,
    version,
    connectionId: id,
    commandId: id,
    expectedDefinitionHash: hash.optional(),
  })
  .strict();
const schemas = {
  list: z
    .object({
      limit: z.number().int().min(1).max(100),
      appId: appId.optional(),
      versionsAfter: cursor.optional(),
      connectionsAfter: cursor.optional(),
    })
    .strict(),
  describe: consent.extend({ projectId: id }).strict(),
  install: z
    .object({
      definition: z.unknown(),
      manifest: z.unknown().optional(),
      commandId: id.optional(),
    })
    .strict(),
  grant: z
    .object({
      appId,
      version,
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
      state: z.enum(["active", "disabled"]),
    })
    .strict(),
  connect: consent
    .extend({
      connectionId: id,
      expectedRevision: z.literal(0),
      serviceId: opaque,
      dataAuthorityId: opaque,
    })
    .strict(),
  connectionState: consent
    .extend({
      connectionId: id,
      expectedRevision: revision,
      state: z.enum(["active", "disabled", "unavailable"]),
    })
    .strict(),
  invoke: target
    .extend({
      operationId: opaque,
      parameters: z.unknown(),
      resources: z.unknown(),
      commandId: id.nullable(),
    })
    .strict(),
  readObject: target
    .extend({
      object: resource,
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
  commandStatus: commandTarget,
  recover: commandTarget,
};
export type CognitiveAppInstallRequest =
  | { definition: CognitiveAppDefinition; manifest?: never; commandId?: never }
  | {
      definition: CognitiveAppDefinition;
      manifest: ApplicationManifest;
      commandId: string;
    };
export type CognitiveAppRequestMap = {
  [K in Exclude<keyof typeof schemas, "install" | "invoke">]: z.infer<
    (typeof schemas)[K]
  >;
} & {
  install: CognitiveAppInstallRequest;
  invoke: Omit<z.infer<typeof schemas.invoke>, "parameters" | "resources"> & {
    parameters: JsonValue;
    resources: readonly OperationResourceReference[];
  };
};
export type CognitiveAppMethod = keyof CognitiveAppRequestMap;

/** Guards own data before serialization/parsing; accessors/toJSON never run.
 * Every request is an independent finite snapshot before any service await.
 */
export function parseCognitiveAppRequest<M extends CognitiveAppMethod>(
  method: M,
  input: unknown,
): CognitiveAppRequestMap[M] {
  const safe =
    method === "install" ? parseUiInstallJson(input) : parseWireJson(input);
  const detached: unknown = JSON.parse(JSON.stringify(safe));
  const request = schemas[method].parse(detached);
  if (method === "install") {
    const install = request as z.infer<typeof schemas.install>;
    const definition = parseCognitiveAppDefinition(install.definition);
    if (definition.ui === null) {
      if (install.manifest !== undefined || install.commandId !== undefined)
        throw new Error("Headless installation has no UI carrier.");
      return { definition } as CognitiveAppRequestMap[M];
    }
    if (install.commandId === undefined || install.manifest === undefined)
      throw new Error(
        "UI installation requires its original command and exact manifest.",
      );
    const manifest = applicationManifestSchema.parse(install.manifest);
    if (
      manifest.ui.type !== "sandbox" ||
      new TextEncoder().encode(manifest.ui.html).byteLength > 1_000_000
    )
      throw new Error("UI installation requires bounded HTML bytes.");
    return {
      definition,
      manifest,
      commandId: install.commandId,
    } as CognitiveAppRequestMap[M];
  }
  if (method === "invoke") {
    const invoke = request as z.infer<typeof schemas.invoke>;
    return {
      ...invoke,
      parameters: parseProtocolValue(invoke.parameters),
      resources: parseOperationResources("project", invoke.resources),
    } as CognitiveAppRequestMap[M];
  }
  return request as CognitiveAppRequestMap[M];
}

const grantShape = z
  .object({
    appId,
    version,
    state: z.enum(["active", "disabled"]),
    revision,
    consentedAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
const connectionShape = z
  .object({
    appId,
    instanceId: id,
    serviceId: opaque,
    dataAuthorityId: opaque,
    connectionId: id,
    state: z.enum(["active", "disabled", "unavailable"]),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
const metadataShape = z
  .object({
    appId,
    version,
    definitionHash: hash,
    title: z.string().min(1).max(100).refine(isPortableText),
    description: z.string().max(500).refine(isPortableText),
    icon: z.enum(["layers", "document", "globe", "code", "book", "film"]),
    harness: z
      .object({
        id: z.string().min(1).max(100).refine(isPortableText),
        version: z.string().min(1).max(100).refine(isPortableText),
      })
      .strict()
      .nullable(),
    ui: z.object({ packageVersion: version, sha256: hash }).strict().nullable(),
    grant: grantShape,
  })
  .strict();
const listShape = z
  .object({
    versions: z.array(metadataShape).max(100),
    connections: z.array(connectionShape).max(100),
    nextVersionsAfter: cursor.nullable(),
    nextConnectionsAfter: cursor.nullable(),
  })
  .strict();
const installedShape = z
  .object({ appId, version, definitionHash: hash })
  .strict();
const descriptionShape = z
  .object({
    definition: z.unknown(),
    definitionHash: hash,
    grantRevision: revision,
  })
  .strict();
export type CognitiveAppGrantDto = z.infer<typeof grantShape>;
export type CognitiveAppConnectionDto = z.infer<typeof connectionShape>;
export type CognitiveAppCatalogDto = z.infer<typeof listShape>;
export type CognitiveAppInstalledDto = z.infer<typeof installedShape>;
export type CognitiveAppDescriptionDto = {
  definition: CognitiveAppDefinition;
  definitionHash: string;
  grantRevision: number;
};
export type CognitiveAppInvokeResult = DomainReadResult | BrowserCommandResult;
export type CognitiveAppResponseMap = {
  list: CognitiveAppCatalogDto;
  describe: CognitiveAppDescriptionDto;
  install: CognitiveAppInstalledDto;
  grant: CognitiveAppGrantDto;
  connect: CognitiveAppConnectionDto;
  connectionState: CognitiveAppConnectionDto;
  invoke: CognitiveAppInvokeResult;
  readObject: DomainObjectReadResponse;
  commandStatus: BrowserCommandFacts;
  recover: BrowserCommandResult;
};
const summary = resource
  .extend({
    kind: z.string().min(1).max(100).refine(isPortableText),
    title: z.string().min(1).max(180).refine(isPortableText),
  })
  .strict();
const commandResultShape = z
  .object({
    kind: z.literal("command"),
    commandId: id,
    command: z.unknown(),
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
        objects: z.array(summary).max(32),
      })
      .strict()
      .optional(),
    persistence: z.literal("pending").optional(),
  })
  .strict();
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid public cognitive result.");
}
/** Headless command projection needs no fabricated BrowserContext. Operation
 * output-schema validation remains with Gateway's exact retained definition.
 */
export function parseCognitiveAppCommandResult(
  input: unknown,
): BrowserCommandResult {
  const parsed = commandResultShape.parse(
    JSON.parse(JSON.stringify(parseWireJson(input))),
  );
  const command = parseBrowserCommandFacts(parsed.command);
  check(parsed.commandId === command.commandId);
  if (parsed.observedCommitted) {
    check(
      parsed.persistence === "pending" &&
        parsed.hostIssue === "receipt-storage" &&
        ["admitted", "dispatching", "unknown"].includes(command.state),
    );
    check(
      new Set(parsed.observedCommitted.objects.map((o) => o.objectId)).size ===
        parsed.observedCommitted.objects.length,
    );
    check(
      new TextEncoder().encode(JSON.stringify(parsed.observedCommitted.objects))
        .byteLength <=
        64 * 1024,
    );
    check(
      parsed.observedCommitted.objects.every(
        (o) => o.kind.trim().length && o.title.trim().length,
      ),
    );
  } else
    check(
      parsed.persistence === undefined &&
        parsed.hostIssue !== "receipt-storage",
    );
  if (parsed.hostIssue === "projection-pending")
    check(
      command.state === "committed" && command.projectionState === "pending",
    );
  if (parsed.contentIds !== undefined)
    check(
      command.state === "committed" && command.projectionState === "projected",
    );
  if (parsed.result !== undefined || parsed.contractIssue !== undefined)
    check(
      command.state === "committed" || parsed.observedCommitted !== undefined,
    );
  return {
    ...parsed,
    command,
    ...(parsed.result === undefined
      ? {}
      : { result: parseProtocolValue(parsed.result) }),
  } as BrowserCommandResult;
}
export function parseCognitiveAppCatalog(
  input: unknown,
): CognitiveAppCatalogDto {
  const result = listShape.parse(
    JSON.parse(JSON.stringify(parseWireJson(input))),
  );
  for (const v of result.versions)
    check(
      v.appId === v.grant.appId &&
        v.version === v.grant.version &&
        (v.ui === null || v.ui.packageVersion === v.version),
    );
  return result;
}
export function parseCognitiveAppDescription(
  input: unknown,
): CognitiveAppDescriptionDto {
  const result = descriptionShape.parse(
    JSON.parse(JSON.stringify(parseWireJson(input))),
  );
  return {
    ...result,
    definition: parseCognitiveAppDefinition(result.definition),
  };
}
export const parseCognitiveAppInstalled = (
  input: unknown,
): CognitiveAppInstalledDto =>
  installedShape.parse(JSON.parse(JSON.stringify(parseWireJson(input))));
export const parseCognitiveAppGrant = (input: unknown): CognitiveAppGrantDto =>
  grantShape.parse(JSON.parse(JSON.stringify(parseWireJson(input))));
export const parseCognitiveAppConnection = (
  input: unknown,
): CognitiveAppConnectionDto =>
  connectionShape.parse(JSON.parse(JSON.stringify(parseWireJson(input))));
export function parseCognitiveAppReadResult(input: unknown): DomainReadResult {
  const parsed = z
    .object({
      protocol: z.literal(domainProtocol),
      authority: z.unknown(),
      operationId: opaque,
      result: z.unknown(),
    })
    .strict()
    .parse(JSON.parse(JSON.stringify(parseWireJson(input))));
  return {
    ...parsed,
    authority: parseDomainAuthority(parsed.authority),
    result: parseProtocolValue(parsed.result),
  };
}
