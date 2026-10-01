import { createHash } from "node:crypto";

/** Stable catalog identity for one owning App original. It is independent of
 * the original's version and current Platform project. */
export function contentIdForAppObject(
  tenantId: string,
  instanceId: string,
  objectId: string,
): string {
  return `content_${createHash("sha256")
    .update(JSON.stringify([tenantId, instanceId, objectId]))
    .digest("hex")
    .slice(0, 40)}`;
}
