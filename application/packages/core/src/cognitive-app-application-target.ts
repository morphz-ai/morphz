import { z } from "zod";
import { parseWireJson } from "../../cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  parseDomainAuthority,
  type DomainAuthorityReference,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import type { CognitiveAppObjectLocator } from "./cognitive-app-object-locator.js";

/** Explicit application context, not a grant or a client-selected Harness. */
export type CognitiveAppApplicationTarget = Readonly<{
  connectionId: string;
  authority: DomainAuthorityReference;
}>;
const shape = z
  .object({
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    authority: z.unknown(),
  })
  .strict();
export function parseCognitiveAppApplicationTarget(
  input: unknown,
): CognitiveAppApplicationTarget {
  const value = shape.parse(JSON.parse(JSON.stringify(parseWireJson(input))));
  return Object.freeze({
    connectionId: value.connectionId,
    authority: Object.freeze(parseDomainAuthority(value.authority)),
  });
}
export const cognitiveAppApplicationTargetSchema = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return parseCognitiveAppApplicationTarget(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "认知应用目标无效。" });
      return z.NEVER;
    }
  });
export function sameCognitiveAppApplicationTarget(
  left: CognitiveAppApplicationTarget | undefined,
  right: CognitiveAppApplicationTarget | undefined,
): boolean {
  if (!left || !right) return left === right;
  const a = canonicalJsonBytes(left),
    b = canonicalJsonBytes(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
/** Inspect only the additive slot; legacy carrier budgets remain unchanged. */
export function guardCognitiveAppApplicationCommand(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const op = Object.getOwnPropertyDescriptor(input, "operation");
  if (!op) {
    if ("operation" in input) throw new Error("输入操作必须是自有数据。");
    return;
  }
  if (!("value" in op)) throw new Error("输入操作不是有效的自有数据。");
  const carrier: unknown = op.value;
  if (!carrier || typeof carrier !== "object") return;
  const slot = Object.getOwnPropertyDescriptor(carrier, "cognitiveApplication");
  if (!slot) {
    if ("cognitiveApplication" in carrier)
      throw new Error("应用目标必须是自有数据。");
    return;
  }
  if (!("value" in slot) || !slot.enumerable)
    throw new Error("应用目标不是有效的自有数据。");
  if (slot.value !== undefined) parseCognitiveAppApplicationTarget(slot.value);
}
export function coherentCognitiveAppApplicationInput(input: {
  projectId: string;
  cognitiveApplication?: CognitiveAppApplicationTarget;
  cognitiveObject?: CognitiveAppObjectLocator;
  reading?: unknown;
  scriptGeneration?: unknown;
  scriptTarget?: unknown;
}): boolean {
  const target = input.cognitiveApplication;
  return (
    !target ||
    (!input.reading &&
      !input.scriptGeneration &&
      !input.scriptTarget &&
      (!input.cognitiveObject ||
        (input.projectId === input.cognitiveObject.projectId &&
          sameCognitiveAppApplicationTarget(target, {
            connectionId: input.cognitiveObject.connectionId,
            authority: input.cognitiveObject.authority,
          }))))
  );
}
