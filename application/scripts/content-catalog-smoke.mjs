import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyInteractive } from "../dist/service/packages/core/src/interactive.js";
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const seedDirectory = join(fixture, "morphz-e2e-catalog-seed");
mkdirSync(seedDirectory);
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(MORPHZ_|MORPHZ_WORK_|DOUBAO_|OPENAI_|ANTHROPIC_)/.test(key),
    ),
  ),
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  // A real Agent-authored Objects document is eligible for正文检索. Only the
  // fixture's accepted Runtime observations are controlled; no legacy SQL or
  // model request is used to manufacture app data or grant an Agent identity.
  const seeded = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { openEmbeddedApplication } from "./apps/desktop/application-host.ts";
import { PlatformClient } from "./apps/web/src/platform-client.ts";
import { agentDomainFixture } from "./tests/agent-domain-fixture.ts";
(async () => {
  const {directory} = JSON.parse(readFileSync(0, "utf8"));
  const projectId = randomUUID(), projectTitle = "TEST 内容目录项目";
  const host = await openEmbeddedApplication(directory, directory + "/profile");
  try { await (await PlatformClient.connect(host.connection)).createProject(projectTitle, randomUUID(), projectId); }
  finally { await host.close(); }
  const f = await agentDomainFixture({existingCenter: {directory, projectId}});
  try {
    const document = await f.call({action: "create-document", title: "TEST 内容页验收", markdown: "用于正文搜索的独特短语：卡片内容查找。"});
    f.assertNoLegacyData();
    console.log(JSON.stringify({projectId, projectTitle, contentId: document.contentId}));
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    {
      env,
      encoding: "utf8",
      input: JSON.stringify({ directory: seedDirectory }),
      timeout: 30_000,
    },
  );
  assert.equal(seeded.status, 0, seeded.stderr);
  const seed = JSON.parse(seeded.stdout.trim().split("\n").at(-1));
  renameSync(seedDirectory, join(fixture, "data"));
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
  const collapseExchange = async () => {
    const collapse = page.getByRole("button", {
      name: "收起 AI 输入框",
      exact: true,
    });
    if (await collapse.isVisible()) await collapse.click();
  };
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  const call = (method, params) =>
    page.evaluate(
      async ({ method, params }) => {
        const api = window.morphzDesktop.application;
        const boot = await api.invoke({
          id: crypto.randomUUID(),
          method: "platform.bootstrap",
        });
        if (!boot.ok) throw new Error(JSON.stringify(boot.error));
        if (method === "reader.import")
          params.data = new Uint8Array(params.data);
        const reply = await api.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          identityGeneration: boot.value.csrfToken,
        });
        if (!reply.ok) throw new Error(JSON.stringify(reply.error));
        return reply.value;
      },
      { method, params },
    );
  const { projectId, projectTitle, contentId: id } = seed;
  await call("reader.import", {
    commandId: crypto.randomUUID(),
    projectId,
    relativePath: "TEST reader.pdf",
    data: Array.from(
      readFileSync(new URL("../tests/fixtures/reader.pdf", import.meta.url)),
    ),
  });
  await call("interactive.create", {
    commandId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
    projectId,
    title: "TEST 表格实际数据",
    content: {
      ...structuredClone(emptyInteractive),
      rows: [{ id: "row1", cells: { name: "上线检查", value: 42 } }],
    },
  });
  const before = {
    document: await call("documents.read", { contentId: id }),
    runtime: await call("runtime.snapshot"),
  };
  await page.reload();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(page.getByLabel("工作空间选项", { exact: true })).toHaveCount(0);
  const canvas = page.getByRole("img", { name: "PDF 首页预览" });
  const waitForPdfPixels = async () => {
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
  };
  await waitForPdfPixels();
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
  // The directory does not materialize unopened originals. Explicitly open
  // the unchanged document, then verify its loaded card's creator attribution.
  await page.getByLabel("打开内容：TEST 内容页验收", { exact: true }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText(
    "TEST 内容页验收",
  );
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(
    page
      .locator(".artifact-card")
      .filter({
        has: page.getByLabel("打开内容：TEST 内容页验收", { exact: true }),
      })
      .locator(".content-origin"),
  ).toHaveText("Morphz生成");
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
      // Search/layout changes remount lazy previews. Capture the rendered PDF,
      // not a blank canvas while its authorized original is still loading.
      if (
        (await canvas.count()) > 0 &&
        (await canvas.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.top < innerHeight && bounds.bottom > 0;
        }))
      )
        await waitForPdfPixels();
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
        name: projectTitle,
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
    // Keep the same entry/order in the reader. The existing narrow toolbar
    // scrolls to reveal the active app, so compare its unscrolled position.
    const contents = page.getByRole("button", {
      name: "查看项目内容",
      exact: true,
    });
    await contents.click();
    await expect(page.locator(".library-collection:visible")).toBeVisible();
    await expect(contents).toHaveText("项目内容");
    await collapseExchange();
    const entryGeometry = () =>
      contents.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x + element.closest(".application-strip").scrollLeft,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      });
    const contentPosition = await entryGeometry();
    await page.getByLabel("打开内容：TEST 内容页验收", { exact: true }).click();
    await expect(page.locator(".object-paper > h1")).toHaveText(
      "TEST 内容页验收",
    );
    assert.deepEqual(await entryGeometry(), contentPosition);
    await contents.click();
    await expect(contents).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".library-collection:visible")).toBeVisible();
    await page.reload();
    await expect(page.locator(".library-collection:visible")).toBeVisible();
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await collapseExchange();
    await recent
      .getByRole("button", { name: "继续打开：TEST 内容页验收" })
      .click();
    await expect(page.locator(".object-paper > h1")).toHaveText(
      "TEST 内容页验收",
    );
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
  const after = await call("documents.read", { contentId: id });
  assert.deepEqual(await call("runtime.snapshot"), before.runtime);
  assert.equal(after.markdown, before.document.markdown);
  assert.equal(after.revision, 3);
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
