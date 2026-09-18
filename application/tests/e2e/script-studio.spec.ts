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
}
async function saveText(page: Page, text: string) {
  await editor(page).fill(text);
  await button(page, "保存文稿").click();
  await expect(button(page, "保存文稿")).toBeDisabled();
  await expect(editor(page)).toHaveValue(text);
  await expect(page.locator(".script-edit-status")).toContainText("已保存 v");
  await expect(page.locator(".workspace-notice")).toHaveCount(0);
}
async function permitModel(page: Page) {
  await button(page, "项目规范与交付模板").click();
  const dialog = page.getByRole("dialog", {
    name: "项目规范与交付模板",
    exact: true,
  });
  await dialog
    .getByLabel("资料权利与使用范围", { exact: true })
    .fill("TEST 合成原创资料，仅用于隔离自动化验证，不是合作方授权。");
  await dialog
    .getByLabel("我确认本项目所选资料允许交给当前模型服务处理", { exact: true })
    .check();
  await dialog.getByRole("button", { name: "保存规范", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function approveAndLock(page: Page) {
  await button(page, "提交审阅").click();
  await expect(button(page, "批准此版本")).toBeEnabled();
  await button(page, "批准此版本").click();
  const dialog = page.getByRole("dialog", { name: "批准此版本", exact: true });
  await dialog
    .getByLabel("决定说明", { exact: true })
    .fill("TEST 人工审阅路径。");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(button(page, "锁稿")).toBeEnabled();
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
  await expect(
    page.getByRole("tabpanel", { name: "候选", exact: true }),
  ).toContainText("非真实模型生成");
  await button(page, "采纳为新版本").click();
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
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await approveAndLock(page);
  await expect(button(page, "生成候选")).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await button(page, "导出 Word").click();
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
  await button(page, "项目规范与交付模板").click();
  const dialog = page.getByRole("dialog", {
    name: "项目规范与交付模板",
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
  await expect(button(page, "项目规范与交付模板")).toBeFocused();
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
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(geometry.headerHeight).toBeLessThanOrEqual(40);
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
  expect(geometry.width).toBe(420);
  expect(geometry.height).toBeLessThanOrEqual(230);
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
    await expect(submit).toBeInViewport();
    await expect(cancel).toBeInViewport();
  }
  await page.screenshot({
    path: testInfo.outputPath("script-dialog-narrow-error.png"),
  });
  await cancel.focus();
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
    // Both first-run and toolbar shortcuts use the host composer, never template text.
    await button(page, "向 Morphz 描述想法").click();
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
        await expect(button(page, "项目规范与交付模板")).toBeInViewport();
        await button(page, "手动新建剧本").click();
        const compact = page.getByRole("dialog", {
          name: "手动新建剧本",
          exact: true,
        });
        const dialogGeometry = await assertStudioDialog(compact);
        expect(dialogGeometry.width).toBe(420);
        expect(dialogGeometry.height).toBeLessThanOrEqual(230);
        await expect(
          compact.getByLabel("剧本名称", { exact: true }),
        ).toBeFocused();
        if (accent === "mono") {
          await page.screenshot({
            path: testInfo.outputPath(`script-studio-dialog-${mode}.png`),
          });
        }
        await page.keyboard.press("Escape");
        await expect(compact).toBeHidden();
        await expect(button(page, "手动新建剧本")).toBeFocused();
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
    await expect(button(page, "项目规范与交付模板")).toBeInViewport();
    await button(page, "项目规范与交付模板").click();
    const settings = page.getByRole("dialog", {
      name: "项目规范与交付模板",
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
    await expect(button(page, "项目规范与交付模板")).toBeFocused();
    await button(page, "手动新建剧本").click();
    const zoomDialog = page.getByRole("dialog", {
      name: "手动新建剧本",
      exact: true,
    });
    await assertStudioDialog(zoomDialog);
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
    // No generation input is submitted. These are isolated automated images,
    // not acceptance of the user's current Desktop window or OS hit-testing.
  } finally {
    await desktop.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
