import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  await call("command", {
    commandId: crypto.randomUUID(),
    operation: {
      type: "create-artifact",
      projectId: "first-project",
      title: "TEST 合并交流面板",
      content: {
        kind: "task",
        description: "隔离布局验收",
        assigneeId: "local-human",
        model: null,
        priority: "normal",
        dueDate: null,
        assignment: "accepted",
        execution: "planned",
        delivery: "none",
        resultIds: [],
      },
    },
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page
    .getByRole("button", { name: "打开事项：TEST 合并交流面板", exact: true })
    .click();
  const input = page.getByLabel("AI 输入内容");
  const reopen = async () => {
    if (!(await input.isVisible()))
      await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
    await input.focus();
    await expect(input).toBeFocused();
  };
  await reopen();
  await input.fill(
    "TEST 本地持久消息，用于面板回归；不调用外部模型。\n" +
      "这是用于回看、返回最新、焦点与缩放验收的合成历史。\n".repeat(40),
  );
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".conversation .human-message")).toContainText(
    "TEST 本地持久消息",
  );
  await input.fill("TEST 未发送草稿，切换与缩放均保留");
  const panel = page.locator(".exchange-panel");
  const controls = page.getByRole("group", {
    name: "交流面板操作",
    exact: true,
  });
  await expect(controls.getByRole("button")).toHaveCount(4);
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
    await expect(
      page.getByRole("button", { name: "固定输入框", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    for (const name of [
      "附加文件",
      "授权 Agent 读写目录",
      "截图输入",
      "语音输入",
      "固定输入框",
      "收起 AI 输入框",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeInViewport();
    await expect(page.locator(".send")).toBeInViewport();
    assert.ok(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
    );
    assert.ok((await input.boundingBox()).height >= 60);
    await page
      .getByRole("button", { name: "展开完整记录", exact: true })
      .click();
    await expect(page.locator(".primary-panel")).toHaveAttribute(
      "data-interaction",
      "history",
    );
    await page
      .getByRole("button", { name: "返回工作内容", exact: true })
      .click();
    await expect(input).toHaveValue("TEST 未发送草稿，切换与缩放均保留");
    for (const mode of ["recent", "history"]) {
      if (mode === "history")
        await page
          .getByRole("button", { name: "展开完整记录", exact: true })
          .click();
      for (const action of ["mouse", "Enter", "Space"]) {
        const scroll = page.locator(".conversation");
        await scroll.evaluate((el) => {
          el.scrollTop = 0;
        });
        const latest = page.getByRole("button", { name: /返回最新/ });
        await expect(latest).toBeVisible();
        const button = await latest.boundingBox();
        const tools = await page
          .locator(".composer-floating-tools")
          .boundingBox();
        const gap = tools.y - button.y - button.height;
        assert.ok(
          gap >= 4 && gap <= 12,
          `return/Dock gap ${gap}, ${width}/${zoom}x/${mode}`,
        );
        if (action === "mouse") await latest.click();
        else {
          await latest.focus();
          await page.keyboard.press(action);
        }
        // No reopen helper or pin: verify the production bug, not its workaround.
        await expect(input).toBeFocused();
        await expect(input).toHaveValue("TEST 未发送草稿，切换与缩放均保留");
        await expect(latest).toHaveCount(0);
        await expect
          .poll(() =>
            scroll.evaluate(
              (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
      }
      if (mode === "history")
        await page
          .getByRole("button", { name: "返回工作内容", exact: true })
          .click();
    }
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const png = await win.evaluate(async (w) =>
      (await w.capturePage()).toPNG().toString("base64"),
    );
    writeFileSync(
      `test-results/exchange-panel-desktop-${width}-${zoom}x.png`,
      Buffer.from(png, "base64"),
    );
  }
  await page.getByRole("button", { name: "固定输入框", exact: true }).click();
  await page.reload();
  await reopen();
  await expect(input).toHaveValue("TEST 未发送草稿，切换与缩放均保留");
  await expect(page.locator(".conversation .human-message")).toContainText(
    "TEST 本地持久消息",
  );
  await page.getByRole("button", { name: "收起交流记录", exact: true }).click();
  await expect(page.locator(".conversation")).toHaveCount(0);
  await expect(
    controls.getByRole("button", { name: "展开完整记录", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await reopen();
  await expect(input).toHaveValue("TEST 未发送草稿，切换与缩放均保留");
  const after = await call("workspace");
  assert.equal(
    after.workspace.inputs.length,
    before.workspace.inputs.length + 1,
  );
  console.log(
    "PASS production Electron: unpinned return-latest mouse/Enter/Space in recent/full history, Dock clearance at 1380×920, 760×540 and 200% zoom; persisted long message, history/pin/collapse, draft/reload. No external execution.",
  );
} finally {
  if (app) await app.close();
  const real = realpathSync(fixture);
  if (!real.startsWith(realpathSync(tmpdir()) + "/morphz-embedded-electron-"))
    throw Error("Refuse cleanup outside fixture");
  rmSync(real, { recursive: true, force: true });
}
