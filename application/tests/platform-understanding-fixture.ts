import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { isolatedCenterDirectory } from "./platform-agent-original-fixture.js";

/** Publish controlled state for UI assertions in the isolated E2E center.
 * Real Runtime frame publication is tested by platform-understanding-runtime-smoke. */
export async function seedProjectUnderstanding(
  client: PlatformClient,
  projectId: string,
  body: string,
  sources: { contentId: string; versionRef: string }[] = [],
) {
  const project = await client.project(projectId);
  const agentPrincipalId = project.memberPrincipalIds.find(
    (principalId) => principalId !== client.boot.principalId,
  );
  if (!agentPrincipalId)
    throw new Error("当前理解夹具需要项目中已登记的 Agent。");
  const suffix = randomUUID().replaceAll("-", "");
  const credential = `isolated-e2e-agent-${suffix}`;
  const actantId = `isolated-e2e-agent-actant-${suffix}`;
  const verifier: PlatformAuthorityVerifier = {
    resolveActor: async (request) =>
      request.credential === credential
        ? {
            tenantId: client.boot.centerId,
            principalId: client.boot.principalId,
            actantId,
            kind: "agent" as const,
            runtimeInputId: `input_${suffix}`,
            initiatingHumanActantId: client.boot.actantId,
            scopeProjectId: projectId,
          }
        : null,
    resolveActant: async (request) =>
      request.actantId === actantId
        ? { principalId: agentPrincipalId, kind: "agent" as const }
        : null,
    resolveProjectAgent: async () => null,
    verifyApplicationObject: async () => false,
  };
  const store = await PlatformStore.sqlite(
    join(isolatedCenterDirectory(), "platform.sqlite"),
    verifier,
  );
  try {
    return await store.publishProjectUnderstanding(
      { credential },
      {
        commandId: `publish_${suffix}`,
        projectId,
        expectedRevision: 0,
        frameId: `mw-public-${projectId}`,
        frameRevision: 1,
        mindVersion: 1,
        body,
        sources,
      },
    );
  } finally {
    await store.close();
  }
}
