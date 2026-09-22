import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { openInput } from "./interaction-helpers.js";

test("对话交付直接打开原剧本和分集；返回、刷新、同名对象和旧版不串线", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/workspace")).json();
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  );
  if (!isAbsolute(directory) || !basename(directory).startsWith("morphz-e2e-"))
    throw new Error("fixture center only");
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  expect(store.identity()).toBe(boot.centerId);
  const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
  const execute = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  const projectId = store
    .snapshot()
    .projects.find((p) => p.kind === "desk")!.id;
  const inputId = execute({
    type: "record-input",
    projectId,
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "TEST 请在剧本工作室创建废火和第一集",
    targetActantId: agent.actantId,
  });
  store.saveRuntimeState({ deliveries: [{ inputId, state: "running" }] });
  const run = (
    command: Extract<Operation, { type: "script-command" }>["command"],
  ) =>
    store.execute(
      {
        commandId: randomUUID(),
        operation: { type: "script-command", command },
      },
      agent,
      inputId,
    ).entityId;
  const productionId = run({
    action: "create-production",
    projectId,
    title: "TEST 废火入口",
  });
  const itemId = run({
    action: "create-item",
    productionId,
    kind: "episode",
    draft: emptyScriptDraft("第一集：废火破金甲"),
  });
  // Same title is not authority; a different workspace/production must not win.
  execute({
    type: "script-command",
    command: {
      action: "create-production",
      projectId: "first-project",
      title: "TEST 废火入口",
    },
  });
  store.saveRuntimeState(null);
  store.close();
  await page.goto("/");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const input = page.getByLabel("AI 输入内容");
  await input.fill("TEST 返回后保留的对话草稿");
  const delivery = page.locator(".delivery-message");
  await expect(
    delivery.filter({ hasText: "第一集：废火破金甲" }),
  ).toContainText("空白条目");
  await page
    .getByRole("button", { name: "打开剧本：TEST 废火入口", exact: true })
    .click();
  await expect(page.locator(".script-studio")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回上一位置" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "返回上一位置" }).click();
  await expect(input).toHaveValue("TEST 返回后保留的对话草稿");
  const link = page.getByRole("button", {
    name: "打开剧本结果：第一集：废火破金甲",
    exact: true,
  });
  await link.click();
  const editor = page.getByLabel("剧本正文", { exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("");
  await editor.fill("TEST 尚未保存的正文");
  await page.reload();
  // Opening a delivered version never replaces a newer unsaved draft.
  await expect(
    page.getByRole("tab", { name: "历史", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await expect(editor).toHaveValue("TEST 尚未保存的正文");
  await page.getByRole("button", { name: "全部剧本", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "剧本列表", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(input).toHaveValue("TEST 返回后保留的对话草稿");
  const reopened = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    expect(
      reopened.snapshot().inputs.filter((i) => i.id === inputId),
    ).toHaveLength(1);
    expect(
      reopened
        .snapshot()
        .scriptProductions.find((p) => p.id === productionId)!
        .items.find((i) => i.id === itemId)!.revision,
    ).toBe(1);
    reopened.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "script-command",
          command: {
            action: "revise-item",
            productionId,
            itemId,
            expectedRevision: 1,
            draft: {
              ...emptyScriptDraft("第一集：正式新版本"),
              text: "TEST 保存到 v2",
            },
          },
        },
      },
      localAccess,
    );
  } finally {
    reopened.close();
  }
  await page.reload();
  await link.click();
  await expect(
    page.getByRole("tab", { name: "历史", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("combobox", { name: "查看版本", exact: true }),
  ).toHaveValue("1");
  await expect(page.locator(".script-history pre")).toHaveText("");
  await page.screenshot({ path: "test-results/script-delivery-version.png" });
  await openInput(page);
  await expect(page.getByLabel("AI 输入内容")).toBeVisible();
});
