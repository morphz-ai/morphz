import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../dist/service/packages/application/src/store.js";
import { localAccess } from "../dist/service/packages/core/src/model.js";
import { emptyInteractive } from "../dist/service/packages/core/src/interactive.js";
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const env = {
  ...process.env,
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
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  const store = new WorkspaceStore(join(fixture, "data/workspace.sqlite"));
  const seed = (operation, agent = false) =>
    store.execute(
      { commandId: crypto.randomUUID(), operation },
      agent
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess,
    ).entityId;
  const id = seed(
    {
      type: "create-artifact",
      projectId: "first-project",
      title: "TEST 内容页验收",
      content: {
        kind: "document",
        markdown: "用于正文搜索的独特短语：卡片内容查找。",
      },
    },
    true,
  );
  const pdf = store.addPdf(
    readFileSync(new URL("../tests/fixtures/reader.pdf", import.meta.url)),
    ["合成测试资料"],
    localAccess,
  );
  seed({
    type: "import-pdf",
    projectId: "first-project",
    relativePath: "TEST reader.pdf",
    content: pdf,
  });
  seed({
    type: "create-artifact",
    projectId: "first-project",
    title: "TEST 表格实际数据",
    content: {
      ...structuredClone(emptyInteractive),
      rows: [{ id: "row1", cells: { name: "上线检查", value: 42 } }],
    },
  });
  const before = store.snapshot();
  store.close();
  await page.reload();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(page.getByLabel("工作空间选项", { exact: true })).toHaveCount(0);
  const canvas = page.getByRole("img", { name: "PDF 首页预览" });
  await expect(canvas).toBeVisible();
  await expect
    .poll(() => canvas.evaluate((el) => el.width))
    .toBeGreaterThan(100);
  await expect
    .poll(() =>
      canvas.evaluate((el) => {
        const data = el
          .getContext("2d")
          .getImageData(0, 0, el.width, el.height).data;
        return data.some(
          (n, i) => i % 4 !== 3 && n < 180 && data[i - (i % 4) + 3] > 0,
        );
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("table", { name: "TEST 表格实际数据预览" }),
  ).toContainText("上线检查42");
  await page.getByLabel("搜索内容", { exact: true }).fill("卡片内容查找");
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".content-match")).toContainText("卡片内容查找");
  await page.getByLabel("内容操作：TEST 内容页验收", { exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.getByLabel("内容名称", { exact: true }).fill("TEST 内容页已改名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByLabel("打开内容：TEST 内容页已改名", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByLabel("打开内容：TEST 内容页验收", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("清除搜索", { exact: true }).click();
  const win = await app.browserWindow(page);
  mkdirSync("test-results", { recursive: true });
  for (const [width, height, zoom] of [
    [1380, 920, 1],
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await win.evaluate(
      (w, { width, height, zoom }) => {
        w.webContents.setZoomFactor(zoom);
        w.setBounds({ width, height });
      },
      { width, height, zoom },
    );
    for (const layout of ["卡片视图", "列表视图"]) {
      await page.getByLabel(layout, { exact: true }).click();
      await expect(
        page.getByLabel("其他内容创作", { exact: true }),
      ).toBeInViewport();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      const card = page.locator(".artifact-card").first();
      assert.ok(await card.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      await card.getByLabel(/^内容操作：/).click();
      await expect(
        page.getByRole("group", { name: "内容操作", exact: true }),
      ).toBeInViewport();
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: `test-results/content-electron-${width}-${zoom}-${layout}.png`,
      });
    }
    await page.getByLabel("打开内容：TEST 内容页验收", { exact: true }).click();
    await expect(page.locator(".object-paper > h1")).toHaveText(
      "TEST 内容页验收",
    );
    await page
      .getByRole("button", {
        name: before.projects.find((p) => p.id === "first-project").title,
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    const recent = page.getByRole("region", { name: "继续工作", exact: true });
    await expect(
      recent.getByRole("heading", { name: "继续工作" }),
    ).toBeVisible();
    await expect(
      recent.getByRole("button", { name: "继续打开：TEST 内容页验收" }),
    ).toBeInViewport();
    await expect(recent.locator(".workspace-recent-meta")).toContainText(
      "文档",
    );
    await expect(
      page.getByRole("region", { name: "应用", exact: true }),
    ).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.reload();
    await expect(
      recent.getByRole("button", { name: "继续打开：TEST 内容页验收" }),
    ).toBeInViewport();
    await page.screenshot({
      path: `test-results/workspace-launcher-electron-${width}-${zoom}.png`,
    });
    await nav.getByRole("button", { name: "内容", exact: true }).click();
  }
  await page
    .getByLabel("让智能体处理：TEST 内容页验收", { exact: true })
    .click();
  await expect(page.getByLabel("AI 输入内容", { exact: true })).toBeFocused();
  await expect(page.locator(".composer .context-chip")).toContainText(
    "TEST 内容页验收",
  );
  await page
    .getByLabel("AI 输入内容", { exact: true })
    .fill("TEST 未发送的内容处理草稿");
  await page.reload();
  const current = new WorkspaceStore(join(fixture, "data/workspace.sqlite"));
  try {
    const after = current.snapshot();
    assert.deepEqual(after.inputs, before.inputs);
    assert.deepEqual(
      after.artifacts.find((a) => a.id === id).content,
      before.artifacts.find((a) => a.id === id).content,
    );
    assert.equal(after.artifacts.find((a) => a.id === id).revision, 3);
  } finally {
    current.close();
  }
  console.log(
    JSON.stringify({
      passed: true,
      productionEntry: true,
      applicationHTTP: false,
      pdfPixels: true,
      tableRows: true,
      bodySearch: true,
      metadataUndo: true,
      draftScope: true,
      zoom200: true,
      launcherRecency: true,
    }),
  );
} finally {
  await app?.close();
  rmSync(fixture, { recursive: true, force: true });
}
