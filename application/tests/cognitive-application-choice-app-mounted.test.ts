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
    Reflect.get(window, "cognitiveChoiceAppFixture").report(),
  );
}
async function action(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(
    ({ name, args }) =>
      Reflect.get(window, "cognitiveChoiceAppFixture")[name](...args),
    { name, args },
  );
  return report(page);
}
const selectionIo = (r: any) =>
  r.requests.filter((request: any) =>
    /^(?:platform\.message|conversations\.create|app-views\.(?:launch|save|close)|cognitive-apps\.(?:install|grant|connect|connection-state|describe|read-object|invoke)|cognitive-app-views\.|objects\.|reading\.|script-studio\.)/.test(
      request.method,
    ),
  );

test(
  "complete production App explicit cognitive input choices; controlled logical transport, not SQL/native/author/manual-App acceptance",
  { timeout: 240_000 },
  async (t) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "formal entry prepares actual Chromium",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-choice-app-vite-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixture = resolve(
      "tests/fixtures/cognitive-application-choice-app-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "complete-choice-app-controlled",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__choice-app") return next();
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
    const serverUrl = `http://127.0.0.1:${address.port}/__choice-app`;
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
    const authorResources: string[] = [];
    await page.route("**/api/application-view/**", async (route) => {
      authorResources.push(route.request().url());
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body><div id='unaccepted-author-marker'>UNACCEPTED_COGNITIVE_GUI</div></body></html>",
      });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    async function load(mode = "fresh") {
      authorResources.length = 0;
      await page.goto(`${serverUrl}?mode=${mode}`);
      await page.waitForFunction(
        () => !!Reflect.get(window, "cognitiveChoiceAppFixture"),
      );
      try {
        await page
          .getByRole("textbox", { name: "AI 输入内容", exact: true })
          .waitFor({ timeout: 15_000 });
      } catch (error) {
        assert.fail(
          "Actual App boot did not reach its real composer: " +
            JSON.stringify({
              error: String(error),
              pageErrors: errors,
              report: await report(page),
            }),
        );
      }
      await page.waitForFunction(
        () =>
          Reflect.get(window, "cognitiveChoiceAppFixture")
            .report()
            .requests.filter((r: any) => r.method === "cognitive-apps.list")
            .length >= 2,
      );
      const r = await report(page);
      assert.deepEqual(errors, []);
      assert.deepEqual(r.unknown, [], JSON.stringify(r));
      return r;
    }
    const picker = () =>
      page.getByRole("dialog", {
        name: "本次输入使用的应用",
        exact: true,
      });
    async function workbenchChoice(version = "1.0.0", title = "作者笔记") {
      await page
        .getByRole("button", {
          name: `用于本次输入：${title} ${version}`,
          exact: true,
        })
        .click();
      await picker().waitFor();
      return picker();
    }
    async function choose(connection = "connection-A", version = "1.0.0") {
      await picker()
        .getByRole("button", {
          name: `使用作者笔记 ${version}，数据连接 ${connection}`,
          exact: true,
        })
        .click();
      await picker().waitFor({ state: "detached" });
      return report(page);
    }
    async function scopeMenu() {
      await page.getByRole("button", { name: "输入关联", exact: true }).click();
      const menu = page.getByRole("group", {
        name: "本次输入关联",
        exact: true,
      });
      await menu.waitFor();
      return menu;
    }
    async function launcher() {
      await page.getByRole("button", { name: "全部应用", exact: true }).click();
      const menu = page.getByRole("group", { name: "选择应用", exact: true });
      await menu.waitFor();
      return menu;
    }
    await t.test(
      "actual App/CSS/StrictMode boot uses its genuine persisted window draft and shared paged directory",
      async () => {
        const r = await load();
        assert.equal(
          r.textarea.value,
          "原草稿字节\nUNCHANGED 😀",
          JSON.stringify(r),
        );
        assert.equal(r.preferences.view, "desk");
        assert.deepEqual(r.drafts["desk:desk:desk"].attachments, [
          { assetId: "e".repeat(64), name: "原附件.txt", mime: "text/plain" },
        ]);
        assert.equal(r.drafts["desk:desk:desk"].reasoningEffort, "max");
        assert.equal(
          r.drafts["desk:quotes"].textQuotes[0].text,
          "原引用字节 😀",
        );
        assert.deepEqual(selectionIo(r), []);
        assert.equal(r.iframes.length, 0);
        const list = r.requests.filter(
          (request: any) => request.method === "cognitive-apps.list",
        );
        assert.ok(
          list.some(
            (request: any) =>
              request.params.versionsAfter === "common_checkpoint_v2",
          ),
        );
        assert.equal(
          list.length,
          2,
          "the real owner uses the shared checkpoint once",
        );
      },
    );
    await t.test(
      "an explicit choice preserves every original draft field and stores the complete exact Core target, never the first connection",
      async () => {
        const before = await load();
        await action(page, "clearRequests");
        await workbenchChoice("2.0.0");
        const after = await choose("connection-B", "2.0.0");
        const expected = await page.evaluate(() =>
          Reflect.get(window, "cognitiveChoiceAppFixture").target(
            "connection-B",
            "2.0.0",
          ),
        );
        assert.deepEqual(after.drafts, {
          ...before.drafts,
          "desk:desk:desk": {
            ...before.drafts["desk:desk:desk"],
            cognitiveApplication: expected,
          },
        });
        assert.equal(after.textarea.value, before.textarea.value);
        assert.deepEqual(selectionIo(after), []);
        assert.deepEqual(after.unknown, []);
        assert.equal(after.iframes.length, 0);
        assert.equal(after.preferences.projectId, "desk");
        assert.equal(after.preferences.cognitiveLocation ?? null, null);
        await page
          .getByRole("button", { name: "输入关联", exact: true })
          .waitFor();
        assert.ok(
          (
            await page
              .getByRole("button", { name: "输入关联", exact: true })
              .textContent()
          )?.includes("作者笔记 · 2.0.0"),
        );
      },
    );
    await t.test(
      "Launcher and pinned Dock use the very same explicit choice and preserve hidden saved pins",
      async () => {
        const before = await load("pinned");
        await action(page, "clearRequests");
        const menu = await launcher();
        await menu
          .getByRole("button", {
            name: "用于本次输入：作者笔记 2.0.0",
            exact: true,
          })
          .click();
        await picker().waitFor();
        assert.deepEqual((await report(page)).drafts, before.drafts);
        let after = await choose("connection-B", "2.0.0");
        assert.deepEqual(selectionIo(after), []);
        await page
          .locator(
            '.application-dock-pins button[data-dock-key="cognitive:author.notes@1.0.0#' +
              "a".repeat(64) +
              '"]',
          )
          .click();
        await picker().waitFor();
        after = await choose("connection-A", "1.0.0");
        assert.equal(
          after.drafts["desk:desk:desk"].cognitiveApplication.connectionId,
          "connection-A",
        );
        assert.equal(
          after.drafts["desk:desk:desk"].cognitiveApplication.authority.version,
          "1.0.0",
        );
        assert.deepEqual(
          after.preferences.dockApplications,
          before.preferences.dockApplications,
        );
        assert.deepEqual(selectionIo(after), []);
        assert.deepEqual(after.unknown, []);
      },
    );
    await t.test(
      "actual input association changes and removes only its target via the common picker",
      async () => {
        const before = await load("selected");
        await action(page, "clearRequests");
        let menu = await scopeMenu();
        assert.ok(
          (await menu.textContent())?.includes("作者/资料/connection-A"),
        );
        await menu
          .getByRole("button", { name: "更改本次输入应用", exact: true })
          .click();
        await picker().waitFor();
        let after = await choose("connection-B", "2.0.0");
        assert.equal(
          after.drafts["desk:desk:desk"].cognitiveApplication.authority.version,
          "2.0.0",
        );
        menu = await scopeMenu();
        await menu
          .getByRole("button", { name: "移除本次输入应用", exact: true })
          .click();
        after = await report(page);
        const originalDraft = { ...before.drafts["desk:desk:desk"] };
        delete originalDraft.cognitiveApplication;
        assert.deepEqual(after.drafts, {
          ...before.drafts,
          "desk:desk:desk": originalDraft,
        });
        assert.deepEqual(selectionIo(after), []);
        assert.equal(
          await page
            .getByRole("button", { name: "输入关联", exact: true })
            .count(),
          0,
          "implicit personal routing has no permanent empty target label",
        );
      },
    );
    await t.test(
      "unselected personal input stays unlabeled and a deliberate empty Dock stays empty, not repopulated",
      async () => {
        await load("pinned");
        const pins = page.locator(".application-dock-pins");
        assert.equal(await pins.count(), 1);
        assert.equal(await pins.locator("[data-dock-source=dock]").count(), 1);
        const before = await load("empty-pins");
        assert.equal(await pins.count(), 1);
        assert.equal(
          await page
            .getByRole("button", { name: "输入关联", exact: true })
            .count(),
          0,
        );
        assert.equal(await pins.locator("[data-dock-source=dock]").count(), 0);
        assert.deepEqual(before.preferences.dockApplications, []);
        const menu = await launcher();
        assert.equal(
          await menu
            .getByRole("button", {
              name: "用于本次输入：作者笔记 1.0.0",
              exact: true,
            })
            .count(),
          1,
        );
        assert.deepEqual((await report(page)).preferences.dockApplications, []);
        assert.deepEqual(selectionIo(await report(page)), []);
      },
    );
    await t.test(
      "GUI absence and declared-but-unaccepted GUI are honest; the same installed cognitive GUI never offers old sandbox launch",
      async () => {
        await load();
        await action(page, "clearRequests");
        assert.equal(
          await page
            .getByRole("button", { name: "打开作者界面", exact: true })
            .count(),
          0,
        );
        await workbenchChoice();
        assert.ok(
          (await picker().textContent())?.includes("此应用没有独立界面"),
        );
        await picker()
          .getByRole("button", { name: "关闭应用选择", exact: true })
          .click();
        const menu = await launcher();
        assert.equal(
          await menu
            .getByRole("button", { name: "打开作者界面", exact: true })
            .count(),
          0,
        );
        await menu
          .getByRole("button", {
            name: "用于本次输入：作者界面 1.0.0",
            exact: true,
          })
          .click();
        await picker().waitFor();
        assert.ok((await picker().textContent())?.includes("应用界面尚未开放"));
        assert.equal((await report(page)).iframes.length, 0);
        assert.deepEqual(selectionIo(await report(page)), []);
      },
    );
    await t.test(
      "disabled installation and no active connection explain their unavailable choice without granting or selecting",
      async () => {
        const before = await load();
        const disabled = page.getByRole("button", {
          name: "用于本次输入：未就绪应用 1.0.0",
          exact: true,
        });
        assert.equal(await disabled.count(), 2);
        assert.equal(await disabled.first().isDisabled(), true);
        assert.equal(await disabled.last().isDisabled(), true);
        assert.deepEqual((await report(page)).drafts, before.drafts);
        assert.deepEqual(selectionIo(await report(page)), []);
      },
    );
    await t.test(
      "permission loss retains exact selected target and original draft instead of falling back to Morphz or another connection",
      async () => {
        const before = await load("selected");
        await action(page, "clearRequests");
        await action(page, "hideCatalog");
        await page.waitForFunction(() =>
          document
            .querySelector(".composer-scope-trigger")
            ?.textContent?.includes("应用目标"),
        );
        const after = await report(page);
        assert.deepEqual(after.drafts, before.drafts);
        assert.equal(after.textarea.value, before.textarea.value);
        const menu = await scopeMenu();
        assert.ok((await menu.textContent())?.includes("当前不可用"));
        assert.deepEqual(selectionIo(after), []);
        assert.equal(after.iframes.length, 0);
        assert.deepEqual(after.unknown, []);
      },
    );
    for (const fault of ["rotateWindowOwner", "denyWindowOwnerRead"]) {
      await t.test(
        `real ${fault} refuses a previously opened choice and preserves complete original draft`,
        async () => {
          const before = await load();
          await workbenchChoice();
          await action(page, "clearRequests");
          await action(page, fault);
          await picker()
            .getByRole("button", {
              name: "使用作者笔记 1.0.0，数据连接 connection-B",
              exact: true,
            })
            .click();
          const after = await report(page);
          assert.deepEqual(after.drafts, before.drafts);
          assert.equal(after.textarea.value, before.textarea.value);
          assert.ok(after.text.includes("输入工作范围已有变化"));
          assert.deepEqual(selectionIo(after), []);
          await action(page, "restoreWindowOwner");
        },
      );
      await t.test(
        `real ${fault} refuses target removal through an already-open association menu`,
        async () => {
          const before = await load("selected");
          const menu = await scopeMenu();
          await action(page, "clearRequests");
          await action(page, fault);
          await menu
            .getByRole("button", { name: "移除本次输入应用", exact: true })
            .click();
          const after = await report(page);
          assert.deepEqual(after.drafts, before.drafts);
          assert.ok(after.text.includes("输入工作范围已有变化"));
          assert.deepEqual(selectionIo(after), []);
          await action(page, "restoreWindowOwner");
        },
      );
    }
    await t.test(
      "a special supplement draft blocks all new choices without changing the frozen original operation or pending retry",
      async () => {
        const before = await load("special");
        await action(page, "clearRequests");
        await workbenchChoice();
        const button = picker().getByRole("button", {
          name: "使用作者笔记 1.0.0，数据连接 connection-B",
          exact: true,
        });
        assert.equal(await button.isDisabled(), true);
        assert.ok(
          (await picker().textContent())?.includes(
            "原输入中已有来源或专用请求",
          ),
        );
        const after = await report(page);
        assert.deepEqual(after.drafts, before.drafts);
        assert.deepEqual(selectionIo(after), []);
        assert.equal(after.pending.length, 0);
      },
    );
    await t.test(
      "open project association cannot choose through a stale menu after actual sidebar navigation; both original scoped drafts remain",
      async () => {
        const before = await load("project");
        const menu = await scopeMenu();
        assert.equal(
          await menu
            .getByRole("button", { name: "选择本次输入应用", exact: true })
            .count(),
          1,
        );
        await action(page, "clearRequests");
        await page.getByRole("button", { name: "项目 B", exact: true }).click();
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveChoiceAppFixture").report()
              .preferences.projectId === "project-B",
        );
        assert.equal(await picker().count(), 0);
        const after = await report(page);
        assert.deepEqual(after.drafts, before.drafts);
        assert.equal(after.textarea.value, "项目 B 原草稿");
        assert.deepEqual(selectionIo(after), []);
      },
    );
    for (const [field, value] of [
      ["centerId", "99999999-9999-4999-8999-999999999999"],
      ["principalId", "human-B"],
      ["csrfToken", "session-B"],
    ] as const) {
      await t.test(
        `actual workspace ${field} refresh retires an open choice rather than applying it to the new identity`,
        async () => {
          const before = await load();
          await workbenchChoice();
          await action(page, "clearRequests");
          await action(page, "switchIdentity", field, value);
          await picker().waitFor({ state: "detached" });
          await page
            .getByRole("textbox", { name: "AI 输入内容", exact: true })
            .waitFor();
          const after = await report(page);
          for (const [key, bytes] of Object.entries(before.stored))
            if (key.includes(":draft:"))
              assert.equal(
                after.stored[key],
                bytes,
                "identity changes do not overwrite or move the original window draft",
              );
          assert.deepEqual(selectionIo(after), []);
          assert.deepEqual(after.unknown, []);
          assert.equal(after.iframes.length, 0);
        },
      );
    }
    await t.test(
      "explicit ordinary send freezes A target once; late A ACK preserves later B target and unsent body in the actual App",
      async () => {
        await load("selected");
        await action(page, "clearRequests");
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveChoiceAppFixture").report().pending
              .length === 1,
        );
        const submitted = await report(page);
        const command = submitted.pending[0].request;
        const a = await page.evaluate(() =>
          Reflect.get(window, "cognitiveChoiceAppFixture").target(),
        );
        assert.deepEqual(command.params.operation.cognitiveApplication, a);
        assert.equal(command.params.operation.body, "原草稿字节\nUNCHANGED 😀");
        assert.equal(command.params.operation.model, "fixture-model");
        assert.equal(command.params.operation.reasoningEffort, "max");
        await page
          .getByRole("textbox", { name: "AI 输入内容", exact: true })
          .fill("B 的后来新草稿 😀");
        await workbenchChoice("2.0.0");
        await choose("connection-B", "2.0.0");
        const beforeAck = await report(page);
        await action(page, "settle", 0);
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveChoiceAppFixture").report().pending[0]
              .settled === true,
        );
        const after = await report(page);
        assert.equal(after.textarea.value, "B 的后来新草稿 😀");
        assert.deepEqual(
          after.drafts["desk:desk:desk"].cognitiveApplication,
          beforeAck.drafts["desk:desk:desk"].cognitiveApplication,
        );
        assert.deepEqual(after.pending[0].request, command);
        assert.equal(
          after.requests.filter((r: any) => r.method === "platform.message")
            .length,
          1,
        );
        assert.deepEqual(after.unknown, []);
        assert.equal(after.iframes.length, 0);
      },
    );
    await t.test(
      "reload restores the same exact chosen application target and original unsent fields, without opening GUI or sending",
      async () => {
        await load();
        await workbenchChoice("2.0.0");
        const before = await choose("connection-B", "2.0.0");
        const after = await load("keep");
        assert.deepEqual(after.drafts, before.drafts);
        assert.equal(after.textarea.value, before.textarea.value);
        assert.deepEqual(selectionIo(after), []);
        assert.equal(after.iframes.length, 0);
        assert.deepEqual(after.unknown, []);
      },
    );
    await t.test(
      "actual restored original V1 refuses a V2 or different-connection application choice without replacing its opaque original locator",
      async () => {
        await load("original");
        await page.locator(".document-body").waitFor();
        const before = await report(page);
        assert.equal(before.textarea.value, "原件 V1 的未发送草稿");
        const original = await page.evaluate(
          () => Reflect.get(window, "cognitiveChoiceAppFixture").original,
        );
        const originalKey = Object.keys(before.drafts).find((key) =>
          key.includes(":cognitive:"),
        )!;
        assert.deepEqual(before.drafts[originalKey].cognitiveObject, original);
        await action(page, "clearRequests");
        const menu = await launcher();
        await menu
          .getByRole("button", {
            name: "用于本次输入：作者笔记 2.0.0",
            exact: true,
          })
          .click();
        await picker().waitFor();
        const after = await choose("connection-B", "2.0.0");
        assert.deepEqual(after.drafts, before.drafts);
        assert.equal(after.textarea.value, before.textarea.value);
        assert.deepEqual(
          after.preferences.cognitiveLocation,
          before.preferences.cognitiveLocation,
        );
        assert.deepEqual(selectionIo(after), []);
        assert.deepEqual(after.unknown, []);
        assert.equal(after.iframes.length, 0);
      },
    );
    await t.test(
      "real Workbench exposes the exact authorized headless version as an explicit input choice",
      async () => {
        const before = await load();
        await action(page, "clearRequests");
        const button = page.getByRole("button", {
          name: "用于本次输入：作者笔记 1.0.0",
          exact: true,
        });
        assert.equal(
          await button.count(),
          1,
          "the real shared Workbench entry must consume the actual cognitive catalog, not a fake UI manifest",
        );
        await button.click();
        const dialog = page.getByRole("dialog", {
          name: "本次输入使用的应用",
          exact: true,
        });
        await dialog.waitFor();
        assert.equal(
          await dialog
            .getByRole("button", {
              name: "使用作者笔记 1.0.0，数据连接 connection-A",
              exact: true,
            })
            .count(),
          1,
        );
        assert.equal(
          await dialog
            .getByRole("button", {
              name: "使用作者笔记 1.0.0，数据连接 connection-B",
              exact: true,
            })
            .count(),
          1,
        );
        const current = await report(page);
        assert.deepEqual(
          current.drafts,
          before.drafts,
          "opening a chooser is not choosing the first connection",
        );
        assert.deepEqual(selectionIo(current), []);
        assert.equal(
          current.iframes.length,
          0,
          "headless choice cannot manufacture a GUI",
        );
      },
    );
    for (const mode of [
      "existing-active",
      "existing-disabled",
      "existing-no-grant",
    ]) {
      await t.test(
        `${mode}: current SQL-shaped cognitive UI summary is already filtered by the real Client without legacy iframe or author resource IO`,
        async () => {
          const before = await load(mode);
          assert.equal(
            await page
              .getByRole("tab", { name: "作者界面", exact: true })
              .count(),
            0,
          );
          assert.equal(before.iframes.length, 0);
          assert.deepEqual(authorResources, []);
          assert.equal(
            before.preferences.applications.desk,
            "legacy-cognitive-window",
            "filtering projection does not delete original saved preference",
          );
          assert.equal(before.textarea.value, "原草稿字节\nUNCHANGED 😀");
          assert.deepEqual(selectionIo(before), []);
          assert.deepEqual(before.unknown, []);
        },
      );
    }
    for (const mode of [
      "existing-legacy-active",
      "existing-legacy-disabled",
      "existing-legacy-no-grant",
    ]) {
      await t.test(
        `${mode}: defense-in-depth for contradictory controlled legacy-shaped port projection; not reachable current SQL evidence; preserve restored tab and drafts but no legacy sandbox`,
        async () => {
          const before = await load(mode);
          await page
            .getByRole("tab", { name: "作者界面", exact: true })
            .waitFor();
          assert.equal(
            before.preferences.applications.desk,
            "legacy-cognitive-window",
          );
          const returned = before.requests.filter(
            (request: any) => request.method === "app-views.list",
          );
          assert.ok(returned.length > 0);
          assert.equal(
            before.iframes.length,
            0,
            "registered cognitive GUI must not fall back to the old UI-only sandbox: " +
              JSON.stringify({
                iframes: before.iframes,
                resources: authorResources,
              }),
          );
          assert.deepEqual(
            authorResources,
            [],
            "opening a restored cognitive tab must not read the old author UI resource",
          );
          assert.deepEqual(selectionIo(before), []);
          assert.deepEqual(before.unknown, []);
          assert.ok(
            before.text.includes("尚未开放") ||
              before.text.includes("尚未通过"),
          );
          await page
            .getByRole("button", { name: "应用启动台", exact: true })
            .click();
          const after = await report(page);
          assert.deepEqual(after.drafts, before.drafts);
          assert.equal(after.preferences.applications.desk, null);
          assert.deepEqual(selectionIo(after), []);
          assert.equal(
            await page
              .getByRole("tab", { name: "作者界面", exact: true })
              .count(),
            1,
          );
        },
      );
    }
    await t.test(
      "complete App modal geometry and keyboard viewport reachability: light/dark/narrow/CSS-200-percent, not native Desktop zoom",
      async () => {
        const screenshots = await mkdtemp(
          resolve(tmpdir(), "morphz-choice-full-app-screens-"),
        );
        console.log(
          "Actual production App automated screenshots: " + screenshots,
        );
        for (const scenario of [
          {
            name: "wide-light",
            width: 1440,
            height: 1000,
            dark: false,
            zoom: 1,
          },
          { name: "wide-dark", width: 1440, height: 1000, dark: true, zoom: 1 },
          { name: "narrow", width: 760, height: 540, dark: false, zoom: 1 },
          { name: "css-200", width: 1440, height: 1000, dark: false, zoom: 2 },
        ]) {
          await page.setViewportSize({
            width: scenario.width,
            height: scenario.height,
          });
          await page.emulateMedia({
            colorScheme: scenario.dark ? "dark" : "light",
          });
          const before = await load("selected");
          if (scenario.zoom !== 1)
            await page.locator(".app").evaluate((element) => {
              (element as HTMLElement).style.zoom = "2";
            });
          const menu = await scopeMenu();
          await menu
            .getByRole("button", { name: "更改本次输入应用", exact: true })
            .click();
          await picker().waitFor();
          const geometry = await picker().evaluate((element) => {
            const box = element.getBoundingClientRect();
            return {
              left: box.left,
              top: box.top,
              right: box.right,
              bottom: box.bottom,
              width: innerWidth,
              height: innerHeight,
            };
          });
          assert.ok(
            geometry.left >= -1 &&
              geometry.top >= -1 &&
              geometry.right <= geometry.width + 1 &&
              geometry.bottom <= geometry.height + 1,
            scenario.name + ": " + JSON.stringify(geometry),
          );
          for (let step = 0; step < 15; step++) {
            await page.keyboard.press("Tab");
            const focused = await page.evaluate(() => {
              const active = document.activeElement as HTMLElement;
              const box = active.getBoundingClientRect();
              return {
                inDialog: !!active.closest("dialog"),
                left: box.left,
                top: box.top,
                right: box.right,
                bottom: box.bottom,
                width: innerWidth,
                height: innerHeight,
              };
            });
            assert.equal(focused.inDialog, true, scenario.name);
            assert.ok(
              focused.left >= -1 &&
                focused.top >= -1 &&
                focused.right <= focused.width + 1 &&
                focused.bottom <= focused.height + 1,
              scenario.name + ": " + JSON.stringify(focused),
            );
          }
          await picker().evaluate(async (element) => {
            await Promise.all(
              element.getAnimations().map((animation) => animation.finished),
            );
            await new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            );
          });
          const material = await picker().evaluate((element) => {
            const computed = getComputedStyle(element);
            const header = element.querySelector(
              ".cognitive-application-choices header",
            )!;
            const title = header.querySelector("div")!;
            const headerBox = header.getBoundingClientRect(),
              titleBox = title.getBoundingClientRect();
            return {
              background: computed.backgroundColor,
              opacity: computed.opacity,
              backdropFilter: computed.backdropFilter,
              animations: element
                .getAnimations()
                .map((animation) => animation.playState),
              headerJustify: getComputedStyle(header).justifyContent,
              headerMargin: getComputedStyle(header).margin,
              titleLeft: titleBox.left,
              headerLeft: headerBox.left,
            };
          });
          console.log(
            scenario.name +
              " actual modal material: " +
              JSON.stringify(material),
          );
          assert.equal(material.opacity, "1", scenario.name);
          assert.equal(material.headerJustify, "flex-start", scenario.name);
          assert.equal(material.headerMargin, "0px", scenario.name);
          await page.screenshot({
            path: resolve(screenshots, scenario.name + ".png"),
          });
          await page.keyboard.press("Escape");
          await picker().waitFor({ state: "detached" });
          assert.deepEqual((await report(page)).drafts, before.drafts);
          assert.deepEqual(selectionIo(await report(page)), []);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.emulateMedia({ colorScheme: "light" });
      },
    );
  },
);
