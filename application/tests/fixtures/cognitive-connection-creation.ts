import {
  type PlatformStore,
  type PlatformActor,
  type HostVerifiedCognitiveConnectionProof,
  type HostVerifiedCognitiveConnectionCreate,
} from "../../packages/platform/src/store.js";
import { parseCognitiveAppRequest } from "../../packages/core/src/cognitive-app-api.js";

/** Test setup only: obtain the real known Human's consent/identity snapshot.
 * Negative tests must prepare a valid Human envelope first and then replace
 * only the access/proof being tested, so this helper cannot deny for the Store.
 * No connection, receipt, authorization or transport success is synthesized. */
export async function prepareConnectionCreation(
  platform: PlatformStore,
  access: PlatformActor,
  input: {
    proof: HostVerifiedCognitiveConnectionProof;
    connectionId: string;
    expectedRevision: 0;
    expectedGrantRevision?: number;
    now?: string;
  },
): Promise<HostVerifiedCognitiveConnectionCreate> {
  const request = parseCognitiveAppRequest("connect", {
    appId: input.proof.appId,
    version: input.proof.version,
    expectedDefinitionHash: input.proof.definitionHash,
    ...(input.expectedGrantRevision !== undefined
      ? { expectedGrantRevision: input.expectedGrantRevision }
      : {}),
    connectionId: input.connectionId,
    expectedRevision: input.expectedRevision,
    serviceId: input.proof.serviceId,
    dataAuthorityId: input.proof.dataAuthorityId,
  });
  const prepared = await platform.prepareCognitiveAppConnection(
    access,
    request,
  );
  return {
    request,
    proof: input.proof,
    verifiedGrantRevision: prepared.grant.revision,
    verifiedActor: prepared.actor,
    ...(input.now !== undefined ? { now: input.now } : {}),
  };
}
