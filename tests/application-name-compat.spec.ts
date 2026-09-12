import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";

for (const legacy of [false, true])
  test(`${legacy ? "旧" : "新"}应用协议握手与恢复，加载 iframe 时宿主弹窗单击创建有效`, async ({
    page,
  }) => {
    // Protocol fixtures must not add launcher tiles to other tests' shared
    // center: coordinate-based background checks must still hit background.
    const store = new WorkspaceStore(":memory:");
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const server = createAppServer(store, {
      port,
      webRoot: resolve("dist/web"),
    });
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${port}`;
    try {
      const manifest = JSON.parse(
        readFileSync("examples/applications/scratchpad.json", "utf8"),
      );
      manifest.id = `test.names-${legacy ? "legacy" : "current"}`;
      manifest.title = `协议兼容${legacy ? "旧" : "新"}`;
      if (legacy) {
        manifest.format = "morphz-work-app/v1";
        manifest.version = "1.0.0";
        manifest.ui.html = manifest.ui.html.replaceAll(
          "morphz-app:",
          "morphz-work:",
        );
      }
      await page.goto(origin);
      const launcher = page.getByRole("button", {
        name: "应用启动台",
        exact: true,
      });
      if (await launcher.isVisible()) await launcher.click();
      await page.getByLabel("应用包文件").setInputFiles({
        name: "compat.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(manifest)),
      });
      await page.getByRole("button", { name: "允许并安装" }).click();
      await page
        .getByRole("button", {
          name: `${manifest.title} ${manifest.version}`,
          exact: true,
        })
        .click();
      const frame = page.frameLocator(
        `iframe[title="${manifest.title}应用界面"]`,
      );
      await expect(frame.locator("#status")).toContainText("已连接");
      await frame.locator("#note").fill("old and new retain exact state");
      await frame.getByRole("button", { name: "保存便笺状态" }).click();
      await expect(frame.locator("#status")).toContainText("已保存");
      for (let index = 0; index < 8; index++) {
        await page.getByRole("button", { name: "工作台", exact: true }).click();
        await page
          .getByRole("tab", { name: manifest.title, exact: true })
          .click();
        await page.reload();
        // Do not wait for iframe readiness before opening the outer modal: a late
        // iframe load must not steal the one create click from the native dialog.
        await page
          .getByRole("button", { name: "新建项目", exact: true })
          .click();
        await expect(
          page.locator(`iframe[title="${manifest.title}应用界面"]`),
        ).toHaveCSS("pointer-events", "none");
        const title = `名称兼容-${legacy}-${index}-${crypto.randomUUID()}`;
        await page.getByLabel("新对象标题").fill(title);
        await page.getByRole("button", { name: "创建", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const snapshot = await (
          await page.request.get(origin + "/api/workspace")
        ).json();
        expect(
          snapshot.workspace.projects.filter(
            (p: { title: string }) => p.title === title,
          ),
        ).toHaveLength(1);
      }
      await page.getByRole("button", { name: "工作台", exact: true }).click();
      await page
        .getByRole("tab", { name: manifest.title, exact: true })
        .click();
      await expect(frame.locator("#note")).toHaveValue(
        "old and new retain exact state",
      );
      await page
        .getByRole("button", {
          name: `关闭应用 ${manifest.title}`,
          exact: true,
        })
        .click();
      await expect(
        page.locator(`iframe[title="${manifest.title}应用界面"]`),
      ).toHaveCount(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });
