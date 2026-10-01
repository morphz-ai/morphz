import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";

/** Actual Platform, private App stores and Human ingress for isolated scripts.
 * This fixture has no Runtime/model connection and no legacy Workspace backend.
 */
export async function openSmokeDomainHost(directory: string) {
  const filename = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(filename);
  const domains = await openApplicationDomainsHost(directory, store);
  const options = {
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
    platformReader: domains.reader,
    bookmarkDomain: domains.browser,
    images: domains.images,
    messageAttachments: domains.messageAttachments,
    uiPackages: domains.uiPackages,
    notifications: domains.notifications,
    platformTaskRuns: domains.taskRuns(),
  };
  const session = new Application(store, options).session(localAccess);
  try {
    await session.createPlatformProject({
      commandId: randomUUID(),
      projectId: "first-project",
      title: "TEST 原生能力验收",
    });
  } catch (error) {
    await domains.close();
    store.close();
    throw error;
  }
  return {
    store,
    domains,
    options,
    session,
    createDocument(title: string, markdown: string) {
      return session.createPlatformDocument({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: "first-project",
        title,
        markdown,
      });
    },
    assertNoAgentDelivery() {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.equal(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM runtime_deliveries")
              .get() as { count: number }
          ).count,
          0,
        );
        assert.deepEqual(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','assets','commands')",
            )
            .all(),
          [],
        );
      } finally {
        db.close();
      }
    },
    async close() {
      await domains.close();
      store.close();
    },
  };
}
