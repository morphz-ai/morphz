import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Page } from "@playwright/test";
import { build } from "esbuild";

/** Compile the actual complete App before browser interaction deadlines.
 * The unchanged fixture still installs its controlled transport before its
 * lazy App initialization. No production module, React lifetime or CSS is
 * replaced; only the development-server module waterfall is removed. */
export async function prepareMountedAppFixture(fixture: string, route: string) {
  const started = performance.now();
  const output = resolve("tests/.mounted-app-fixture/app-fixture.js");
  const bundle = await build({
    entryPoints: [fixture],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2023",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "import.meta.env": JSON.stringify({
        BASE_URL: "/",
        DEV: true,
        MODE: "development",
        PROD: false,
        SSR: false,
      }),
    },
    write: false,
    outfile: output,
    metafile: true,
    plugins: [
      {
        name: "actual-mounted-app-assets",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, async (args) => {
            const result = await builder.resolve(args.path.slice(0, -4), {
              resolveDir: args.resolveDir,
              kind: args.kind,
            });
            if (result.errors.length) return { errors: result.errors };
            return { path: result.path, namespace: "mounted-app-asset" };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "mounted-app-asset" },
            async (args) => ({
              contents: await readFile(args.path),
              loader: "file",
            }),
          );
          builder.onResolve({ filter: /^\/(?:src|@fs)\// }, ({ path }) => ({
            path: path.startsWith("/src/")
              ? resolve("apps/web", path.slice(1))
              : path.slice("/@fs/".length),
          }));
        },
      },
    ],
  });
  const compiled = new Set(
    Object.keys(bundle.metafile.inputs).map((path) => resolve(path)),
  );
  for (const path of [fixture, resolve("apps/web/src/App.tsx")])
    assert.ok(
      compiled.has(path),
      `Cold fixture must include actual source ${path}`,
    );
  const javascript = bundle.outputFiles.find((file) => file.path === output);
  const stylesheet = bundle.outputFiles.find(
    (file) => file.path === output.replace(/\.js$/, ".css"),
  );
  assert.ok(javascript && stylesheet, "Actual App script and CSS are required");
  const assets = new Map(
    bundle.outputFiles.map((file) => [
      "/" + basename(file.path),
      file.contents,
    ]),
  );
  const html = `<!doctype html><html><head><link rel="icon" href="data:,"/><link rel="stylesheet" href="${route}.css"/></head><body><div id="root"></div><script type="module" src="${route}.js"></script></body></html>`;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const path = request.url?.split("?")[0];
    if (path === route) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } else if (path === `${route}.js`) {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(javascript.contents);
    } else if (path === `${route}.css`) {
      response.setHeader("Content-Type", "text/css; charset=utf-8");
      response.end(stylesheet.contents);
    } else if (assets.has(path ?? "")) {
      response.setHeader(
        "Content-Type",
        path!.endsWith(".mjs")
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream",
      );
      response.end(assets.get(path!));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    preparation: {
      coldCache: true,
      compileMs: Math.round(performance.now() - started),
      bundleInputCount: compiled.size,
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export type MountedAppFixture = Awaited<
  ReturnType<typeof prepareMountedAppFixture>
>;

/** Every document must use its prepared actual App, never a late dev crawl. */
export async function assertPreparedAppDocument(page: Page, route: string) {
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => ({
      path: new URL(entry.name).pathname,
      type: (entry as PerformanceResourceTiming).initiatorType,
    })),
  );
  assert.deepEqual(
    resources
      .filter((entry) => entry.type === "script")
      .map((entry) => entry.path),
    [`${route}.js`],
  );
  assert.deepEqual(
    resources
      .filter((entry) => entry.path.endsWith(".css"))
      .map((entry) => entry.path),
    [`${route}.css`],
  );
}
