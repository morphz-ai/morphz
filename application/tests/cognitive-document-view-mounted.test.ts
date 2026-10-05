import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Page, type Frame } from "@playwright/test";
import { appContentSecurityPolicy } from "../packages/core/src/resource-policy.js";
import type { CognitiveAppViewUi } from "../packages/core/src/cognitive-app-view-api.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

async function report(page: Page): Promise<any> {
  return page.evaluate(() =>
    Reflect.get(window, "documentViewFixture").report(),
  );
}
async function action(
  page: Page,
  method: string,
  value?: unknown,
): Promise<any> {
  return page.evaluate(
    ({ method, value }) =>
      Reflect.get(window, "documentViewFixture")[method](value),
    { method, value },
  );
}
async function connected(page: Page): Promise<Frame> {
  await page.waitForFunction(() => {
    const state = Reflect.get(window, "documentViewFixture").report();
    const frame = state.frames[0];
    return (
      frame?.className === "cognitive-application-frame" &&
      state.authorEvents.some(
        (item: any) =>
          item.proof === new URL(frame.src).searchParams.get("documentProof") &&
          item.event.phase === "connected",
      )
    );
  });
  // Resolve the currently mounted native Frame from its actual iframe element,
  // not an index in asynchronously retiring StrictMode childFrames().
  const outerElement = await page
    .locator(".cognitive-document-container>iframe")
    .elementHandle();
  const outer = await outerElement!.contentFrame();
  assert.ok(outer);
  await outer.waitForFunction(() => document.querySelector("iframe"));
  const guestElement = await outer.locator("iframe").elementHandle();
  const guest = await guestElement!.contentFrame();
  assert.ok(guest);
  const actual = await guest.evaluate(() => {
    const author = Reflect.get(window, "documentViewAuthor");
    return {
      connected: author.connected,
      birth: author.birth,
      context: author.context(),
    };
  });
  assert.equal(actual.connected, true);
  const state = await report(page);
  const proof = new URL(state.frames[0].src).searchParams.get("documentProof");
  assert.ok(
    state.authorEvents.some(
      (item: any) =>
        item.proof === proof &&
        item.event.birth === actual.birth &&
        item.event.phase === "connected",
    ),
  );
  return guest;
}
const light = {
  theme: { appearance: "light", accent: "coral" },
  presentation: { mode: "workspace", returnControl: null },
  active: true,
};

test(
  "actual React StrictMode document component + fixed HTTP/SQL resource/native source SDK; controlled parent owner, no production App",
  { timeout: 180_000 },
  async (t) => {
    const host = (
      await build({
        entryPoints: ["tests/fixtures/cognitive-document-view-mounted.tsx"],
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2023",
        write: false,
        jsx: "automatic",
      })
    ).outputFiles[0]!.text;
    const author = (
      await build({
        stdin: {
          contents: `import {connectMorphz} from './packages/cognitive-app-sdk/src/browser.ts';
  let client;const outcomes={};
  const notify=phase=>top.postMessage({kind:'document-view-author-observation',phase,birth:window.documentViewAuthor.birth,outcomes,context:client?.context},'*');
  window.documentViewAuthor={birth:crypto.randomUUID(),connected:false,outcomes,context(){return client.context},save(){client.saveState({expectedRevision:1,state:{view:'warm-original'}}).then(value=>{outcomes.save={ok:true,value};notify('saved');},error=>{outcomes.save={ok:false,code:error.code};notify('saved');})}};
  connectMorphz().then(value=>{client=value;window.documentViewAuthor.connected=true;client.onContextChange(()=>notify('context'));notify('connected');},error=>outcomes.connect={code:error.code});`,
          resolveDir: process.cwd(),
          loader: "ts",
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        target: "es2023",
        write: false,
      })
    ).outputFiles[0]!.text;
    const html = `<!doctype html><meta charset="utf-8"><script>${author.replaceAll("</script", "<\\/script")}</script><p>原作者文档</p>`;
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "Formal entry must prepare actual Chromium",
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable,
    });
    t.after(() => browser.close());
    async function run(
      backend: "sqlite" | "postgres",
      work: (
        page: Page,
        source: CognitiveAppViewUi,
        resourceRequests: string[],
      ) => Promise<void>,
      settings: { initiallyValid?: boolean; holdAuthorize?: boolean } = {},
    ) {
      await withViewTransport(
        backend,
        async (f) => {
          const { receipt } = await f.local.call(
            "cognitive-app-views.launch",
            f.launch,
            { identityGeneration: f.localCsrf },
          );
          const source = await f.local.call(
            "cognitive-app-views.read-ui",
            {
              viewId: receipt.viewId,
              expectedViewRevision: receipt.viewRevision,
              expectedBindingRevision: receipt.bindingRevision,
            },
            { identityGeneration: f.localCsrf },
          );
          const context = await browser.newContext();
          const cookie = f.cookie()!,
            at = cookie.indexOf("=");
          await context.addCookies([
            {
              name: cookie.slice(0, at),
              value: cookie.slice(at + 1),
              url: f.origin,
            },
          ]);
          const page = await context.newPage();
          page.setDefaultTimeout(5_000);
          const pending = new Map<string, AbortController>();
          const errors: string[] = [];
          const resourceRequests: string[] = [];
          page.on("request", (request) => {
            if (
              new URL(request.url()).pathname.startsWith(
                "/api/cognitive-app-document/",
              )
            )
              resourceRequests.push(request.url());
          });
          page.on("pageerror", (error) => errors.push(error.message));
          await page.exposeFunction("documentViewSource", () => source);
          await page.exposeFunction("documentViewAbort", (id: string) =>
            pending.get(id)?.abort(),
          );
          await page.exposeFunction(
            "documentViewCall",
            async (id: string, method: string, parameters: unknown) => {
              assert.ok(
                method === "cognitive-app-views.read-ui" ||
                  method === "cognitive-app-views.save",
                "No author business or close/launch may reach this test port",
              );
              const controller = new AbortController();
              pending.set(id, controller);
              try {
                return await f.local.call(method, parameters as never, {
                  signal: controller.signal,
                  identityGeneration: f.localCsrf,
                });
              } catch (error) {
                console.error(
                  "Actual document component Local port failure",
                  method,
                  parameters,
                  error,
                );
                throw error;
              } finally {
                pending.delete(id);
              }
            },
          );
          await page.addInitScript(
            (settings) => Reflect.set(window, "documentViewSettings", settings),
            settings,
          );
          // Only the controlled React parent is served by the fixture; fixed
          // Document bytes/security headers remain the actual authenticated service.
          await page.route(f.origin + "/", (route) =>
            route.fulfill({
              contentType: "text/html",
              headers: { "Content-Security-Policy": appContentSecurityPolicy },
              body: '<!doctype html><div id="mount"></div><script type="module" src="/document-view-host.js"></script>',
            }),
          );
          await page.route(f.origin + "/document-view-host.js", (route) =>
            route.fulfill({ contentType: "text/javascript", body: host }),
          );
          try {
            await page.goto(f.origin + "/");
            await page.waitForFunction(() =>
              Reflect.get(window, "documentViewFixture"),
            );
            try {
              await work(page, source, resourceRequests);
            } catch (error) {
              console.error(
                "Actual document component browser report",
                JSON.stringify(await report(page)),
              );
              console.error(
                "Actual document component frames",
                page.frames().map((frame) => frame.url()),
              );
              for (const outer of page.mainFrame().childFrames())
                for (const guest of outer.childFrames()) {
                  console.error(
                    "Actual document component author result",
                    await guest.evaluate(() => ({
                      connected: Reflect.get(window, "documentViewAuthor")
                        ?.connected,
                      birth: Reflect.get(window, "documentViewAuthor")?.birth,
                      outcomes: Reflect.get(window, "documentViewAuthor")
                        ?.outcomes,
                      context: (() => {
                        try {
                          return Reflect.get(
                            window,
                            "documentViewAuthor",
                          )?.context();
                        } catch (error) {
                          return {
                            error: Object.getOwnPropertyDescriptor(
                              error,
                              "code",
                            )?.value,
                          };
                        }
                      })(),
                    })),
                  );
                }
              throw error;
            }
            assert.deepEqual((await report(page)).records, {
              draft: "原草稿 😀",
              preferences: "原应用现场",
            });
            assert.deepEqual(errors, []);
          } finally {
            for (const controller of pending.values()) controller.abort();
            await context.close();
          }
        },
        { html },
      );
    }
    for (const backend of ["postgres", "sqlite"] as const)
      await t.test(
        `${backend}: initial child mount waits for actual parent layout publication; own save CAS2 remains warm`,
        async () => {
          await run(backend, async (page, source) => {
            const guest = await connected(page);
            const original = await guest.evaluate(() =>
              Reflect.get(window, "documentViewAuthor").context(),
            );
            assert.deepEqual(original.authority, source.authority);
            assert.equal(original.view.id, source.view.id);
            assert.equal(
              original.view.bindingRevision,
              source.binding.revision,
            );
            // Existing real canvas CSS, not new presentation rules. A single
            // canonical Host/pane wrapper must retain the old definite height.
            await page.addStyleTag({
              content:
                readFileSync("apps/web/src/styles.css", "utf8") +
                "\n" +
                readFileSync("apps/web/src/ui.css", "utf8"),
            });
            const geometry = await page.evaluate(() => {
              const canvas = document
                .querySelector(".application-canvas")!
                .getBoundingClientRect();
              const frame = document
                .querySelector(".cognitive-document-container>iframe")!
                .getBoundingClientRect();
              return {
                canvasHeight: canvas.height,
                frameHeight: frame.height,
                frameWidth: frame.width,
              };
            });
            assert.ok(geometry.canvasHeight >= 500);
            assert.ok(
              Math.abs(geometry.frameHeight - geometry.canvasHeight) <= 1,
            );
            assert.ok(geometry.frameWidth >= 950);
            assert.ok(
              (await report(page)).guards.every(
                (guard: any) => guard.published === guard.captured,
              ),
            );
            await action(page, "captureFrame");
            await guest.evaluate(() =>
              Reflect.get(window, "documentViewAuthor").save(),
            );
            await page.waitForFunction(() =>
              Reflect.get(window, "documentViewFixture")
                .report()
                .authorEvents.some((item: any) => item.event.phase === "saved"),
            );
            assert.deepEqual(
              await guest.evaluate(
                () => Reflect.get(window, "documentViewAuthor").outcomes.save,
              ),
              {
                ok: true,
                value: { revision: 2, state: { view: "warm-original" } },
              },
            );
            await action(page, "presentation", light);
            await page.waitForFunction(() =>
              Reflect.get(window, "documentViewFixture")
                .report()
                .authorEvents.some(
                  (item: any) =>
                    item.event.phase === "context" &&
                    item.event.context.theme.accent === "coral",
                ),
            );
            assert.equal((await report(page)).sameFrame, true);
            assert.equal(
              await guest.evaluate(
                () =>
                  Reflect.get(window, "documentViewAuthor").context().view
                    .revision,
              ),
              2,
            );
            await action(page, "rerender");
            assert.equal((await report(page)).sameFrame, true);
            assert.equal((await report(page)).actions.close, 0);
            assert.equal((await report(page)).status, null);
            await action(page, "replaceSource");
            const nextGuest = await connected(page);
            assert.equal((await report(page)).sameFrame, false);
            assert.equal(
              await nextGuest.evaluate(
                () =>
                  Reflect.get(window, "documentViewAuthor").context().view
                    .revision,
              ),
              2,
            );
            assert.equal((await report(page)).actions.close, 0);
          });
        },
      );
    await t.test(
      "external owner invalidation is synchronous on committed layout; replacing callbacks cannot resurrect captured lease",
      async () => {
        await run("sqlite", async (page) => {
          await connected(page);
          assert.equal(await action(page, "invalidate", true), 0);
          await page.waitForSelector("[role=alert]");
          await action(page, "rerender");
          assert.equal((await report(page)).frames.length, 0);
          assert.equal((await report(page)).actions.close, 0);
          await page.getByRole("button", { name: "重试", exact: true }).click();
          await page.getByRole("button", { name: "返回", exact: true }).click();
          assert.deepEqual((await report(page)).actions, {
            retry: 1,
            close: 1,
            abort: 0,
          });
        });
      },
    );
    await t.test(
      "initial owner denial never appends or requests an executable document",
      async () => {
        await run(
          "sqlite",
          async (page, _source, resourceRequests) => {
            await page.waitForSelector("[role=alert]");
            assert.equal((await report(page)).frames.length, 0);
            assert.equal(page.mainFrame().childFrames().length, 0);
            assert.deepEqual((await report(page)).calls, []);
            assert.deepEqual(resourceRequests, []);
          },
          { initiallyValid: false },
        );
      },
    );
    await t.test(
      "layout cleanup aborts held authorization; late ready cannot reinstall the retired Document",
      async () => {
        await run(
          "sqlite",
          async (page) => {
            await page.waitForFunction(() =>
              Reflect.get(window, "documentViewFixture")
                .report()
                .calls.some((call: any) => !call.done),
            );
            assert.equal(await action(page, "unmount"), 0);
            await action(page, "release");
            await page.waitForFunction(() =>
              Reflect.get(window, "documentViewFixture")
                .report()
                .calls.every((call: any) => call.done),
            );
            const r = await report(page);
            assert.equal(r.frames.length, 0);
            assert.ok(r.calls.some((call: any) => call.aborted));
            assert.equal(r.actions.close, 0);
            assert.equal(r.status, null);
          },
          { holdAuthorize: true },
        );
      },
    );
    await t.test(
      "absent/closed/unbound/error remain honest non-executing status; retry and return are Human actions only",
      async () => {
        await run("sqlite", async (page) => {
          await connected(page);
          for (const status of [
            "absent",
            "closed",
            "unbound",
            "error",
          ] as const) {
            await action(page, "status", status);
            assert.equal((await report(page)).frames.length, 0);
            assert.equal(
              (await report(page)).status,
              "真实窗口当前为 " + status,
            );
          }
          assert.equal((await report(page)).actions.close, 0);
        });
      },
    );
  },
);
