import { z } from "zod";
import {
  isPortableText,
  parseOperationResources,
  parseProtocolValue,
  parseWireJson,
  type JsonValue,
  type OperationResourceReference,
} from "../../cognitive-app-sdk/src/protocol.js";

const appId = z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/);
const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const opaque = z.string().min(1).max(200).refine(isPortableText);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const consent = {
  appId,
  version,
  expectedDefinitionHash: hash.optional(),
  expectedGrantRevision: revision.optional(),
};
const target = {
  ...consent,
  connectionId: id,
  expectedConnectionRevision: revision.optional(),
};
const object = z.object({ objectId: opaque, versionRef: opaque }).strict();

/** A bounded adapter over the existing shared Service, never an author
 * registry or authority source. New command IDs and project are Host facts.
 * mode only routes read/null versus a Host-derived command; Service verifies
 * the exact immutable operation's real effect, including historical replay.
 */
export const cognitiveAppToolSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      limit: z.number().int().min(1).max(50).default(20),
      appId: appId.optional(),
      versionsAfter: cursor.optional(),
      connectionsAfter: cursor.optional(),
    })
    .strict(),
  z.object({ action: z.literal("describe"), ...consent }).strict(),
  z
    .object({
      action: z.literal("invoke"),
      ...target,
      mode: z.enum(["read", "command"]),
      operationId: opaque,
      parameters: z.unknown(),
      resources: z.array(object).max(32),
    })
    .strict(),
  z
    .object({
      action: z.literal("read-object"),
      ...target,
      object,
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      appId,
      version,
      connectionId: id,
      commandId: id,
      expectedDefinitionHash: hash.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("recover"),
      appId,
      version,
      connectionId: id,
      commandId: id,
      expectedDefinitionHash: hash.optional(),
    })
    .strict(),
]);
export type CognitiveAppToolRequest =
  | Exclude<z.infer<typeof cognitiveAppToolSchema>, { action: "invoke" }>
  | (Omit<
      Extract<z.infer<typeof cognitiveAppToolSchema>, { action: "invoke" }>,
      "parameters" | "resources"
    > & {
      parameters: JsonValue;
      resources: readonly OperationResourceReference[];
    });

/** Snapshot before any await; accessors, prototype objects and toJSON are not
 * evaluated. Keep the SDK's fixed wire/value/resource budgets, not UI limits.
 */
export function parseCognitiveAppToolRequest(
  input: unknown,
): CognitiveAppToolRequest {
  const parsed = cognitiveAppToolSchema.parse(
    JSON.parse(JSON.stringify(parseWireJson(input))),
  );
  return parsed.action === "invoke"
    ? {
        ...parsed,
        parameters: parseProtocolValue(parsed.parameters),
        resources: parseOperationResources("project", parsed.resources),
      }
    : parsed;
}
