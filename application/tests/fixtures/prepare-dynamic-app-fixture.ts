import assert from "node:assert/strict";
import type { DevEnvironment } from "vite";

// Use this before the environment's first transform. Vite's idle promise only
// covers its first static import crawl; it is already settled for a later
// dynamic App graph. Compile that App first without evaluating its transport
// or effects, then prepare the fixture that installs the controlled transport.
export async function prepareDynamicAppFixture(
  client: Pick<DevEnvironment, "transformRequest" | "waitForRequestsIdle">,
  appEntry: string,
  fixtureEntry: string,
): Promise<void> {
  assert.ok(await client.transformRequest(appEntry));
  await client.waitForRequestsIdle();
  assert.ok(await client.transformRequest(fixtureEntry));
}
