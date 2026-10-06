import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test(
  "production App + menu prepares guarded drafts only; real mounted keyboard/geometry with controlled transport, not SQL/native/manual App",
  { timeout: 90_000 },
  async (t) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "formal entry supplies Chromium",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-creation-menu-vite-"),
    );
    const evidenceDir = await mkdtemp(
      resolve(tmpdir(), "morphz-creation-menu-evidence-"),
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
          name: "new-menu-mounted",
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/__new-menu") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url!,
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
    const url = `http://127.0.0.1:${address.port}/__new-menu`;
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
    const input = () =>
      page.getByRole("textbox", { name: "AI 输入内容", exact: true });
    const plus = () =>
      page.getByRole("button", { name: "新建或添加", exact: true });
    const menu = () =>
      page.getByRole("group", { name: "新建与添加", exact: true });
    const scope = () => page.locator(".composer-scope-trigger:visible");
    const scopeMenu = () =>
      page.getByRole("group", { name: "本次输入关联", exact: true });
    async function assertIntentScope(label: string, evidenceName: string) {
      assert(await scope().isVisible(), `${label} has an actionable scope`);
      assert.equal(
        (await scope().innerText()).trim(),
        label,
        "the visible scope matches the creation shortcut",
      );
      assert.equal(
        await page
          .getByText("无项目", { exact: true })
          .evaluateAll(
            (nodes) =>
              nodes.filter(
                (node) =>
                  node.checkVisibility() &&
                  !node.closest(".composer-scope-menu"),
              ).length,
          ),
        0,
        "an implicit personal owner never replaces the visible creation intent",
      );
      await page.screenshot({
        path: resolve(evidenceDir, `${evidenceName}-scope.png`),
        animations: "disabled",
      });
      await scope().click();
      assert(await scopeMenu().isVisible());
      assert.equal(
        await scopeMenu().locator(".composer-intent > span").innerText(),
        label,
        "the expanded intent uses the same label as its trigger",
      );
    }
    const report = () =>
      page.evaluate(() =>
        Reflect.get(window, "cognitiveChoiceAppFixture").report(),
      );
    const action = (name: string, ...args: unknown[]) =>
      page.evaluate(
        ({ name, args }) =>
          Reflect.get(window, "cognitiveChoiceAppFixture")[name](...args),
        { name, args },
      );
    async function load(mode = "fresh") {
      await page.goto(`${url}?mode=${mode}`);
      await input().waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        () =>
          Reflect.get(window, "cognitiveChoiceAppFixture")
            .report()
            .requests.filter((r: any) => r.method === "cognitive-apps.list")
            .length >= 2,
      );
      await action("clearRequests");
    }
    async function more() {
      await plus().click();
      await menu().getByRole("button", { name: "更多应用新建能力" }).click();
      await page.getByRole("textbox", { name: "搜索应用的新建能力" }).waitFor();
    }
    const creation = (version = "1.0.0", connection = "A") =>
      menu().getByRole("button", {
        name: `新建作者笔记，作者笔记 · ${version} · 作者/资料/connection-${connection}`,
        exact: true,
      });
    function assertNoMutationIo(r: any) {
      assert.equal(
        r.requests.filter((request: any) =>
          /^(?:platform\.message|conversations\.create|app-views\.(?:launch|save|close)|cognitive-apps\.(?:install|grant|connect|connection-state|describe|read-object|invoke)|cognitive-app-views\.|objects\.|reading\.|script-studio\.)/.test(
            request.method,
          ),
        ).length,
        0,
      );
      assert.deepEqual(r.unknown, []);
    }

    await load();
    const old = await report();
    await plus().click();
    assert(
      await menu()
        .getByRole("button", { name: "构思剧本，剧本工作室" })
        .isVisible(),
    );
    assert(
      await menu().getByRole("button", { name: "新建事项，事项" }).isVisible(),
    );
    assert(
      await menu()
        .getByRole("button", { name: "起草文档，内容库" })
        .isVisible(),
    );
    assert(
      await menu()
        .getByRole("button", { name: "截图输入", exact: true })
        .isVisible(),
    );
    assert(
      await menu()
        .getByRole("button", { name: "附加文件", exact: true })
        .isVisible(),
    );
    for (const [index, shortcut] of [
      { intent: "script", label: "构思剧本", application: "剧本工作室" },
      { intent: "task", label: "新建事项", application: "事项" },
      { intent: "document", label: "起草文档", application: "内容库" },
    ].entries()) {
      if (index > 0) {
        await load();
        await plus().click();
      }
      await menu()
        .getByRole("button", {
          name: `${shortcut.label}，${shortcut.application}`,
          exact: true,
        })
        .click();
      const builtin = await report();
      assert.equal(builtin.textarea.value, old.textarea.value);
      assert.deepEqual(builtin.drafts["desk:desk:desk"], {
        ...old.drafts["desk:desk:desk"],
        intent: shortcut.intent,
      });
      assert(await input().evaluate((node) => node === document.activeElement));
      assertNoMutationIo(builtin);
      await assertIntentScope(shortcut.label, `builtin-${shortcut.intent}`);
      assert.equal(
        await scopeMenu().locator(".context-chip").innerText(),
        "无项目",
        "the true personal owner is still explained inside the scope popup",
      );
      await scopeMenu()
        .getByRole("button", { name: "移除输入意图", exact: true })
        .click();
      const removed = await report();
      assert.deepEqual(
        removed.drafts,
        old.drafts,
        "removing an intent preserves every existing draft field and other scopes",
      );
      assert.equal(removed.textarea.value, old.textarea.value);
      assert.equal(await page.locator(".composer-scope-trigger").count(), 0);
      assert.equal(await page.locator(".composer-scope-label").count(), 0);
      assert.equal(
        await page
          .getByText("无项目", { exact: true })
          .evaluateAll(
            (nodes) => nodes.filter((node) => node.checkVisibility()).length,
          ),
        0,
        "removing the personal intent leaves no empty scope label or popup",
      );
      assert(await input().evaluate((node) => node === document.activeElement));
      assertNoMutationIo(removed);

      // A removable creation intent must also be directly dismissible without
      // opening its scope details. Keep the original menu-removal proof above.
      await plus().click();
      await menu()
        .getByRole("button", {
          name: `${shortcut.label}，${shortcut.application}`,
          exact: true,
        })
        .click();
      await input().fill(`原文继续编辑 ${shortcut.label} 😀`);
      const beforeDismiss = await report();
      const dismiss = page.locator(".composer-scope-remove");
      assert(
        await dismiss.isVisible(),
        "creation intent has a direct close button",
      );
      assert.equal(
        await dismiss.getAttribute("aria-label"),
        `取消${shortcut.label}`,
      );
      assert.equal(await scopeMenu().isVisible(), false);
      if (index === 0) await dismiss.click();
      else {
        await scope().focus();
        await page.keyboard.press("Tab");
        assert(
          await dismiss.evaluate((node) => node === document.activeElement),
        );
        await page.keyboard.press(index === 1 ? "Enter" : "Space");
      }
      const afterDismiss = await report();
      const { intent: _intent, ...ordinaryDraft } =
        beforeDismiss.drafts["desk:desk:desk"];
      assert.deepEqual(afterDismiss.drafts, {
        ...beforeDismiss.drafts,
        "desk:desk:desk": ordinaryDraft,
      });
      assert.equal(afterDismiss.textarea.value, beforeDismiss.textarea.value);
      assert.equal(await scopeMenu().isVisible(), false);
      assert.equal(await dismiss.count(), 0);
      assert(await input().evaluate((node) => node === document.activeElement));
      assertNoMutationIo(afterDismiss);
    }

    await load("project");
    assert.equal(
      await page.locator(".composer-scope-remove").count(),
      0,
      "an actual project scope is not a removable local intent",
    );
    await input().fill("项目 A 原草稿 · 范围回归测试 😀");
    await page.waitForFunction(
      () =>
        Reflect.get(window, "cognitiveChoiceAppFixture").report().drafts[
          "project-A:quotes"
        ] !== undefined,
    );
    const projectDraft = await report();
    await plus().click();
    await menu()
      .getByRole("button", { name: "构思剧本，剧本工作室", exact: true })
      .click();
    const projectIntent = await report();
    assert.equal(projectIntent.preferences.projectId, "project-A");
    assert.equal(projectIntent.preferences.view, "projects");
    assert.deepEqual(projectIntent.drafts, {
      ...projectDraft.drafts,
      "project-A:project-A:projects": {
        ...projectDraft.drafts["project-A:project-A:projects"],
        intent: "script",
      },
    });
    assert.equal(projectIntent.textarea.value, projectDraft.textarea.value);
    assert((await scope().getAttribute("title"))?.includes("项目 A"));
    await assertIntentScope("构思剧本", "project-script");
    assert.equal(
      await scopeMenu().locator(".context-chip").innerText(),
      "项目 A",
      "intent label precedence does not change the actual project association",
    );
    await scopeMenu()
      .getByRole("button", { name: "移除输入意图", exact: true })
      .click();
    assert.deepEqual((await report()).drafts, projectDraft.drafts);
    assert.equal((await scope().innerText()).trim(), "项目 A");
    assert.equal(await page.locator(".composer-scope-remove").count(), 0);
    assertNoMutationIo(await report());

    for (const binding of [
      { mode: "task-result", field: "taskResult", label: "取消提交事项结果" },
      {
        mode: "script-generation",
        field: "scriptGeneration",
        label: "取消剧本请求引用",
      },
    ]) {
      await load(binding.mode);
      await input().fill(`保留专用请求的未发送原稿 ${binding.mode} 😀`);
      const before = await report();
      assert(before.drafts["desk:desk:desk"][binding.field]);
      await page
        .getByRole("button", { name: binding.label, exact: true })
        .click();
      const after = await report();
      const ordinaryDraft = { ...before.drafts["desk:desk:desk"] };
      delete ordinaryDraft[binding.field];
      assert.deepEqual(after.drafts, {
        ...before.drafts,
        "desk:desk:desk": ordinaryDraft,
      });
      assert.equal(after.textarea.value, before.textarea.value);
      assert.equal(await page.locator(".composer-scope-remove").count(), 0);
      assert(await input().evaluate((node) => node === document.activeElement));
      assertNoMutationIo(after);
    }
    await load("special");
    assert.equal(
      await page.locator(".composer-scope-remove").count(),
      0,
      "a frozen in-flight supplement is not removable via ordinary scope cancellation",
    );
    assertNoMutationIo(await report());

    await load();
    await more();
    const search = page.getByRole("textbox", { name: "搜索应用的新建能力" });
    assert(await search.evaluate((node) => node === document.activeElement));
    assert.equal(await menu().locator(".composer-creation-action").count(), 5); // two versions x two connections, one GUI entry; disabled/unconnected excluded.
    await search.fill("不存在的应用");
    assert.equal(await menu().locator(".composer-creation-action").count(), 0);
    assert(await menu().getByRole("status").isVisible());
    await search.fill("作者笔记 · 1.0.0");
    assert.equal(await menu().locator(".composer-creation-action").count(), 2);
    await search.press("Home");
    assert(await search.evaluate((node) => node === document.activeElement));
    await search.evaluate((node) =>
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          isComposing: true,
          bubbles: true,
        }),
      ),
    );
    assert(
      await search.evaluate((node) => node === document.activeElement),
      "IME ArrowDown stays in editing",
    );
    await search.press("ArrowDown");
    assert(
      await menu()
        .locator(".composer-creation-action")
        .first()
        .evaluate((node) => node === document.activeElement),
    );
    await menu().getByRole("button", { name: "返回新建与添加" }).click();
    assert(
      await menu()
        .getByRole("button", { name: "更多应用新建能力" })
        .evaluate((node) => node === document.activeElement),
    );
    await page.keyboard.press("Escape");
    assert(await plus().evaluate((node) => node === document.activeElement));

    await more();
    const occupied = (await report()).drafts;
    await creation().click();
    assert.deepEqual(
      (await report()).drafts,
      occupied,
      "author preparation cannot half-select an app or replace occupied text",
    );
    await input().fill("");
    await more();
    await creation("2.0.0", "B").click();
    const cognitive = await report();
    assert.equal(cognitive.textarea.value, "请帮我构思一篇作者笔记。");
    assert.deepEqual(
      cognitive.drafts["desk:desk:desk"].cognitiveApplication,
      await page.evaluate(() =>
        Reflect.get(window, "cognitiveChoiceAppFixture").target(
          "connection-B",
          "2.0.0",
        ),
      ),
    );
    assert.equal(cognitive.drafts["desk:desk:desk"].operationId, undefined);
    assert.deepEqual(
      cognitive.drafts["desk:desk:desk"].attachments,
      old.drafts["desk:desk:desk"].attachments,
    );
    assert(await input().evaluate((node) => node === document.activeElement));
    assertNoMutationIo(cognitive);

    await load("selected");
    await input().fill("");
    await more();
    assert(
      await creation().isEnabled(),
      "same selected exact app can prepare new content",
    );
    assert(
      await creation("1.0.0", "B").isDisabled(),
      "a different connection is not silently substituted",
    );
    await creation().click();
    assert.equal((await report()).textarea.value, "请帮我构思一篇作者笔记。");

    await load();
    await input().fill("");
    await more();
    await creation().evaluate((node) => {
      const props = Object.keys(node).find((key) =>
        key.startsWith("__reactProps"),
      )!;
      Reflect.set(
        window,
        "oldCreationCallback",
        Reflect.get(node, props).onClick,
      );
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", {
        name: "用于本次输入：作者笔记 2.0.0",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: "使用作者笔记 2.0.0，数据连接 connection-B",
        exact: true,
      })
      .click();
    const changedTarget = (await report()).drafts;
    await page.evaluate(() => Reflect.get(window, "oldCreationCallback")());
    assert.deepEqual(
      (await report()).drafts,
      changedTarget,
      "a retained new-menu callback cannot redirect a later explicit target",
    );
    assertNoMutationIo(await report());

    await load();
    await input().fill("");
    await more();
    await creation().evaluate((node) => {
      const props = Object.keys(node).find((key) =>
        key.startsWith("__reactProps"),
      )!;
      Reflect.set(
        window,
        "oldCreationCallback",
        Reflect.get(node, props).onClick,
      );
    });
    await action("rotateWindowOwner");
    const staleOwner = (await report()).stored;
    await page.evaluate(() => Reflect.get(window, "oldCreationCallback")());
    assert.deepEqual(
      (await report()).stored,
      staleOwner,
      "old window callback cannot mutate another draft owner",
    );

    // Retain the actual production callback, then update the authenticated catalog
    // and invoke its old closure. This exercises the latest updater, not a mock guard.
    await load();
    await input().fill("");
    await more();
    await creation().evaluate((node) => {
      const props = Object.keys(node).find((key) =>
        key.startsWith("__reactProps"),
      )!;
      Reflect.set(
        window,
        "oldCreationCallback",
        Reflect.get(node, props).onClick,
      );
    });
    await action("changeCreationHint", "更新后的新建能力", "新提示");
    await page.waitForFunction(() =>
      document.body.textContent?.includes("更新后的新建能力"),
    );
    const beforeStale = (await report()).drafts;
    await page.evaluate(() => Reflect.get(window, "oldCreationCallback")());
    assert.deepEqual(
      (await report()).drafts,
      beforeStale,
      "old operation hint cannot prepare new app/text after the definition projection changed",
    );

    await load();
    await input().fill("");
    await more();
    await creation().evaluate((node) => {
      const props = Object.keys(node).find((key) =>
        key.startsWith("__reactProps"),
      )!;
      Reflect.set(
        window,
        "oldCreationCallback",
        Reflect.get(node, props).onClick,
      );
    });
    await action("hideCatalog");
    await page.waitForFunction(() =>
      document.body.textContent?.includes("暂无其他已接入的新建能力。"),
    );
    const beforeRevoke = (await report()).drafts;
    await page.evaluate(() => Reflect.get(window, "oldCreationCallback")());
    assert.deepEqual((await report()).drafts, beforeRevoke);

    // Actual current styles/top-layer geometry: long author text, small viewport,
    // light/dark and 200% zoom. This is not an original native-window screenshot.
    await load();
    await action(
      "changeCreationHint",
      "很长的作者新建能力".repeat(8),
      "可编辑提示",
    );
    await page.emulateMedia({ colorScheme: "light" });
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await plus().click();
      const box = await menu().boundingBox();
      assert(
        box && box.x >= 0 && box.x + box.width <= width + 1,
        `menu fits ${width}`,
      );
      const geometry = await menu().evaluate((node) => ({
        font: getComputedStyle(node.querySelector("h3")!).fontSize,
        separator: getComputedStyle(
          node.querySelector(".composer-creation-more")!,
        ).borderTopWidth,
      }));
      assert.equal(geometry.font, "12px");
      assert.equal(geometry.separator, "1px");
      if (width === 1440)
        await menu().screenshot({
          path: resolve(evidenceDir, "new-menu-light.png"),
          animations: "disabled",
        });
      await menu().getByRole("button", { name: "更多应用新建能力" }).click();
      const moreBox = await menu().boundingBox();
      assert(moreBox && moreBox.x + moreBox.width <= width + 1);
      if (width === 1440)
        await menu().screenshot({
          path: resolve(evidenceDir, "new-menu-more-light.png"),
          animations: "disabled",
        });
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 760, height: 850 });
    await page.emulateMedia({ colorScheme: "dark" });
    await plus().click();
    await menu().screenshot({
      path: resolve(evidenceDir, "new-menu-dark.png"),
      animations: "disabled",
    });
    console.log(
      `[new menu dark computed] ${JSON.stringify(
        await menu().evaluate((node) => {
          const row = node.querySelector<HTMLButtonElement>(
            ".composer-creation-action",
          )!;
          return {
            popupOpacity: getComputedStyle(node).opacity,
            popupBackground: getComputedStyle(node).backgroundColor,
            rowColor: getComputedStyle(row).color,
            rowOpacity: getComputedStyle(row).opacity,
            rowDisabled: row.disabled,
            helperColor: getComputedStyle(node.querySelector("h3")!).color,
          };
        }),
      )}`,
    );
    await menu().getByRole("button", { name: "更多应用新建能力" }).click();
    await menu().screenshot({
      path: resolve(evidenceDir, "new-menu-more-dark.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await action("manyCreationHints");
    await more();
    await page.waitForFunction(
      () =>
        document.querySelector(".composer-creation-results")
          ?.childElementCount === 83,
    );
    assert(
      await menu()
        .locator(".composer-creation-results")
        .evaluate((node) => node.scrollHeight > node.clientHeight),
    );
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 760, height: 850 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await plus().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(evidenceDir, "existing-toolbar-zoom-before.png"),
      animations: "disabled",
    });
    const toolbarHit = await plus().evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      const mic = document
        .querySelector('[aria-label="语音输入"]')
        ?.getBoundingClientRect();
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          scrollX,
          scrollY,
          zoom: getComputedStyle(document.documentElement).zoom,
        },
        plus: box.toJSON(),
        mic: mic?.toJSON(),
        elements: [
          ".workspace-sidebar",
          "#global-composer",
          ".composer-action-bar",
          ".composer-action-leading",
          ".composer-action-trailing",
          ".composer-execution-settings",
        ].map((selector) => {
          const element = document.querySelector(selector);
          return {
            selector,
            rect: element?.getBoundingClientRect().toJSON(),
            display: element && getComputedStyle(element).display,
            width: element && getComputedStyle(element).width,
          };
        }),
        centerHitTag: hit?.tagName,
        centerHitLabel: hit?.closest("button")?.getAttribute("aria-label"),
      };
    });
    console.log(
      `[existing toolbar at 200%] ${JSON.stringify({ toolbarHit, screenshot: resolve(evidenceDir, "existing-toolbar-zoom-before.png"), originalMouseFailure: "语音输入 intercepts + click", menuKeyboardGeometryOnly: true })}`,
    );
    // Existing microphone overlaps + at 200% zoom. Keep that unrelated layout
    // unchanged; keyboard activation still tests the new popover's geometry.
    await plus().focus();
    await plus().press("Enter");
    const zoomed = await menu().boundingBox();
    assert(
      zoomed &&
        zoomed.x >= 0 &&
        zoomed.x + zoomed.width <= 761 &&
        zoomed.y >= 0,
    );
    await menu().screenshot({
      path: resolve(evidenceDir, "new-menu-zoom.png"),
      animations: "disabled",
    });
    console.log(
      `[new menu mounted] ${JSON.stringify({ realApp: true, transport: "controlled", scope: "new feature only", noMutationIo: true, widths: [1440, 760, 390, 320], themes: ["light", "dark"], zoom: 2, evidenceDir })}`,
    );
    assert.deepEqual(errors, []);
  },
);
