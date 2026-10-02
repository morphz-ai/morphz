import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";
import {
  defaultAgentProfile,
  profileUpdateSchema,
  profilePreferenceContract,
  type ProfileUpdate,
} from "../packages/core/src/profile.js";
import { openInput } from "./interaction-helpers.js";
import { localAccess } from "../packages/core/src/model.js";

// These tests use real UI, HTTP typed operations, SQL Host and Rust Runtime.
// The provider is a labeled deterministic HTTP stub, not a real language model.
if (process.env.MORPHZ_TEST_BROWSER_EXECUTABLE)
  test.use({
    launchOptions: {
      executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
    },
  });
test.setTimeout(120_000);
let fixture: Awaited<ReturnType<typeof profileActualTransportFixture>>;
test.beforeEach(async () => {
  fixture = await profileActualTransportFixture();
});
test.afterEach(async () => {
  await fixture?.close();
});
async function enter(page: Page) {
  await page.goto(fixture.origin);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
}
async function agentEditor(page: Page) {
  const panel = page.locator(".subject-sidebar");
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const editor = panel.getByRole("region", { name: "智能体资料", exact: true });
  await expect(
    editor.getByRole("checkbox", { name: "使用 Profile", exact: true }),
  ).toBeEnabled();
  return editor;
}
async function level(editor: Locator, label: string, value: number) {
  await editor
    .getByRole("checkbox", { name: `设置${label}`, exact: true })
    .check();
  const range = editor.getByRole("slider", {
    name: `${label}程度`,
    exact: true,
  });
  await range.press("Home");
  for (let index = 0; index < value; index++) await range.press("ArrowRight");
  await expect(range).toHaveValue(String(value));
}
async function save(editor: Locator, expectedEnabled = true) {
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator(".personality-save-state")).toHaveText(
    expectedEnabled ? "已保存" : "已保存 · 未启用",
  );
  await expect(
    editor.getByRole("checkbox", { name: "使用 Profile", exact: true }),
  ).toBeChecked({ checked: expectedEnabled });
  expect((await fixture.read()).agent.enabled).toBe(expectedEnabled);
}
async function send(page: Page, marker: string) {
  const since = fixture.requests.length;
  const input = await openInput(page);
  await input.fill(marker);
  await input.press("Enter");
  return fixture.waitRequest(marker, since);
}
function modelText(request: Awaited<ReturnType<typeof fixture.waitRequest>>) {
  // Tool schema intentionally still exposes Profile read/propose. Inspect only
  // model-visible messages, never confuse schema property names with ROM bytes.
  return request.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
}
function assertEmptyRom(text: string) {
  for (const marker of [
    "(agent-rom ",
    "(agent-profile ",
    "(human-profile ",
    "Installed agent-rom is caller-owned read-only configuration, not Mind memory.",
    profilePreferenceContract(defaultAgentProfile),
  ])
    expect(
      text.includes(marker),
      `No active ROM marker: ${marker.slice(0, 80)}`,
    ).toBe(false);
}
test("真实 UI 保存稀疏0/5、空值不默认注入；停用后新Thread零ROM，旧Thread继续固定旧版本", async ({
  page,
}, testInfo) => {
  const writes: ProfileUpdate[] = [];
  page.on("request", (request) => {
    if (
      request.url() === fixture.origin + "/api/profile" &&
      request.method() === "POST"
    )
      writes.push(profileUpdateSchema.parse(request.postDataJSON()));
  });
  await enter(page);
  const editor = await agentEditor(page);
  await expect(
    editor.getByRole("checkbox", { name: "使用 Profile", exact: true }),
  ).not.toBeChecked();
  await expect(editor.getByRole("slider")).toHaveCount(0);
  for (const label of ["幽默", "严谨", "亲和", "详略"])
    await expect(
      editor.getByRole("checkbox", { name: `设置${label}`, exact: true }),
    ).not.toBeChecked();
  expect((await fixture.read()).agent.data).toEqual(defaultAgentProfile);
  expect(fixture.sql("SELECT entry_id FROM agent_rom_heads")).toHaveLength(0);
  expect(fixture.sql("SELECT id FROM sessions")).toHaveLength(0);
  await editor.screenshot({
    path: testInfo.outputPath("actual-host-initial-unset.png"),
  });
  await testInfo.attach("actual-host-initial-unset", {
    path: testInfo.outputPath("actual-host-initial-unset.png"),
    contentType: "image/png",
  });
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_UNSET")));

  await level(editor, "幽默", 5);
  await level(editor, "严谨", 0);
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .check();
  await save(editor);
  const saved = await fixture.read();
  await editor.screenshot({
    path: testInfo.outputPath("actual-host-saved-humor5-rigor0.png"),
  });
  await testInfo.attach("actual-host-saved-humor5-rigor0", {
    path: testInfo.outputPath("actual-host-saved-humor5-rigor0.png"),
    contentType: "image/png",
  });
  expect(saved.agent).toMatchObject({
    enabled: true,
    revision: 1,
    data: {
      name: null,
      traits: { humor: 5, rigor: 0, warmth: null, verbosity: null },
      speechStyle: null,
      customStyle: null,
    },
  });
  const rom = await fixture.rom("agent");
  expect(rom.status).toBe(200);
  expect(rom.body.canonical_sexpr).toContain("(humor 5)");
  expect(rom.body.canonical_sexpr).toContain("(rigor 0)");
  for (const absent of [
    "(name ",
    "(warmth ",
    "(verbosity ",
    "(style ",
    "(custom ",
  ])
    expect(rom.body.canonical_sexpr).not.toContain(absent);
  fixture.hold("PROFILE_ACTUAL_CONFIGURED");
  const configured = modelText(await send(page, "PROFILE_ACTUAL_CONFIGURED"));
  for (const marker of [
    "(agent-rom ",
    "(agent-profile ",
    "(humor 5)",
    "(rigor 0)",
    "0–5 scale",
  ])
    expect(
      configured.includes(marker),
      `Configured real model request marker: ${marker}`,
    ).toBe(true);
  const bindings = fixture.sql<{
    thread_id: string;
    entry_id: string;
    revision: number;
  }>(
    "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
  );
  expect(bindings).toHaveLength(1);
  expect(bindings[0]!.revision).toBe(1);

  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .uncheck();
  await save(editor, false);
  expect((await fixture.read()).agent).toMatchObject({
    enabled: false,
    revision: 2,
    data: saved.agent.data,
  });
  const disabled = await fixture.rom("agent");
  expect(disabled.body).toMatchObject({ revision: 2, enabled: false });
  expect(disabled.body.canonical_sexpr).toContain("(humor 5)");
  expect(
    fixture.sql(
      "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
    ),
  ).toEqual(bindings);
  const continuationStart = fixture.requests.length;
  await fixture.continueHeld("PROFILE_ACTUAL_CONFIGURED");
  const continued = modelText(
    await fixture.waitRequest("PROFILE_ACTUAL_CONFIGURED", continuationStart),
  );
  expect(
    continued.includes("(humor 5)"),
    "Old Thread continuation keeps humor5",
  ).toBe(true);
  expect(
    continued.includes("(rigor 0)"),
    "Old Thread continuation keeps rigor0",
  ).toBe(true);
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_DISABLED")));
  await editor
    .getByRole("checkbox", { name: "设置幽默", exact: true })
    .uncheck();
  await editor
    .getByRole("checkbox", { name: "设置严谨", exact: true })
    .uncheck();
  await save(editor, false);
  expect((await fixture.read()).agent).toMatchObject({
    enabled: false,
    revision: 3,
    data: defaultAgentProfile,
  });
  expect((await fixture.rom("agent")).body.canonical_sexpr).toBe(
    "(agent-profile (version 2))",
  );
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_ALL_FIELDS_OFF")));
  expect(
    fixture.sql(
      "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
    ),
  ).toEqual(bindings);
  expect(fixture.sql("SELECT thread_id FROM thread_rom_mounts").length).toBe(4);
  expect(writes.map((write) => write.enabled)).toEqual([true, false, false]);
});

test("真实个人资料UI只保存选中称呼，ROM精确私有Principal；关闭后新Thread无HumanProfile", async ({
  page,
}, testInfo) => {
  await enter(page);
  await page
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("group", { name: "用户菜单", exact: true })
    .getByRole("button", { name: "个人资料", exact: true })
    .click();
  const editor = page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("region", { name: "个人资料", exact: true });
  await expect(
    editor.getByRole("checkbox", { name: "设置你的名字", exact: true }),
  ).not.toBeChecked();
  await editor.getByRole("checkbox", { name: "设置称呼", exact: true }).check();
  await editor
    .getByRole("textbox", { name: "Agent 对你的称呼", exact: true })
    .fill("测试同学");
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .check();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator(".personality-save-state")).toHaveText("已保存");
  const saved = await fixture.read();
  await editor.screenshot({
    path: testInfo.outputPath("actual-host-private-human-address.png"),
  });
  await testInfo.attach("actual-host-private-human-address", {
    path: testInfo.outputPath("actual-host-private-human-address.png"),
    contentType: "image/png",
  });
  expect(saved.human).toMatchObject({
    revision: 1,
    enabled: true,
    data: { name: null, preferredAddress: "测试同学" },
  });
  const identity = await fixture.runtime.profiles.identity(localAccess);
  const privateRom = await fixture.rom("human", identity.principalId);
  expect(privateRom.status).toBe(200);
  expect(privateRom.body.canonical_sexpr).toBe(
    "(human-profile (version 2) (preferred-address 测试同学))",
  );
  expect((await fixture.rom("human")).status).toBe(404);
  expect(
    fixture.sql<{ principal_scope: string; namespace: string }>(
      "SELECT principal_scope,namespace FROM agent_rom_heads",
    ),
  ).toEqual([
    {
      principal_scope: identity.principalId,
      namespace: "morphz.profile.human",
    },
  ]);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  const configured = modelText(
    await send(page, "PROFILE_ACTUAL_PRIVATE_HUMAN"),
  );
  expect(
    configured.includes(
      "(human-profile (version 2) (preferred-address 测试同学))",
    ) ||
      configured.includes(
        '(human-profile (version 2) (preferred-address "测试同学"))',
      ),
    "Selected Human address in actual private ROM slot",
  ).toBe(true);
  expect(configured.includes("(agent-profile ")).toBe(false);
  await page
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("group", { name: "用户菜单", exact: true })
    .getByRole("button", { name: "个人资料", exact: true })
    .click();
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .uncheck();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator(".personality-save-state")).toHaveText(
    "已保存 · 未启用",
  );
  expect((await fixture.read()).human).toMatchObject({
    revision: 2,
    enabled: false,
    data: { name: null, preferredAddress: "测试同学" },
  });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_HUMAN_DISABLED")));
});

test("真实Host提交后丢回执沿用command重试；真实Rust CAS冲突不覆盖用户草稿", async ({
  page,
}) => {
  await enter(page);
  const editor = await agentEditor(page);
  await level(editor, "幽默", 5);
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .check();
  const attempts: ProfileUpdate[] = [];
  let loseReceipt = true;
  await page.route(fixture.origin + "/api/profile", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(profileUpdateSchema.parse(route.request().postDataJSON()));
    // Fault injection only: forward the unmodified request to the actual Host,
    // wait for its real committed Rust receipt, then drop the response bytes.
    if (loseReceipt) {
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      loseReceipt = false;
      return route.abort("failed");
    }
    return route.continue();
  });
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
  await expect(editor.locator(".personality-save-state")).not.toHaveText(
    "已保存",
  );
  expect((await fixture.read()).agent.revision).toBe(1);
  await save(editor);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(
    fixture.sql("SELECT command_id FROM agent_rom_command_receipts"),
  ).toHaveLength(1);
  expect((await fixture.read()).agent.revision).toBe(1);

  await level(editor, "严谨", 0);
  await fixture.update({
    subject: "agent",
    commandId: randomUUID(),
    expectedRevision: 1,
    enabled: false,
    data: {
      ...defaultAgentProfile,
      traits: { ...defaultAgentProfile.traits, warmth: 5 },
    },
  });
  const conflict = page.waitForResponse(
    (response) =>
      response.url() === fixture.origin + "/api/profile" &&
      response.request().method() === "POST" &&
      response.status() === 409,
  );
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await conflict;
  await expect(
    editor.getByRole("slider", { name: "幽默程度", exact: true }),
  ).toHaveValue("5");
  await expect(
    editor.getByRole("slider", { name: "严谨程度", exact: true }),
  ).toHaveValue("0");
  expect((await fixture.read()).agent).toMatchObject({
    revision: 2,
    enabled: false,
    data: { traits: { humor: null, rigor: null, warmth: 5, verbosity: null } },
  });
  expect(
    fixture.sql("SELECT command_id FROM agent_rom_command_receipts"),
  ).toHaveLength(2);
});

test("实际UI空自定义风格和空称呼成功归一为null，不误报提交后变化且全空未启用", async ({
  page,
}) => {
  const writes: ProfileUpdate[] = [];
  page.on("request", (request) => {
    if (
      request.url() === fixture.origin + "/api/profile" &&
      request.method() === "POST"
    )
      writes.push(profileUpdateSchema.parse(request.postDataJSON()));
  });
  await enter(page);
  const agent = await agentEditor(page);
  await agent.locator(".personality-custom summary").click();
  await agent
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .check();
  await expect(
    agent.getByRole("textbox", { name: "自定义讲话风格", exact: true }),
  ).toHaveValue("");
  await agent
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .check();
  await save(agent, false);
  await expect(
    agent.getByRole("checkbox", { name: "设置自定义风格", exact: true }),
  ).not.toBeChecked();
  expect((await fixture.read()).agent).toMatchObject({
    revision: 1,
    enabled: false,
    data: defaultAgentProfile,
  });
  expect((await fixture.rom("agent")).body).toMatchObject({
    revision: 1,
    enabled: false,
    canonical_sexpr: "(agent-profile (version 2))",
  });

  await page
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("group", { name: "用户菜单", exact: true })
    .getByRole("button", { name: "个人资料", exact: true })
    .click();
  const human = page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("region", { name: "个人资料", exact: true });
  await human.getByRole("checkbox", { name: "设置称呼", exact: true }).check();
  await expect(
    human.getByRole("textbox", { name: "Agent 对你的称呼", exact: true }),
  ).toHaveValue("");
  await human
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .check();
  await human.getByRole("button", { name: "保存", exact: true }).click();
  await expect(human.locator(".personality-save-state")).toHaveText(
    "已保存 · 未启用",
  );
  await expect(
    human.getByRole("checkbox", { name: "使用 Profile", exact: true }),
  ).not.toBeChecked();
  await expect(
    human.getByRole("checkbox", { name: "设置称呼", exact: true }),
  ).not.toBeChecked();
  expect((await fixture.read()).human).toMatchObject({
    revision: 1,
    enabled: false,
    data: { name: null, preferredAddress: null },
  });
  await expect(
    page.getByText("资料已再次变化，请重新读取后确认。", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({
    subject: "agent",
    enabled: true,
    data: { customStyle: null },
  });
  expect(writes[1]).toMatchObject({
    subject: "human",
    enabled: true,
    data: { preferredAddress: null },
  });
  expect(fixture.sql("SELECT id FROM sessions")).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
});
