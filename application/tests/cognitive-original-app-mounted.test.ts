import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "vite";

async function report(page: Page): Promise<any> {
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
  return page.evaluate(() =>
    Reflect.get(window, "cognitiveOriginalAppFixture").report(),
  );
}
async function action(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(
    ({ name, args }) =>
      Reflect.get(window, "cognitiveOriginalAppFixture")[name](...args),
    { name, args },
  );
  return report(page);
}

test(
  "complete production App original-reference consumer with controlled logical transport, not native/SQL/HPA acceptance",
  { timeout: 120_000 },
  async (t) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "formal test entry must prepare actual Chromium",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-original-app-vite-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixture = resolve(
      "tests/fixtures/cognitive-original-app-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "complete-original-app-controlled",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__original-app")
                return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url!,
                  `<!doctype html><html><head><link rel="icon" href="data:,"/></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    t.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const serverUrl = `http://127.0.0.1:${address.port}/__original-app`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    async function load(mode = "fresh") {
      await page.goto(`${serverUrl}?mode=${mode}`);
      await page.waitForFunction(
        () => !!Reflect.get(window, "cognitiveOriginalAppFixture"),
      );
      await page.waitForSelector('textarea[aria-label="AI 输入内容"]', {
        timeout: 10_000,
      });
      assert.deepEqual(errors, []);
      const r = await report(page);
      assert.deepEqual(r.unknown, [], JSON.stringify(r));
      return r;
    }
    async function waitHeld(count: number) {
      await page.waitForFunction(
        (count) =>
          Reflect.get(window, "cognitiveOriginalAppFixture").report().pending
            .length >= count,
        count,
      );
      return report(page);
    }
    async function open(index = 0) {
      await page.locator(".message-object-link").nth(index).click();
      return waitHeld(1);
    }
    const authorReads = (r: any) =>
      r.requests.filter((x: any) => x.method === "cognitive-apps.read-object");
    const forbidden = (r: any) =>
      r.requests.filter((x: any) =>
        /^(platform\.message|input\.send|messages\.send|conversations\.create|session.*(?:create|update)|app-views\.(?:launch|save)|objects\.|reading\.|script-studio\.|content\.(?:create|update))/.test(
          x.method,
        ),
      );
    await t.test(
      "smoke full real App boots and renders its genuine Conversation original buttons",
      async () => {
        const r = await load();
        assert.equal(
          await page.locator(".message-object-link").count(),
          2,
          JSON.stringify(r),
        );
        assert.equal(r.textarea.disabled, false);
        assert.equal(r.original, null);
      },
    );
    await t.test(
      "real message open blocks textarea/send, reads pinned opaque V1 not V2 head, adopts once and stores no original body",
      async () => {
        await load();
        await page
          .getByRole("textbox", { name: "AI 输入内容" })
          .fill("UNSENT_OLD_CONVERSATION_DRAFT");
        await action(page, "clearRequests");
        let r = await open();
        assert.equal(r.textarea.disabled, true, JSON.stringify(r));
        assert.equal(r.send.disabled, true);
        assert.equal(
          await page
            .getByRole("button", { name: "语音输入", exact: true })
            .isDisabled(),
          true,
        );
        await page.evaluate(() =>
          document
            .querySelector('textarea[aria-label="AI 输入内容"]')!
            .dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            ),
        );
        r = await action(page, "settle", 0);
        await page.waitForFunction(() =>
          Reflect.get(window, "cognitiveOriginalAppFixture")
            .report()
            .original?.includes("AUTHOR_PINNED_V1_PRIVATE"),
        );
        await page.locator(".document-body").waitFor({ state: "visible" });
        assert.equal(await page.title(), "历史原件 V1 — Morphz");
        r = await report(page);
        const reads = authorReads(r);
        assert.equal(
          reads.length,
          1,
          "explicit open must seed the final navigation epoch without a second target read: " +
            JSON.stringify(r),
        );
        const expected = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalAppFixture").locator(),
        );
        assert.deepEqual(reads[0].params.object, expected.object);
        assert.equal(reads[0].identityGeneration, "session-A");
        assert.deepEqual(forbidden(r), [], JSON.stringify(r));
        assert.deepEqual(r.unknown, []);
        assert.equal(
          r.preferences.cognitiveLocation.locator.object.versionRef,
          expected.object.versionRef,
        );
        assert.equal(r.preferences.artifactId, null);
        assert.equal(r.textarea.disabled, false);
        assert(!JSON.stringify(r.stored).includes("AUTHOR_PINNED_V1_PRIVATE"));
        assert(
          JSON.stringify(r.stored).includes("UNSENT_OLD_CONVERSATION_DRAFT"),
        );
        await page
          .getByRole("textbox", { name: "AI 输入内容" })
          .fill("ORIGINAL_SURFACE_UNSENT");
        r = await report(page);
        const drafts = Object.entries(r.stored).filter(([key]) =>
          key.includes(":draft:"),
        );
        assert(
          drafts.some(
            ([, value]) =>
              String(value).includes("ORIGINAL_SURFACE_UNSENT") &&
              String(value).includes(
                expected.object.versionRef.replaceAll("\n", "\\n"),
              ),
          ),
          JSON.stringify(drafts),
        );
      },
    );
    await t.test(
      "slow original A read cannot return after actual sidebar navigation B",
      async () => {
        await load();
        await action(page, "clearRequests");
        await open();
        await page
          .getByRole("button", { name: "其他项目 B", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveOriginalAppFixture").report()
              .preferences.projectId === "project-B",
        );
        const before = await report(page);
        assert.equal(before.preferences.cognitiveLocation ?? null, null);
        await action(page, "settle", 0, "LATE_A_MUST_NOT_RETURN");
        const after = await report(page);
        assert.equal(after.preferences.projectId, "project-B");
        assert.equal(after.preferences.cognitiveLocation ?? null, null);
        assert.equal(after.original, null);
        assert(!after.text.includes("LATE_A_MUST_NOT_RETURN"));
        assert.deepEqual(forbidden(after), []);
      },
    );
    await t.test(
      "restored original locator keeps actual composer blocked on read failure and retry uses exact version",
      async () => {
        let r = await load("restore");
        r = await waitHeld(1);
        assert.equal(r.textarea.disabled, true);
        assert.equal(r.send.disabled, true);
        assert.equal(
          await page
            .getByRole("button", { name: "语音输入", exact: true })
            .isDisabled(),
          true,
        );
        await action(page, "fail", r.pending.length - 1);
        await page
          .getByText("AUTHOR_READ_DENIED", { exact: true })
          .first()
          .waitFor();
        r = await report(page);
        assert.equal(r.textarea.disabled, true);
        assert.equal(r.send.disabled, true);
        const readsBefore = authorReads(r).length;
        await page
          .getByRole("button", { name: "重试读取原件", exact: true })
          .click();
        r = await waitHeld(r.pending.length + 1);
        assert.equal(authorReads(r).length, readsBefore + 1);
        assert.deepEqual(
          authorReads(r).at(-1).params.object,
          r.preferences.cognitiveLocation.locator.object,
        );
        await action(page, "settle", r.pending.length - 1);
        await page.waitForFunction(() =>
          Reflect.get(window, "cognitiveOriginalAppFixture")
            .report()
            .original?.includes("AUTHOR_PINNED_V1_PRIVATE"),
        );
        r = await report(page);
        assert.equal(r.textarea.disabled, false);
        assert.deepEqual(forbidden(r), []);
      },
    );
    await t.test(
      "real full-App reload restores locator not cached body and preserves exact original-scoped unsent draft",
      async () => {
        await load("restore");
        let r = await waitHeld(1);
        await action(page, "settle", r.pending.length - 1);
        await page.locator(".document-body").waitFor({ state: "visible" });
        await page
          .getByRole("textbox", { name: "AI 输入内容" })
          .fill("RELOAD_ORIGINAL_DRAFT");
        r = await load("keep");
        r = await waitHeld(1);
        assert.equal(r.original, null);
        assert.equal(r.textarea.disabled, true);
        assert.equal(r.send.disabled, true);
        const expected = r.preferences.cognitiveLocation.locator.object;
        assert.deepEqual(authorReads(r).at(-1).params.object, expected);
        await action(page, "settle", r.pending.length - 1);
        await page.locator(".document-body").waitFor({ state: "visible" });
        r = await report(page);
        assert.equal(r.textarea.value, "RELOAD_ORIGINAL_DRAFT");
        assert.equal(r.textarea.disabled, false);
        assert.deepEqual(forbidden(r), []);
        assert(!JSON.stringify(r.stored).includes("AUTHOR_PINNED_V1_PRIVATE"));
      },
    );
    for (const [field, value] of [
      ["csrfToken", "session-B"],
      ["principalId", "human-B"],
      ["centerId", "22222222-2222-4222-8222-222222222222"],
    ]) {
      await t.test(
        "actual current-Human " +
          field +
          " change prevents late old original publication and reauthorizes restored locator",
        async () => {
          await load("restore");
          let r = await waitHeld(1);
          const old = r.pending.length - 1;
          await action(page, "switchIdentity", field, value);
          r = await waitHeld(old + 2);
          await action(page, "settle", old, "OLD_HUMAN_BODY_MUST_NOT_LEAK");
          r = await report(page);
          assert.equal(r.original, null, JSON.stringify(r));
          assert(!r.text.includes("OLD_HUMAN_BODY_MUST_NOT_LEAK"));
          assert.equal(r.textarea.disabled, true);
          await action(
            page,
            "settle",
            r.pending.length - 1,
            "CURRENT_HUMAN_REAUTHORIZED",
          );
          await page.waitForFunction(() =>
            Reflect.get(window, "cognitiveOriginalAppFixture")
              .report()
              .original?.includes("CURRENT_HUMAN_REAUTHORIZED"),
          );
          r = await report(page);
          assert.equal(r.textarea.disabled, false);
          assert.deepEqual(forbidden(r), []);
        },
      );
      await t.test(
        "explicit open cannot adopt its old result after real " +
          field +
          " retirement",
        async () => {
          await load();
          await open();
          await action(page, "switchIdentity", field, value);
          await page.waitForFunction(() => {
            const r = Reflect.get(
              window,
              "cognitiveOriginalAppFixture",
            ).report();
            return (
              r.requests.filter((x: any) => x.method === "platform.bootstrap")
                .length >= 2 &&
              r.textarea &&
              !r.textarea.disabled
            );
          });
          await action(page, "settle", 0, "OLD_EXPLICIT_RESULT_MUST_NOT_ADOPT");
          let r = await report(page);
          assert.equal(r.original, null);
          assert.equal(r.preferences.cognitiveLocation ?? null, null);
          assert(!r.text.includes("OLD_EXPLICIT_RESULT_MUST_NOT_ADOPT"));
          await page.locator(".message-object-link").first().click();
          r = await waitHeld(2);
          await action(page, "settle", 1, "CURRENT_EXPLICIT_RESULT");
          await page.locator(".document-body").waitFor({ state: "visible" });
          r = await report(page);
          assert.equal(r.original, "CURRENT_EXPLICIT_RESULT");
          assert.deepEqual(forbidden(r), []);
        },
      );
    }
    await t.test(
      "beginOpen from restored ready original does not re-read the abandoned old locator before adopting the next original",
      async () => {
        await load("restore");
        let r = await waitHeld(1);
        await action(page, "settle", r.pending.length - 1);
        await page.waitForFunction(() =>
          Reflect.get(window, "cognitiveOriginalAppFixture")
            .report()
            .original?.includes("AUTHOR_PINNED_V1_PRIVATE"),
        );
        await page
          .getByRole("textbox", { name: "AI 输入内容" })
          .fill("STABLE_ORIGINAL_A_DRAFT");
        // Recent exchange intentionally filters to the current object. The real
        // full-history control, not a fixture callback, reveals object B's input.
        await page
          .getByRole("button", { name: "展开完整记录", exact: true })
          .click();
        await action(page, "clearRequests");
        await page.locator(".message-object-link").nth(1).click();
        r = await waitHeld(r.pending.length + 1);
        const reads = authorReads(r);
        assert.equal(
          reads.length,
          1,
          "beginOpen must not re-read obsolete original while reading next: " +
            JSON.stringify(r),
        );
        assert.equal(reads[0].params.object.objectId, "object-B");
        assert.equal(r.original, "AUTHOR_PINNED_V1_PRIVATE");
        assert.equal(r.textarea.value, "STABLE_ORIGINAL_A_DRAFT");
        assert.equal(r.textarea.disabled, true);
        await action(
          page,
          "settle",
          r.pending.length - 1,
          "SECOND_ORIGINAL_PINNED",
        );
        await page.waitForFunction(() =>
          Reflect.get(window, "cognitiveOriginalAppFixture")
            .report()
            .original?.includes("SECOND_ORIGINAL_PINNED"),
        );
        r = await report(page);
        assert.equal(authorReads(r).length, 1);
        assert.equal(r.textarea.disabled, false);
        assert.deepEqual(forbidden(r), []);
      },
    );
    await t.test(
      "failed explicit B keeps ready original A and its local draft without retry or old original read",
      async () => {
        await load("restore");
        let r = await waitHeld(1);
        await action(page, "settle", r.pending.length - 1);
        await page.locator(".document-body").waitFor({ state: "visible" });
        await page
          .getByRole("textbox", { name: "AI 输入内容" })
          .fill("KEEP_A_ON_B_FAILURE");
        await page
          .getByRole("button", { name: "展开完整记录", exact: true })
          .click();
        await action(page, "clearRequests");
        await page.locator(".message-object-link").nth(1).click();
        r = await waitHeld(r.pending.length + 1);
        assert.equal(r.textarea.disabled, true);
        assert.equal(r.send.disabled, true);
        await action(page, "fail", r.pending.length - 1);
        await page.waitForFunction(() => {
          const r = Reflect.get(window, "cognitiveOriginalAppFixture").report();
          return r.text?.includes("AUTHOR_READ_DENIED") && !r.textarea.disabled;
        });
        r = await report(page);
        assert.equal(authorReads(r).length, 1);
        assert.equal(r.original, "AUTHOR_PINNED_V1_PRIVATE");
        assert.equal(r.textarea.value, "KEEP_A_ON_B_FAILURE");
        assert.equal(
          r.preferences.cognitiveLocation.locator.object.objectId,
          "object-A",
        );
        assert.deepEqual(forbidden(r), []);
      },
    );
    await t.test(
      "same exact original re-open uses one explicit owner read and does not replace its draft scope",
      async () => {
        await load("restore");
        let r = await waitHeld(1);
        await action(page, "settle", r.pending.length - 1);
        await page.locator(".document-body").waitFor({ state: "visible" });
        await page
          .getByRole("textbox", { name: "AI 输入内容" })
          .fill("SAME_ORIGINAL_LOCAL_DRAFT");
        await action(page, "clearRequests");
        await page.locator(".message-object-link").first().click();
        r = await waitHeld(r.pending.length + 1);
        assert.equal(authorReads(r).length, 1);
        assert.equal(r.original, "AUTHOR_PINNED_V1_PRIVATE");
        assert.equal(r.textarea.value, "SAME_ORIGINAL_LOCAL_DRAFT");
        assert.equal(r.textarea.disabled, true);
        await action(
          page,
          "settle",
          r.pending.length - 1,
          "REFRESHED_SAME_OPAQUE_VERSION",
        );
        await page.waitForFunction(() =>
          Reflect.get(window, "cognitiveOriginalAppFixture")
            .report()
            .original?.includes("REFRESHED_SAME_OPAQUE_VERSION"),
        );
        r = await report(page);
        assert.equal(authorReads(r).length, 1);
        assert.equal(r.textarea.value, "SAME_ORIGINAL_LOCAL_DRAFT");
        assert.equal(r.textarea.disabled, false);
        assert.deepEqual(forbidden(r), []);
      },
    );
    assert.deepEqual(errors, []);
  },
);
