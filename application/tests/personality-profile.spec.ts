import {
  test,
  expect,
  type Page,
  type Route,
  type Locator,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
  defaultAgentProfile,
  defaultHumanProfile,
  profileSnapshotSchema,
  profileUpdateSchema,
  profileUpdateResultSchema,
  profileAvatarSnapshotSchema,
  type ProfileSnapshot,
  type ProfileUpdate,
} from "../packages/core/src/profile.js";
import { conversationRuntimeSchema } from "../packages/core/src/conversation.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import { platformBootSchema } from "../apps/web/src/platform-client.js";
import { openInput } from "./interaction-helpers.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { IdentityCenter } from "../apps/service/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";

// Presentation/transport regressions, NOT a model/DB/real authentication E2E.
// All controlled profile inputs and receipts use the production typed schemas.
// Runtime persistence, HTTP authorization and avatar decoding have separate tests.
if (process.env.MORPHZ_TEST_BROWSER_EXECUTABLE)
  test.use({
    launchOptions: {
      executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
    },
  });

const profileUrl = /\/api\/profile$/;
const avatarUrl = /\/api\/profile\/avatar(?:\?.*)?$/;
const stamp = "2026-10-01T12:00:00.000Z";
function initialProfile(): ProfileSnapshot {
  return profileSnapshotSchema.parse({
    human: {
      data: { ...defaultHumanProfile },
      revision: 1,
      available: true,
      editable: true,
      avatar: { revision: 0, media: null },
    },
    agent: {
      id: "agent:test-personality",
      data: { ...structuredClone(defaultAgentProfile), name: "TEST 伙伴" },
      revision: 1,
      available: true,
      editable: true,
      avatar: { revision: 0, media: null },
    },
    avatarUploadAvailable: true,
  });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function profileFixture(page: Page, snapshot = initialProfile()) {
  const runtime = conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "TEST-profile-model",
    error: "",
    messages: [],
    deliveries: [],
    activity: {
      available: true,
      truncated: false,
      openWorkComplete: true,
      threads: [],
    },
    attention: { available: true, approvals: [] },
  });
  const conversation = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  const commands: ProfileUpdate[] = [];
  const receipts = new Map<
    string,
    ReturnType<typeof profileUpdateResultSchema.parse>
  >();
  let readFailure = "";
  let onUpdate:
    ((route: Route, command: ProfileUpdate) => Promise<boolean>) | undefined;
  let onRead: ((route: Route) => Promise<boolean>) | undefined;
  await page.route("**/api/platform/bootstrap", async (route) => {
    const { "if-none-match": _cache, ...headers } = route.request().headers();
    const response = await route.fetch({ headers });
    if (!response.ok()) return route.fulfill({ response });
    const actual = await response.json();
    await route.fulfill({
      response,
      json: platformBootSchema.parse(actual),
    });
  });
  const commit = (command: ProfileUpdate) => {
    const existing = receipts.get(command.commandId);
    if (existing) return existing;
    const old = snapshot[command.subject];
    if (old.revision !== command.expectedRevision)
      throw new Error("test CAS mismatch");
    if (command.subject === "agent")
      snapshot.agent = {
        ...snapshot.agent,
        data: command.data,
        revision: old.revision + 1,
      };
    else
      snapshot.human = {
        ...snapshot.human,
        data: command.data,
        revision: old.revision + 1,
      };
    const receipt = profileUpdateResultSchema.parse({
      subject: command.subject,
      commandId: command.commandId,
      data: command.data,
      revision: old.revision + 1,
    });
    receipts.set(command.commandId, receipt);
    return receipt;
  };
  await page.route(profileUrl, async (route) => {
    if (route.request().method() === "GET") {
      if (onRead && (await onRead(route))) return;
      if (readFailure)
        return route.fulfill({ status: 503, json: { message: readFailure } });
      return route.fulfill({ json: profileSnapshotSchema.parse(snapshot) });
    }
    const command = profileUpdateSchema.parse(route.request().postDataJSON());
    commands.push(command);
    if (onUpdate && (await onUpdate(route, command))) return;
    await route.fulfill({ json: commit(command) });
  });
  return {
    snapshot,
    runtime,
    conversation,
    commands,
    commit,
    failReads(message: string) {
      readFailure = message;
    },
    update(handler?: typeof onUpdate) {
      onUpdate = handler;
    },
    read(handler?: typeof onRead) {
      onRead = handler;
    },
  };
}
async function enterDialogue(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
}
async function openAgent(page: Page) {
  const panel = page.locator(".subject-sidebar");
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const editor = panel.getByRole("region", { name: "智能体资料", exact: true });
  await expect(
    editor.getByRole("textbox", { name: "智能体的名字", exact: true }),
  ).toBeEnabled();
  return editor;
}
async function openHuman(page: Page) {
  const trigger = page
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true });
  await trigger.click();
  await page
    .getByRole("group", { name: "用户菜单", exact: true })
    .getByRole("button", { name: "个人资料", exact: true })
    .click();
  const editor = page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("region", { name: "个人资料", exact: true });
  await expect(
    editor.getByRole("textbox", { name: "你的名字", exact: true }),
  ).toBeEnabled();
  return editor;
}
async function setLevel(editor: Locator, label: string, level: number) {
  const slider = editor.getByRole("slider", {
    name: `${label}程度`,
    exact: true,
  });
  await slider.focus();
  await slider.press("Home");
  for (let value = 0; value < level; value++) await slider.press("ArrowRight");
  await expect(slider).toHaveValue(String(level));
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    new RegExp(`^${level}，`),
  );
}
async function save(editor: Locator) {
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator(".personality-save-state")).toHaveText("已保存");
}

test("双方资料入口分离，Agent 与消息草稿跨面板保留，人名和称呼只写 human", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  await enterDialogue(page);
  const input = await openInput(page);
  await input.fill("TEST 不应丢失的消息草稿");
  let agent = await openAgent(page);
  await agent
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("星禾");
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  agent = await openAgent(page);
  await expect(
    agent.getByRole("textbox", { name: "智能体的名字", exact: true }),
  ).toHaveValue("星禾");
  const human = await openHuman(page);
  await expect(human.getByRole("slider")).toHaveCount(0);
  await human
    .getByRole("textbox", { name: "你的名字", exact: true })
    .fill("清河");
  await human
    .getByRole("textbox", { name: "Agent 对你的称呼", exact: true })
    .fill("河哥");
  await save(human);
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.commands[0]).toMatchObject({
    subject: "human",
    expectedRevision: 1,
    data: { name: "清河", preferredAddress: "河哥" },
  });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(
    (await openAgent(page)).getByRole("textbox", {
      name: "智能体的名字",
      exact: true,
    }),
  ).toHaveValue("星禾");
  await expect(await openInput(page)).toHaveValue("TEST 不应丢失的消息草稿");
});

test("初次取名引导可保留 Morphz，后续直接改名，无隐式保存", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.revision = 0;
  snapshot.agent.data = structuredClone(defaultAgentProfile);
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const editor = await openAgent(page);
  await expect(
    editor.getByText("先给我起个名字吧。", { exact: true }),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "就叫 Morphz", exact: true })
    .click();
  expect(fixture.commands).toHaveLength(0);
  await save(editor);
  await expect(
    editor.getByText("先给我起个名字吧。", { exact: true }),
  ).toHaveCount(0);
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("阿禾");
  await save(editor);
  expect(fixture.commands.map((command) => command.expectedRevision)).toEqual([
    0, 1,
  ]);
  expect(fixture.snapshot.agent.data.name).toBe("阿禾");
});

test("四个特性 0–5 所有分值可键盘设置并真实进入 typed 保存 payload", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  await enterDialogue(page);
  const editor = await openAgent(page);
  for (let level = 0; level <= 5; level++) {
    for (const label of ["幽默", "严谨", "亲和", "详略"])
      await setLevel(editor, label, level);
    await save(editor);
    expect(fixture.commands[level]).toMatchObject({
      subject: "agent",
      expectedRevision: level + 1,
      data: {
        traits: { humor: level, rigor: level, warmth: level, verbosity: level },
      },
    });
  }
});

test("风格单选和自定义上下文保存后重开保持，不借此创建目标或发送消息", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  const otherWrites: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:platform\/messages|objectives|execution)/.test(request.url())
    )
      otherWrites.push(request.url());
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  for (const style of ["自然", "干练", "细腻", "直率"]) {
    await editor.getByRole("radio", { name: style, exact: true }).check();
    await expect(
      editor.getByRole("radio", { name: style, exact: true }),
    ).toBeChecked();
  }
  await editor.getByText("自定义风格", { exact: true }).click();
  const text = "先给结论，再解释不确定性；叫我河哥。\n引用事实时标明来源。";
  await editor
    .getByRole("textbox", { name: "自定义讲话风格", exact: true })
    .fill(text);
  await save(editor);
  expect(fixture.commands[0]).toMatchObject({
    subject: "agent",
    data: { speechStyle: "direct", customStyle: text },
  });
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  const reopened = await openAgent(page);
  await reopened.getByText("自定义风格", { exact: true }).click();
  await expect(
    reopened.getByRole("textbox", { name: "自定义讲话风格", exact: true }),
  ).toHaveValue(text);
  expect(otherWrites).toEqual([]);
});

test("写入成功但回执丢失时同 commandId 重试；CAS 冲突不冒称保存或丢草稿", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  let first = true;
  fixture.update(async (route, command) => {
    if (!first) return false;
    first = false;
    fixture.commit(command);
    await route.abort("failed");
    return true;
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("回执重试");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await expect(editor.locator(".personality-save-state")).not.toHaveText(
    "已保存",
  );
  await save(editor);
  expect(fixture.commands[0]).toEqual(fixture.commands[1]);
  expect(fixture.snapshot.agent.revision).toBe(2);
  fixture.update(async (route) => {
    await route.fulfill({
      status: 409,
      json: { message: "资料已被其他操作修改，请重新读取。", code: "conflict" },
    });
    return true;
  });
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("冲突后的本地草稿");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("资料已被其他操作修改");
  await expect(
    editor.getByRole("textbox", { name: "智能体的名字", exact: true }),
  ).toHaveValue("冲突后的本地草稿");
  await expect(editor.locator(".personality-save-state")).toHaveText("未保存");
});

for (const keepChanges of [false, true]) {
  test(`真实资料 CAS 冲突后${keepChanges ? "保留修改" : "使用最新"}须显式选择，不自动覆盖；重存采用新版本与新 commandId`, async ({
    page,
  }) => {
    const fixture = await profileFixture(page);
    fixture.update(async (route, command) => {
      if (
        command.expectedRevision === fixture.snapshot[command.subject].revision
      )
        return false;
      await route.fulfill({
        status: 409,
        json: { message: "TEST 资料版本已更新", code: "conflict" },
      });
      return true;
    });
    await enterDialogue(page);
    const editor = await openAgent(page);
    const name = editor.getByRole("textbox", {
      name: "智能体的名字",
      exact: true,
    });
    await name.fill("本地待确认草稿");
    // An independent writer advanced the authoritative revision after the UI
    // loaded. The controlled transport enforces CAS, not an unconditional error.
    fixture.snapshot.agent = {
      ...fixture.snapshot.agent,
      revision: 5,
      data: { ...fixture.snapshot.agent.data, name: "远端最新名字" },
    };
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText(
      "TEST 资料版本已更新",
    );
    await expect(name).toHaveValue("本地待确认草稿");
    await expect(name).toBeDisabled();
    await expect(editor.getByRole("slider")).toHaveCount(4);
    for (const slider of await editor.getByRole("slider").all())
      await expect(slider).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]!.expectedRevision).toBe(1);
    let freshReads = 0;
    fixture.read(async () => {
      freshReads++;
      return false;
    });
    await editor
      .getByRole("button", {
        name: keepChanges ? "保留修改" : "使用最新",
        exact: true,
      })
      .click();
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue(
      keepChanges ? "本地待确认草稿" : "远端最新名字",
    );
    await expect(editor.getByRole("alert")).toHaveCount(0);
    expect(freshReads).toBe(1);
    // Resolving a conflict only adopts a baseline; it never writes for the user.
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.snapshot.agent.revision).toBe(5);
    expect(fixture.snapshot.agent.data.name).toBe("远端最新名字");
    if (keepChanges) {
      await expect(editor.locator(".personality-save-state")).toHaveText(
        "未保存",
      );
      await save(editor);
      expect(fixture.commands).toHaveLength(2);
      expect(fixture.commands[1]).toMatchObject({
        subject: "agent",
        expectedRevision: 5,
        data: { name: "本地待确认草稿" },
      });
      expect(fixture.commands[1]!.commandId).not.toBe(
        fixture.commands[0]!.commandId,
      );
      expect(fixture.snapshot.agent.revision).toBe(6);
    } else {
      await expect(
        editor.getByRole("button", { name: "保存", exact: true }),
      ).toBeDisabled();
      await expect(editor.locator(".personality-save-state")).toHaveText("");
    }
  });
}

test("保存后的读取失败必须显示未确认，恢复读取后同操作重试不多写版本", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  fixture.update(async (_route, command) => {
    fixture.commit(command);
    fixture.failReads("TEST 保存结果暂无法读取");
    return false;
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("等待核对");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "TEST 保存结果暂无法读取",
  );
  await expect(editor.locator(".personality-save-state")).toHaveText("未保存");
  fixture.update();
  fixture.failReads("");
  await save(editor);
  expect(fixture.commands[1]).toEqual(fixture.commands[0]);
  expect(fixture.snapshot.agent.revision).toBe(2);
});

test("失败保存关闭再打开保留同一 commandId，绝不把未知结果作为新修改重复提交", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  let first = true;
  fixture.update(async (route, command) => {
    if (!first) return false;
    first = false;
    fixture.commit(command);
    await route.abort("failed");
    return true;
  });
  await enterDialogue(page);
  let editor = await openAgent(page);
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("重开仍是同一次保存");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  editor = await openAgent(page);
  await expect(
    editor.getByRole("textbox", { name: "智能体的名字", exact: true }),
  ).toHaveValue("重开仍是同一次保存");
  await save(editor);
  expect(fixture.commands[1]).toEqual(fixture.commands[0]);
  expect(fixture.snapshot.agent.revision).toBe(2);
});

test("头像由 Runtime 的真实阶段驱动，未知状态静止而非假空闲，减少动态停眨眼", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  await enterDialogue(page);
  const editor = await openAgent(page);
  const avatar = editor.locator(".personality-portrait > .profile-avatar");
  await expect(avatar).toHaveAttribute("data-state", "idle");
  fixture.runtime.deliveries = [
    {
      inputId: "TEST-pending",
      state: "running",
      error: null,
      retryable: false,
    },
  ];
  await fixture.conversation.refresh();
  await expect(avatar).toHaveAttribute("data-state", "processing");
  fixture.runtime.deliveries = [];
  fixture.runtime.activity!.threads = [
    {
      id: "TEST-work",
      kind: "dialogue_turn",
      ...fixture.conversation.scope,
      inputId: null,
      rootId: "TEST-root",
      sessionId: "TEST-session",
      title: "TEST 工作",
      phase: "running",
      lifecycle: "open",
      controlState: "active",
      revision: 1,
      updatedAt: stamp,
    },
  ];
  await fixture.conversation.refresh();
  await expect(avatar).toHaveAttribute("data-state", "working");
  await expect(avatar.locator(".profile-avatar-look")).toHaveCSS(
    "animation-name",
    "profile-avatar-thought",
  );
  fixture.runtime.attention!.approvals = [
    {
      scope: {
        projectId: fixture.conversation.scope.projectId,
        artifactId: null,
        inputId: "TEST-approval-input",
      },
      approval: {
        fingerprint: "a".repeat(64),
        requested_at: stamp,
        request: {
          approval_id: "TEST-approval",
          session_id: "TEST-session",
          context_id: "TEST-context",
          justification: "TEST 待授权呈现",
          action: {},
          requested: {},
        },
      },
    },
  ];
  await fixture.conversation.refresh();
  await expect(avatar).toHaveAttribute("data-state", "approval");
  fixture.runtime.attention!.approvals = [];
  fixture.runtime.activity!.threads[0]!.phase = "runnable";
  await fixture.conversation.refresh();
  await expect(avatar).toHaveAttribute("data-state", "waiting");
  fixture.runtime.activity!.threads[0]!.phase = "waiting";
  fixture.runtime.activity!.threads[0]!.controlState = "paused";
  await fixture.conversation.refresh();
  await expect(avatar).toHaveAttribute("data-state", "paused");
  fixture.runtime.activity!.available = false;
  await fixture.conversation.refresh();
  await expect(avatar).toHaveAttribute("data-state", "unavailable");
  await expect(avatar).toHaveAttribute("data-motion", "off");
  fixture.runtime.activity!.available = true;
  fixture.runtime.activity!.threads = [];
  await fixture.conversation.refresh();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(avatar).toHaveAttribute("data-motion", "off");
  await expect(avatar.locator(".profile-avatar-eyes")).toHaveCSS(
    "animation-name",
    "none",
  );
});

async function avatarBuffers() {
  const red = await sharp({
    create: { width: 12, height: 12, channels: 4, background: "#82c2bd" },
  })
    .png()
    .toBuffer();
  const blue = await sharp({
    create: { width: 12, height: 12, channels: 4, background: "#b9cadf" },
  })
    .png()
    .toBuffer();
  const original = await sharp([red, blue], { join: { animated: true } })
    .gif({ delay: [200, 200], loop: 0 })
    .toBuffer();
  const poster = await sharp(original, { pages: 1 }).png().toBuffer();
  return { original, poster };
}
function avatarSnapshot(
  buffers: Awaited<ReturnType<typeof avatarBuffers>>,
  revision = 1,
) {
  const version = (variant: "original" | "poster") => ({
    storeId: "TEST-avatar-store",
    artifactId: `TEST-${variant}`,
    revision: 1,
    sha256: "a".repeat(64),
    byteLength: buffers[variant].length,
    mime: variant === "original" ? "image/gif" : "image/png",
  });
  return profileAvatarSnapshotSchema.parse({
    revision,
    media: {
      original: version("original"),
      poster: version("poster"),
      width: 12,
      height: 12,
      frames: 2,
      durationMs: 400,
    },
  });
}

test("二进制上传和头像读取含当前授权，使用本地 blob，减少动态切换真实 poster", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const types = new Map<string, string>();
    (
      window as unknown as { profileTestBlobTypes: Map<string, string> }
    ).profileTestBlobTypes = types;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = create(blob);
      if (blob instanceof Blob) types.set(url, blob.type);
      return url;
    };
  });
  const fixture = await profileFixture(page);
  const buffers = await avatarBuffers();
  const observed: {
    method: string;
    subject: string | null;
    variant: string | null;
    token: string | undefined;
  }[] = [];
  await page.route(avatarUrl, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const headers = request.headers();
    observed.push({
      method: request.method(),
      subject: url.searchParams.get("subject"),
      variant: url.searchParams.get("variant"),
      token: headers["x-morphz-token"],
    });
    if (request.method() === "POST") {
      expect(headers["content-type"]).toBe("application/octet-stream");
      expect(request.postDataBuffer()).toEqual(buffers.original);
      expect(url.searchParams.get("expectedRevision")).toBe("0");
      expect(url.searchParams.get("commandId")).toBeTruthy();
      fixture.snapshot.agent.avatar = avatarSnapshot(buffers);
      return route.fulfill({ json: fixture.snapshot.agent.avatar });
    }
    expect(url.searchParams.get("revision")).toBe("1");
    const variant =
      url.searchParams.get("variant") === "poster" ? "poster" : "original";
    return route.fulfill({
      contentType: variant === "poster" ? "image/png" : "image/gif",
      body: buffers[variant],
    });
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await editor.locator('input[type="file"]').setInputFiles({
    name: "TEST-avatar.gif",
    mimeType: "image/gif",
    buffer: buffers.original,
  });
  const image = editor.locator(".profile-avatar-media");
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth === 12,
      ),
    )
    .toBe(true);
  const originalUrl = await image.getAttribute("src");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(image).not.toHaveAttribute("src", originalUrl!);
  expect(
    await image.evaluate((element: HTMLImageElement) =>
      (
        window as unknown as { profileTestBlobTypes: Map<string, string> }
      ).profileTestBlobTypes.get(element.src),
    ),
  ).toBe("image/png");
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth === 12,
      ),
    )
    .toBe(true);
  const reads = observed.filter((request) => request.method === "GET");
  expect(reads.map((request) => request.variant).sort()).toEqual([
    "original",
    "poster",
  ]);
  for (const request of observed) {
    expect(request.subject).toBe("agent");
    expect(request.token).toBeTruthy();
  }
});

test("头像读取被拒绝时无越权重试路径，保留资料并安全降级；禁上传时按钮关闭", async ({
  page,
}) => {
  const buffers = await avatarBuffers(),
    snapshot = initialProfile();
  snapshot.agent.avatar = avatarSnapshot(buffers);
  snapshot.avatarUploadAvailable = false;
  await profileFixture(page, snapshot);
  const requests: string[] = [];
  await page.route(avatarUrl, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 403,
      json: { message: "TEST 没有头像读取权限" },
    });
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await expect(
    editor.getByRole("button", { name: "上传智能体头像", exact: true }),
  ).toBeDisabled();
  await expect(editor.locator(".personality-read-error")).toContainText(
    "头像暂时无法读取，请重试。",
  );
  await expect(
    editor.locator(".personality-portrait > .profile-avatar"),
  ).toHaveAttribute("data-avatar-kind", "native");
  await expect(editor.locator(".profile-avatar-media")).toHaveCount(0);
  await expect(
    editor.getByRole("textbox", { name: "智能体的名字", exact: true }),
  ).toHaveValue("TEST 伙伴");
  expect(
    requests.every(
      (request) => new URL(request).searchParams.get("subject") === "agent",
    ),
  ).toBe(true);
});

test("Human 头像上传和移除都核对 readback，失败重试保留 commandId；超限文件不发请求", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  const buffers = await avatarBuffers();
  const uploads: { commandId: string; expectedRevision: number }[] = [],
    clears: { commandId: string; expectedRevision: number }[] = [];
  let receipt = avatarSnapshot(buffers);
  let acceptedUpload = "",
    acceptedClear = "";
  await page.route(avatarUrl, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(url.searchParams.get("subject")).toBe("human");
    if (request.method() === "GET") {
      const variant =
        url.searchParams.get("variant") === "poster" ? "poster" : "original";
      return route.fulfill({
        contentType: variant === "poster" ? "image/png" : "image/gif",
        body: buffers[variant],
      });
    }
    const command = {
      commandId: url.searchParams.get("commandId")!,
      expectedRevision: Number(url.searchParams.get("expectedRevision")),
    };
    uploads.push(command);
    if (!acceptedUpload) {
      acceptedUpload = command.commandId;
      fixture.snapshot.human.avatar = receipt;
      fixture.failReads("TEST 上传结果待核对");
    }
    expect(command.commandId).toBe(acceptedUpload);
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/profile/avatar/clear", async (route) => {
    const command = route.request().postDataJSON();
    expect(command.subject).toBe("human");
    clears.push({
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
    });
    if (!acceptedClear) {
      acceptedClear = command.commandId;
      receipt = profileAvatarSnapshotSchema.parse({ revision: 2, media: null });
      fixture.snapshot.human.avatar = receipt;
      fixture.failReads("TEST 移除结果待核对");
    }
    expect(command.commandId).toBe(acceptedClear);
    return route.fulfill({ json: receipt });
  });
  await enterDialogue(page);
  const editor = await openHuman(page);
  const file = editor.locator('input[type="file"]');
  await file.setInputFiles({
    name: "TEST-too-large.gif",
    mimeType: "image/gif",
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  await expect(editor.getByRole("alert")).toContainText("头像不能超过 4 MB");
  expect(uploads).toHaveLength(0);
  await file.setInputFiles({
    name: "TEST-human.gif",
    mimeType: "image/gif",
    buffer: buffers.original,
  });
  await expect(editor.getByRole("alert")).toContainText("TEST 上传结果待核对");
  fixture.failReads("");
  await editor.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect.poll(() => uploads.length).toBe(2);
  await expect(editor).toHaveAttribute("aria-busy", "false");
  await expect(editor.getByRole("alert")).toHaveCount(0);
  expect(uploads[1]).toEqual(uploads[0]);
  expect(fixture.snapshot.human.avatar.revision).toBe(1);
  expect(fixture.snapshot.agent.avatar).toEqual({ revision: 0, media: null });
  await editor.getByRole("button", { name: "移除头像", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("TEST 移除结果待核对");
  fixture.failReads("");
  await editor.getByRole("button", { name: "重试移除", exact: true }).click();
  await expect.poll(() => clears.length).toBe(2);
  await expect(editor).toHaveAttribute("aria-busy", "false");
  await expect(editor.getByRole("alert")).toHaveCount(0);
  expect(clears[1]).toEqual(clears[0]);
  await expect(
    editor.getByRole("button", { name: "移除头像", exact: true }),
  ).toHaveCount(0);
  expect(fixture.snapshot.human.avatar).toEqual({ revision: 2, media: null });
});

test("头像真实 CAS 冲突只更新显式基线，上传与移除重试使用新 commandId，不暗中覆盖", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  const buffers = await avatarBuffers();
  const uploads: { commandId: string; expectedRevision: number }[] = [];
  const clears: { commandId: string; expectedRevision: number }[] = [];
  const conflict = (route: Route) =>
    route.fulfill({
      status: 409,
      json: { message: "TEST 头像版本已更新", code: "conflict" },
    });
  await page.route(avatarUrl, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(url.searchParams.get("subject")).toBe("human");
    if (request.method() === "GET") {
      const variant =
        url.searchParams.get("variant") === "poster" ? "poster" : "original";
      return route.fulfill({
        contentType: variant === "poster" ? "image/png" : "image/gif",
        body: buffers[variant],
      });
    }
    const command = {
      commandId: url.searchParams.get("commandId")!,
      expectedRevision: Number(url.searchParams.get("expectedRevision")),
    };
    uploads.push(command);
    expect(request.postDataBuffer()).toEqual(buffers.original);
    if (command.expectedRevision !== fixture.snapshot.human.avatar.revision)
      return conflict(route);
    fixture.snapshot.human.avatar = avatarSnapshot(
      buffers,
      command.expectedRevision + 1,
    );
    return route.fulfill({ json: fixture.snapshot.human.avatar });
  });
  await page.route("**/api/profile/avatar/clear", async (route) => {
    const command = route.request().postDataJSON();
    expect(command.subject).toBe("human");
    clears.push({
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
    });
    if (command.expectedRevision !== fixture.snapshot.human.avatar.revision)
      return conflict(route);
    fixture.snapshot.human.avatar = profileAvatarSnapshotSchema.parse({
      revision: command.expectedRevision + 1,
      media: null,
    });
    return route.fulfill({ json: fixture.snapshot.human.avatar });
  });
  await enterDialogue(page);
  const editor = await openHuman(page);
  fixture.snapshot.human.avatar = avatarSnapshot(buffers, 3);
  await editor.locator('input[type="file"]').setInputFiles({
    name: "TEST-rebase.gif",
    mimeType: "image/gif",
    buffer: buffers.original,
  });
  await expect(editor.getByRole("alert")).toContainText("TEST 头像版本已更新");
  await expect(
    editor.getByRole("textbox", { name: "你的名字", exact: true }),
  ).toBeDisabled();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.expectedRevision).toBe(0);
  await editor.getByRole("button", { name: "保留修改", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "重试上传", exact: true }),
  ).toBeEnabled();
  expect(uploads).toHaveLength(1);
  expect(fixture.snapshot.human.avatar.revision).toBe(3);
  await editor.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect.poll(() => uploads.length).toBe(2);
  await expect(editor).toHaveAttribute("aria-busy", "false");
  await expect(editor.getByRole("alert")).toHaveCount(0);
  expect(uploads[1]!.expectedRevision).toBe(3);
  expect(uploads[1]!.commandId).not.toBe(uploads[0]!.commandId);
  expect(fixture.snapshot.human.avatar.revision).toBe(4);

  fixture.snapshot.human.avatar = avatarSnapshot(buffers, 7);
  await editor.getByRole("button", { name: "移除头像", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("TEST 头像版本已更新");
  expect(clears[0]!.expectedRevision).toBe(4);
  await editor.getByRole("button", { name: "使用最新", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveCount(0);
  await expect(editor).toHaveAttribute("aria-busy", "false");
  expect(clears).toHaveLength(1);
  expect(fixture.snapshot.human.avatar.revision).toBe(7);
  await expect(
    editor.getByRole("button", { name: "移除头像", exact: true }),
  ).toBeEnabled();

  fixture.snapshot.human.avatar = avatarSnapshot(buffers, 8);
  await editor.getByRole("button", { name: "移除头像", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("TEST 头像版本已更新");
  expect(clears[1]!.expectedRevision).toBe(7);
  await editor.getByRole("button", { name: "保留修改", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "重试移除", exact: true }),
  ).toBeEnabled();
  expect(clears).toHaveLength(2);
  expect(fixture.snapshot.human.avatar.revision).toBe(8);
  await editor.getByRole("button", { name: "重试移除", exact: true }).click();
  await expect.poll(() => clears.length).toBe(3);
  await expect(editor).toHaveAttribute("aria-busy", "false");
  await expect(editor.getByRole("alert")).toHaveCount(0);
  expect(clears[2]!.expectedRevision).toBe(8);
  expect(clears[2]!.commandId).not.toBe(clears[1]!.commandId);
  expect(fixture.snapshot.human.avatar).toEqual({ revision: 9, media: null });
  expect(fixture.snapshot.agent.avatar).toEqual({ revision: 0, media: null });
});

test("成功读取资料与解码头像后 403 撤权须隐藏旧资料并撤销双 Blob URL，恢复授权后显式重试", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    const urls: string[] = [],
      revoked: string[] = [];
    (
      window as unknown as {
        profileTestUrls: { urls: string[]; revoked: string[] };
      }
    ).profileTestUrls = { urls, revoked };
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = create(blob);
      urls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      revoke(url);
    };
  });
  const buffers = await avatarBuffers(),
    snapshot = initialProfile();
  snapshot.agent.avatar = avatarSnapshot(buffers);
  const fixture = await profileFixture(page, snapshot);
  await page.route(avatarUrl, async (route) => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url());
    expect(url.searchParams.get("subject")).toBe("agent");
    const variant =
      url.searchParams.get("variant") === "poster" ? "poster" : "original";
    return route.fulfill({
      contentType: variant === "poster" ? "image/png" : "image/gif",
      body: buffers[variant],
    });
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  const image = editor.locator(".profile-avatar-media");
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth === 12,
      ),
    )
    .toBe(true);
  const originalUrl = await image.getAttribute("src");
  const avatarUrls = await page.evaluate(() =>
    (
      window as unknown as {
        profileTestUrls: { urls: string[]; revoked: string[] };
      }
    ).profileTestUrls.urls.slice(),
  );
  expect(avatarUrls).toHaveLength(2);
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("撤权时仍应保留的本人草稿");
  fixture.read(async (route) => {
    await route.fulfill({
      status: 403,
      json: { message: "TEST 资料访问已撤回", code: "forbidden" },
    });
    return true;
  });
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.locator(".personality-read-error")).toContainText(
    "TEST 资料访问已撤回",
  );
  await expect(editor.getByRole("textbox")).toHaveCount(0);
  await expect(editor.locator(".personality-portrait")).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(`img[src="${originalUrl}"]`)).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate((expected) => {
        const actual = (
          window as unknown as {
            profileTestUrls: { urls: string[]; revoked: string[] };
          }
        ).profileTestUrls.revoked;
        return expected.every((url) => actual.includes(url));
      }, avatarUrls),
    )
    .toBe(true);
  expect(fixture.commands).toHaveLength(1);
  // A transient retry failure does not restore an explicitly withdrawn read
  // permission. Only a successful authorized snapshot can reveal the form.
  fixture.read(async (route) => {
    await route.fulfill({
      status: 503,
      json: { message: "TEST 恢复权限尚待核对" },
    });
    return true;
  });
  await editor.getByRole("button", { name: "重试", exact: true }).click();
  await expect(editor.locator(".personality-read-error")).toContainText(
    "TEST 恢复权限尚待核对",
  );
  await expect(editor.getByRole("textbox")).toHaveCount(0);
  await expect(editor.locator(".personality-portrait")).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  expect(fixture.commands).toHaveLength(1);
  fixture.read();
  await editor.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "智能体的名字", exact: true }),
  ).toHaveValue("撤权时仍应保留的本人草稿");
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect(image).not.toHaveAttribute("src", originalUrl!);
  expect(fixture.commands).toHaveLength(1);
  await save(editor);
  expect(fixture.commands[1]).toEqual(fixture.commands[0]);
  expect(fixture.snapshot.agent.revision).toBe(2);
});

test("真实 Team 登录切换后丢弃 mock 旧资料迟到响应与旧草稿，不污染新身份", async ({
  page,
}) => {
  // Unlike the other presentation cases, identity/navigation are the real
  // isolated Team Host. Only Profile payload/latency and Runtime observations
  // are controlled; a fake bootstrap cannot stand in for a new principal.
  const directory = mkdtempSync(join(tmpdir(), "morphz-profile-identity-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const members = [
    { principalId: "profile-alpha", actantId: "profile-alpha-human" },
    { principalId: "profile-beta", actantId: "profile-beta-human" },
  ];
  const tokens = ["a".repeat(64), "b".repeat(64)];
  const configuration = {
    version: 1 as const,
    members: members.map((member, index) => ({
      ...member,
      enabled: true,
      loginTokenHash: createHash("sha256").update(tokens[index]!).digest("hex"),
    })),
  };
  const identity = new IdentityCenter(
    store,
    configuration,
    Date.now,
    members.map((member, index) => ({
      ...member,
      name: `TEST 身份${index + 1}`,
      projectIds: [],
      enabled: true,
    })),
  );
  const domains = await openApplicationDomainsHost(directory, store, identity);
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const server = createAppServer(store, {
    port,
    webRoot: resolve("dist/web"),
    identity,
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
    platformReader: domains.reader,
    bookmarkDomain: domains.browser,
    messageAttachments: domains.messageAttachments,
    images: domains.images,
    uiPackages: domains.uiPackages,
    notifications: domains.notifications,
    platformTaskRuns: domains.taskRuns(),
    profiles: domains.profiles,
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const gate = deferred(),
    pending = deferred();
  try {
    const fixture = await profileFixture(page);
    await page.goto(`http://127.0.0.1:${port}`);
    const login = async (index: number) => {
      await expect(
        page.getByRole("heading", { name: "登录 Morphz", exact: true }),
      ).toBeVisible();
      await page.getByLabel("登录凭据").fill(tokens[index]!);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(
        page.getByRole("navigation", { name: "主导航" }),
      ).toBeVisible();
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "对话", exact: true })
        .click();
    };
    await login(0);
    const editor = await openAgent(page);
    await editor
      .getByRole("textbox", { name: "智能体的名字", exact: true })
      .fill("旧身份本地草稿");
    let held = false;
    fixture.update(async (route, command) => {
      if (held) return false;
      held = true;
      pending.release();
      await gate.promise;
      await route.fulfill({
        json: profileUpdateResultSchema.parse({
          subject: command.subject,
          commandId: command.commandId,
          revision: command.expectedRevision + 1,
          data: command.data,
        }),
      });
      return true;
    });
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await pending.promise;
    await page
      .getByRole("button", { name: "用户菜单", exact: true })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("button", { name: "退出当前身份", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "登录 Morphz", exact: true }),
    ).toBeVisible();
    fixture.snapshot.agent = {
      ...fixture.snapshot.agent,
      id: "agent:identity-b",
      data: { ...structuredClone(defaultAgentProfile), name: "新身份伙伴" },
      revision: 4,
    };
    fixture.snapshot.human.data.name = "新身份用户";
    await login(1);
    const next = await openAgent(page);
    await expect(
      next.getByRole("textbox", { name: "智能体的名字", exact: true }),
    ).toHaveValue("新身份伙伴");
    gate.release();
    await expect(
      next.getByRole("textbox", { name: "智能体的名字", exact: true }),
    ).toHaveValue("新身份伙伴");
    await expect(next.locator(".personality-save-state")).not.toHaveText(
      "已保存",
    );
    await expect(next.getByRole("alert")).toHaveCount(0);
    expect(fixture.commands).toHaveLength(1);
    expect(
      await page.evaluate(() => JSON.stringify(localStorage)),
    ).not.toContain("旧身份本地草稿");
  } finally {
    gate.release();
    await page.unrouteAll({ behavior: "wait" });
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const appearance of ["light", "dark"] as const) {
  test(`真实布局截图：${appearance} 主题，390px 与 200% Profile 不横向裁切`, async ({
    page,
  }, testInfo) => {
    await profileFixture(page);
    await page.emulateMedia({
      colorScheme: appearance,
      reducedMotion: "reduce",
    });
    await enterDialogue(page);
    const agent = await openAgent(page);
    await agent.getByText("自定义风格", { exact: true }).click();
    await agent
      .getByRole("textbox", { name: "自定义讲话风格", exact: true })
      .fill("先给结论，再解释细节。保持真诚，别堆说明文字。");
    for (const [width, zoom] of [
      [390, 1],
      [1440, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate((scale) => {
        document.documentElement.style.zoom = String(scale);
      }, zoom);
      await expect(agent).toBeVisible();
      const geometry = await agent.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const inputs = [
          ...element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            "input:not([type=file]),textarea",
          ),
        ];
        return {
          left: bounds.left,
          right: bounds.right,
          viewport: innerWidth,
          overflow: element.scrollWidth > element.clientWidth + 1,
          inputOverflow: inputs.some(
            (input) => input.getBoundingClientRect().right > bounds.right + 1,
          ),
        };
      });
      await testInfo.attach(`agent-${appearance}-${width}-${zoom}-geometry`, {
        body: JSON.stringify(geometry),
        contentType: "application/json",
      });
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.overflow).toBe(false);
      expect(geometry.inputOverflow).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath(`agent-${appearance}-${width}-${zoom}.png`),
        fullPage: true,
      });
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
    });
    await page.setViewportSize({ width: 390, height: 960 });
    const human = await openHuman(page);
    await expect(
      human.getByRole("textbox", { name: "你的名字", exact: true }),
    ).toBeInViewport();
    await expect(
      human.getByRole("textbox", { name: "Agent 对你的称呼", exact: true }),
    ).toBeInViewport();
    const humanGeometry = await human.evaluate((element) => ({
      overflow: element.scrollWidth > element.clientWidth + 1,
      right: element.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    expect(humanGeometry.overflow).toBe(false);
    expect(humanGeometry.right).toBeLessThanOrEqual(humanGeometry.viewport + 1);
    await page.screenshot({
      path: testInfo.outputPath(`human-${appearance}-390.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    const zoomGeometry = await human.evaluate((element) => ({
      overflow: element.scrollWidth > element.clientWidth + 1,
      right: element.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    await page.screenshot({
      path: testInfo.outputPath(`human-${appearance}-1440-2.png`),
      fullPage: true,
    });
    expect(zoomGeometry.overflow).toBe(false);
    expect(zoomGeometry.right).toBeLessThanOrEqual(zoomGeometry.viewport + 1);
  });
}
