import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { orderedTasks } from "../dist/service/packages/core/src/model.js";
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
  let identityGeneration;
  const call = async (method, params) => {
    const result = await page.evaluate(
      async ({ method, params, identityGeneration }) => {
        const reply = await window.morphzDesktop.application.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          identityGeneration,
        });
        if (!reply.ok) throw Error(JSON.stringify(reply));
        return reply.value;
      },
      {
        method,
        params,
        identityGeneration:
          method === "workspace" ? undefined : identityGeneration,
      },
    );
    if (method === "workspace") identityGeneration = result.csrfToken;
    return result;
  };
  const before = await call("workspace");
  identityGeneration = before.csrfToken;
  const content = {
    kind: "task",
    description: "合成测试，不执行外部工作",
    assigneeId: "local-human",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    runRequested: 0,
    notBefore: null,
    everySeconds: null,
    dependsOnIds: [],
    watchSourceIds: [],
  };
  for (const [title, extra] of [
    ["TEST 今天核对", { dueDate: new Date().toLocaleDateString("en-CA") }],
    ["TEST 已逾期", { dueDate: "2020-01-01", priority: "high" }],
    ["TEST 等待 Agent", { assigneeId: "morphz-agent", execution: "waiting" }],
  ]) {
    await call("command", {
      commandId: crypto.randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title,
        content: { ...content, ...extra },
      },
    });
  }
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  assert.equal((await call("workspace")).capabilities.taskCompletion, true);
  const checkbox = page.getByRole("checkbox", {
    name: "标记完成：TEST 今天核对",
  });
  await checkbox.click();
  await expect(checkbox).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(checkbox).toBeVisible();
  await page.getByRole("button", { name: "关闭完成提示", exact: true }).click();
  const humanRow = page.locator(".task-row").filter({ has: checkbox });
  await expect(humanRow.getByLabel("事项状态", { exact: true })).toBeVisible();
  await humanRow.getByLabel("事项状态", { exact: true }).selectOption("active");
  await expect(humanRow.getByLabel("事项状态", { exact: true })).toHaveValue(
    "active",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(humanRow.getByLabel("事项状态", { exact: true })).toHaveValue(
    "planned",
  );
  await page.getByRole("button", { name: "看板视图", exact: true }).click();
  await expect(
    page.locator(".task-board").getByLabel("事项状态", { exact: true }),
  ).toHaveCount(0);
  const grip = page.getByRole("button", {
    name: "排序：TEST 今天核对",
    exact: true,
  });
  const source = await grip.boundingBox();
  const target = await page
    .locator('.task-board-column[aria-label="进行中"]')
    .boundingBox();
  const beforeDrag = await call("workspace");
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x + 60, target.y + 70, { steps: 24 });
  await page.mouse.up();
  await expect(
    page
      .locator('.task-board-column[aria-label="进行中"]')
      .getByRole("button", { name: "打开事项：TEST 今天核对", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-drop-target="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  const afterDragUndo = await call("workspace");
  assert.deepEqual(
    orderedTasks(afterDragUndo.workspace).map((a) => a.id),
    orderedTasks(beforeDrag.workspace).map((a) => a.id),
  );
  assert.equal(
    afterDragUndo.workspace.artifacts.find((a) => a.title === "TEST 今天核对")
      .content.execution,
    "planned",
  );
  await page.getByRole("button", { name: "清单视图", exact: true }).click();
  for (const [width, height, zoom] of [
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height, zoom }) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === "morphz://app/",
        );
        win.setSize(width, height);
        win.webContents.setZoomFactor(zoom);
      },
      { width, height, zoom },
    );
    await expect(
      page.getByRole("button", { name: /^筛选事项：/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^筛选事项：/ }).click();
    const filters = page.getByRole("group", { name: "筛选事项", exact: true });
    await filters.getByLabel("事项负责人筛选").selectOption("all");
    await page.keyboard.press("Escape");
    await expect(page.locator(".task-row")).toHaveCount(3);
    for (const selector of [".topbar", ".task-list"])
      assert.equal(
        await page
          .locator(selector)
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
        true,
      );
    await expect(checkbox).toBeInViewport();
    await expect(
      humanRow.getByLabel("事项状态", { exact: true }),
    ).toBeInViewport();
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const image = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL() === "morphz://app/")
          .capturePage()
      )
        .toPNG()
        .toString("base64"),
    );
    writeFileSync(
      `test-results/task-list-desktop-${zoom}x.png`,
      Buffer.from(image, "base64"),
    );
    await page.getByRole("button", { name: "看板视图", exact: true }).click();
    await expect(page.locator(".task-board-column")).toHaveCount(4);
    await expect(page.getByLabel("事项列表", { exact: true })).toBeVisible();
    await expect(
      page.locator(".task-board").getByLabel("事项状态", { exact: true }),
    ).toHaveCount(0);
    assert.equal(
      await page
        .locator(".topbar")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
      true,
    );
    await expect(page.getByLabel("优先级", { exact: true })).toHaveCount(0);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const boardImage = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL() === "morphz://app/")
          .capturePage()
      )
        .toPNG()
        .toString("base64"),
    );
    writeFileSync(
      `test-results/task-board-desktop-${zoom}x.png`,
      Buffer.from(boardImage, "base64"),
    );
    await page.getByRole("button", { name: "清单视图", exact: true }).click();
  }
  await page.reload();
  await expect(page.locator(".task-row")).toHaveCount(3);
  assert.deepEqual(
    (await call("workspace")).workspace.inputs,
    before.workspace.inputs,
  );
  assert.deepEqual(
    (await call("workspace")).workspace.taskResponses,
    before.workspace.taskResponses,
  );
  console.log(
    "PASS production Electron: list/board, filters, completion/undo receipts, no priority controls or messages, reload, minimum window and 200% zoom.",
  );
} finally {
  if (app) await app.close();
  const real = realpathSync(fixture);
  if (!real.startsWith(realpathSync(tmpdir()) + "/morphz-embedded-electron-"))
    throw Error("Refuse cleanup outside the test fixture");
  rmSync(real, { recursive: true, force: true });
}
