import { z } from "zod";
import {
  parseOperationResources,
  parseWireJson,
  type OperationResourceReference,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  parseDomainAuthority,
  type DomainAuthorityReference,
} from "../../cognitive-app-sdk/src/domain-wire.js";

/** An immutable original reference, never an actor, grant or dispatch permit.
 * The authenticated Host rechecks its catalog and current connection policy. */
export type CognitiveAppObjectLocator = Readonly<{
  contentId: string;
  projectId: string;
  connectionId: string;
  authority: DomainAuthorityReference;
  object: OperationResourceReference;
}>;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const shape = z
  .object({
    contentId: id,
    projectId: id,
    connectionId: id,
    authority: z.unknown(),
    object: z.unknown(),
  })
  .strict();

export function parseCognitiveAppObjectLocator(
  input: unknown,
): CognitiveAppObjectLocator {
  // Reject accessors/non-JSON before reading any field; detach from callers.
  const value = shape.parse(JSON.parse(JSON.stringify(parseWireJson(input))));
  const authority = Object.freeze(parseDomainAuthority(value.authority));
  const object = Object.freeze(
    parseOperationResources("objects", [value.object])[0]!,
  );
  return Object.freeze({
    contentId: value.contentId,
    projectId: value.projectId,
    connectionId: value.connectionId,
    authority,
    object,
  });
}
export const cognitiveAppObjectLocatorSchema = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return parseCognitiveAppObjectLocator(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "认知应用原件引用无效。" });
      return z.NEVER;
    }
  });

/** Inspect the new slot without invoking an operation/slot accessor. Do not
 * impose the SDK wire budget on unrelated legacy input fields. */
export function guardCognitiveAppInputCommand(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const operation = Object.getOwnPropertyDescriptor(input, "operation");
  if (!operation) {
    if ("operation" in input) throw new Error("输入操作必须是自有数据。");
    return;
  }
  if (!("value" in operation)) throw new Error("输入来源不是有效的自有数据。");
  const carrier: unknown = operation.value;
  if (!carrier || typeof carrier !== "object") return;
  const slot = Object.getOwnPropertyDescriptor(carrier, "cognitiveObject");
  if (!slot) {
    // Never allow an inherited new source slot to become caller authority.
    if ("cognitiveObject" in carrier)
      throw new Error("原件引用必须是自有数据。");
    return;
  }
  if (!("value" in slot) || !slot.enumerable)
    throw new Error("原件引用不是有效的自有数据。");
  if (slot.value !== undefined) parseCognitiveAppObjectLocator(slot.value);
}

export function sameCognitiveAppObjectLocator(
  left: CognitiveAppObjectLocator | undefined,
  right: CognitiveAppObjectLocator | undefined,
): boolean {
  if (!left || !right) return left === right;
  const a = canonicalJsonBytes(left),
    b = canonicalJsonBytes(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Keep the independent cognitive original out of numeric builtin slots. */
export function coherentCognitiveAppInput(input: {
  projectId: string;
  cognitiveObject?: CognitiveAppObjectLocator;
  artifactId?: string | null;
  artifactRevision?: number | null;
  selection?: string;
  reading?: unknown;
  scriptGeneration?: unknown;
  scriptTarget?: unknown;
  localFile?: unknown;
}): boolean {
  return (
    !input.cognitiveObject ||
    (input.projectId === input.cognitiveObject.projectId &&
      !input.artifactId &&
      !input.artifactRevision &&
      !input.selection &&
      !input.reading &&
      !input.scriptGeneration &&
      !input.scriptTarget &&
      !input.localFile)
  );
}
