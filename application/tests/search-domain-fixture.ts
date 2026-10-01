import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Application } from "../packages/application/src/application.js";
import { localAccess, type AccessContext } from "../packages/core/src/model.js";
import type { SearchRequest } from "../packages/core/src/retrieval.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

/** Real Platform directory plus Objects originals/index and Host permissions.
 * The Agent fixture controls accepted Runtime provenance, not storage/search.
 */
export async function searchDomainFixture(
  options: Parameters<typeof agentDomainFixture>[0] = {},
) {
  const host = await agentDomainFixture(options);
  const session = (access: AccessContext = localAccess) =>
    new Application(host.transport, {
      identity: host.identity,
      platformWork: host.domains.work,
      platformDocuments: host.domains.content,
      platformReader: host.domains.reader,
      images: host.domains.images,
    }).session(access);
  return {
    host,
    session,
    get projectId() {
      return host.projectId;
    },
    async createAgent(title: string, markdown = title) {
      const result = await host.call<{ contentId: string; versionRef: string }>(
        {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.create-document",
            parameters: { title, markdown },
          },
        },
      );
      const entry = await session().getPlatformContent({
        contentId: result.contentId,
      });
      return { ...result, objectId: entry.appObjectId };
    },
    createHuman(title: string, markdown = title) {
      return session().createPlatformDocument({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: host.projectId,
        title,
        markdown,
      });
    },
    import(
      text: string,
      relativePath = "external.md",
      commandId = randomUUID(),
      objectId = randomUUID(),
    ) {
      return session().importPlatformDocument({
        commandId,
        objectId,
        projectId: host.projectId,
        relativePath,
        text,
      });
    },
    search(request: SearchRequest, access: AccessContext = localAccess) {
      return session(access).search(request);
    },
    readOriginal(objectId: string, revision?: number) {
      return host.withHuman((actor) =>
        host.domains.content.objects.readObject({
          credential: actor.credential,
          objectId,
          ...(revision ? { revision } : {}),
        }),
      );
    },
    assertNoLegacyData() {
      host.assertNoLegacyData();
    },
    async reopen() {
      await host.reopen();
    },
    async close() {
      await host.close();
    },
    async assertIndexOnly(objectIds: string[]) {
      const tenantId = host.transport.identity();
      const indexed = await host.domains.content.objects.searchCandidates({
        tenantId,
        query: "共同词",
        limit: 50,
      });
      assert.deepEqual(
        new Set(indexed.map((row) => row.objectId)),
        new Set(objectIds),
      );
    },
  };
}
