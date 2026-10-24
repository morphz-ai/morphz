import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Electron downloader's locked undici clears the EventSource, integrity and content-encoding advisories", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const dependencies = Object.entries(lock.packages).filter(
    ([path]) =>
      path === "node_modules/undici" || path.endsWith("/node_modules/undici"),
  );
  assert.ok(dependencies.length > 0, "Expected Electron's HTTP dependency");
  // GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472 and GHSA-xjj6-f33q-929c.
  const floors = new Map([
    [7, [30, 1]],
    [8, [12, 2]],
  ]);
  for (const [path, dependency] of dependencies) {
    const { version } = dependency as { version: string };
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version.split(".").map(Number);
    const floor = floors.get(major!);
    assert.ok(floor, `Review the security floor for ${path}@${version}`);
    assert.ok(
      minor! > floor[0]! || (minor === floor[0] && patch! >= floor[1]!),
      `${path}@${version} is below the patched release`,
    );
  }
});
