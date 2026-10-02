import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  BrowserBroker,
  platformBrowserPageAuthority,
} from "../packages/application/src/browser.js";

/** Exercise the production Host and Platform authority, never a Workspace
 * snapshot or a second browser-specific membership model. */
export async function browserControlFixture() {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-browser-"));
  const profile = join(directory, "profile");
  let host = await openEmbeddedApplication(directory, profile);
  let client = await PlatformClient.connect(host.connection);
  const projectId = await client.createProject(
    "浏览器回执验收",
    randomUUID(),
    "first-project",
  );
  const createBroker = (now?: () => number) => {
    const application = host.connection.application;
    const work = application.options.platformWork;
    const content = application.options.platformDocuments;
    if (!work || !content) throw new Error("正式 Platform 领域未连接");
    return new BrowserBroker(
      application.store,
      platformBrowserPageAuthority({ work, content }),
      now,
    );
  };
  return {
    directory,
    projectId,
    get connection() {
      return host.connection;
    },
    get client() {
      return client;
    },
    get store() {
      return host.connection.application.store;
    },
    createBroker,
    async reopen() {
      await host.close();
      host = await openEmbeddedApplication(directory, profile);
      client = await PlatformClient.connect(host.connection);
    },
    async close() {
      await host.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
