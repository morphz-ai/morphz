import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  PlatformClient,
  platformHistorySchema,
  type PlatformHistory,
} from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

type Presentation = Pick<PlatformHistory, "inputs" | "runtime">;
const navigation = /\/api\/platform\/runtime-navigation(?:\?.*)?$/;
const history =
  /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/;

/** Synthetic transport for message presentation tests, using real Platform
 * identity/navigation. Persistence and model dispatch have separate Runtime tests. */
export async function mockPlatformConversation(
  page: Page,
  snapshot: () => Presentation,
) {
  const client = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const spaces = await client.ensurePersonalSpaces();
  const scope = {
    projectId: spaces.dialogueId,
    conversationId: spaces.dialogueId,
  };
  const version = () =>
    createHash("sha256").update(JSON.stringify(snapshot())).digest("hex");

  await page.route(navigation, async (route) => {
    const response = await route.fetch();
    const actual = await response.json();
    await route.fulfill({
      response,
      json: {
        ...actual,
        historyVersion: version(),
        runtime: snapshot().runtime,
      },
    });
  });
  await page.route(history, (route) =>
    route.fulfill({
      json: platformHistorySchema.parse({ ...snapshot(), nextCursor: null }),
    }),
  );

  return {
    client,
    spaces,
    scope,
    input(
      id: string,
      body: string,
      createdAt: string,
    ): PlatformHistory["inputs"][number] {
      return {
        id,
        ...scope,
        author: {
          principalId: client.boot.principalId,
          actantId: client.boot.actantId,
        },
        targetActantId: "morphz-agent",
        body,
        createdAt,
      };
    },
    async refresh() {
      const expected = version();
      const updated = page.waitForResponse(
        async (response) =>
          navigation.test(response.url()) &&
          response.ok() &&
          (await response.json()).historyVersion === expected,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await updated;
    },
  };
}
