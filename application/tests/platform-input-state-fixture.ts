import type { Page } from "@playwright/test";
import type {
  PlatformClient,
  PlatformContent,
  ContentCursor,
} from "../apps/web/src/platform-client.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";

/** Inspect the real Host delivery state and this browser identity's locally
 * saved inputs. A disconnected E2E center has no Runtime history to fabricate. */
export async function platformInputState(page: Page, source: PlatformClient) {
  const { runtime } = await source.navigationRuntime();
  const { centerId, principalId, actantId } = source.boot;
  const prefix = `${applicationStoragePrefix}${centerId}:${principalId}:${actantId}:saved-input:`;
  const saved = await page.evaluate(
    (prefix) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, body: localStorage.getItem(key) })),
    prefix,
  );
  return { deliveries: runtime.deliveries, saved };
}

/** Actual catalog identities/versions and document originals for UI operations
 * that must not change saved content. App views and local recency are excluded. */
export async function platformContentState(source: PlatformClient) {
  const content: PlatformContent[] = [];
  let before: ContentCursor | undefined;
  do {
    const next = await source.content({ limit: 100, before });
    content.push(...next.items);
    before = next.nextCursor ?? undefined;
  } while (before);
  const documents = await Promise.all(
    content
      .filter((entry) => entry.kind === "document")
      .map(async (entry) => ({
        contentId: entry.id,
        original: await source.readDocument(entry.id),
        versions: await source.objectVersions(entry.id),
      })),
  );
  return { content, documents };
}
