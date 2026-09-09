import { _electron, expect } from "@playwright/test";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createServer as createPortProbe } from "node:net";

// Change only an isolated source copy. No user draft, source file or model request.
for (const port of [65419, 65426]) {
  const probe = createPortProbe();
  await new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  });
  await new Promise((done) => probe.close(done));
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), "morphzwork-hmr-test-")));
mkdirSync(join(dir, "apps"));
cpSync("apps/web", join(dir, "apps/web"), { recursive: true });
cpSync("packages", join(dir, "packages"), { recursive: true });
symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
const service = spawn(
  process.execPath,
  ["dist/service/apps/service/src/main.js"],
  {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      MORPHZWORK_PORT: "65426",
      MORPHZWORK_DATA_DIR: join(dir, "data"),
      MORPHZWORK_ENV_FILE: "",
    },
    stdio: "pipe",
  },
);
let app, vite;
try {
  const center = "http://127.0.0.1:65426";
  await expect
    .poll(
      async () => {
        try {
          return (
            service.exitCode === null &&
            (await fetch(center + "/api/health")).ok
          );
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBeTruthy();
  vite = await createServer({
    configFile: resolve("vite.config.ts"),
    root: join(dir, "apps/web"),
    server: {
      fs: { allow: [dir, resolve(".")] },
      proxy: { "/api": { target: center } },
    },
  });
  await vite.listen();
  app = await _electron.launch({
    args: ["apps/desktop/main.cjs", `--center=${center}`, "--hot"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      MORPHZWORK_TEST_PROFILE: join(dir, "profile"),
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error("Renderer:", error.message));
  page.on("response", async (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      console.error(
        "Fixture API:",
        response.status(),
        await response.text().catch(() => "unavailable"),
      );
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    )
    .toBe(true);
  await page.getByLabel("AI 输入内容").waitFor();
  assert.equal(new URL(page.url()).origin, "http://127.0.0.1:65419");
  const web = await (await fetch(center + "/api/workspace")).json();
  const identity = await page.evaluate(async () => {
    const boot = await (await fetch("/api/workspace")).json();
    window.__hmrSentinel = crypto.randomUUID();
    return {
      id: boot.centerId,
      sentinel: window.__hmrSentinel,
      windowId: sessionStorage.getItem("morphzwork:window"),
    };
  });
  assert.equal(identity.id, web.centerId);
  const input = page.getByLabel("AI 输入内容");
  await input.fill("热更新保留的未发送草稿");
  const css = join(dir, "apps/web/src/ui.css");
  writeFileSync(
    css,
    readFileSync(css, "utf8") + "\n:root { --hmr-smoke-proof: 37px; }\n",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--hmr-smoke-proof")
          .trim(),
      ),
    )
    .toBe("37px");
  const source = join(dir, "apps/web/src/App.tsx");
  const original = readFileSync(source, "utf8");
  assert.ok(original.includes("<span>Morphz</span>"));
  writeFileSync(
    source,
    original.replace("<span>Morphz</span>", "<span>Morphz HMR</span>"),
  );
  await expect(page.locator(".wordmark")).toHaveText("Morphz HMR");
  await expect(input).toHaveValue("热更新保留的未发送草稿");
  assert.equal(
    await page.evaluate(() => window.__hmrSentinel),
    identity.sentinel,
  );
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("morphzwork:window")),
    identity.windowId,
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  // Exercise actual native IPC and a CSRF-protected write through the unchanged center.
  assert.ok(
    Array.isArray(
      await page.evaluate(() => window.morphzDesktop.sources.list()),
    ),
  );
  await page.getByRole("button", { name: "查看本空间内容", exact: true }).click();
  await page
    .locator(".library-authoring-options")
    .getByRole("button", { name: "手动写文档", exact: true })
    .click();
  await page
    .getByLabel("新对象标题", { exact: true })
    .fill("热更新后的真实保存");
  await page
    .getByLabel("新文档正文")
    .fill("验证开发资源与 API 连接到原来的中心。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "热更新后的真实保存", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/desktop-hmr.png" });
  await app.close();
  app = undefined;
  assert.equal((await fetch(center + "/api/health")).ok, true);
  assert.equal(
    (await (await fetch(center + "/api/workspace")).json()).workspace.inputs
      .length,
    0,
  );
  console.log(
    "Electron HMR passed: CSS + React updates, no reload, draft/window identity preserved, native IPC, CSRF-protected document saved, original center alive, no model input.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  service.kill("SIGTERM");
  await delay(100);
}
