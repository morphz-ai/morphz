import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../../core/src/cognitive-app-object-locator.js";
import {
  PlatformStorageError,
  type PlatformActor,
  type PlatformStore,
} from "../../platform/src/store.js";

/** Current catalog/connection policy only. No author network call, no head
 * substitution and no grant created by retaining this original reference. */
export async function authorizeCognitiveAppInputObject(
  platform: PlatformStore,
  actor: PlatformActor,
  reference: CognitiveAppObjectLocator,
) {
  const locator = parseCognitiveAppObjectLocator(reference);
  const { authority } = locator;
  const resolved = await platform.resolveCognitiveAppObjectRead(actor, {
    projectId: locator.projectId,
    contentId: locator.contentId,
    appId: authority.appId,
    version: authority.version,
    connectionId: locator.connectionId,
    expectedDefinitionHash: authority.definitionHash,
    object: locator.object,
    // This is a metadata policy check, not an original-body hydration.
    maxBytes: 1,
  });
  const target = resolved.target;
  if (
    authority.appId !== target.appId ||
    authority.version !== target.version ||
    authority.definitionHash !== target.definitionHash ||
    authority.instanceId !== target.instanceId ||
    authority.serviceId !== target.serviceId ||
    authority.dataAuthorityId !== target.dataAuthorityId
  )
    throw new PlatformStorageError(
      "conflict",
      "认知应用原件的保存方已变化，未发送。",
    );
  return target;
}
