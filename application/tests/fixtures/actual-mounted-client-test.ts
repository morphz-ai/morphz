import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { Boot, WorkspaceClient } from "../../apps/web/src/client.js";
import { HttpApplicationClient } from "../../packages/core/src/http-application-client.js";

type ClientMethodName = {
  [K in keyof WorkspaceClient]: WorkspaceClient[K] extends (
    ...args: any[]
  ) => unknown
    ? K
    : never;
}[keyof WorkspaceClient];
type ClientMethod<K extends ClientMethodName> = Extract<
  WorkspaceClient[K],
  (...args: any[]) => unknown
>;

// Independent server authorization probe using this private browser's genuine
// session cookie. It cannot manufacture a principal or access generation.
export function authenticatedHttp(client: ActualMountedClient) {
  const origin = new URL(client.page.url()).origin;
  return new HttpApplicationClient(origin, async (input, init) => {
    const url = new URL(String(input), origin);
    assert.equal(url.origin, origin);
    const headers = new Headers(init?.headers);
    headers.set(
      "Cookie",
      (await client.page.context().cookies(origin))
        .map((c) => `${c.name}=${c.value}`)
        .join("; "),
    );
    if (init?.method === "POST") headers.set("Origin", origin);
    return fetch(url, { ...init, headers });
  });
}
export async function mountedClientWebRoot() {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-actual-client-mounted-"),
  );
  try {
    await build({
      entryPoints: ["tests/fixtures/actual-mounted-client-browser.tsx"],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2023",
      jsx: "automatic",
      outfile: join(directory, "fixture.js"),
    });
    writeFileSync(
      join(directory, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
    return {
      directory,
      close() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
type Reply =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { name: string; message: string; status?: number; code?: string };
    };
// Machine fields are observations of the actual browser Error, not a new API
// receipt. Identity comparisons remain in the same browser realm below.
function unwrap(value: Reply) {
  if (value.ok) return value.value;
  const error = new Error(value.error.message);
  Object.assign(error, value.error);
  throw error;
}
export class ActualMountedClient {
  private holdSequence = 0;
  private constructor(
    readonly browser: Browser,
    readonly page: Page,
  ) {}
  static async open(origin: string) {
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath(),
    });
    try {
      const page = await browser.newPage();
      const constructionRequests: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/"))
          constructionRequests.push(url.pathname);
      });
      await page.goto(origin);
      await page.waitForFunction(
        () => !!Reflect.get(window, "actualMountedClient"),
      );
      const client = new ActualMountedClient(browser, page);
      const construction = await client.control("construction");
      assert.equal(construction.captured, true);
      assert.equal(construction.before, 0);
      assert.equal(
        construction.after,
        0,
        "pure SSR construction performs no API I/O; it is not the business owner",
      );
      assert.deepEqual(
        constructionRequests,
        [],
        "native network observer also proves construction sent no API request, including EventSource",
      );
      await client.control("mount");
      return client;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  async control(name: string, ...args: unknown[]): Promise<any> {
    return this.page.evaluate(
      ({ name, args }) => {
        const api = Reflect.get(window, "actualMountedClient");
        const value = api[name];
        return typeof value === "function" ? value(...args) : value;
      },
      { name, args },
    );
  }
  call<K extends ClientMethodName>(
    name: K,
    args?: Parameters<ClientMethod<K>>,
    slot?: string,
  ): Promise<Awaited<ReturnType<ClientMethod<K>>>>;
  async call(name: string, args: unknown[] = [], slot?: string): Promise<any> {
    const cleanups: Array<() => Promise<unknown>> = [];
    try {
      const serialize = async (value: unknown): Promise<unknown> => {
        if (value instanceof File)
          return {
            __fixtureFile: true,
            bytes: [...new Uint8Array(await value.arrayBuffer())],
            name: value.name,
            type: value.type,
            lastModified: value.lastModified,
          };
        if (value instanceof AbortSignal) {
          const id: string = await this.control(
            "abortController",
            value.aborted,
          );
          const abort = () => {
            void this.control("abort", id);
          };
          value.addEventListener("abort", abort, { once: true });
          if (value.aborted) await this.control("abort", id);
          cleanups.push(async () => {
            value.removeEventListener("abort", abort);
            await this.control("forgetAbort", id);
          });
          return { __fixtureAbort: id };
        }
        if (Array.isArray(value)) return Promise.all(value.map(serialize));
        if (value && Object.getPrototypeOf(value) === Object.prototype)
          return Object.fromEntries(
            await Promise.all(
              Object.entries(value).map(async ([key, item]) => [
                key,
                await serialize(item),
              ]),
            ),
          );
        return value;
      };
      const serialized = await Promise.all(args.map(serialize));
      return unwrap(await this.control("call", name, serialized, slot));
    } finally {
      for (const cleanup of cleanups) await cleanup();
    }
  }
  start(name: string, args: unknown[] = [], slot?: string): Promise<string> {
    return this.control("start", name, args, slot);
  }
  async finish(id: string): Promise<any> {
    return unwrap(await this.control("finish", id));
  }
  async snapshot(slot?: string): Promise<Boot | null> {
    return this.control("snapshot", slot);
  }
  async waitReady(principalId: string) {
    try {
      await this.page.waitForFunction(
        (principal) =>
          Reflect.get(window, "actualMountedClient").report().snapshot
            ?.principalId === principal,
        principalId,
        { timeout: 8000 },
      );
      // Mount/login effects must finish before a test clears its request
      // ledger. EventSource remains live; this waits only for native fetch.
      await this.page.waitForFunction(
        () => {
          const report = Reflect.get(window, "actualMountedClient").report();
          return (
            report.networkPending === 0 &&
            Date.now() - report.networkSettledAt >= 50
          );
        },
        undefined,
        { timeout: 8000 },
      );
    } catch (error) {
      const report = await this.control("report");
      const ledger = await this.control("reads");
      throw new Error(
        "Actual mounted Client readiness failed: " +
          JSON.stringify({
            principal: report.snapshot?.principalId,
            error: report.error,
            publications: report.publications.length,
            reads: ledger.map(
              (row: { path: string; method: string; status: number }) => ({
                path: row.path,
                method: row.method,
                status: row.status,
              }),
            ),
          }),
        { cause: error },
      );
    }
  }
  async hold(path: string) {
    const id: string = await this.control("hold", path);
    return this.heldResponse(id);
  }
  async holdWhere(
    match: (url: URL) => boolean,
    verify: (value: unknown) => void,
  ) {
    const name = "fixtureHoldMatch" + ++this.holdSequence;
    await this.page.exposeFunction(
      name,
      (response: { url: string; status: number; value: unknown }) => {
        if (!match(new URL(response.url))) return false;
        assert.equal(
          response.status,
          200,
          "hold only a genuine authorized response",
        );
        verify(response.value);
        return true;
      },
    );
    return this.heldResponse(await this.control("hold", "", name));
  }
  private heldResponse(id: string) {
    return {
      id,
      reached: async () => {
        await this.page.waitForFunction(
          (key) =>
            Reflect.get(window, "actualMountedClient").holdReport(key).reached,
          id,
          { timeout: 8000 },
        );
        return this.control("holdReport", id);
      },
      release: () => this.control("release", id),
    };
  }
  async close() {
    try {
      await this.control("cleanup");
    } finally {
      await this.browser.close();
    }
  }
}
