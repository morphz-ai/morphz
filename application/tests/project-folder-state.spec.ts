import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  conversationClient,
  conversationState,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

test("当前项目显示打开文件夹，展开列表和明暗／图标栏不改变项目、会话或草稿", async ({
  page,
  messageHost,
}) => {
  await page.goto("/");
  const source = await conversationClient(page);
  const suffix = randomUUID().slice(0, 8);
  const projectA = { id: randomUUID(), title: `TEST 文件夹 A ${suffix}` };
  const projectB = { id: randomUUID(), title: `TEST 文件夹 B ${suffix}` };
  await source.createProject(projectA.title, randomUUID(), projectA.id);
  await source.createProject(projectB.title, randomUUID(), projectB.id);
  const conversationId = randomUUID();
  const inputId = randomUUID();
  const conversationTitle = "TEST 文件夹命名会话";
  const seedBody = "TEST 已提交的项目 B 命名会话消息";
  await source.sendMessage({
    commandId: inputId,
    projectId: projectB.id,
    conversationId,
    newConversation: { title: conversationTitle },
    body: seedBody,
  });
  await page.reload();

  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  const projectEntry = nav.getByRole("button", { name: "项目", exact: true });
  const primaryGlyph = projectEntry.locator(
    'svg[data-navigation-icon="projects"]',
  );
  const primaryPath = await primaryGlyph.locator("path").getAttribute("d");
  const rowA = page.getByRole("group", {
    name: projectA.title + "的会话",
    exact: true,
  });
  const rowB = page.getByRole("group", {
    name: projectB.title + "的会话",
    exact: true,
  });
  const parentA = rowA.getByRole("button", {
    name: projectA.title,
    exact: true,
  });
  const parentB = rowB.getByRole("button", {
    name: projectB.title,
    exact: true,
  });
  const folderA = parentA.locator("svg[data-folder-state]");
  const folderB = parentB.locator("svg[data-folder-state]");
  const named = rowB.getByRole("button", {
    name: "打开对话：" + conversationTitle,
    exact: true,
  });
  const before = await conversationState(page);
  const deliveries = messageHost.deliveries();
  expect(
    before.conversations.find((c) => c.id === conversationId),
  ).toMatchObject({
    projectId: projectB.id,
    title: conversationTitle,
  });
  expect(messageHost.input(inputId)).toMatchObject({
    projectId: projectB.id,
    conversationId,
    body: seedBody,
  });

  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(folderA).toHaveAttribute("data-folder-state", "closed");
  await expect(folderB).toHaveAttribute("data-folder-state", "closed");
  await parentA.click();
  await expect(page).toHaveTitle(projectA.title + " — Morphz");
  await expect(folderA).toHaveAttribute("data-folder-state", "open");
  await expect(folderA).toHaveClass(/lucide-folder-open/);
  await expect(folderB).toHaveAttribute("data-folder-state", "closed");
  const draftA = "TEST 项目 A 默认草稿，不发送";
  await (await openInput(page)).fill(draftA);

  await parentB.click();
  await expect(folderA).toHaveAttribute("data-folder-state", "closed");
  await expect(folderB).toHaveAttribute("data-folder-state", "open");
  await rowB
    .getByRole("button", { name: "收起项目会话：" + projectB.title })
    .click();
  await expect(named).toHaveCount(0);
  await expect(folderB).toHaveAttribute("data-folder-state", "open");
  await parentA.click();
  await expect(await openInput(page)).toHaveValue(draftA);
  await rowB
    .getByRole("button", { name: "展开项目会话：" + projectB.title })
    .click();
  await expect(named).toBeVisible();
  await expect(rowA).toHaveAttribute("data-active", "true");
  await expect(folderA).toHaveAttribute("data-folder-state", "open");
  await expect(folderB).toHaveAttribute("data-folder-state", "closed");
  await expect(folderB).toHaveClass(/lucide-folder(?!-open)/);
  await expect(page).toHaveTitle(projectA.title + " — Morphz");
  await expect(await openInput(page)).toHaveValue(draftA);

  // A named conversation belongs to its active project even though the parent
  // default-conversation button is not the selected navigation entry.
  await named.click();
  await expect(named).toHaveAttribute("aria-current", "true");
  await expect(parentB).not.toHaveAttribute("aria-current", "true");
  await expect(folderA).toHaveAttribute("data-folder-state", "closed");
  await expect(folderB).toHaveAttribute("data-folder-state", "open");
  await expect(
    page.locator(`.human-message[data-input-id="${inputId}"]`),
  ).toContainText(seedBody);
  const namedDraft = "TEST 项目 B 命名会话草稿，不发送";
  await (await openInput(page)).fill(namedDraft);
  const handle = page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });
  for (const [label, appearance] of [
    ["亮色", "light"],
    ["暗色", "dark"],
  ] as const) {
    await handle.focus();
    await page.keyboard.press("End");
    const settings = await openSettings(page, "外观");
    await settings.getByRole("button", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".app")).toHaveAttribute(
      "data-appearance",
      appearance,
    );
    for (const folder of [folderA, folderB]) {
      await expect(folder).toHaveAttribute("aria-hidden", "true");
      await expect(folder).toHaveAttribute("focusable", "false");
      await expect(folder).toHaveAttribute("stroke", "currentColor");
      await expect(folder).toHaveAttribute("fill", "none");
      expect(
        await folder.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.stroke === style.color;
        }),
      ).toBe(true);
    }
    await expect(parentA).toHaveAccessibleName(projectA.title);
    await expect(parentB).toHaveAccessibleName(projectB.title);

    await handle.focus();
    await page.keyboard.press("Home");
    await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
    await expect(rowB).toBeHidden();
    await expect(
      page.locator(
        `.sidebar-project[data-project-id="${projectB.id}"] svg[data-folder-state]`,
      ),
    ).toHaveAttribute("data-folder-state", "open");
    await expect(primaryGlyph).not.toHaveAttribute("data-folder-state");
    await expect(primaryGlyph.locator("path")).toHaveAttribute(
      "d",
      primaryPath!,
    );
    await expect(page).toHaveTitle(projectB.title + " — Morphz");
    await expect(await openInput(page)).toHaveValue(namedDraft);
    await handle.focus();
    await page.keyboard.press("End");
    await expect(rowB).toBeVisible();
    await expect(named).toHaveAttribute("aria-current", "true");
    await expect(folderB).toHaveAttribute("data-folder-state", "open");
    await expect(await openInput(page)).toHaveValue(namedDraft);
  }

  await page.reload();
  await expect(named).toHaveAttribute("aria-current", "true");
  await expect(folderB).toHaveAttribute("data-folder-state", "open");
  await expect(await openInput(page)).toHaveValue(namedDraft);
  await parentA.click();
  await expect(folderA).toHaveAttribute("data-folder-state", "open");
  await expect(folderB).toHaveAttribute("data-folder-state", "closed");
  await expect(await openInput(page)).toHaveValue(draftA);
  const after = await conversationState(page);
  expect(after.conversations).toEqual(before.conversations);
  expect(messageHost.deliveries()).toEqual(deliveries);
  expect(messageHost.input(inputId)).toMatchObject({
    projectId: projectB.id,
    conversationId,
    body: seedBody,
  });
});
