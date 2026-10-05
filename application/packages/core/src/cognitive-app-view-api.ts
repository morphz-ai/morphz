import { z } from "zod";
import {
  isPortableText,
  parseCognitiveAppDefinition,
  parseUiInstallJson,
  parseWireJson,
  type CognitiveAppDefinition,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  parseDomainAuthority,
  type DomainAuthorityReference,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import {
  parseBrowserNavigationState,
  type BrowserNavigationState,
} from "../../cognitive-app-sdk/src/browser-wire.js";
import {
  applicationManifestSchema,
  type ApplicationManifest,
} from "./applications.js";

// Human window lifecycle only. These locators are not caller authority or a
// guest wire protocol; authenticated ingress supplies the actual Human actor.
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
const premise = revision.or(z.literal(0));
const timestamp = z.string().max(64).pipe(z.iso.datetime());
const target = z.object({
  projectId: id,
  appId,
  version,
  connectionId: id,
  expectedDefinitionHash: hash.optional(),
  expectedGrantRevision: revision.optional(),
  expectedConnectionRevision: revision.optional(),
});
const cas = z.object({
  viewId: id,
  expectedViewRevision: revision,
  expectedBindingRevision: revision,
});
const schemas = {
  launch: target
    .extend({
      commandId: id,
      expectedViewRevision: premise,
      expectedBindingRevision: premise,
    })
    .strict(),
  bind: target
    .extend({
      viewId: id,
      commandId: id,
      expectedViewRevision: revision,
      expectedBindingRevision: premise,
    })
    .strict(),
  read: z.object({ viewId: id }).strict(),
  readUi: cas.strict(),
  save: cas.extend({ commandId: id, state: z.unknown() }).strict(),
  close: cas.extend({ commandId: id }).strict(),
};
export type CognitiveAppViewMethod = keyof typeof schemas;
export type CognitiveAppViewRequestMap = {
  [M in Exclude<CognitiveAppViewMethod, "save">]: z.infer<(typeof schemas)[M]>;
} & {
  save: Omit<z.infer<typeof schemas.save>, "state"> & {
    state: BrowserNavigationState;
  };
};
const mutation = z
  .object({
    receipt: z
      .object({ viewId: id, viewRevision: revision, bindingRevision: revision })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();
const viewShape = z
  .object({
    id,
    workspaceId: id,
    applicationId: appId,
    applicationVersion: version,
    revision,
    state: z.unknown(),
    status: z.enum(["open", "closed"]),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
const bindingShape = z
  .object({
    appId,
    version,
    instanceId: id,
    serviceId: opaque,
    dataAuthorityId: opaque,
    viewId: id,
    projectId: id,
    connectionId: id,
    revision,
    viewRevision: revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
const metadataShape = z
  .object({ view: viewShape, binding: bindingShape })
  .strict();
const uiShape = metadataShape
  .extend({
    manifest: z.unknown(),
    definition: z.unknown(),
    authority: z.unknown(),
    grantRevision: revision,
    connectionRevision: revision,
  })
  .strict();
export type CognitiveAppViewMutation = z.infer<typeof mutation>;
export type CognitiveAppViewMetadata = {
  view: Omit<z.infer<typeof viewShape>, "state"> & {
    state: BrowserNavigationState;
  };
  binding: z.infer<typeof bindingShape>;
};
export type CognitiveAppViewUi = CognitiveAppViewMetadata & {
  manifest: ApplicationManifest;
  definition: CognitiveAppDefinition;
  authority: DomainAuthorityReference;
  grantRevision: number;
  connectionRevision: number;
};
export type CognitiveAppViewResponseMap = {
  launch: CognitiveAppViewMutation;
  bind: CognitiveAppViewMutation;
  read: CognitiveAppViewMetadata;
  readUi: CognitiveAppViewUi;
  save: CognitiveAppViewMutation;
  close: CognitiveAppViewMutation;
};
function detached(input: unknown, ui = false): unknown {
  // The UI carrier alone needs the fixed 8MiB JSON-escaping budget. Exact HTML
  // still has its independent 1,000,000 UTF-8 byte limit below, not 8MiB.
  return JSON.parse(
    JSON.stringify(ui ? parseUiInstallJson(input) : parseWireJson(input)),
  );
}
function check(value: unknown): asserts value {
  if (!value)
    throw new Error("Window data differs from its fixed public binding.");
}
export function parseCognitiveAppViewRequest<M extends CognitiveAppViewMethod>(
  method: M,
  input: unknown,
): CognitiveAppViewRequestMap[M] {
  const request = schemas[method].parse(detached(input));
  if (method === "save") {
    const save = request as z.infer<typeof schemas.save>;
    return {
      ...save,
      state: parseBrowserNavigationState(save.state),
    } as CognitiveAppViewRequestMap[M];
  }
  return request as CognitiveAppViewRequestMap[M];
}
function metadata(input: unknown): CognitiveAppViewMetadata {
  const value = metadataShape.parse(input);
  const { view, binding } = value;
  check(
    binding.viewId === view.id &&
      binding.projectId === view.workspaceId &&
      binding.appId === view.applicationId &&
      binding.version === view.applicationVersion &&
      binding.viewRevision === view.revision,
  );
  return {
    ...value,
    view: { ...view, state: parseBrowserNavigationState(view.state) },
  };
}
export function parseCognitiveAppViewResponse<M extends CognitiveAppViewMethod>(
  method: M,
  input: unknown,
): CognitiveAppViewResponseMap[M] {
  const safe = detached(input, method === "readUi");
  if (method === "read")
    return metadata(safe) as CognitiveAppViewResponseMap[M];
  if (method !== "readUi")
    return mutation.parse(safe) as CognitiveAppViewResponseMap[M];
  const response = uiShape.parse(safe);
  const current = metadata({ view: response.view, binding: response.binding });
  const definition = parseCognitiveAppDefinition(response.definition);
  const authority = parseDomainAuthority(response.authority);
  const manifest = applicationManifestSchema.parse(response.manifest);
  check(definition.ui !== null && manifest.ui.type === "sandbox");
  check(new TextEncoder().encode(manifest.ui.html).byteLength <= 1_000_000);
  check(current.view.status === "open");
  check(
    definition.id === current.binding.appId &&
      definition.version === current.binding.version &&
      authority.appId === current.binding.appId &&
      authority.version === current.binding.version &&
      authority.instanceId === current.binding.instanceId &&
      authority.serviceId === current.binding.serviceId &&
      authority.dataAuthorityId === current.binding.dataAuthorityId &&
      definition.ui.packageVersion === manifest.version &&
      manifest.id === definition.id &&
      manifest.version === definition.version &&
      manifest.title === definition.title &&
      manifest.description === definition.description &&
      manifest.icon === definition.icon &&
      manifest.iconImage === definition.iconImage &&
      JSON.stringify(manifest.harness) === JSON.stringify(definition.harness) &&
      manifest.permissions.every(
        (permission) => permission === "input.compose",
      ),
  );
  // A parser cannot prove byte SHA/authorization. Only readCognitive's actual
  // Store read, immutable metadata and before/after gate can supply that fact.
  return {
    ...current,
    manifest,
    definition,
    authority,
    grantRevision: response.grantRevision,
    connectionRevision: response.connectionRevision,
  } as CognitiveAppViewResponseMap[M];
}
