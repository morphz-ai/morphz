import { openSettings } from "./settings-test-helpers.mjs";
import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real production IPC + actual HTTP diagnostic responses; never the user's profile.
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const token = "connection-fixture-private-token";
let healthy = true;
const methods = [];
const runtime = createServer((req, res) => {
  methods.push(req.method);
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  if (!healthy) {
    res.destroy();
    return;
  }
  // This diagnostic-only Runtime fixture has no accepted Session. The current
  // authorized history ports require a real not-found response, not a status
  // object pretending to be a Session timeline or an Event page.
  if (req.url.startsWith("/api/sessions/")) {
    res.writeHead(404);
    res.end(
      JSON.stringify({ error: "Session not found in diagnostic fixture" }),
    );
    return;
  }
  res.end(
    JSON.stringify(
      req.url === "/api/runtime/inference"
        ? { model: "", models: [] }
        : { model: "", identity_mode: "default" },
    ),
  );
});
await new Promise((resolve) => runtime.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${runtime.address().port}`;
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("MORPHZ_APP_") && !key.startsWith("MORPHZWORK_"),
    ),
  ),
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  const page = app.windows().find((p) => p.url() === "morphz://app/");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 连接恢复草稿，未发送");
  const businessState = async () =>
    page.evaluate(async () => {
      const api = window.morphzDesktop.application;
      const result = await api.invoke({
        id: crypto.randomUUID(),
        method: "platform.bootstrap",
      });
      if (!result.ok) throw Error(result.error.message);
      const boot = result.value;
      const call = async (method, params) => {
        const reply = await api.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          identityGeneration: boot.csrfToken,
        });
        if (!reply.ok) throw Error(reply.error.message);
        return reply.value;
      };
      await call("spaces.ensure");
      const lists = {
        projects: await call("projects.list", { status: "all", limit: 100 }),
        tasks: await call("tasks.list", { owner: "all", limit: 100 }),
        conversations: await call("conversations.navigation", { limit: 100 }),
        content: await call("content.list", { limit: 100 }),
      };
      // This isolated fixture is deliberately small. Never mistake a truncated
      // page for the complete business state the connection controls preserve.
      for (const [kind, list] of Object.entries(lists))
        if (!Array.isArray(list) || list.length >= 100)
          throw Error(`Unexpected paginated fixture ${kind}`);
      return { centerId: boot.centerId, principalId: boot.principalId, lists };
    });
  const before = await businessState();
  const trigger = page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "设置", exact: true });
  const identity = page.locator(".sidebar-bottom .profile-summary");
  const status = identity.locator(".profile-status");
  await expect(status).toHaveText("智能体未连接");
  await expect(status).toBeInViewport();
  await openSettings(page, "智能体连接");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("button", { name: "连接智能体", exact: true }).click();
  await dialog.getByLabel("运行服务地址").fill(endpoint);
  await dialog.getByLabel("连接凭据").fill("wrong-fixture-token");
  await dialog.getByRole("button", { name: "验证并连接", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("凭据");
  await dialog.getByLabel("连接凭据").fill(token);
  await dialog.getByRole("button", { name: "验证并连接", exact: true }).click();
  await expect(dialog.getByLabel("连接凭据")).toHaveCount(0);
  await expect(dialog).toContainText("尚未配置");
  await expect(
    dialog.getByRole("button", { name: "设置模型", exact: true }),
  ).toBeVisible();
  assert.equal(
    JSON.parse(readFileSync(join(fixture, "data/runtime.json"), "utf8")).token,
    token,
  );
  healthy = false;
  const checkConnection = dialog.getByRole("button", {
    name: /^(检查连接|重新连接)$/,
  });
  await checkConnection.click();
  await expect(dialog).toContainText("无法连接智能体");
  await expect(
    dialog.getByRole("button", { name: "设置模型", exact: true }),
  ).toHaveCount(0);
  healthy = true;
  await checkConnection.click();
  await expect(dialog).toContainText("尚未配置");
  await expect(dialog).not.toContainText("无法连接智能体");
  mkdirSync("test-results", { recursive: true });
  await dialog.getByRole("button", { name: "连接设置", exact: true }).click();
  for (const [width, height, zoom] of [
    [1380, 920, 1],
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height, zoom]) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === "morphz://app/",
        );
        win.setSize(width, height);
        win.webContents.setZoomFactor(zoom);
      },
      [width, height, zoom],
    );
    // Native resize/zoom is asynchronous; assert the resulting layout, not its old frame.
    await expect(async () => {
      const box = await dialog.boundingBox();
      const view = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= view.width + 1 &&
          box.y + box.height <= view.height + 1,
        JSON.stringify({ box, view }),
      );
    }).toPass({ timeout: 3000 });
    assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    for (const name of ["取消设置", "关闭设置"]) {
      const button = dialog.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      assert.ok(
        await button.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
          );
        }),
      );
    }
    await page.screenshot({
      path: `test-results/connection-desktop-${width}-${zoom}.png`,
    });
  }
  await dialog.getByRole("button", { name: "取消设置" }).click();
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await expect(status).toHaveText("智能体已连接");
  await expect(status).toBeInViewport();
  await expect(identity).toHaveAccessibleDescription("我 · 智能体已连接");
  assert.ok(await trigger.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  await status.click();
  const menu = page.getByRole("group", { name: "用户菜单", exact: true });
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: "test-results/profile-menu-desktop-200.png" });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.screenshot({
    path: "test-results/profile-status-desktop-200.png",
  });
  const after = await businessState();
  assert.equal(after.centerId, before.centerId);
  assert.equal(after.principalId, before.principalId);
  assert.deepEqual(after.lists, before.lists);
  assert.ok(methods.every((m) => m === "GET"));
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes("connection-fixture-private-token"),
    ),
    false,
  );
  await app.close();
  app = undefined;
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  const reopened = app.windows().find((p) => p.url() === "morphz://app/");
  const reopenInput = reopened.getByRole("button", { name: /向 Morphz 输入/ });
  await expect(
    reopenInput.or(reopened.getByLabel("AI 输入内容")),
  ).toBeVisible();
  if (await reopenInput.isVisible()) await reopenInput.click();
  await expect(reopened.getByLabel("AI 输入内容")).toHaveValue(
    "TEST 连接恢复草稿，未发送",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      productionIPC: true,
      applicationHTTPListener: false,
      invalidCredentialsRejected: true,
      recovery: true,
      draftsPreserved: true,
      dataPreserved: true,
      nativeZoom200: true,
      modelNotConfigured: true,
      visibleProfileStatus: true,
    }),
  );
} finally {
  await app?.close();
  runtime.closeAllConnections();
  await new Promise((resolve) => runtime.close(resolve));
  rmSync(fixture, { recursive: true });
}
