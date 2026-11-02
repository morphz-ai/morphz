import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import { waitForFixtureReadySignal } from "./fixtures/fixture-ready-signal.js";
import { prepareDynamicAppFixture } from "./fixtures/prepare-dynamic-app-fixture.js";

test(
  "real Vite preparation awaits the late App dependency graph without evaluating App or spending a UI deadline",
  { timeout: 20_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(resolve(tmpdir(), "morphz-dynamic-app-preparation-")),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const compilingChild = new Promise<void>((resolve) => (entered = resolve));
    let server: ViteDevServer | undefined;
    t.after(async () => {
      release();
      await server?.close();
      await rm(root, { recursive: true, force: true });
    });
    await Promise.all([
      writeFile(
        resolve(root, "fixture.js"),
        'export const load = () => import("./App.js");',
      ),
      writeFile(
        resolve(root, "App.js"),
        'import { marker } from "./child.js"; globalThis.morphzCompilerProbeExecuted = marker; export const App = marker;',
      ),
      writeFile(resolve(root, "child.js"), 'export const marker = "original";'),
    ]);
    server = await createServer({
      configFile: false,
      root,
      cacheDir: resolve(root, "cache"),
      optimizeDeps: { noDiscovery: true },
      logLevel: "error",
      plugins: [
        {
          name: "controlled-cold-app-compiler",
          async transform(_code, id) {
            if (id === normalizePath(resolve(root, "child.js"))) {
              entered();
              await blocked;
            }
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const client = server.environments.client!;
    let finished = false;
    const preparation = prepareDynamicAppFixture(
      {
        async transformRequest(url) {
          if (url === "/App.js") {
            // Delay admission, before Vite registers the App request. An
            // already completed fixture-only crawl can settle in this gap;
            // a first App crawl still owns its genuine pending child.
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return client.transformRequest(url);
        },
        waitForRequestsIdle: () => client.waitForRequestsIdle(),
      },
      "/App.js",
      "/fixture.js",
    ).then(() => {
      finished = true;
    });
    try {
      await waitForFixtureReadySignal(
        compilingChild,
        5_000,
        "Controlled cold App compiler",
      );
      // The root transform itself can finish while a warmed child remains
      // blocked. Completion must belong to the whole first static App crawl.
      assert.ok(await client.transformRequest("/App.js"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false, "App preparation omitted its cold child");
      release();
      await preparation;
      assert.ok(
        (await client.moduleGraph.getModuleByUrl("/child.js"))?.transformResult,
      );
      assert.ok(
        (await client.moduleGraph.getModuleByUrl("/fixture.js"))
          ?.transformResult,
      );
      assert.equal(
        Reflect.get(globalThis, "morphzCompilerProbeExecuted"),
        undefined,
      );
    } finally {
      release();
      await preparation.catch(() => {});
    }
  },
);
