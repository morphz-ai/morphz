import { createHash } from "node:crypto";
import { test as base, type Page } from "@playwright/test";
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

/** Route callbacks can outlive the last assertion. Drain them before Playwright
 * disposes the context/HTTP responses; preserve failures instead of swallowing them. */
export const test = base.extend<{ platformConversationRoutes: void }>({
  platformConversationRoutes: [
    async ({ page }, use) => {
      await use();
      await page.unrouteAll({ behavior: "wait" });
    },
    { auto: true },
  ],
});

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
  let sequence = 1;

  // Presentation data below is synthetic. Its invalidations must be synthetic
  // too: the real server's authorized workspace stream belongs to other data.
  // Keep all other EventSource transports native, including conversation streams.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    class WorkspaceFixtureStream extends EventTarget {
      readonly url: string;
      readonly withCredentials = false;
      readyState: number = NativeEventSource.CONNECTING;
      onopen: EventSource["onopen"] = null;
      onmessage: EventSource["onmessage"] = null;
      onerror: EventSource["onerror"] = null;
      constructor(url: string) {
        super();
        this.url = url;
        window.addEventListener("morphz:test-workspace-change", this.receive);
        queueMicrotask(() => {
          if (this.readyState === NativeEventSource.CLOSED) return;
          this.readyState = NativeEventSource.OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.call(this as unknown as EventSource, event);
          this.message({
            kind: "workspace",
            sequence: 1,
            reason: "resync",
            accessChanged: false,
          });
        });
      }
      private message(value: unknown) {
        if (this.readyState !== NativeEventSource.OPEN) return;
        const event = new MessageEvent("message", {
          data: JSON.stringify(value),
        });
        this.dispatchEvent(event);
        this.onmessage?.call(this as unknown as EventSource, event);
      }
      private receive = (event: Event) =>
        this.message((event as CustomEvent).detail);
      close() {
        this.readyState = NativeEventSource.CLOSED;
        window.removeEventListener(
          "morphz:test-workspace-change",
          this.receive,
        );
      }
    }
    window.EventSource = new Proxy(NativeEventSource, {
      construct(target, args) {
        const url = new URL(String(args[0]), window.location.href);
        return url.pathname === "/api/platform/workspace/stream"
          ? new WorkspaceFixtureStream(url.href)
          : Reflect.construct(target, args);
      },
    });
  });

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
      await page.evaluate(
        (sequence) =>
          window.dispatchEvent(
            new CustomEvent("morphz:test-workspace-change", {
              detail: {
                kind: "workspace",
                sequence,
                reason: "changed",
                accessChanged: false,
              },
            }),
          ),
        ++sequence,
      );
      await updated;
    },
  };
}
