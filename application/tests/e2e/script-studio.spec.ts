import {
  test,
  expect,
  _electron,
  type Page,
  type Locator,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { seedCenter } from "../center-fixtures.js";
import { openInput } from "../interaction-helpers.js";
import {
  assertDialogControlMetrics,
  assertSingleFieldDialog,
} from "../dialog-control-helpers.js";
import { WorkspaceStore } from "../../packages/application/src/store.js";
import {
  currentScriptDraft,
  type ScriptProduction,
  type ScriptCommand,
} from "../../packages/core/src/script-studio.js";
import type { Boot } from "../../apps/web/src/client.js";

const snapshot = async (page: Page): Promise<Boot> =>
  (await page.request.get("/api/workspace")).json();
const command = (page: Page, command: ScriptCommand) =>
  seedCenter(page, { type: "script-command", command });
const production = async (page: Page, id: string) =>
  (await snapshot(page)).workspace.scriptProductions.find((p) => p.id === id)!;
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const editor = (page: Page) => page.getByLabel("剧本正文", { exact: true });
const openScript = (page: Page, title: string) =>
  button(page, `打开剧本：${title}`);

async function assertLibraryControls(page: Page) {
  const create = button(page, "构思新剧");
  await expect(create).toBeEnabled();
  const contrast = () =>
    create.evaluate((element) => {
      const css = getComputedStyle(element);
      const luminance = (color: string) => {
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      const light = luminance(css.color);
      const dark = luminance(css.backgroundColor);
      return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    });
  await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
  await create.hover();
  await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
  const search = page.locator(".script-library-search");
  const geometry = await search.evaluate((element) => {
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    const input = element.querySelector("input")!.getBoundingClientRect();
    return {
      height: element.getBoundingClientRect().height,
      inputHeight: input.height,
      iconCenter: icon.y + icon.height / 2,
      inputCenter: input.y + input.height / 2,
      iconRight: icon.right,
      inputTextLeft:
        input.left +
        parseFloat(
          getComputedStyle(element.querySelector("input")!).paddingLeft,
        ),
    };
  });
  expect(geometry.height).toBe(geometry.inputHeight);
  expect(geometry.height).toBeLessThanOrEqual(40);
  expect(
    Math.abs(geometry.iconCenter - geometry.inputCenter),
  ).toBeLessThanOrEqual(1);
  expect(geometry.iconRight).toBeLessThan(geometry.inputTextLeft);
}

test("剧本入口：列表搜索、键盘打开与返回、草稿恢复及空间隔离", async ({
  page,
}, testInfo) => {
  const p = await setup(page);
  await createItem(page, "入口回归第一集");
  const unsaved = "TEST 未保存正文，切到剧本列表后必须保留";
  await editor(page).fill(unsaved);
  await button(page, "全部剧本").click();
  await expect(page.getByRole("combobox", { name: "当前剧本" })).toHaveCount(0);
  await expect(openScript(page, p.title)).toBeFocused();
  const inputCount = (await snapshot(page)).workspace.inputs.length;
  const otherProject = await seedCenter(page, {
    type: "create-project",
    title: "TEST 其他项目 " + randomUUID().slice(0, 6),
  });
  const hiddenTitle = "TEST 不属于当前项目 " + randomUUID().slice(0, 6);
  await command(page, {
    action: "create-production",
    projectId: otherProject,
    title: hiddenTitle,
  });
  await page.reload();
  await expect(page.getByLabel("查找剧本", { exact: true })).toBeVisible();
  await expect(openScript(page, hiddenTitle)).toBeVisible();
  const search = page.getByLabel("查找剧本", { exact: true });
  await search.fill("找不到的剧本 " + randomUUID());
  await expect(page.locator(".script-library")).toContainText(
    "没有找到符合条件的剧本",
  );
  await button(page, "清除搜索").click();
  await search.fill(p.title);
  await expect(page.locator(".script-library-card")).toHaveCount(1);
  for (const width of [1440, 760, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(openScript(page, p.title)).toBeInViewport();
    await expect(button(page, "构思新剧")).toBeInViewport();
    await expect(button(page, "手动新建剧本")).toBeInViewport();
    await expect(button(page, "保存为项目")).toHaveCount(0);
    const geometry = await page
      .locator(".script-library")
      .evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    await assertLibraryControls(page);
  }
  await page.screenshot({
    path: testInfo.outputPath("script-library-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openScript(page, p.title).focus();
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveValue(unsaved);
  await expect(button(page, "保存文稿")).toBeEnabled();
  await expect(page.getByLabel("文稿标题", { exact: true })).toBeFocused();
  await button(page, "全部剧本").click();
  await expect(search).toHaveValue(p.title);
  await button(page, "构思新剧").click();
  await expect(page.getByLabel("AI 输入内容", { exact: true })).toBeFocused();
  expect((await snapshot(page)).workspace.inputs.length).toBe(inputCount);
});

test("剧本归属：只整理选中内容，多部剧本可加入一个项目，目录和应用共用原对象", async ({
  page,
}) => {
  const p = await setup(page);
  await createItem(page, "归属回归第一集");
  await saveText(page, "TEST 正式正文保持原版本");
  await editor(page).fill("TEST 整理归属不能丢失未保存正文");
  const secondTitle = "TEST 同项目第二部 " + randomUUID().slice(0, 6);
  const second = await command(page, {
    action: "create-production",
    projectId: p.projectId,
    title: secondTitle,
  });
  const doc = await seedCenter(page, {
    type: "create-artifact",
    projectId: p.projectId,
    title: "TEST 不应被一起移动的文档",
    content: { kind: "document", markdown: "保持原文" },
  });
  const before = (await snapshot(page)).workspace;
  await button(page, "设置项目").click();
  const dialog = page.getByRole("dialog", { name: "设置项目", exact: true });
  await expect(dialog).toContainText(p.title);
  await dialog.getByLabel("目标项目").selectOption("new");
  await dialog.getByLabel("新项目名称").fill("TEST 取消不应创建");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect((await snapshot(page)).workspace.projects).toEqual(before.projects);
  await button(page, "设置项目").click();
  await dialog.getByLabel("目标项目").selectOption("new");
  const projectTitle = "TEST 多剧本项目 " + randomUUID().slice(0, 6);
  await dialog.getByLabel("新项目名称").fill(projectTitle);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".script-project")).toHaveText(projectTitle);
  const after = (await snapshot(page)).workspace;
  const projectId = after.projects.find(
    (value) => value.title === projectTitle,
  )!.id;
  expect(
    after.scriptProductions.find((value) => value.id === p.id)!.items,
  ).toEqual(before.scriptProductions.find((value) => value.id === p.id)!.items);
  expect(
    after.scriptProductions.find((value) => value.id === second)!.projectId,
  ).toBe(p.projectId);
  expect(after.artifacts.find((value) => value.id === doc)!.projectId).toBe(
    p.projectId,
  );
  expect(after.inputs).toEqual(before.inputs);
  expect(after.projects.find((value) => value.id === p.projectId)!.kind).toBe(
    "desk",
  );
  await page.reload();
  await expect(page.locator(".script-project")).toHaveText(projectTitle);
  await page
    .getByRole("navigation", { name: "剧本目录" })
    .getByRole("button", { name: /归属回归第一集/ })
    .click();
  await expect(editor(page)).toHaveValue("TEST 整理归属不能丢失未保存正文");
  await button(page, "全部剧本").click();
  await expect(openScript(page, p.title)).toBeVisible();
  await expect(openScript(page, secondTitle)).toBeVisible();
  await openScript(page, secondTitle).click();
  await button(page, "设置项目").click();
  await dialog.getByLabel("目标项目").selectOption(projectId);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".script-project")).toHaveText(projectTitle);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await page.getByLabel("内容范围", { exact: true }).selectOption("all");
  await page
    .getByRole("group", { name: "内容类型" })
    .getByRole("button", { name: "剧本", exact: true })
    .click();
  await expect(button(page, "打开内容：" + p.title)).toBeVisible();
  await expect(button(page, "打开内容：" + secondTitle)).toBeVisible();
  await page.getByLabel("内容范围", { exact: true }).selectOption(projectId);
  await expect(page.locator(".artifact-card")).toHaveCount(2);
  await button(page, "打开内容：" + p.title).click();
  await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
    p.title,
  );
  const final = (await snapshot(page)).workspace;
  expect(
    final.scriptProductions
      .filter((value) => value.projectId === projectId)
      .map((value) => value.id)
      .sort(),
  ).toEqual([p.id, second].sort());
  expect(final.scriptProductions.length).toBe(before.scriptProductions.length);
  expect(final.inputs).toEqual(before.inputs);
  expect(final.conversations.filter((c) => c.projectId !== projectId)).toEqual(
    before.conversations,
  );
  expect(
    final.conversations
      .filter((c) => c.projectId === projectId)
      .every((c) => c.id === projectId),
  ).toBe(true);
});
async function setup(page: Page) {
  await page.goto("/");
  const boot = await snapshot(page);
  // This suite must never submit a real model request.
  expect(boot.runtime.configured).toBe(false);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await button(page, "应用启动台").click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  await expect(page.getByRole("region", { name: "剧本工作区" })).toBeVisible();
  const title = "TEST 剧本 " + randomUUID().slice(0, 8);
  await button(page, "手动新建剧本").click();
  const dialog = page.getByRole("dialog", {
    name: "手动新建剧本",
    exact: true,
  });
  await dialog.getByLabel("剧本名称", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
    title,
  );
  const p = (await snapshot(page)).workspace.scriptProductions.find(
    (p) => p.title === title,
  )!;
  expect(p.items).toEqual([]);
  return p;
}
async function createItem(
  page: Page,
  title: string,
  kind = "episode",
  parent?: string,
) {
  const labels: Record<string, string> = {
    outline: "新建全剧大纲",
    episode: "新建一集",
    scene: "添加分场",
    character: "添加角色",
    setting: "添加设定",
    source: "添加参考资料",
  };
  await button(page, "添加剧本内容").click();
  await page
    .getByRole("group", { name: "添加剧本内容菜单", exact: true })
    .getByRole("button", { name: labels[kind], exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: labels[kind], exact: true });
  await expect(dialog.getByLabel("条目类型", { exact: true })).toHaveValue(
    kind,
  );
  await dialog.getByLabel("条目标题", { exact: true }).fill(title);
  if (parent)
    await dialog.getByLabel("所属分集", { exact: true }).selectOption(parent);
  await dialog.getByRole("button", { name: "创建条目", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("文稿标题", { exact: true })).toHaveValue(title);
  await expect(page.getByLabel("文稿标题", { exact: true })).toBeFocused();
}
async function saveText(page: Page, text: string) {
  await editor(page).fill(text);
  await button(page, "保存文稿").click();
  await expect(button(page, "保存文稿")).toBeDisabled();
  await expect(editor(page)).toHaveValue(text);
  await expect(page.locator(".script-edit-status")).toContainText("已保存 v");
  await expect(page.locator(".workspace-notice")).toHaveCount(0);
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
}
async function permitModel(page: Page) {
  await button(page, "剧本设置").click();
  const dialog = page.getByRole("dialog", {
    name: "剧本设置",
    exact: true,
  });
  await dialog
    .getByLabel("资料权利与使用范围", { exact: true })
    .fill("TEST 合成原创资料，仅用于隔离自动化验证，不是合作方授权。");
  await dialog
    .getByLabel("我确认本剧本所选资料允许交给当前模型服务处理", { exact: true })
    .check();
  await dialog.getByRole("button", { name: "保存规范", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function approveAndLock(page: Page) {
  await button(page, "提交审阅").click();
  await expect(button(page, "批准此版本")).toBeEnabled();
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
  await button(page, "批准此版本").click();
  const dialog = page.getByRole("dialog", { name: "批准此版本", exact: true });
  await dialog
    .getByLabel("决定说明", { exact: true })
    .fill("TEST 人工审阅路径。");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(button(page, "锁稿")).toBeEnabled();
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
  await button(page, "锁稿").click();
  await expect(editor(page)).toHaveAttribute("readonly", "");
}
/** Explicitly synthetic model output: only the isolated E2E database is opened.
 * It goes through the real command and origin-input rules, not a production bypass.
 * No Runtime or model is started. The temporary delivery ledger is restored. */
async function syntheticCandidate(
  page: Page,
  p: ScriptProduction,
  inputId: string,
  text: string,
) {
  const boot = await snapshot(page);
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  );
  if (!isAbsolute(directory) || !basename(directory).startsWith("morphz-e2e-"))
    throw new Error("Isolated center required");
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    expect(store.identity()).toBe(boot.centerId);
    const input = store.snapshot().inputs.find((i) => i.id === inputId)!;
    const target = p.items.find(
      (i) => i.id === input.scriptGeneration!.targetId,
    )!;
    const previous = store.runtimeState();
    const runtime = (previous ?? {}) as Record<string, unknown> & {
      deliveries?: unknown[];
    };
    store.saveRuntimeState({
      ...runtime,
      deliveries: [
        ...(runtime.deliveries ?? []),
        { inputId, state: "running" },
      ],
    });
    try {
      store.execute(
        {
          commandId: randomUUID(),
          operation: {
            type: "script-command",
            command: {
              action: "submit-candidate",
              productionId: p.id,
              draft: { ...currentScriptDraft(target), text },
              explanation: "TEST 模拟候选；非真实模型生成。",
            },
          },
        },
        { principalId: "morphz-service", actantId: "morphz-agent" },
        inputId,
      );
    } finally {
      store.saveRuntimeState(previous);
    }
  } finally {
    store.close();
  }
}

test("准备失败保留要求和限制，取消后重开可继续，空的新剧意图不阻止准备", async ({
  page,
}) => {
  const p = await setup(page);
  await permitModel(page);
  await createItem(page, "请求准备回归");
  await saveText(page, "TEST 原创正文");
  const before = (await snapshot(page)).workspace.inputs;
  await button(page, "构思新剧").click();
  const input = page.getByLabel("AI 输入内容", { exact: true });
  await input.fill("TEST 已有草稿，不可合并或覆盖");
  await button(page, "生成候选").click();
  const dialog = page.getByRole("dialog", {
    name: "准备生成候选请求",
    exact: true,
  });
  await expect(dialog).toContainText("最多执行一轮语义自审");
  await expect(dialog).toContainText("暂不支持单次费用硬限额");
  await dialog
    .getByLabel("本次要求", { exact: true })
    .fill("保留要求：只写雨中的动作");
  await dialog.getByLabel("可提交字符上限", { exact: true }).fill("1000");
  await dialog
    .getByRole("button", { name: "准备到输入框", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("已有未发送");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(dialog.getByLabel("本次要求", { exact: true })).toHaveValue(
    "保留要求：只写雨中的动作",
  );
  await expect(
    dialog.getByLabel("可提交字符上限", { exact: true }),
  ).toHaveValue("1000");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await openInput(page);
  await expect(input).toHaveValue("TEST 已有草稿，不可合并或覆盖");
  await input.fill("");
  await button(page, "生成候选").click();
  await expect(dialog.getByLabel("本次要求", { exact: true })).toHaveValue(
    "保留要求：只写雨中的动作",
  );
  await dialog
    .getByRole("button", { name: "准备到输入框", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(input).toBeFocused();
  expect(await input.inputValue()).toContain("保留要求：只写雨中的动作");
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "请求准备回归",
  );
  await expect(button(page, "移除输入意图")).toHaveCount(0);
  expect((await snapshot(page)).workspace.inputs).toEqual(before);
  await button(page, "保存输入").click();
  await expect
    .poll(async () => (await snapshot(page)).workspace.inputs.length)
    .toBe(before.length + 1);
  const submitted = (await snapshot(page)).workspace.inputs.at(-1)!;
  expect(submitted.scriptGeneration).toMatchObject({
    productionId: p.id,
    maxOutputCharacters: 1000,
  });
});

test("错误只在发起位置显示，标签方向键及成功操作焦点完整", async ({ page }) => {
  await setup(page);
  await createItem(page, "错误与键盘回归");
  await button(page, "提交审阅").click();
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("请先填写正文");
  await saveText(page, "TEST 待审正文");
  const edit = page.getByRole("tab", { name: "正文", exact: true });
  await edit.focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "检查与影响", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tabpanel", { name: "检查与影响", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(edit).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: "检查与影响", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(edit).toBeFocused();
  await expect(page.locator('.script-tabs [tabindex="0"]')).toHaveCount(1);
  await page.getByRole("tab", { name: /^审阅/ }).click();
  await page
    .getByLabel("审阅意见", { exact: true })
    .fill("TEST 阻断：需要核对动机");
  await page.getByLabel("意见级别", { exact: true }).selectOption("blocking");
  await button(page, "添加意见").click();
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
  await expect(page.locator(".script-review > small")).toContainText("我");
  await expect(page.locator(".script-review > small")).not.toContainText(
    "local-human",
  );
  await button(page, "提交审阅").click();
  await button(page, "批准此版本").click();
  const dialog = page.getByRole("dialog", { name: "批准此版本", exact: true });
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("阻断");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(button(page, "批准此版本")).toBeFocused();
});

test("检查可定位准确依赖，长内容保存栏与设置操作持续可达", async ({ page }) => {
  const p = await setup(page);
  await createItem(page, "上游集");
  await saveText(page, "TEST 第一稿");
  const parent = (await production(page, p.id)).items[0]!;
  await createItem(page, "下游场", "scene", parent.id);
  await saveText(page, "TEST 场景正文");
  await command(page, {
    action: "revise-item",
    productionId: p.id,
    itemId: parent.id,
    expectedRevision: parent.revision,
    draft: { ...currentScriptDraft(parent), text: "TEST 更新上游" },
  });
  await page.getByRole("tab", { name: "检查与影响", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "检查与影响", exact: true }),
  ).toContainText("上游集");
  await button(page, "查看并更新引用").click();
  const dependency = page.getByLabel("上游集依赖版本", { exact: true });
  await expect(dependency).toBeFocused();
  await expect(dependency).toHaveValue(String(parent.revision));
  await dependency.selectOption(String(parent.revision + 1));
  await expect(button(page, "保存文稿")).toBeInViewport();
  await button(page, "保存文稿").click();
  await page.getByRole("tab", { name: "检查与影响", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "检查与影响", exact: true }),
  ).toContainText("当前未发现结构性问题");
  await button(page, "剧本设置").click();
  const settings = page.getByRole("dialog", {
    name: "剧本设置",
    exact: true,
  });
  await settings
    .locator("summary")
    .filter({ hasText: "Word 交付模板" })
    .click();
  for (const width of [1440, 760, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await settings.getByLabel("字号", { exact: true }).scrollIntoViewIfNeeded();
    await expect(
      settings.getByRole("button", { name: "关闭", exact: true }),
    ).toBeInViewport();
    await expect(
      settings.getByRole("button", { name: "保存规范", exact: true }),
    ).toBeInViewport();
    await expect(
      settings.getByRole("button", { name: "取消", exact: true }),
    ).toBeInViewport();
    await assertStudioDialog(settings);
  }
  await settings.getByRole("button", { name: "取消", exact: true }).click();
});

test("导出提示属于原剧本，历史显示确切稿名版本并可直接到达", async ({
  page,
}) => {
  const p = await setup(page);
  await createItem(page, "已交付第一集");
  await saveText(page, "TEST 交付正文");
  await approveAndLock(page);
  const waiting = page.waitForEvent("download");
  await button(page, "导出 Word").click();
  await page
    .getByRole("dialog", { name: "导出 Word", exact: true })
    .getByRole("button", { name: "导出所选", exact: true })
    .click();
  await waiting;
  await expect(page.locator(".script-export-status")).toContainText(
    "Word 文件已生成",
  );
  await button(page, "查看导出历史").click();
  await expect(page.locator(".script-export-record")).toContainText(
    "已交付第一集 · v2",
  );
  await expect(button(page, "重新下载")).toBeVisible();
  const before = (await production(page, p.id)).exports;
  await button(page, "手动新建剧本").click();
  const dialog = page.getByRole("dialog", {
    name: "手动新建剧本",
    exact: true,
  });
  await dialog
    .getByLabel("剧本名称", { exact: true })
    .fill("TEST 另一部剧 " + randomUUID().slice(0, 8));
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".script-export-status")).toHaveCount(0);
  await expect(page.locator(".script-export-record")).toHaveCount(0);
  expect((await production(page, p.id)).exports).toEqual(before);
});

test("批准弹窗固定打开时的版本，后台重新提交新稿不能被旧决定批准", async ({
  page,
}) => {
  const p = await setup(page);
  await createItem(page, "第一集");
  await saveText(page, "审阅者已看过的旧稿");
  const viewed = (await production(page, p.id)).items[0]!;
  await button(page, "提交审阅").click();
  await button(page, "批准此版本").click();
  const dialog = page.getByRole("dialog", { name: "批准此版本", exact: true });
  await expect(dialog).toContainText(`本次决定：v${viewed.revision}`);
  await dialog.getByLabel("决定说明", { exact: true }).fill("我认可旧稿。");
  await command(page, {
    action: "revise-item",
    productionId: p.id,
    itemId: viewed.id,
    expectedRevision: viewed.revision,
    draft: { ...currentScriptDraft(viewed), text: "弹窗打开后写入的未见新稿" },
  });
  const changed = (await production(page, p.id)).items[0]!;
  await command(page, {
    action: "submit-review",
    productionId: p.id,
    itemId: changed.id,
    expectedRevision: changed.revision,
    expectedWorkflowRevision: changed.workflowRevision,
  });
  await expect(dialog.getByRole("alert")).toContainText("正文或审阅状态已变化");
  await expect(
    dialog.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("决定说明", { exact: true }).press("Control+Enter");
  expect((await production(page, p.id)).items[0]!.approval).toBeNull();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor(page)).toHaveValue("弹窗打开后写入的未见新稿");
  await button(page, "批准此版本").click();
  await expect(dialog).toContainText(`本次决定：v${changed.revision}`);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  expect((await production(page, p.id)).items[0]!.approval?.revision).toBe(
    changed.revision,
  );
});

test("仅导出已完成的集场，未完成分集不阻塞；分场自动关联父集且取消不产生导出", async ({
  page,
}) => {
  const p = await setup(page);
  await createItem(page, "已完成第一集");
  await saveText(page, "已完成的第一集正文");
  await approveAndLock(page);
  const episode = (await production(page, p.id)).items[0]!;
  await createItem(page, "已完成第一场", "scene", episode.id);
  await saveText(page, "已完成的第一场正文");
  await approveAndLock(page);
  await createItem(page, "未完成第二集");
  await button(page, "导出 Word").click();
  const dialog = page.getByRole("dialog", { name: "导出 Word", exact: true });
  const first = dialog.getByRole("checkbox", { name: /已完成第一集/ });
  const scene = dialog.getByRole("checkbox", { name: /已完成第一场/ });
  const second = dialog.getByRole("checkbox", { name: /未完成第二集/ });
  await expect(first).toBeChecked();
  await expect(scene).toBeChecked();
  await expect(second).toBeDisabled();
  await expect(second).not.toBeChecked();
  await first.uncheck();
  await expect(scene).not.toBeChecked();
  await scene.check();
  await expect(first).toBeChecked();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await production(page, p.id)).exports).toHaveLength(0);
  await button(page, "导出 Word").click();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出所选", exact: true }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const bytes = readFileSync((await download.path())!);
  expect(bytes.toString("utf8")).toContain("已完成的第一场正文");
  expect(bytes.toString("utf8")).not.toContain("未完成第二集");
  const exported = (await production(page, p.id)).exports.at(-1)!;
  expect(exported.items).toHaveLength(2);
  expect(exported.items.some((i) => i.itemId === episode.id)).toBe(true);
});

test("创作目录按集场组织：上下文新增、折叠、键盘和刷新保留正文与原有数据", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const p = await setup(page);
  const nav = page.getByRole("navigation", { name: "剧本目录", exact: true });
  const group = (key: string) => nav.locator(`[data-script-group="${key}"]`);
  const before = (await snapshot(page)).workspace;
  await expect(
    nav.locator(".script-overview-link, .script-nav-disclosure"),
  ).toHaveText(["概览", "全剧大纲", "分集剧本", "设定与角色", "参考资料"]);
  await expect(
    nav.getByRole("button", { name: "概览", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    group("people").getByRole("button", { name: "设定与角色", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    group("sources").getByRole("button", { name: "参考资料", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator(".script-overview-details[open]").count()).toBe(0);
  await expect(
    page.getByRole("region", { name: "创作简报", exact: true }),
  ).toContainText("生成前需确认");
  // Contextual actions choose a sensible default, but still need explicit confirmation.
  const addEpisode = group("episodes").getByRole("button", {
    name: "新建一集",
    exact: true,
  });
  await addEpisode.focus();
  await page.keyboard.press("Enter");
  let dialog = page.getByRole("dialog", { name: "新建一集", exact: true });
  await expect(dialog.getByLabel("条目类型", { exact: true })).toHaveValue(
    "episode",
  );
  await page.keyboard.press("Escape");
  await expect(addEpisode).toBeFocused();
  expect((await production(page, p.id)).items).toEqual([]);
  await createItem(page, "第 01 集 · 雨夜");
  await saveText(page, "TEST 第一集已保存梗概。");
  const episode = (await production(page, p.id)).items[0]!;
  const episodeNode = nav.locator(`[data-script-episode="${episode.id}"]`);
  await episodeNode
    .getByRole("button", { name: "添加分场", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "添加分场", exact: true });
  await expect(dialog.getByLabel("条目类型", { exact: true })).toHaveValue(
    "scene",
  );
  await expect(dialog.getByLabel("所属分集", { exact: true })).toHaveValue(
    episode.id,
  );
  await dialog.getByLabel("条目标题", { exact: true }).fill("1-1 车站外");
  await dialog.getByRole("button", { name: "创建条目", exact: true }).click();
  await expect(dialog).toBeHidden();
  const scene = (await production(page, p.id)).items.find(
    (value) => value.kind === "scene",
  )!;
  expect(currentScriptDraft(scene).parentId).toBe(episode.id);
  expect(currentScriptDraft(scene).dependencies).toContainEqual({
    itemId: episode.id,
    revision: episode.revision,
  });
  await editor(page).fill("TEST 未保存的分场正文。\n切换目录不丢稿。");
  const dirty = await editor(page).inputValue();
  const sceneRow = episodeNode.locator(".script-scene-list .script-tree-row");
  await expect(sceneRow).toHaveAttribute("aria-current", "true");
  await episodeNode
    .getByRole("button", { name: "分场目录", exact: true })
    .click();
  await expect(sceneRow).toBeHidden();
  await expect(editor(page)).toHaveValue(dirty);
  await page.keyboard.press("Enter");
  await expect(sceneRow).toBeVisible();
  await createItem(page, "第 02 集 · 回信");
  await createItem(page, "全剧主线", "outline");
  await createItem(page, "林舟", "character");
  await createItem(page, "小城时间线", "setting");
  await createItem(page, "TEST 调研笔记", "source");
  await expect(group("people").locator(".script-tree-row")).toHaveText([
    "林舟角色 · 草稿",
    "小城时间线设定 · 草稿",
  ]);
  await expect(group("outlines").locator(".script-tree-row")).toContainText(
    "全剧主线",
  );
  await sceneRow.click();
  await expect(editor(page)).toHaveValue(dirty);
  const persisted = await production(page, p.id);
  const people = group("people").getByRole("button", {
    name: "设定与角色",
    exact: true,
  });
  await people.click();
  await expect(people).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(editor(page)).toHaveValue(dirty);
  await expect(sceneRow).toHaveAttribute("aria-current", "true");
  await expect(people).toHaveAttribute("aria-expanded", "false");
  const overview = nav.getByRole("button", { name: "概览", exact: true });
  await overview.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    nav.getByRole("button", { name: "全剧大纲", exact: true }),
  ).toBeFocused();
  await overview.click();
  await expect(
    page.getByRole("heading", { name: "继续创作", exact: true }),
  ).toBeVisible();
  expect(await page.locator(".script-overview-details[open]").count()).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("script-writing-overview.png"),
  });
  await page.reload();
  await expect(overview).toHaveAttribute("aria-current", "true");
  await sceneRow.click();
  await expect(editor(page)).toHaveValue(dirty);
  await page.setViewportSize({ width: 780, height: 640 });
  const directoryToggle = button(page, "剧本目录开关");
  await expect(directoryToggle).toBeVisible();
  await expect(directoryToggle).toHaveAttribute("aria-expanded", "false");
  await expect(nav).toBeHidden();
  const fullMain = (await page.locator(".script-main").boundingBox())!;
  const layout = (await page.locator(".script-layout").boundingBox())!;
  expect(fullMain.width).toBeGreaterThanOrEqual(layout.width - 1);
  expect(fullMain.height).toBeGreaterThan(layout.height * 0.75);
  await directoryToggle.focus();
  await page.keyboard.press("Enter");
  await expect(sceneRow).toBeFocused();
  await expect(sceneRow).toBeInViewport();
  const geometry = await nav.evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
  await page.screenshot({
    path: testInfo.outputPath("script-writing-narrow-directory.png"),
  });
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(directoryToggle).toBeFocused();
  await expect(editor(page)).toHaveValue(dirty);
  await directoryToggle.click();
  await overview.click();
  await expect(nav).toBeHidden();
  await expect(directoryToggle).toContainText("概览");
  await directoryToggle.click();
  await sceneRow.click();
  await expect(nav).toBeHidden();
  await expect(directoryToggle).toContainText("1-1 车站外");
  await expect(editor(page)).toHaveValue(dirty);
  await page.reload();
  await expect(editor(page)).toHaveValue(dirty);
  await expect(directoryToggle).toHaveAttribute("aria-expanded", "false");
  await editor(page).focus();
  await page.screenshot({
    path: testInfo.outputPath("script-writing-narrow.png"),
  });
  const after = (await snapshot(page)).workspace;
  expect(after.inputs).toEqual(before.inputs);
  expect(after.conversations).toEqual(before.conversations);
  expect(after.scriptProductions.find((value) => value.id === p.id)).toEqual(
    persisted,
  );
  expect(
    currentScriptDraft(persisted.items.find((value) => value.id === scene.id)!)
      .text,
  ).toBe("");
});

test("真实空态创建、编辑草稿刷新与后台改版 CAS 不覆盖", async ({ page }) => {
  const p = await setup(page);
  await createItem(page, "第一集 雨夜");
  await saveText(page, "雨夜。林舟在车站等候。\n列车到站。");
  const before = await production(page, p.id);
  const item = before.items[0]!;
  await editor(page).fill("本机尚未提交的修改");
  await page.reload();
  await expect(editor(page)).toHaveValue("本机尚未提交的修改");
  await command(page, {
    action: "revise-item",
    productionId: p.id,
    itemId: item.id,
    expectedRevision: item.revision,
    draft: { ...currentScriptDraft(item), text: "另一位作者已经保存的新稿" },
  });
  await expect(page.locator(".script-editor .script-warning")).toContainText(
    "中心已有",
  );
  await expect(editor(page)).toHaveValue("本机尚未提交的修改");
  await button(page, "保存文稿").click();
  await expect(page.locator(".script-editor .script-error")).toBeVisible();
  expect(
    currentScriptDraft((await production(page, p.id)).items[0]!).text,
  ).toBe("另一位作者已经保存的新稿");
  await expect(editor(page)).toHaveValue("本机尚未提交的修改");
  await button(page, "保留旧草稿并载入最新稿").click();
  await expect(editor(page)).toHaveValue("另一位作者已经保存的新稿");
  await page.getByRole("tab", { name: "历史", exact: true }).click();
  await page
    .getByRole("combobox", { name: "查看版本", exact: true })
    .selectOption(String(item.revision));
  await button(page, "将此历史稿恢复为新版本").click();
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await expect(editor(page)).toHaveValue(currentScriptDraft(item).text);
  await page.reload();
  await expect(editor(page)).toHaveValue(currentScriptDraft(item).text);
});

test("构思新剧只切换意图：重复点击、附件、移除和刷新不改正文或发送", async ({
  page,
}) => {
  const p = await setup(page);
  const before = (await snapshot(page)).workspace;
  const input = page.getByLabel("AI 输入内容", { exact: true });
  const intent = page.locator(".composer-meta .composer-intent");
  for (let i = 0; i < 3; i++) {
    await button(page, "构思新剧").click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute(
      "placeholder",
      "描述新剧的想法、题材或创作要求…",
    );
    await expect(intent).toHaveCount(1);
    await expect(intent).toContainText("构思新剧");
    await expect(button(page, "保存输入")).toBeDisabled();
  }
  const scope = await page
    .locator(".composer-meta .context-chip")
    .textContent();
  const body =
    "TEST 我已经写下的想法。\n请保留我的换行和手动补充，不追加模板。";
  await input.fill(body);
  await page.getByLabel("消息附件文件").setInputFiles({
    name: "构思素材.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("TEST 合成附件，仅用于隔离回归"),
  });
  const attachment = page.getByLabel("消息附件", { exact: true });
  await expect(attachment).toContainText("构思素材.txt");
  for (let i = 0; i < 3; i++) {
    await button(page, "构思新剧").click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(body);
    await expect(intent).toHaveCount(1);
    await expect(attachment).toContainText("构思素材.txt");
    expect(
      await page.locator(".composer-meta .context-chip").textContent(),
    ).toBe(scope);
  }
  const prepared = (await snapshot(page)).workspace;
  expect(prepared.inputs).toEqual(before.inputs);
  expect(prepared.conversations).toEqual(before.conversations);
  expect(prepared.scriptProductions).toEqual(before.scriptProductions);
  expect(prepared.applicationInstances).toEqual(before.applicationInstances);
  await button(page, "移除输入意图").click();
  await expect(intent).toHaveCount(0);
  await expect(input).toHaveValue(body);
  await expect(input).toBeFocused();
  await expect(attachment).toContainText("构思素材.txt");
  await button(page, "构思新剧").click();
  await page.reload();
  await openInput(page);
  await expect(input).toHaveValue(body);
  await expect(intent).toContainText("构思新剧");
  await expect(attachment).toContainText("构思素材.txt");
  expect((await snapshot(page)).workspace.inputs).toEqual(before.inputs);
  await button(page, "保存输入").click();
  await expect
    .poll(async () => (await snapshot(page)).workspace.inputs.length)
    .toBe(before.inputs.length + 1);
  const saved = (await snapshot(page)).workspace;
  const recorded = saved.inputs.find(
    (i) => !before.inputs.some((old) => old.id === i.id),
  )!;
  expect(recorded.body).toBe(body);
  expect(recorded.intent).toBe("script");
  expect(recorded.projectId).toBe(p.projectId);
  expect(recorded.application?.id).toBe("morphz.script-studio");
  expect(recorded.scriptGeneration).toBeUndefined();
  expect(recorded.attachments).toHaveLength(1);
  expect(saved.conversations).toEqual(before.conversations);
  expect(saved.scriptProductions).toEqual(before.scriptProductions);
});

test("生成只准备输入、切换条目不改绑；人工保存固定版本，模拟候选审改锁稿导出真实 Word", async ({
  page,
}) => {
  test.setTimeout(90000);
  const p = await setup(page);
  await permitModel(page);
  await createItem(page, "第一集 车站");
  await saveText(page, "车站。林舟拿起信封。\n他决定返回故乡。");
  const first = (await production(page, p.id)).items[0]!;
  const before = (await snapshot(page)).workspace;
  await button(page, "生成候选").click();
  await page
    .getByRole("dialog", { name: "准备生成候选请求", exact: true })
    .getByRole("button", { name: "准备到输入框", exact: true })
    .click();
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "第一集 车站",
  );
  expect((await snapshot(page)).workspace.inputs).toEqual(before.inputs);
  expect((await snapshot(page)).workspace.conversations).toEqual(
    before.conversations,
  );
  const preparedText = await page.getByLabel("AI 输入内容").inputValue();
  await button(page, "构思新剧").click();
  await expect(page.locator(".workspace-notice")).toContainText(
    "输入中已有另一份请求",
  );
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(preparedText);
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "第一集 车站",
  );
  await expect(button(page, "移除输入意图")).toHaveCount(0);
  await createItem(page, "仅用来测试切换的大纲", "outline");
  await openInput(page);
  await expect(page.getByTestId("script-input-reference")).toContainText(
    `v${first.revision}`,
  );
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "第一集 车站",
  );
  expect((await snapshot(page)).workspace.inputs).toEqual(before.inputs);
  await button(page, "保存输入").click();
  await expect
    .poll(async () => (await snapshot(page)).workspace.inputs.length)
    .toBe(before.inputs.length + 1);
  const input = (await snapshot(page)).workspace.inputs.find(
    (i) => !before.inputs.some((old) => old.id === i.id),
  )!;
  expect(input.scriptGeneration).toMatchObject({
    productionId: p.id,
    targetId: first.id,
    baseRevision: first.revision,
  });
  expect(input.application?.id).toBe("morphz.script-studio");
  const generatedText =
    "车站。林舟拿起信封。\n雨水冲淡邮戳，他认出母亲的笔迹。\n他决定返回故乡。";
  await syntheticCandidate(
    page,
    await production(page, p.id),
    input.id,
    generatedText,
  );
  await page.reload();
  await page
    .getByRole("navigation", { name: "剧本目录", exact: true })
    .getByRole("button", { name: /第一集 车站/ })
    .click();
  await page.getByRole("tab", { name: /候选 1/ }).click();
  await expect(page.locator(".script-diff")).toContainText("他认出母亲的笔迹");
  await expect(page.getByRole("tabpanel", { name: /^候选/ })).toContainText(
    "非真实模型生成",
  );
  await button(page, "采纳为新版本").click();
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await expect(editor(page)).toHaveValue(generatedText);
  await page.getByRole("tab", { name: /审阅 0/ }).click();
  await page.getByLabel("审阅引用", { exact: true }).fill("他决定返回故乡");
  await page.getByLabel("审阅意见", { exact: true }).fill("核对返乡的动机");
  await button(page, "添加意见").click();
  await expect(page.locator(".script-review")).toContainText("核对返乡的动机");
  await button(page, "记录解决方式").click();
  const resolve = page.getByRole("dialog", {
    name: "解决审阅意见",
    exact: true,
  });
  await resolve
    .getByLabel("决定说明", { exact: true })
    .fill("由信封和母亲笔迹建立动机。");
  await resolve.getByRole("button", { name: "确认", exact: true }).click();
  await expect(resolve).not.toBeVisible();
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await approveAndLock(page);
  await expect(button(page, "生成候选")).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await button(page, "导出 Word").click();
  await page
    .getByRole("dialog", { name: "导出 Word", exact: true })
    .getByRole("button", { name: "导出所选", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  expect(await download.failure()).toBeNull();
  const bytes = readFileSync((await download.path())!);
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  // The pure exporter uses stored ZIP entries, so these are the actual XML bytes.
  expect(bytes.toString("utf8")).toContain("word/document.xml");
  expect(bytes.toString("utf8")).toContain(
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  );
  expect(bytes.toString("utf8")).toContain("他认出母亲的笔迹");
  const exported = await production(page, p.id);
  expect(exported.exports.at(-1)?.items).toEqual([
    { itemId: first.id, revision: first.revision + 1 },
  ]);
  await button(page, "说明原因并解锁").click();
  const unlock = page.getByRole("dialog", {
    name: "说明原因并解锁",
    exact: true,
  });
  await expect(
    unlock.getByRole("button", { name: "确认", exact: true }),
  ).toBeDisabled();
  await unlock
    .getByLabel("决定说明", { exact: true })
    .fill("TEST 制片返修，保留原锁稿历史。");
  await unlock.getByRole("button", { name: "确认", exact: true }).click();
  await expect(unlock).not.toBeVisible();
  await expect(
    page.locator(".script-editor [data-script-focus-anchor]"),
  ).toBeFocused();
  await expect(editor(page)).not.toHaveAttribute("readonly", "");
});

test("分场目录及父集依赖持久化、窄窗模态键盘与焦点", async ({ page }) => {
  const p = await setup(page);
  await createItem(page, "第一集", "episode");
  await saveText(page, "分集梗概。");
  const episode = (await production(page, p.id)).items[0]!;
  await createItem(page, "1-1 车站外", "scene", episode.id);
  await saveText(page, "外景。夜。林舟走出车站。");
  const scene = (await production(page, p.id)).items.find(
    (i) => i.kind === "scene",
  )!;
  expect(currentScriptDraft(scene).parentId).toBe(episode.id);
  expect(currentScriptDraft(scene).dependencies).toContainEqual({
    itemId: episode.id,
    revision: episode.revision,
  });
  await page.reload();
  await expect(editor(page)).toHaveValue("外景。夜。林舟走出车站。");
  await page.setViewportSize({ width: 780, height: 640 });
  await button(page, "剧本设置").click();
  const dialog = page.getByRole("dialog", {
    name: "剧本设置",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(780);
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(button(page, "剧本设置")).toBeFocused();
  await expect(
    page.getByRole("region", { name: "剧本工作区", exact: true }),
  ).toBeVisible();
});

test("迟到历史意见不计当前阻断，缺少新字段的旧意见仍待处理", async ({
  page,
}) => {
  const p = await setup(page);
  await createItem(page, "第一集 · 意见版本边界");
  await saveText(page, "站台。林舟停下脚步。");
  const first = (await production(page, p.id)).items[0]!;
  await command(page, {
    action: "add-review",
    productionId: p.id,
    itemId: first.id,
    itemRevision: first.revision,
    quote: "林舟停下脚步",
    body: "TEST 已生效的当前阻断",
    severity: "blocking",
  });
  await saveText(page, "站台。林舟停下脚步。\n他认出母亲留下的信封。");
  await command(page, {
    action: "add-review",
    productionId: p.id,
    itemId: first.id,
    itemRevision: first.revision,
    quote: "林舟停下脚步",
    body: "TEST 迟到的历史阻断",
    severity: "blocking",
  });
  const current = await production(page, p.id);
  const activeReview = current.reviews.find(
    (r) => r.body === "TEST 已生效的当前阻断",
  )!;
  expect(activeReview.historicalOnly).toBe(false);
  expect(
    current.reviews.find((r) => r.body === "TEST 迟到的历史阻断")!
      .historicalOnly,
  ).toBe(true);
  // Response-only compatibility fixture: legacy stored reviews predate these
  // optional fields. It must not infer history merely from an old item revision.
  // No production database or Runtime is used or changed by this simulation.
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const boot: Boot = await response.json();
    const legacy = boot.workspace.scriptProductions
      .find((v) => v.id === p.id)!
      .reviews.find((r) => r.id === activeReview.id)!;
    delete legacy.historicalOnly;
    delete legacy.contextRevision;
    await route.fulfill({ response, json: boot });
  });
  await page.reload();
  await page.getByRole("tab", { name: "审阅 1", exact: true }).click();
  const historical = page
    .locator(".script-review")
    .filter({ hasText: "TEST 迟到的历史阻断" });
  await expect(historical).toContainText("历史意见，不阻断当前稿");
  await expect(historical).not.toContainText("当前阻断意见");
  const active = page
    .locator(".script-review")
    .filter({ hasText: "TEST 已生效的当前阻断" });
  await expect(active).toContainText("当前阻断意见");
  await expect(active).not.toContainText("历史意见，不阻断当前稿");
  await page.getByRole("tab", { name: "检查与影响", exact: true }).click();
  const checks = page.getByRole("tabpanel", {
    name: "检查与影响",
    exact: true,
  });
  await expect(checks).toContainText("TEST 已生效的当前阻断");
  await expect(checks).not.toContainText("TEST 迟到的历史阻断");
});

async function assertStudioDialog(dialog: Locator) {
  await assertDialogControlMetrics(dialog);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/create-dialog/);
  await expect(dialog).toHaveCSS("border-top-width", "1px");
  await expect(dialog).toHaveCSS("border-top-style", "solid");
  await expect(dialog).toHaveCSS("border-top-left-radius", "14px");
  await expect(dialog.locator("header h2")).toHaveCSS("font-size", "14px");
  // Wait for the host's modal entrance animation, not an arbitrary sleep.
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const geometry = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector("header")!.getBoundingClientRect();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      headerHeight: header.height,
      headerGap: parseFloat(
        getComputedStyle(element.querySelector("header")!).marginBottom,
      ),
      background: getComputedStyle(element).backgroundColor,
      footerBackground: getComputedStyle(element.querySelector("form footer")!)
        .backgroundColor,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(geometry.headerHeight).toBeLessThanOrEqual(32);
  expect(geometry.headerGap).toBeLessThanOrEqual(4);
  expect(geometry.footerBackground).toBe(geometry.background);
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.y).toBeGreaterThanOrEqual(0);
  expect(geometry.x + geometry.width).toBeLessThanOrEqual(
    geometry.viewportWidth + 1,
  );
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(
    geometry.viewportHeight + 1,
  );
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  return geometry;
}

async function assertDialogFocusRing(control: Locator) {
  await expect(control).toBeFocused();
  const ring = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    const width = parseFloat(style.outlineWidth);
    const outset = Math.max(0, width + parseFloat(style.outlineOffset));
    const bounds = element.getBoundingClientRect();
    const clearance: { edge: string; space: number }[] = [
      { edge: "viewport left", space: bounds.left },
      { edge: "viewport right", space: innerWidth - bounds.right },
      { edge: "viewport top", space: bounds.top },
      { edge: "viewport bottom", space: innerHeight - bounds.bottom },
    ];
    // Element bounds alone miss an outline clipped by the form's scrollport.
    // Stop at the top-layer dialog: the app's ancestors do not clip it.
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const css = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      const left = rect.left + parent.clientLeft;
      const top = rect.top + parent.clientTop;
      if (css.overflowX !== "visible") {
        clearance.push(
          { edge: `${parent.tagName} left`, space: bounds.left - left },
          {
            edge: `${parent.tagName} right`,
            space: left + parent.clientWidth - bounds.right,
          },
        );
      }
      if (css.overflowY !== "visible") {
        clearance.push(
          { edge: `${parent.tagName} top`, space: bounds.top - top },
          {
            edge: `${parent.tagName} bottom`,
            space: top + parent.clientHeight - bounds.bottom,
          },
        );
      }
      if (parent instanceof HTMLDialogElement) break;
    }
    return { width, style: style.outlineStyle, outset, clearance };
  });
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.style).not.toBe("none");
  for (const { edge, space } of ring.clearance)
    expect(space, `focus ring clearance: ${edge}`).toBeGreaterThanOrEqual(
      ring.outset - 0.5,
    );
}

test("剧本共用弹窗：紧凑几何、长错误保留、窄窗与键盘操作", async ({
  page,
}, testInfo) => {
  await setup(page);
  const before = (await snapshot(page)).workspace.scriptProductions.length;
  const trigger = button(page, "手动新建剧本");
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "手动新建剧本",
    exact: true,
  });
  const name = dialog.getByLabel("剧本名称", { exact: true });
  await expect(name).toBeFocused();
  const geometry = await assertStudioDialog(dialog);
  await assertSingleFieldDialog(dialog);
  await expect(name).toHaveAttribute("placeholder", "剧本名称");
  await dialog.screenshot({
    path: testInfo.outputPath("script-create-compact.png"),
  });
  await assertDialogFocusRing(name);
  expect(geometry.width).toBe(420);
  expect(geometry.height).toBeLessThanOrEqual(96);
  const submit = dialog.getByRole("button", { name: "创建", exact: true });
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  await expect(submit).toHaveClass(/primary/);
  await expect(cancel).toHaveClass(/secondary-action/);
  await expect(submit).toBeDisabled();
  const title = "TEST 弹窗键盘创建 " + randomUUID().slice(0, 8);
  await name.fill(title);
  const failure =
    "TEST 合成保存失败，输入保留：" + "LongUnbrokenDiagnostic".repeat(10);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.postData()?.includes('"create-production"')
    ) {
      await route.fulfill({ status: 503, json: { message: failure } });
    } else {
      await route.continue();
    }
  });
  await name.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(failure);
  await expect(name).toHaveValue(title);
  await expect(submit).toBeEnabled();
  for (const width of [760, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await assertStudioDialog(dialog);
    await assertSingleFieldDialog(dialog);
    await name.focus();
    await assertDialogFocusRing(name);
    await expect(submit).toBeInViewport();
    await expect(cancel).toBeInViewport();
  }
  await page.screenshot({
    path: testInfo.outputPath("script-dialog-narrow-error.png"),
  });
  await cancel.focus();
  await assertDialogFocusRing(cancel);
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect((await snapshot(page)).workspace.scriptProductions.length).toBe(
    before,
  );
  await page.unroute("**/api/**");
  await page.setViewportSize({ width: 1440, height: 960 });
  await trigger.click();
  await name.fill(title);
  await name.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
    title,
  );
  expect((await snapshot(page)).workspace.scriptProductions.length).toBe(
    before + 1,
  );
});

test("隔离内嵌 Electron：四主题明暗、真实 200% 缩放与编辑恢复", async ({}, testInfo) => {
  test.setTimeout(90000);
  const fixture = await mkdtemp(join(tmpdir(), "morphz-embedded-electron-"));
  // The existing embedded fixture refuses TCP listeners and opens only this new
  // directory. Do not inherit user Runtime, identity or speech configuration.
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
    args: ["tests/fixtures/embedded-desktop-entry.cjs"],
    env,
  });
  try {
    const page = await desktop.firstWindow();
    await expect(page.locator(".app")).toBeVisible();
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(1440, 960);
      window.webContents.setZoomFactor(1);
    });
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    await button(page, "应用启动台").click();
    await page
      .getByRole("region", { name: "应用", exact: true })
      .getByRole("button", { name: "剧本工作室 1.0.0" })
      .click();
    const studio = page.getByRole("region", {
      name: "剧本工作区",
      exact: true,
    });
    await expect(studio).toBeVisible();
    // The first-run library uses the same visible action and host composer.
    await expect(page.getByLabel("查找剧本", { exact: true })).toBeVisible();
    await button(page, "构思新剧").click();
    const input = page.getByLabel("AI 输入内容", { exact: true });
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(page.locator(".composer-meta .composer-intent")).toContainText(
      "构思新剧",
    );
    await button(page, "构思新剧").click();
    await expect(input).toHaveValue("");
    await expect(page.locator(".composer-meta .composer-intent")).toHaveCount(
      1,
    );
    await input.fill("TEST 原生构思草稿，不自动发送。");
    await button(page, "构思新剧").click();
    await expect(input).toHaveValue("TEST 原生构思草稿，不自动发送。");
    await page.reload();
    await openInput(page);
    await expect(input).toHaveValue("TEST 原生构思草稿，不自动发送。");
    await expect(page.locator(".composer-meta .composer-intent")).toContainText(
      "构思新剧",
    );
    await page.screenshot({
      path: testInfo.outputPath("script-conceive-native.png"),
    });
    await button(page, "移除输入意图").click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("TEST 原生构思草稿，不自动发送。");
    await input.fill("");
    await button(page, "手动新建剧本").click();
    const create = page.getByRole("dialog", {
      name: "手动新建剧本",
      exact: true,
    });
    await create
      .getByLabel("剧本名称", { exact: true })
      .fill("TEST Electron 编剧工作区");
    await create.getByRole("button", { name: "创建", exact: true }).click();
    await expect(create).toBeHidden();
    await createItem(page, "第一集 · 自动化合成素材");
    await saveText(
      page,
      "TEST 合成场景。雨停后，主角推开车站的大门。\n不是合作方资料。",
    );
    const savedText = await editor(page).inputValue();
    await createItem(page, "1-1 车站外 · 合成分场", "scene");
    await saveText(page, savedText);
    await createItem(page, "全剧主线 · 合成大纲", "outline");
    await createItem(page, "林舟 · 合成人物", "character");
    const directory = page.getByRole("navigation", {
      name: "剧本目录",
      exact: true,
    });
    const nativeScene = directory.getByRole("button", {
      name: /1-1 车站外 · 合成分场/,
    });
    await nativeScene.click();
    for (const [modeName, mode] of [
      ["亮色", "light"],
      ["暗色", "dark"],
    ] as const) {
      for (const [accentName, accent] of [
        ["电光青", "cyan"],
        ["鸢尾紫", "iris"],
        ["暖珊瑚", "coral"],
        ["纯单色", "mono"],
      ] as const) {
        await openInput(page);
        await button(page, "外观设置").click();
        const menu = page.getByRole("group", {
          name: "外观设置面板",
          exact: true,
        });
        await menu.getByRole("button", { name: modeName, exact: true }).click();
        await menu
          .getByRole("button", { name: accentName, exact: true })
          .click();
        await expect(page.locator(".app")).toHaveAttribute(
          "data-appearance",
          mode,
        );
        await expect(page.locator(".app")).toHaveAttribute(
          "data-accent",
          accent,
        );
        await editor(page).click();
        await expect(editor(page)).toHaveValue(savedText);
        const colors = await studio.evaluate((element) => {
          const css = getComputedStyle(element);
          return { color: css.color, background: css.backgroundColor };
        });
        expect(colors.color).not.toBe(colors.background);
        await expect(button(page, "剧本设置")).toBeInViewport();
        await button(page, "手动新建剧本").click();
        const compact = page.getByRole("dialog", {
          name: "手动新建剧本",
          exact: true,
        });
        const dialogGeometry = await assertStudioDialog(compact);
        await assertSingleFieldDialog(compact);
        expect(dialogGeometry.width).toBe(420);
        expect(dialogGeometry.height).toBeLessThanOrEqual(96);
        await expect(
          compact.getByLabel("剧本名称", { exact: true }),
        ).toBeFocused();
        await assertDialogFocusRing(
          compact.getByLabel("剧本名称", { exact: true }),
        );
        if (accent === "mono") {
          await page.screenshot({
            path: testInfo.outputPath(`script-studio-dialog-${mode}.png`),
          });
        }
        await page.keyboard.press("Escape");
        await expect(compact).toBeHidden();
        await expect(button(page, "手动新建剧本")).toBeFocused();
        await button(page, "全部剧本").click();
        const scriptCard = button(page, "打开剧本：TEST Electron 编剧工作区");
        await expect(scriptCard).toBeVisible();
        await expect(scriptCard).toBeFocused();
        await expect(scriptCard).toContainText("1 集 · 1 场");
        await assertLibraryControls(page);
        if (accent === "mono")
          await page.screenshot({
            path: testInfo.outputPath(`script-library-${mode}.png`),
          });
        await scriptCard.press("Enter");
        await expect(editor(page)).toHaveValue(savedText);
      }
      await page.screenshot({
        path: testInfo.outputPath(`script-studio-${mode}.png`),
      });
      await directory
        .getByRole("button", { name: "概览", exact: true })
        .click();
      await expect(directory.locator('[aria-current="true"]')).toHaveText(
        "概览",
      );
      await expect(
        page.getByRole("heading", { name: "继续创作", exact: true }),
      ).toBeVisible();
      await expect(nativeScene).not.toHaveAttribute("aria-current", "true");
      // Exact visual-state assertions: only the current row has a selection edge.
      await expect(directory.locator(".script-overview-link")).not.toHaveCSS(
        "box-shadow",
        "none",
      );
      await expect(nativeScene).toHaveCSS("box-shadow", "none");
      await expect(nativeScene).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      // Let Electron paint the selection as well as the newly mounted main pane.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.screenshot({
        path: testInfo.outputPath(`script-writing-overview-${mode}.png`),
      });
      await nativeScene.click();
      await expect(editor(page)).toHaveValue(savedText);
    }
    const widthBefore = await page.evaluate(() => window.innerWidth);
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeLessThan(widthBefore * 0.6);
    // Returning from overview remounts the editor: the save toast is transient,
    // but the persisted revision, exact text and clean state must all survive.
    await expect(page.locator(".script-edit-status")).toHaveText("草稿 · v2");
    await expect(editor(page)).toHaveValue(savedText);
    await expect(button(page, "保存文稿")).toBeDisabled();
    await expect(page.locator(".workspace-notice")).toHaveCount(0);
    await expect(button(page, "剧本设置")).toBeInViewport();
    await button(page, "剧本设置").click();
    const settings = page.getByRole("dialog", {
      name: "剧本设置",
      exact: true,
    });
    await expect(settings).toBeVisible();
    const bounds = (await settings.boundingBox())!;
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    await settings.getByRole("button", { name: "取消", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(
      settings.getByRole("button", { name: "关闭", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(button(page, "剧本设置")).toBeFocused();
    await button(page, "手动新建剧本").click();
    const zoomDialog = page.getByRole("dialog", {
      name: "手动新建剧本",
      exact: true,
    });
    await assertStudioDialog(zoomDialog);
    await assertSingleFieldDialog(zoomDialog);
    await assertDialogFocusRing(
      zoomDialog.getByLabel("剧本名称", { exact: true }),
    );
    await expect(
      zoomDialog.getByRole("button", { name: "取消", exact: true }),
    ).toBeInViewport();
    const dialogCapture = await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      return (await window.webContents.capturePage())
        .toPNG()
        .toString("base64");
    });
    await writeFile(
      testInfo.outputPath("script-studio-dialog-200-percent-native.png"),
      Buffer.from(dialogCapture, "base64"),
    );
    await page.keyboard.press("Escape");
    await expect(zoomDialog).toBeHidden();
    await expect(button(page, "手动新建剧本")).toBeFocused();
    await button(page, "全部剧本").click();
    const zoomCard = button(page, "打开剧本：TEST Electron 编剧工作区");
    await expect(zoomCard).toBeInViewport();
    const listGeometry = await page
      .locator(".script-library")
      .evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    expect(listGeometry.scrollWidth).toBeLessThanOrEqual(
      listGeometry.width + 1,
    );
    await assertLibraryControls(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const libraryCapture = await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      return (await window.webContents.capturePage())
        .toPNG()
        .toString("base64");
    });
    await writeFile(
      testInfo.outputPath("script-library-200-percent-native.png"),
      Buffer.from(libraryCapture, "base64"),
    );
    await zoomCard.click();
    await expect(editor(page)).toHaveValue(savedText);
    const compactDirectory = button(page, "剧本目录开关");
    await expect(compactDirectory).toBeVisible();
    await expect(directory).toBeHidden();
    await expect(compactDirectory).toHaveAttribute("aria-expanded", "false");
    await compactDirectory.focus();
    await page.keyboard.press("Enter");
    await expect(nativeScene).toBeFocused();
    await expect(nativeScene).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(directory).toBeHidden();
    await expect(compactDirectory).toBeFocused();
    await editor(page).fill(savedText + "\nTEST 200% 下保留未提交文字。");
    const dirtyText = await editor(page).inputValue();
    await expect(editor(page)).toBeFocused();
    await expect(compactDirectory).toHaveAttribute("aria-expanded", "false");
    await expect(directory).toBeHidden();
    // DOM assertions can settle before Electron publishes the next compositor
    // frame. Native capturePage otherwise may return the preceding open tree.
    // Wait for paint without changing zoom, scrolling, data or navigation.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const captureState = await studio.evaluate((element) => {
      const main = element
        .querySelector(".script-main")!
        .getBoundingClientRect();
      const text = element.querySelector<HTMLTextAreaElement>(".script-text")!;
      const rect = text.getBoundingClientRect();
      return {
        directoryExpanded: element
          .querySelector(".script-directory-toggle")!
          .getAttribute("aria-expanded"),
        directoryHeight: element
          .querySelector(".script-directory")!
          .getBoundingClientRect().height,
        focusedText: document.activeElement === text,
        visibleTextHeight: Math.max(
          0,
          Math.min(rect.bottom, main.bottom, innerHeight) -
            Math.max(rect.top, main.top, 0),
        ),
        text: text.value,
      };
    });
    expect(captureState.directoryExpanded).toBe("false");
    expect(captureState.directoryHeight).toBeLessThanOrEqual(40);
    expect(captureState.focusedText).toBe(true);
    expect(captureState.visibleTextHeight).toBeGreaterThan(60);
    expect(captureState.text).toBe(dirtyText);
    // Playwright's page capture can crop Electron at non-default native zoom.
    // Capture the full webContents surface without changing the zoom or data.
    const nativeCapture = await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const image = await window.webContents.capturePage();
      return {
        png: image.toPNG().toString("base64"),
        size: image.getSize(),
        content: window.getContentBounds(),
        zoom: window.webContents.getZoomFactor(),
      };
    });
    await writeFile(
      testInfo.outputPath("script-studio-200-percent-native.png"),
      Buffer.from(nativeCapture.png, "base64"),
    );
    const geometry = await studio.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const main = element.querySelector(".script-main")!;
      const mainRect = main.getBoundingClientRect();
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        studio: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        main: { x: mainRect.x, width: mainRect.width, height: mainRect.height },
        layoutHeight: element
          .querySelector(".script-layout")!
          .getBoundingClientRect().height,
        directoryHeight: element
          .querySelector(".script-directory")!
          .getBoundingClientRect().height,
        documentWidth: document.documentElement.scrollWidth,
        mainWidth: main.clientWidth,
        mainScrollWidth: main.scrollWidth,
      };
    });
    const geometryEvidence = JSON.stringify(
      {
        ...geometry,
        captureState,
        native: { ...nativeCapture, png: undefined },
      },
      null,
      2,
    );
    await writeFile(
      testInfo.outputPath("script-studio-native-geometry.json"),
      geometryEvidence,
    );
    await testInfo.attach("script-studio-native-geometry", {
      body: geometryEvidence,
      contentType: "application/json",
    });
    expect(nativeCapture.zoom).toBe(2);
    expect(nativeCapture.size.width).toBeGreaterThanOrEqual(
      nativeCapture.content.width,
    );
    expect(nativeCapture.size.height).toBeGreaterThanOrEqual(
      nativeCapture.content.height,
    );
    expect(geometry.studio.x).toBeGreaterThanOrEqual(0);
    expect(geometry.studio.x + geometry.studio.width).toBeLessThanOrEqual(
      geometry.viewport.width + 1,
    );
    expect(geometry.studio.y + geometry.studio.height).toBeLessThanOrEqual(
      geometry.viewport.height + 1,
    );
    expect(geometry.main.height).toBeGreaterThan(120);
    expect(geometry.main.height).toBeGreaterThan(geometry.layoutHeight * 0.7);
    expect(geometry.directoryHeight).toBeLessThanOrEqual(40);
    expect(geometry.documentWidth).toBeLessThanOrEqual(
      geometry.viewport.width + 1,
    );
    expect(geometry.mainScrollWidth).toBeLessThanOrEqual(
      geometry.mainWidth + 1,
    );
    await page.reload();
    await expect(editor(page)).toHaveValue(dirtyText);
    await button(page, "保存文稿").click();
    await expect(button(page, "保存文稿")).toBeDisabled();
    await page.reload();
    await expect(editor(page)).toHaveValue(dirtyText);
    // Native mouse clicks disable the submit control during a command. A
    // rejected approval must restore focus inside the still-open dialog.
    await page.getByRole("tab", { name: /^审阅/ }).click();
    await page
      .getByLabel("审阅意见", { exact: true })
      .fill("TEST 原生阻断意见");
    await page.getByLabel("意见级别", { exact: true }).selectOption("blocking");
    await button(page, "添加意见").click();
    // Collapse the input, if open, before using a bottom-edge page action.
    // The entry's transparent margins must not intercept the native click.
    const collapse = button(page, "收起 AI 输入框");
    if (await collapse.isVisible()) await collapse.click();
    await button(page, "提交审阅").click();
    await button(page, "批准此版本").click();
    const approval = page.getByRole("dialog", {
      name: "批准此版本",
      exact: true,
    });
    await approval.getByRole("button", { name: "确认", exact: true }).click();
    await expect(approval.getByRole("alert")).toContainText("阻断");
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(
      approval.getByRole("button", { name: "确认", exact: true }),
    ).toBeFocused();
    await approval.getByRole("button", { name: "取消", exact: true }).click();
    await expect(button(page, "批准此版本")).toBeFocused();
    // No generation input is submitted. These are isolated automated images,
    // not acceptance of the user's current Desktop window or OS hit-testing.
  } finally {
    await desktop.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
