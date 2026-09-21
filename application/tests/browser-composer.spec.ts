import { test, expect, _electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInput } from "./interaction-helpers.js";

test("认知应用的交流面板悬浮，不改变画布尺寸；固定和收起均保留草稿", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
    .click();
  await openInput(page);
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  const canvas = page.locator("main.application-canvas");
  const before = (await canvas.boundingBox())!;
  await page.locator(".composer-reopen").click();
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await input.fill("TEST 悬浮交流草稿");
  await expect
    .poll(async () =>
      Math.abs((await canvas.boundingBox())!.height - before.height),
    )
    .toBeLessThan(2);
  await page.getByRole("button", { name: "固定输入框", exact: true }).click();
  await expect
    .poll(async () =>
      Math.abs((await canvas.boundingBox())!.height - before.height),
    )
    .toBeLessThan(2);
  await expect(input).toHaveValue("TEST 悬浮交流草稿");
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  // A collapsed entry must not leave an invisible, full-width click barrier.
  await expect
    .poll(() =>
      page.locator(".composer-dock").evaluate((dock) => {
        const rect = dock.getBoundingClientRect();
        return !!document
          .elementFromPoint(rect.left + 1, rect.top + rect.height / 2)
          ?.closest(".exchange-surface");
      }),
    )
    .toBe(false);
  await page.locator(".composer-reopen").press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("TEST 悬浮交流草稿");
});

test("真实 Electron 网页上叠放交流：视口与表单不变、入口可点击、网页无宿主权限", async ({}, info) => {
  test.setTimeout(90000);
  const fixture = await mkdtemp(join(tmpdir(), "morphz-embedded-electron-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !/^(MORPHZ_APP_|MORPHZ_WORK_|DOUBAO_|ELECTRON_RUN_AS_NODE$)/.test(
          entry[0],
        ),
    ),
  );
  env.MORPHZ_APP_EMBEDDED_FIXTURE = fixture;
  env.MORPHZ_APP_ENV_FILE = "";
  const desktop = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  try {
    await expect
      .poll(() => desktop.windows().some((p) => p.url() === "morphz://app/"))
      .toBe(true);
    const page = desktop.windows().find((p) => p.url() === "morphz://app/")!;
    // Native focus transfer cannot be asserted from an inactive OS window.
    // Establish the same foreground prerequisite as the capture-window test.
    await desktop.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .focus();
    });
    await expect
      .poll(
        () =>
          desktop.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find(
                  (window) => window.webContents.getURL() === "morphz://app/",
                )
                ?.isFocused() ?? false,
          ),
        { message: "原生网页键盘回归需要已解锁的前台窗口" },
      )
      .toBe(true);
    const boot = await page.evaluate(async () => {
      const result = await window.morphzDesktop!.application!.invoke({
        id: crypto.randomUUID(),
        method: "workspace",
      });
      if (!result.ok) throw new Error("fixture workspace unavailable");
      return result.value as { centerId: string; principalId: string };
    });
    const partition =
      "persist:morphz-browser-" +
      createHash("sha256")
        .update(boot.centerId + ":" + boot.principalId)
        .digest("hex");
    await desktop.evaluate(({ session }, partition) => {
      session
        .fromPartition(partition)
        .protocol.handle(
          "https",
          () =>
            new Response(
              `<!doctype html><title>TEST 悬浮网页</title><style>body{margin:0;background:#d9eef2;font:20px system-ui}header{padding:60px}article{height:1800px;background:repeating-linear-gradient(#d9eef2 0px,#d9eef2 79px,#84aeb7 80px)}button{position:fixed;left:20px;bottom:80px;padding:15px}#footer-button{left:calc(50% + 200px);bottom:10px;height:32px;padding:0 8px}</style><header><input id="form" value="TEST 网页未提交表单"><p>TEST 网页画布</p></header><article></article><button id="page-button" onclick="this.textContent='TEST 网页点击成功'">TEST 网页按钮</button><button id="footer-button" onclick="this.textContent='TEST 底部点击成功'">TEST 网页底部</button><script>window.instance=crypto.randomUUID()</script>`,
              { headers: { "Content-Type": "text/html; charset=utf-8" } },
            ),
        );
    }, partition);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page
      .getByRole("button", { name: "浏览器 1.0.0", exact: true })
      .click();
    const address = page.getByRole("textbox", { name: "网站地址" });
    await address.fill("https://browser-overlay.invalid/");
    await address.press("Enter");
    const siteState = () =>
      desktop.evaluate(async ({ webContents }) => {
        const site = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === "https://browser-overlay.invalid/");
        if (!site) return null;
        return site.executeJavaScript(
          "({width:innerWidth,height:innerHeight,scroll:scrollY,form:document.querySelector('#form').value,instance:window.instance,node:typeof require,bridge:typeof window.morphzDesktop,button:document.querySelector('#page-button').textContent})",
        );
      });
    await expect
      .poll(async () => (await siteState())?.form)
      .toBe("TEST 网页未提交表单");
    await openInput(page);
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    const reopen = page.locator(".composer-reopen");
    await expect(reopen).toBeVisible();
    // A guest has a separate compositor hit-test surface. DOM elementFromPoint
    // alone cannot prove that the collapsed Dock's blank margin passes clicks.
    const footerPoint = await desktop.evaluate(async ({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      return site.executeJavaScript(
        "(()=>{const r=document.querySelector('#footer-button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
    });
    const guestBounds = (await page.locator(".browser-slot").boundingBox())!;
    await page.mouse.click(
      guestBounds.x + footerPoint.x,
      guestBounds.y + footerPoint.y,
    );
    await expect
      .poll(() =>
        desktop.evaluate(async ({ webContents }) => {
          const site = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
          return site.executeJavaScript(
            "document.querySelector('#footer-button').textContent",
          );
        }),
      )
      .toBe("TEST 底部点击成功");
    const before = await siteState();
    await reopen.click();
    const input = page.getByLabel("AI 输入内容", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("TEST 网页悬浮输入，不发送");
    await expect.poll(siteState).toEqual(before);
    await page.getByRole("button", { name: "固定输入框", exact: true }).click();
    await expect.poll(siteState).toEqual(before);
    await page
      .getByRole("button", { name: "收起交流记录", exact: true })
      .click();
    await expect.poll(siteState).toEqual(before);
    await expect(input).toHaveValue("TEST 网页悬浮输入，不发送");
    // The composed guest must not intercept an edge drag or lose its viewport,
    // instance or form when the host exchange changes size.
    const resize = page.getByRole("separator", { name: "调整消息区高度" });
    const dragTo = async (height: number) => {
      const reading = Number(await resize.getAttribute("aria-valuenow"));
      const r = (await resize.boundingBox())!;
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        r.x + r.width / 2,
        r.y + r.height / 2 + reading - height,
        { steps: 10 },
      );
      await page.mouse.up();
      await expect(page.locator(".exchange-resize-shield")).toHaveCount(0);
    };
    const collapsed = (await page.locator(".exchange-panel").boundingBox())!;
    await dragTo(200);
    // Revealing the browser's scope header consumes some reading height. The
    // frame edge, rather than the text-only height, must follow the pointer.
    await expect
      .poll(
        async () =>
          (await page.locator(".exchange-panel").boundingBox())!.height,
      )
      .toBeCloseTo(collapsed.height + 200, 0);
    await dragTo(200);
    await expect(resize).toHaveAttribute("aria-valuenow", "200");
    await expect.poll(siteState).toEqual(before);
    await dragTo(Number(await resize.getAttribute("aria-valuemax")) - 20);
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "history",
    );
    await dragTo(180);
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    await expect.poll(siteState).toEqual(before);
    await expect(input).toHaveValue("TEST 网页悬浮输入，不发送");
    await info.attach("browser-overlay", {
      body: await page.screenshot({
        path: info.outputPath("browser-overlay.png"),
      }),
      contentType: "image/png",
    });
    // Click the guest beside the panel, through Chromium's composed hit-testing.
    const slot = (await page.locator(".browser-slot").boundingBox())!;
    await page.mouse.click(slot.x + 55, slot.y + slot.height - 100);
    await expect
      .poll(async () => (await siteState())?.button)
      .toBe("TEST 网页点击成功");
    await expect(input).toBeVisible();
    await page
      .getByRole("button", { name: "取消固定输入框", exact: true })
      .click();
    await page.mouse.click(slot.x + 55, slot.y + slot.height - 100);
    await expect(input).toBeHidden();
    await expect(reopen).toBeVisible();
    // The shortcut originates in the isolated guest, not the host document.
    await desktop.evaluate(({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "https://browser-overlay.invalid/")!;
      site.sendInputEvent({
        type: "keyDown",
        keyCode: "J",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    });
    await expect(input).toBeFocused();
    // Focus moved to the host on keydown. A physical key release goes there;
    // send it to that surface, not to the previously focused guest.
    await desktop.evaluate(({ webContents }) => {
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === "morphz://app/")!
        .sendInputEvent({
          type: "keyUp",
          keyCode: "J",
          modifiers: [process.platform === "darwin" ? "meta" : "control"],
        });
    });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 网页悬浮输入，不发送");
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    await expect(reopen).toBeVisible();
    await reopen.press("Enter");
    await expect(input).toHaveValue("TEST 网页悬浮输入，不发送");
    await expect(
      page.getByRole("button", { name: "允许 Agent 协助", exact: true }),
    ).toBeVisible();
    expect(before.node).toBe("undefined");
    expect(before.bridge).toBe("undefined");
    await page
      .getByRole("button", { name: "返回工作空间", exact: true })
      .click();
    await page.getByRole("tab", { name: /浏览器/ }).click();
    await expect
      .poll(async () => (await siteState())?.instance)
      .toBe(before.instance);
    await expect.poll(async () => (await siteState())?.form).toBe(before.form);
    await openInput(page);
    await page
      .getByRole("button", { name: "收起 AI 输入框", exact: true })
      .click();
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === "morphz://app/",
      )!;
      window.webContents.setZoomFactor(2);
    });
    await expect(reopen).toBeInViewport();
    const zoomed = await siteState();
    await reopen.click();
    await expect(input).toBeInViewport();
    await expect.poll(siteState).toEqual(zoomed);
    await expect(resize).toBeInViewport();
    await resize.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "history",
    );
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "recent",
    );
    await expect(input).toBeInViewport();
    await expect.poll(siteState).toEqual(zoomed);
    const geometry = await page.evaluate(() => {
      const input = document
        .querySelector(".composer textarea")!
        .getBoundingClientRect();
      return { input: input.toJSON(), width: innerWidth, height: innerHeight };
    });
    expect(geometry.input.x).toBeGreaterThanOrEqual(0);
    expect(geometry.input.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.input.y).toBeGreaterThanOrEqual(0);
    expect(geometry.input.bottom).toBeLessThanOrEqual(geometry.height);
    // Playwright's page screenshot clips Electron zoom coordinates; capture
    // the actual window compositor for the 200% visual evidence.
    const png = await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === "morphz://app/",
      )!;
      return (await window.webContents.capturePage())
        .toPNG()
        .toString("base64");
    });
    await writeFile(
      info.outputPath("browser-overlay-200.png"),
      Buffer.from(png, "base64"),
    );
  } finally {
    await desktop.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
