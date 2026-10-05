import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { Boot } from "../../apps/web/src/client.js";

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
  async call(name: string, args: unknown[] = [], slot?: string): Promise<any> {
    return unwrap(await this.control("call", name, args, slot));
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
