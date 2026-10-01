import { createServer } from "node:net";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { createAppServer } from "../apps/service/src/http.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { platformMessageFixture } from "./platform-message-fixture.js";

/** Isolated real Host, HTTP adapter, identity, Platform/App stores and queued
 * inputs. Runtime dispatch remains stopped; no model success is fabricated. */
async function openMessageHost() {
  const host = await platformMessageFixture([], {
    browser: true,
    model: "isolated-project-conversation-model",
  });
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const server = createAppServer(host.transport, {
    ...host.applicationOptions,
    port,
    webRoot: resolve("dist/web"),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await host.close();
    throw error;
  }
  return {
    ...host,
    origin,
    async close() {
      try {
        server.closeStreams();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        host.assertNoLegacyData();
      } finally {
        await host.close();
      }
    },
  };
}

export const test = base.extend<{
  messageHost: Awaited<ReturnType<typeof openMessageHost>>;
}>({
  messageHost: async ({}, use) => {
    const host = await openMessageHost();
    try {
      await use(host);
    } finally {
      await host.close();
    }
  },
  baseURL: async ({ messageHost }, use) => use(messageHost.origin),
  page: async ({ page, messageHost }, use, testInfo) => {
    const errors: { path: string; status?: number; error: string }[] = [];
    page.on("response", async (response) => {
      if (response.status() < 400) return;
      errors.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        error: await response.text().catch(() => "Response body unavailable"),
      });
    });
    page.on("requestfailed", (request) => {
      errors.push({
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText ?? "Request failed",
      });
    });
    if (messageHost.loginToken) {
      const response = await page.request.post(
        `${messageHost.origin}/api/identity/login`,
        {
          headers: { Origin: messageHost.origin },
          data: { token: messageHost.loginToken },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
    }
    try {
      await use(page);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus)
        await testInfo.attach("host-http-errors", {
          body: JSON.stringify(errors, null, 2),
          contentType: "application/json",
        });
    }
  },
});
export { expect };

export async function conversationClient(page: Page) {
  const origin = new URL(page.url()).origin;
  return PlatformClient.connect(
    new HttpApplicationClient(origin, async (url, options) => {
      const headers = new Headers(options?.headers);
      const cookies = await page.context().cookies(origin);
      headers.set(
        "Cookie",
        cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      );
      return fetch(url, { ...options, headers });
    }),
  );
}

export async function conversationState(page: Page) {
  const source = await conversationClient(page);
  return {
    source,
    projects: await source.allProjects(),
    conversations: await source.allNavigationConversations(),
  };
}

/** Agent-authored search fixture through the real typed domain, with explicitly
 * controlled accepted Runtime input evidence, not an old workspace command. */
export async function seedConversationDocument(
  messageHost: { directory: string; identityConfiguration: unknown },
  projectId: string,
  title: string,
  markdown: string,
) {
  const host = await agentDomainFixture({
    existingCenter: {
      directory: messageHost.directory,
      projectId,
      identityConfiguration: messageHost.identityConfiguration,
    },
  });
  try {
    const result = await host.call<{ ok: boolean }>(
      {
        action: "create-document",
        title,
        markdown,
      },
      host.input(projectId, "TEST 合成 Agent 原创文档夹具"),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
}
