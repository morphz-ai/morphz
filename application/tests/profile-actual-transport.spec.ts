import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";
import {
  defaultAgentProfile,
  profileUpdateSchema,
  profilePreferenceContract,
  normalizeAgentProfileData,
  normalizeHumanProfileData,
  profileHasConfiguredFields,
  parseProfileAuthoringState,
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
  const toggle = page.getByRole("button", { name: /^(显示|隐藏)右侧栏$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const editor = panel.getByRole("region", { name: "智能体资料", exact: true });
  await expect(
    editor.getByRole("button", { name: "编辑智能体名字", exact: true }),
  ).toBeEnabled();
  return editor;
}
async function editText(editor: Locator, action: string, label: string) {
  const input = editor.locator(`input[aria-label="${label}"]`);
  if (!(await input.isVisible()))
    await editor.getByRole("button", { name: action, exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  // Name/address editing stays in place; finishing or clearing is an input
  // boundary, never an extra action row or a second persistence operation.
  await expect(editor.locator(".personality-edit-actions")).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: /^(完成|不设置.*)$/ }),
  ).toHaveCount(0);
  return input;
}
async function preferences(editor: Locator) {
  const summary = editor.locator("summary").filter({ hasText: "个性与表达" });
  if (
    !(await summary.evaluate(
      (element) => (element.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
}
async function level(editor: Locator, label: string, value: number) {
  await preferences(editor);
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
async function settled(editor: Locator, expectedEnabled = true) {
  const subject =
    (await editor.getAttribute("aria-label")) === "智能体资料"
      ? "agent"
      : "human";
  // Match the current form to the real typed Host readback, so a previous
  // optimistic save label cannot satisfy the next automatic write.
  const intent = await editor.evaluate((element) => {
    const checked = (name: string) =>
      element.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)
        ?.checked === true;
    const text = (name: string) =>
      element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[aria-label="${name}"]`,
      )?.value ?? "";
    const configuredText = (name: string) =>
      element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[aria-label="${name}"]`,
      )?.dataset.configured === "true"
        ? text(name)
        : null;
    return element.getAttribute("aria-label") === "智能体资料"
      ? {
          name: configuredText("智能体的名字"),
          traits: Object.fromEntries(
            [
              ["humor", "幽默"],
              ["rigor", "严谨"],
              ["warmth", "亲和"],
              ["verbosity", "详略"],
            ].map(([key, label]) => [
              key,
              checked(`设置${label}`) ? Number(text(`${label}程度`)) : null,
            ]),
          ),
          speechStyle: null,
          customStyle: configuredText("自定义讲话风格"),
          customStyleEnabled: checked("设置自定义风格"),
        }
      : {
          name: configuredText("你的名字"),
          preferredAddress: configuredText("Agent 对你的称呼"),
        };
  });
  const data =
    subject === "agent"
      ? normalizeAgentProfileData(intent)
      : normalizeHumanProfileData(intent);
  const usageIntent =
    subject === "agent"
      ? await editor
          .getByRole("checkbox", { name: "使用人格设定", exact: true })
          .isChecked()
      : await editor
          .getByRole("checkbox", { name: "使用个人资料", exact: true })
          .isChecked();
  expect(usageIntent).toBe(expectedEnabled);
  if (subject === "human")
    expect(expectedEnabled && profileHasConfiguredFields(data)).toBe(
      expectedEnabled,
    );
  await editor.evaluate((element) => {
    if (element.contains(document.activeElement))
      (document.activeElement as HTMLElement | null)?.blur();
  });
  await expect
    .poll(async () => (await fixture.read())[subject].data)
    .toEqual(data);
  await expect
    .poll(async () => (await fixture.read())[subject].enabled)
    .toBe(usageIntent);
  await expect(editor.getByRole("alert")).toHaveCount(0);
  await expect(editor.locator(".personality-save-state")).toHaveText(
    "资料已保存",
  );
  if (subject === "agent") {
    await expect(editor).toHaveAttribute(
      "data-profile-use",
      String(expectedEnabled),
    );
    await expect(
      editor.locator(".personality-identity input[type=checkbox]"),
    ).toHaveCount(1);
    const usage = editor.getByRole("checkbox", {
      name: "使用人格设定",
      exact: true,
    });
    await expect(usage).toBeEnabled();
    await expect(usage).toBeChecked({ checked: expectedEnabled });
    await expect(editor.locator(".personality-usage")).toHaveCount(0);
    await expect(
      editor.getByRole("button", { name: /^(不使用人格设定|使用这些设定)$/ }),
    ).toHaveCount(0);
  } else {
    const usage = editor.getByRole("checkbox", {
      name: "使用个人资料",
      exact: true,
    });
    if (profileHasConfiguredFields(data))
      await expect(usage).toBeChecked({ checked: expectedEnabled });
    else {
      await expect(usage).not.toBeChecked();
      await expect(usage).toBeDisabled();
    }
  }
  await expect(
    editor.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  return (await fixture.read())[subject];
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
test("真实 UI 空资料总开关on/off/reload持久且零ROM；稀疏0/5、停用保留与旧Thread固定版本", async ({
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
  await expect(editor).toHaveAttribute("data-profile-use", "false");
  await expect(
    editor.locator(".personality-identity input[type=checkbox]"),
  ).toHaveCount(1);
  const usage = editor.getByRole("checkbox", {
    name: "使用人格设定",
    exact: true,
  });
  await expect(usage).toBeEnabled();
  await expect(usage).not.toBeChecked();
  await expect(editor.locator(".personality-usage")).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: /^(不使用人格设定|使用这些设定)$/ }),
  ).toHaveCount(0);
  await expect(editor.getByRole("slider")).toHaveCount(0);
  for (const label of ["幽默", "严谨", "亲和", "详略"])
    await expect(
      editor.getByRole("checkbox", {
        name: `设置${label}`,
        exact: true,
        includeHidden: true,
      }),
    ).not.toBeChecked();
  await expect(
    editor.locator('input[aria-label="智能体的名字"]'),
  ).toHaveAttribute("data-configured", "false");
  await expect(
    editor.locator("summary").filter({ hasText: "个性与表达" }),
  ).toBeVisible();
  await expect(
    editor.locator("details.personality-preferences"),
  ).not.toHaveAttribute("open");
  expect((await fixture.read()).agent.data).toEqual(defaultAgentProfile);
  expect(fixture.sql("SELECT entry_id FROM agent_rom_heads")).toHaveLength(0);
  expect(
    fixture.sql("SELECT command_id FROM agent_rom_command_receipts"),
  ).toHaveLength(0);
  expect(writes).toHaveLength(0);
  expect(fixture.sql("SELECT id FROM sessions")).toHaveLength(0);
  await editor.screenshot({
    path: testInfo.outputPath("actual-host-initial-unset.png"),
  });
  await testInfo.attach("actual-host-initial-unset", {
    path: testInfo.outputPath("actual-host-initial-unset.png"),
    contentType: "image/png",
  });
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_UNSET")));

  // The empty global switch is a real durable choice, not presentation-only
  // priming. Its v2 BODY stays empty and is not selected for new Thread ROM.
  await usage.check();
  const emptyOn = await settled(editor);
  expect(emptyOn).toMatchObject({
    revision: 1,
    enabled: true,
    data: defaultAgentProfile,
  });
  const emptyRom = (await fixture.rom("agent")).body;
  expect(emptyRom).toMatchObject({
    revision: emptyOn.revision,
    enabled: true,
    canonical_sexpr: "(agent-profile (version 2))",
  });
  expect(
    parseProfileAuthoringState(emptyRom.canonical_authoring_state!),
  ).toEqual(defaultAgentProfile);
  expect(fixture.sql("SELECT entry_id FROM agent_rom_heads")).toHaveLength(1);
  expect(
    fixture.sql<{ revision: number; enabled: number; canonical_sexpr: string }>(
      "SELECT v.revision,v.enabled,v.canonical_sexpr FROM agent_rom_heads h JOIN agent_rom_versions v ON v.entry_id=h.entry_id AND v.revision=h.current_revision",
    ),
  ).toEqual([
    { revision: 1, enabled: 1, canonical_sexpr: "(agent-profile (version 2))" },
  ]);
  const emptyWrites = writes.length;
  await page.reload();
  await agentEditor(page);
  await settled(editor);
  expect(writes).toHaveLength(emptyWrites);
  expect((await fixture.read()).agent.revision).toBe(emptyOn.revision);
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_EMPTY_ON")));
  expect(fixture.sql("SELECT thread_id FROM thread_rom_bindings")).toHaveLength(
    0,
  );
  await usage.uncheck();
  const emptyOff = await settled(editor, false);
  expect(emptyOff.revision).toBe(emptyOn.revision + 1);
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_EMPTY_OFF")));
  // An existing empty/off head is an explicit opt-out, unlike a never-written
  // default. A new valid field must stay off until the global switch is used.
  await level(editor, "幽默", 0);
  const emptyOffEdited = await settled(editor, false);
  expect(emptyOffEdited.data).toMatchObject({ traits: { humor: 0 } });
  expect(emptyOffEdited.revision).toBeGreaterThan(emptyOff.revision);
  await editor
    .getByRole("checkbox", { name: "设置幽默", exact: true })
    .uncheck();
  const emptyOffCleared = await settled(editor, false);
  expect(emptyOffCleared.data).toEqual(defaultAgentProfile);
  await usage.check();
  const emptyRestored = await settled(editor);
  expect(emptyRestored.revision).toBe(emptyOffCleared.revision + 1);
  expect(emptyRestored.data).toEqual(defaultAgentProfile);
  assertEmptyRom(modelText(await send(page, "PROFILE_ACTUAL_EMPTY_RESTORED")));
  expect(fixture.sql("SELECT thread_id FROM thread_rom_bindings")).toHaveLength(
    0,
  );

  await level(editor, "幽默", 5);
  await level(editor, "严谨", 0);
  await settled(editor);
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
  expect(bindings[0]!.revision).toBe(saved.agent.revision);

  await editor
    .getByRole("checkbox", { name: "使用人格设定", exact: true })
    .uncheck();
  await settled(editor, false);
  expect((await fixture.read()).agent).toMatchObject({
    enabled: false,
    revision: saved.agent.revision + 1,
    data: saved.agent.data,
  });
  const disabled = await fixture.rom("agent");
  expect(disabled.body).toMatchObject({
    revision: saved.agent.revision + 1,
    enabled: false,
  });
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
  await settled(editor, false);
  expect((await fixture.read()).agent).toMatchObject({
    enabled: false,
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
  expect(fixture.sql("SELECT thread_id FROM thread_rom_mounts").length).toBe(7);
  expect(writes.some((write) => write.enabled === true)).toBe(true);
  expect(writes.at(-1)?.enabled).toBe(false);
  expect(new Set(writes.map((write) => write.commandId)).size).toBe(
    writes.length,
  );
  expect((await fixture.read()).agent.revision).toBe(writes.length);
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
  await expect(editor.locator('input[aria-label="你的名字"]')).toHaveAttribute(
    "data-configured",
    "false",
  );
  const address = await editText(editor, "编辑称呼", "Agent 对你的称呼");
  expect((await fixture.read()).human.revision).toBe(0);
  await address.fill("测试同学");
  await settled(editor);
  const saved = await fixture.read();
  await editor.screenshot({
    path: testInfo.outputPath("actual-host-private-human-address.png"),
  });
  await testInfo.attach("actual-host-private-human-address", {
    path: testInfo.outputPath("actual-host-private-human-address.png"),
    contentType: "image/png",
  });
  expect(saved.human).toMatchObject({
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
    .getByRole("checkbox", { name: "使用个人资料", exact: true })
    .uncheck();
  await settled(editor, false);
  expect((await fixture.read()).human).toMatchObject({
    revision: saved.human.revision + 1,
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
  const name = await editText(editor, "编辑智能体名字", "智能体的名字");
  await name.fill("ReceiptName");
  await name.press("Enter");
  await expect(
    editor.getByRole("button", { name: "重试保存", exact: true }),
  ).toBeEnabled();
  await expect(editor.locator(".personality-save-state")).not.toHaveText(
    "资料已保存",
  );
  expect((await fixture.read()).agent.revision).toBe(1);
  await editor.getByRole("button", { name: "重试保存", exact: true }).click();
  await settled(editor);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(
    fixture.sql("SELECT command_id FROM agent_rom_command_receipts"),
  ).toHaveLength(1);
  expect((await fixture.read()).agent.revision).toBe(1);

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
  await level(editor, "严谨", 0);
  await conflict;
  await expect(name).toHaveValue("ReceiptName");
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

test("实际Inplace名字/称呼结束空值写null且请求省略；临时空名保护、默认零写、风格null与Human停用保持", async ({
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
  const initialName = await editText(agent, "编辑智能体名字", "智能体的名字");
  await expect(initialName).toHaveValue("");
  await initialName.press("Tab");
  await expect(initialName).toBeHidden();
  expect((await fixture.read()).agent.revision).toBe(0);
  expect(writes).toHaveLength(0);
  expect(fixture.sql("SELECT entry_id FROM agent_rom_heads")).toHaveLength(0);
  await preferences(agent);
  await agent
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .check();
  await expect(
    agent.getByRole("textbox", { name: "自定义讲话风格", exact: true }),
  ).toHaveValue("");
  expect((await fixture.read()).agent.revision).toBe(0);
  await agent
    .getByRole("textbox", { name: "自定义讲话风格", exact: true })
    .fill("TEST 待清空风格");
  await settled(agent);
  await agent
    .getByRole("textbox", { name: "自定义讲话风格", exact: true })
    .fill("");
  await settled(agent);
  expect((await fixture.read()).agent).toMatchObject({
    enabled: true,
    data: defaultAgentProfile,
  });
  expect((await fixture.rom("agent")).body).toMatchObject({
    revision: (await fixture.read()).agent.revision,
    enabled: true,
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
  const initialHumanName = await editText(human, "编辑你的名字", "你的名字");
  await expect(initialHumanName).toHaveValue("");
  const beforeEmptyHumanEnd = writes.length;
  await initialHumanName.press("Enter");
  await expect(initialHumanName).toBeHidden();
  expect((await fixture.read()).human.revision).toBe(0);
  expect(writes).toHaveLength(beforeEmptyHumanEnd);
  const address = await editText(human, "编辑称呼", "Agent 对你的称呼");
  await expect(address).toHaveValue("");
  expect((await fixture.read()).human.revision).toBe(0);
  await address.fill("TEST 待清空称呼");
  await settled(human);
  await editText(human, "编辑称呼", "Agent 对你的称呼");
  await address.fill("");
  await settled(human, false);
  expect((await fixture.read()).human).toMatchObject({
    enabled: false,
    data: { name: null, preferredAddress: null },
  });
  await expect(
    page.getByText("资料已再次变化，请重新读取后确认。", { exact: true }),
  ).toHaveCount(0);
  expect(
    writes.filter((write) => write.subject === "agent").at(-1),
  ).toMatchObject({
    subject: "agent",
    enabled: true,
    data: { customStyle: null },
  });
  expect(
    writes.filter((write) => write.subject === "human").at(-1),
  ).toMatchObject({
    subject: "human",
    enabled: false,
    data: { preferredAddress: null },
  });
  expect(fixture.sql("SELECT id FROM sessions")).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);

  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  const agentNameMarker = "TEST_INPLACE_AGENT_NAME_REMOVED";
  const name = await editText(agent, "编辑智能体名字", "智能体的名字");
  await name.fill(agentNameMarker);
  // Effective text still autosaves after the existing debounce while editing;
  // entering a temporary empty name must not erase that durable value.
  await expect
    .poll(async () => (await fixture.read()).agent.data.name)
    .toBe(agentNameMarker);
  await expect(name).toBeVisible();
  const namedAgent = (await fixture.read()).agent;
  await name.fill("");
  await page.waitForTimeout(550);
  await expect(name).toBeFocused();
  expect((await fixture.read()).agent).toMatchObject({
    revision: namedAgent.revision,
    data: { name: agentNameMarker },
  });
  await name.press("Escape");
  await expect(name).toBeHidden();
  await expect(
    agent.getByRole("button", { name: "编辑智能体名字", exact: true }),
  ).toBeFocused();
  await expect(agent.locator(".personality-save-state")).toHaveText(
    "资料已保存",
  );
  expect((await fixture.read()).agent).toMatchObject({
    revision: namedAgent.revision,
    data: { name: agentNameMarker },
  });
  await editText(agent, "编辑智能体名字", "智能体的名字");
  await name.fill("");
  await name.press("Enter");
  await expect(name).toBeHidden();
  const clearedAgent = await settled(agent);
  expect(clearedAgent).toMatchObject({
    revision: namedAgent.revision + 1,
    enabled: true,
    data: defaultAgentProfile,
  });
  expect((await fixture.rom("agent")).body.canonical_sexpr).toBe(
    "(agent-profile (version 2))",
  );
  expect(
    writes.filter((write) => write.subject === "agent").at(-1),
  ).toMatchObject({
    enabled: true,
    data: { name: null },
  });
  const agentClearedRequest = modelText(
    await send(page, "PROFILE_INPLACE_AGENT_NAME_CLEARED"),
  );
  assertEmptyRom(agentClearedRequest);
  expect(agentClearedRequest).not.toContain(agentNameMarker);

  await page
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("group", { name: "用户菜单", exact: true })
    .getByRole("button", { name: "个人资料", exact: true })
    .click();
  const humanNameMarker = "TEST_INPLACE_HUMAN_NAME_REMOVED";
  const humanAddressMarker = "TEST_INPLACE_ADDRESS_REMOVED";
  const humanName = await editText(human, "编辑你的名字", "你的名字");
  await humanName.fill(humanNameMarker);
  await humanName.press("Enter");
  await settled(human);
  await editText(human, "编辑称呼", "Agent 对你的称呼");
  await address.fill(humanAddressMarker);
  await address.press("Enter");
  const namedHuman = await settled(human);
  expect(namedHuman.data).toEqual({
    name: humanNameMarker,
    preferredAddress: humanAddressMarker,
  });
  await editText(human, "编辑你的名字", "你的名字");
  await humanName.fill("");
  await humanName.press("Enter");
  await expect(humanName).toBeHidden();
  const clearedHumanName = await settled(human);
  expect(clearedHumanName.data).toEqual({
    name: null,
    preferredAddress: humanAddressMarker,
  });
  const identity = await fixture.runtime.profiles.identity(localAccess);
  const privateRom = (await fixture.rom("human", identity.principalId)).body;
  expect(privateRom.canonical_sexpr).not.toContain("(name ");
  expect(privateRom.canonical_sexpr).toContain(humanAddressMarker);
  expect((await fixture.rom("human")).status).toBe(404);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  const humanNameClearedRequest = modelText(
    await send(page, "PROFILE_INPLACE_HUMAN_NAME_CLEARED"),
  );
  expect(humanNameClearedRequest).toContain(humanAddressMarker);
  expect(humanNameClearedRequest).not.toContain(humanNameMarker);

  await page
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("group", { name: "用户菜单", exact: true })
    .getByRole("button", { name: "个人资料", exact: true })
    .click();
  await editText(human, "编辑称呼", "Agent 对你的称呼");
  await address.fill("");
  await address.press("Tab");
  await expect(address).toBeHidden();
  const clearedHuman = await settled(human, false);
  expect(clearedHuman.data).toEqual({ name: null, preferredAddress: null });
  expect(
    (await fixture.rom("human", identity.principalId)).body.canonical_sexpr,
  ).toBe("(human-profile (version 2))");
  expect(
    writes.filter((write) => write.subject === "human").at(-1),
  ).toMatchObject({
    enabled: false,
    data: { name: null, preferredAddress: null },
  });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  const humanClearedRequest = modelText(
    await send(page, "PROFILE_INPLACE_ALL_PERSONAL_TEXT_CLEARED"),
  );
  assertEmptyRom(humanClearedRequest);
  expect(humanClearedRequest).not.toContain(humanNameMarker);
  expect(humanClearedRequest).not.toContain(humanAddressMarker);
});

test("同一Session即时Echo与旧Thread固定版本；整体off零ROM，custom off保留原文且请求零字节、reload/on恢复", async ({
  page,
}) => {
  await enter(page);
  const editor = await agentEditor(page);
  assertEmptyRom(modelText(await send(page, "PROFILE_IMMEDIATE_UNSET")));
  const sessions = fixture.sql<{ id: string }>("SELECT id FROM sessions");
  expect(sessions).toHaveLength(1);
  expect(fixture.sql("SELECT thread_id FROM thread_rom_bindings")).toHaveLength(
    0,
  );

  let permitWrite!: () => void;
  const writeGate = new Promise<void>((done) => (permitWrite = done));
  let echoWriteSeen = false;
  const submittedInputs: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/platform/messages")
    )
      submittedInputs.push(request.postData() ?? "");
  });
  await page.route(fixture.origin + "/api/profile", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const command = profileUpdateSchema.parse(route.request().postDataJSON());
    if (command.subject === "agent" && command.data.name === "Echo") {
      echoWriteSeen = true;
      // Hold before the real Host commits. Sending must flush the debounce and
      // await durable confirmation before admitting the new Runtime input.
      await writeGate;
    }
    return route.continue();
  });
  const input = await openInput(page);
  const name = await editText(editor, "编辑智能体名字", "智能体的名字");
  await name.fill("Echo");
  const configuredStart = fixture.requests.length;
  fixture.hold("PROFILE_IMMEDIATE_ECHO");
  // There is no Save click or settling delay between the edit and submit.
  await input.fill("PROFILE_IMMEDIATE_ECHO：你叫什么？");
  await input.press("Enter");
  try {
    await expect.poll(() => echoWriteSeen).toBe(true);
    // Deliberately keep the durable write blocked long enough for a leaking
    // Session ingress to arrive; this is fault injection, not UI synchronization.
    await page.waitForTimeout(150);
    expect((await fixture.read()).agent.data.name).toBeNull();
    expect(submittedInputs).toHaveLength(0);
    expect(fixture.requests).toHaveLength(configuredStart);
  } finally {
    permitWrite();
  }
  const configured = modelText(
    await fixture.waitRequest("PROFILE_IMMEDIATE_ECHO", configuredStart),
  );
  expect(configured).toContain("(name Echo)");
  const savedEcho = await settled(editor);
  expect(savedEcho.data.name).toBe("Echo");
  expect(fixture.sql("SELECT id FROM sessions")).toEqual(sessions);
  expect(
    fixture.sql<{ session_id: string }>(
      "SELECT DISTINCT session_id FROM session_message_requests",
    ),
  ).toEqual([{ session_id: sessions[0]!.id }]);
  const echoBindings = fixture.sql<{
    thread_id: string;
    entry_id: string;
    revision: number;
  }>(
    "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
  );
  expect(echoBindings).toHaveLength(1);
  expect(echoBindings[0]!.revision).toBe(savedEcho.revision);

  await editText(editor, "编辑智能体名字", "智能体的名字");
  await name.fill("Nova");
  await name.press("Enter");
  const savedNova = await settled(editor);
  expect(savedNova.data.name).toBe("Nova");
  expect(savedNova.revision).toBe(savedEcho.revision + 1);
  expect(
    fixture.sql(
      "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
    ),
  ).toEqual(echoBindings);
  const continuationStart = fixture.requests.length;
  await fixture.continueHeld("PROFILE_IMMEDIATE_ECHO");
  const continued = modelText(
    await fixture.waitRequest("PROFILE_IMMEDIATE_ECHO", continuationStart),
  );
  expect(continued).toContain("(name Echo)");
  expect(continued).not.toContain("(name Nova)");

  await editor
    .getByRole("checkbox", { name: "使用人格设定", exact: true })
    .uncheck();
  const disabled = await settled(editor, false);
  expect(disabled.data.name).toBe("Nova");
  await level(editor, "幽默", 5);
  const editedWhileDisabled = await settled(editor, false);
  expect(editedWhileDisabled.data).toMatchObject({
    name: "Nova",
    traits: { humor: 5 },
  });
  expect(editedWhileDisabled.revision).toBeGreaterThan(disabled.revision);
  assertEmptyRom(modelText(await send(page, "PROFILE_IMMEDIATE_DISABLED")));
  expect(fixture.sql("SELECT id FROM sessions")).toEqual(sessions);
  expect(
    fixture.sql(
      "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
    ),
  ).toEqual(echoBindings);
  await editor
    .getByRole("checkbox", { name: "使用人格设定", exact: true })
    .check();
  const restored = await settled(editor);
  expect(restored.data).toEqual(editedWhileDisabled.data);
  expect(restored.revision).toBe(editedWhileDisabled.revision + 1);
  const restoredRequest = modelText(
    await send(page, "PROFILE_IMMEDIATE_RESTORED"),
  );
  expect(restoredRequest).toContain("(name Nova)");
  expect(restoredRequest).toContain("(humor 5)");
  expect(fixture.sql("SELECT id FROM sessions")).toEqual(sessions);
  const restoredBindings = fixture.sql<{
    thread_id: string;
    entry_id: string;
    revision: number;
  }>(
    "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
  );
  expect(restoredBindings).toHaveLength(2);
  expect(restoredBindings).toContainEqual(echoBindings[0]);
  expect(restoredBindings).toContainEqual({
    thread_id: expect.any(String),
    entry_id: echoBindings[0]!.entry_id,
    revision: restored.revision,
  });

  // Field-level off is durable authoring state, not deletion or a textual
  // instruction hidden in the still-mounted effective ROM BODY.
  await level(editor, "幽默", 0);
  const beforeCustom = await settled(editor);
  const customChoice = editor.getByRole("checkbox", {
    name: "设置自定义风格",
    exact: true,
  });
  const customText = editor.locator('textarea[aria-label="自定义讲话风格"]');
  await customChoice.check();
  await expect(customText).toBeVisible();
  await expect(customText).toHaveValue("");
  await settled(editor);
  expect((await fixture.read()).agent.revision).toBe(beforeCustom.revision);
  const customMarker = "TEST_RETAINED_AUTHORING_CUSTOM_NEVER_IN_OFF_REQUEST";
  await customText.fill(customMarker);
  const customOn = await settled(editor);
  expect(customOn.data).toMatchObject({
    name: "Nova",
    traits: { humor: 0 },
    customStyle: customMarker,
  });
  fixture.hold("PROFILE_CUSTOM_ACTIVE");
  const customOnRequest = modelText(await send(page, "PROFILE_CUSTOM_ACTIVE"));
  expect(customOnRequest).toContain(customMarker);
  expect(customOnRequest).not.toContain("(profile-authoring ");
  const customBindings = fixture.sql<{
    thread_id: string;
    entry_id: string;
    revision: number;
  }>(
    "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
  );
  expect(customBindings).toHaveLength(3);
  expect(customBindings).toContainEqual({
    thread_id: expect.any(String),
    entry_id: echoBindings[0]!.entry_id,
    revision: customOn.revision,
  });

  await customChoice.uncheck();
  const customOff = await settled(editor);
  expect(customOff.data).toMatchObject({
    name: "Nova",
    traits: { humor: 0 },
    customStyle: customMarker,
    customStyleEnabled: false,
  });
  expect(customOff.enabled).toBe(true);
  await expect(customText).toBeHidden();
  await expect(customText).toBeDisabled();
  await expect(customText).toHaveValue(customMarker);
  const offRom = (await fixture.rom("agent")).body;
  expect(offRom.canonical_sexpr).not.toContain(customMarker);
  expect(offRom.canonical_sexpr).not.toContain("(custom ");
  expect(offRom.canonical_authoring_state).toBeTruthy();
  expect(parseProfileAuthoringState(offRom.canonical_authoring_state!)).toEqual(
    customOff.data,
  );
  const offSql = fixture.sql<{
    revision: number;
    canonical_sexpr: string;
    canonical_authoring_state: string;
  }>(
    "SELECT v.revision,v.canonical_sexpr,v.canonical_authoring_state FROM agent_rom_heads h JOIN agent_rom_versions v ON v.entry_id=h.entry_id AND v.revision=h.current_revision WHERE h.namespace='morphz.profile.agent'",
  );
  expect(offSql).toHaveLength(1);
  expect(offSql[0]!.revision).toBe(customOff.revision);
  expect(offSql[0]!.canonical_sexpr).toBe(offRom.canonical_sexpr);
  expect(offSql[0]!.canonical_authoring_state).toBe(
    offRom.canonical_authoring_state,
  );

  await page.reload();
  await agentEditor(page);
  await preferences(editor);
  await expect(customChoice).not.toBeChecked();
  await expect(customText).toBeHidden();
  await expect(customText).toHaveValue(customMarker);
  expect((await settled(editor)).data).toEqual(customOff.data);
  expect(
    fixture.sql(
      "SELECT thread_id,entry_id,revision FROM thread_rom_bindings ORDER BY thread_id,entry_id",
    ),
  ).toContainEqual(
    customBindings.find((binding) => binding.revision === customOn.revision)!,
  );
  const oldCustomStart = fixture.requests.length;
  await fixture.continueHeld("PROFILE_CUSTOM_ACTIVE");
  const oldCustomRequest = modelText(
    await fixture.waitRequest("PROFILE_CUSTOM_ACTIVE", oldCustomStart),
  );
  expect(oldCustomRequest).toContain(customMarker);
  expect(oldCustomRequest).toContain("(humor 0)");
  expect(oldCustomRequest).not.toContain("(profile-authoring ");

  // Complete the deliberately held previous evaluation before submitting the
  // next input; this fixture tests frozen ROM, not concurrent composer sends.
  const offRequest = modelText(await send(page, "PROFILE_CUSTOM_INACTIVE"));
  expect(offRequest).toContain("(name Nova)");
  expect(offRequest).toContain("(humor 0)");
  expect(offRequest).not.toContain(customMarker);
  expect(offRequest).not.toContain("(custom ");
  expect(offRequest).not.toContain("(profile-authoring ");

  await customChoice.check();
  await expect(customText).toBeVisible();
  await expect(customText).toHaveValue(customMarker);
  const customRestored = await settled(editor);
  expect(customRestored.revision).toBe(customOff.revision + 1);
  expect(customRestored.data).toEqual(customOn.data);
  const customRestoredRequest = modelText(
    await send(page, "PROFILE_CUSTOM_REACTIVATED"),
  );
  expect(customRestoredRequest).toContain(customMarker);
  expect(customRestoredRequest).toContain("(name Nova)");
  expect(customRestoredRequest).toContain("(humor 0)");
  expect(customRestoredRequest).not.toContain("(profile-authoring ");
  expect(fixture.sql("SELECT id FROM sessions")).toEqual(sessions);
});
