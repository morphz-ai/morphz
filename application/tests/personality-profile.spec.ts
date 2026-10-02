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
  profileHasConfiguredFields,
  normalizeAgentProfileData,
  normalizeHumanProfileData,
  type ProfileSnapshot,
  type ProfileUpdate,
} from "../packages/core/src/profile.js";
import { conversationRuntimeSchema } from "../packages/core/src/conversation.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";
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
const fixtures = new WeakMap<
  Page,
  Awaited<ReturnType<typeof profileFixture>>
>();
function initialProfile(): ProfileSnapshot {
  return profileSnapshotSchema.parse({
    human: {
      data: { name: "TEST 本人", preferredAddress: "TEST 称呼" },
      enabled: true,
      revision: 1,
      available: true,
      editable: true,
      avatar: { revision: 0, media: null },
    },
    agent: {
      id: "agent:test-personality",
      data: {
        name: "TEST 伙伴",
        traits: { humor: 2, rigor: 3, warmth: 3, verbosity: 2 },
        speechStyle: "natural",
        customStyle: null,
      },
      enabled: true,
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
  const readbacks: ProfileSnapshot[] = [];
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
    const enabled =
      command.subject === "agent"
        ? (command.enabled ?? profileHasConfiguredFields(command.data))
        : command.enabled === true && profileHasConfiguredFields(command.data);
    if (old.revision !== command.expectedRevision)
      throw new Error("test CAS mismatch");
    if (command.subject === "agent")
      snapshot.agent = {
        ...snapshot.agent,
        data: command.data,
        enabled,
        revision: old.revision + 1,
      };
    else
      snapshot.human = {
        ...snapshot.human,
        data: command.data,
        enabled,
        revision: old.revision + 1,
      };
    const receipt = profileUpdateResultSchema.parse({
      subject: command.subject,
      commandId: command.commandId,
      data: command.data,
      enabled,
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
      const actual = profileSnapshotSchema.parse(snapshot);
      readbacks.push(actual);
      return route.fulfill({ json: actual });
    }
    const command = profileUpdateSchema.parse(route.request().postDataJSON());
    commands.push(command);
    if (onUpdate && (await onUpdate(route, command))) return;
    await route.fulfill({ json: commit(command) });
  });
  const fixture = {
    snapshot,
    runtime,
    conversation,
    commands,
    readbacks,
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
  fixtures.set(page, fixture);
  return fixture;
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
  await expect(
    page.getByRole("button", { name: /^(显示|隐藏)右侧栏$/, exact: true }),
  ).toBeVisible();
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const editor = panel.getByRole("region", { name: "智能体资料", exact: true });
  await expect(
    editor.getByRole("button", { name: "编辑智能体名字", exact: true }),
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
    editor.getByRole("button", { name: "编辑你的名字", exact: true }),
  ).toBeEnabled();
  return editor;
}
function profileText(editor: Locator, field: "name" | "preferredAddress") {
  return editor.locator(
    field === "preferredAddress"
      ? 'input[aria-label="Agent 对你的称呼"]'
      : 'input[aria-label="智能体的名字"],input[aria-label="你的名字"]',
  );
}
async function editText(editor: Locator, field: "name" | "preferredAddress") {
  const name =
    field === "preferredAddress"
      ? "编辑称呼"
      : (await editor.getAttribute("aria-label")) === "智能体资料"
        ? "编辑智能体名字"
        : "编辑你的名字";
  const input = profileText(editor, field);
  if (!(await input.isVisible()))
    await editor.getByRole("button", { name, exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  return input;
}
async function clearText(editor: Locator, field: "name" | "preferredAddress") {
  const input = await editText(editor, field);
  await input.fill("");
  await input.press("Enter");
  await expect(input).toBeHidden();
}
async function expectInplaceOnly(editor: Locator) {
  await expect(editor.locator(".personality-edit-actions")).toHaveCount(0);
  await expect(editor.locator(".personality-inline-editor button")).toHaveCount(
    0,
  );
  await expect(
    editor.getByRole("button", { name: "完成", exact: true }),
  ).toHaveCount(0);
  await expect(editor.getByRole("button", { name: /^不设置/ })).toHaveCount(0);
}
function profileTextDisplay(
  editor: Locator,
  field: "name" | "preferredAddress",
) {
  return editor.getByRole("button", {
    name:
      field === "preferredAddress"
        ? "编辑称呼"
        : /^(编辑智能体名字|编辑你的名字)$/,
    exact: true,
  });
}
async function expectInplaceGeometry(
  editor: Locator,
  field: "name" | "preferredAddress",
  scale: number,
) {
  const display = profileTextDisplay(editor, field);
  const before = await display.evaluate((element, field) => {
    const rect = (target: Element) => {
      const box = target.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      };
    };
    const spans = element.querySelectorAll("span");
    const text = field === "preferredAddress" ? spans[1]! : spans[0]!;
    const style = getComputedStyle(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    const glyph = range.getBoundingClientRect();
    const root = element.closest(".personality-profile")!;
    return {
      box: rect(field === "preferredAddress" ? text : element),
      caption: field === "preferredAddress" ? rect(spans[0]!) : null,
      identity: rect(root.querySelector(".personality-identity")!),
      master: rect(root.querySelector(".personality-master")!),
      value: text.textContent,
      glyphLeft: glyph.left,
      glyphRight: glyph.right,
      font: {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        align:
          style.textAlign === "start"
            ? style.direction === "rtl"
              ? "right"
              : "left"
            : style.textAlign,
      },
    };
  }, field);
  const input = await editText(editor, field);
  await expectInplaceOnly(editor);
  await expect(input).toHaveValue(before.value ?? "");
  const after = await input.evaluate((element) => {
    const rect = (target: Element) => {
      const box = target.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      };
    };
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const root = element.closest(".personality-profile")!;
    const caption = element.parentElement!.querySelector("label");
    return {
      box: rect(element),
      caption: caption ? rect(caption) : null,
      identity: rect(root.querySelector(".personality-identity")!),
      master: rect(root.querySelector(".personality-master")!),
      textLeft:
        box.left +
        parseFloat(style.paddingLeft) +
        parseFloat(style.borderLeftWidth),
      textRight:
        box.right -
        parseFloat(style.paddingRight) -
        parseFloat(style.borderRightWidth),
      font: {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        align:
          style.textAlign === "start"
            ? style.direction === "rtl"
              ? "right"
              : "left"
            : style.textAlign,
      },
    };
  });
  expect(after.font).toEqual(before.font);
  for (const part of ["box", "identity", "master"] as const)
    for (const coordinate of ["left", "top", "width", "height"] as const)
      expect(
        Math.abs(after[part][coordinate] - before[part][coordinate]) / scale,
      ).toBeLessThanOrEqual(1);
  if (field === "preferredAddress") {
    expect(before.caption).not.toBeNull();
    expect(after.caption).not.toBeNull();
    for (const coordinate of ["left", "top", "width", "height"] as const)
      expect(
        Math.abs(after.caption![coordinate] - before.caption![coordinate]) /
          scale,
      ).toBeLessThanOrEqual(1);
  }
  expect(
    Math.abs(
      after.font.align === "right"
        ? after.textRight - before.glyphRight
        : after.textLeft - before.glyphLeft,
    ) / scale,
  ).toBeLessThanOrEqual(1);
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(display).toBeFocused();
}
async function expectProfileUsage(editor: Locator, enabled: boolean) {
  if ((await editor.getAttribute("aria-label")) === "智能体资料")
    await expect(editor).toHaveAttribute("data-profile-use", String(enabled));
  const control = profileUsageControl(editor);
  await expect(control).toBeVisible();
  if (enabled) await expect(control).toBeChecked();
  else await expect(control).not.toBeChecked();
}
async function expectEmptyProfileUsage(editor: Locator, enabled = false) {
  await expectProfileUsage(editor, enabled);
  if ((await editor.getAttribute("aria-label")) === "智能体资料") {
    // An empty Agent Profile has a real usage intent, not a disabled control
    // or an invented name/trait. Human retains its configured-only contract.
    await expect(profileUsageControl(editor)).toBeEnabled();
  } else {
    await expect(profileUsageControl(editor)).toBeDisabled();
  }
}
async function setProfileUsage(editor: Locator, enabled: boolean) {
  await profileUsageControl(editor).setChecked(enabled);
  await expectProfileUsage(editor, enabled);
}
function profileUsageControl(editor: Locator) {
  return editor.locator(
    'input[aria-label="使用人格设定"],input[aria-label="使用个人资料"]',
  );
}
async function expectUsageSwitchAppearance(
  control: Locator,
  { touch = false, scale = 1 } = {},
) {
  await expect(control).toBeVisible();
  await expect(control).toHaveCSS("outline-style", "none");
  await expect(control).toHaveCSS("border-top-style", "solid");
  await expect(control).toHaveCSS("border-top-width", "1px");
  await expect(control).toHaveCSS("border-top-left-radius", "999px");
  await expect(control).toHaveCSS("cursor", "pointer");
  const rendered = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const label = element.closest("label")?.getBoundingClientRect();
    const dot = getComputedStyle(element, "::before");
    return {
      height: bounds.height,
      width: bounds.width,
      labelWidth: label?.width ?? 0,
      labelHeight: label?.height ?? 0,
      checked: (element as HTMLInputElement).checked,
      dotWidth: parseFloat(dot.width),
      dotHeight: parseFloat(dot.height),
      dotTransform: dot.transform,
      opacity: style.opacity,
      background: style.backgroundColor,
    };
  });
  expect(rendered.width / scale).toBeCloseTo(32, 1);
  expect(rendered.height / scale).toBeCloseTo(20, 1);
  expect(rendered.labelWidth / scale).toBeGreaterThanOrEqual(touch ? 44 : 32);
  expect(rendered.labelHeight / scale).toBeGreaterThanOrEqual(touch ? 44 : 32);
  expect(rendered.dotWidth).toBe(14);
  expect(rendered.dotHeight).toBe(14);
  expect(rendered.dotTransform).toBe(
    rendered.checked ? "matrix(1, 0, 0, 1, 12, 0)" : "none",
  );
  expect(rendered.opacity).toBe("1");
  expect(rendered.background).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  return rendered;
}
async function expectSwitchKeyboardFocus(control: Locator) {
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS("outline-style", "none");
  const focus = await control.evaluate((element) => {
    // Resolve the theme's actual ink color without changing Profile state.
    const probe = document.createElement("span");
    probe.hidden = true;
    probe.style.color = "var(--ink)";
    element.parentElement!.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return {
      visible: element.matches(":focus-visible"),
      shadow: getComputedStyle(element).boxShadow,
      ink,
    };
  });
  expect(focus.visible).toBe(true);
  expect(focus.shadow).toBe(`${focus.ink} 0px 0px 0px 2px inset`);
}
async function expectSwitchPointerFocus(control: Locator) {
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS("outline-style", "none");
  await expect(control).toHaveCSS("box-shadow", "none");
  expect(
    await control.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(false);
}
async function openPreferences(editor: Locator) {
  const details = editor.locator("details.personality-preferences");
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await details.locator(":scope > summary").click();
  await expect(details).toHaveAttribute("open", "");
}
async function openSystem(page: Page) {
  const details = page.locator("details.subject-settings-system");
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await details.locator(":scope > summary").click();
  return details;
}
async function openCustom(editor: Locator) {
  await openPreferences(editor);
}
async function setLevel(editor: Locator, label: string, level: number) {
  await openPreferences(editor);
  await editor
    .getByRole("checkbox", { name: `设置${label}`, exact: true })
    .check();
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
async function flushText(editor: Locator) {
  await editor.evaluate((element) => {
    const active = document.activeElement;
    // Complete text editing without manufacturing a blur on the target which
    // just received focus (for example a summary, switch, button or slider).
    if (
      element.contains(active) &&
      (active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && active.type === "text"))
    )
      active.blur();
  });
}
async function waitForAutosave(editor: Locator) {
  const fixture = fixtures.get(editor.page());
  if (!fixture) throw new Error("Missing controlled Profile transport");
  const subject =
    (await editor.getAttribute("aria-label")) === "智能体资料"
      ? "agent"
      : "human";
  // Capture the actual form intent before blur/readback. Completion must match
  // both the typed Host head and an authorized GET, not an optimistic label.
  const intent = await editor.evaluate((element) => {
    const checked = (name: string) =>
      element.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)
        ?.checked === true;
    const text = (name: string) =>
      element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[aria-label="${name}"]`,
      )?.value ?? "";
    const configured = (name: string) => {
      const input = element.querySelector<HTMLElement>(
        `[aria-label="${name}"]`,
      );
      return (
        input?.closest<HTMLElement>("[data-configured]")?.dataset.configured ===
        "true"
      );
    };
    const agent = element.getAttribute("aria-label") === "智能体资料";
    return {
      enabled: checked(agent ? "使用人格设定" : "使用个人资料"),
      data: agent
        ? {
            name: configured("智能体的名字") ? text("智能体的名字") : null,
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
            speechStyle:
              element.querySelector<HTMLInputElement>(
                'input[type="radio"]:checked',
              )?.value === "on"
                ? null
                : (element.querySelector<HTMLInputElement>(
                    'input[type="radio"]:checked',
                  )?.value ?? null),
            customStyle: configured("自定义讲话风格")
              ? text("自定义讲话风格")
              : null,
            customStyleEnabled: checked("设置自定义风格"),
          }
        : {
            name: configured("你的名字") ? text("你的名字") : null,
            preferredAddress: configured("Agent 对你的称呼")
              ? text("Agent 对你的称呼")
              : null,
          },
    };
  });
  const data =
    subject === "agent"
      ? normalizeAgentProfileData(intent.data)
      : normalizeHumanProfileData(intent.data);
  const enabled =
    subject === "agent"
      ? intent.enabled
      : intent.enabled && profileHasConfiguredFields(data);
  await flushText(editor);
  await expect.poll(() => fixture.snapshot[subject].data).toEqual(data);
  await expect.poll(() => fixture.snapshot[subject].enabled).toBe(enabled);
  await expect
    .poll(() =>
      fixture.readbacks.some(
        (read) =>
          read[subject].revision === fixture.snapshot[subject].revision &&
          JSON.stringify(read[subject].data) === JSON.stringify(data) &&
          read[subject].enabled === enabled,
      ),
    )
    .toBe(true);
  await expect(editor.getByRole("alert")).toHaveCount(0);
  await expect(editor).toHaveAttribute("aria-busy", "false");
  if (fixture.snapshot[subject].revision > 0)
    await expect(editor.locator(".personality-save-state")).toHaveText(
      "资料已保存",
    );
  await expect(
    editor.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "恢复已保存资料", exact: true }),
  ).toHaveCount(0);
  return fixture.commands
    .filter((command) => command.subject === subject)
    .at(-1);
}

async function paintedProfileLabels(editor: Locator) {
  return editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const painted: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text || !node.parentElement) continue;
      if (
        !node.parentElement.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      )
        continue;
      if (node.parentElement.closest(".personality-edit-actions")) continue;
      // Saved receipts and errors are still necessary feedback. This check
      // concerns the repeated field/master labels, not those result messages.
      if (
        !node.parentElement.closest(
          ".personality-identity,.personality-master,.personality-preferences,.personality-field",
        )
      )
        continue;
      let clipped = false;
      for (
        let parent: HTMLElement | null = node.parentElement;
        parent && parent !== element.parentElement;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        if (
          (parent instanceof HTMLDetailsElement &&
            !parent.open &&
            !parent.querySelector(":scope > summary")?.contains(node)) ||
          style.display === "none" ||
          style.visibility !== "visible" ||
          Number(style.opacity) === 0 ||
          style.clipPath === "inset(50%)" ||
          style.clip === "rect(0px, 0px, 0px, 0px)"
        ) {
          clipped = true;
          break;
        }
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      // innerText and Playwright visibility alone include 1px sr-only text.
      // Require laid-out text, and exclude its actual zero-paint clipping.
      if (!clipped && range.getClientRects().length > 0) painted.push(text);
    }
    return painted.join("\n");
  });
}

async function expectQuietProfileLabels(editor: Locator, speechUnset: boolean) {
  const painted = await paintedProfileLabels(editor);
  expect(painted).not.toMatch(/已设置|已启用|未启用/);
  expect(painted.match(/不设置/g) ?? []).toHaveLength(
    speechUnset && (await editor.getByRole("radio").count()) > 0 ? 1 : 0,
  );
}

async function expectUniformSwitches(editor: Locator) {
  for (const checkbox of await editor.getByRole("checkbox").all()) {
    const geometry = await checkbox.evaluate((input) => {
      const bounds = input.getBoundingClientRect();
      const label = input.closest("label")?.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        labelWidth: label?.width,
        labelHeight: label?.height,
      };
    });
    expect(geometry.width).toBe(32);
    expect(geometry.height).toBe(20);
    expect(geometry.labelWidth).toBeGreaterThanOrEqual(32);
    expect(geometry.labelHeight).toBeGreaterThanOrEqual(32);
  }
}

async function expectCompactIdentity(editor: Locator, scale = 1) {
  // Native modal positioning and ResizeObserver anchoring settle after a
  // viewport/CSS zoom change. Assert the real bounded rectangle eventually,
  // then keep all final exact size, overflow and alignment checks below.
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Math.max(-bounds.left, bounds.right - innerWidth);
      }),
    )
    .toBeLessThanOrEqual(1);
  const geometry = await editor.evaluate((element) => {
    const rect = (selector: string) => {
      const target = element.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`Missing Profile layout: ${selector}`);
      const bounds = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
        cssWidth: parseFloat(style.width),
        cssHeight: parseFloat(style.height),
        radius: parseFloat(style.borderTopLeftRadius),
      };
    };
    const bounds = element.getBoundingClientRect();
    const agent = element.getAttribute("aria-label") === "智能体资料";
    return {
      agent,
      identity: rect(".personality-identity"),
      portrait: rect(".personality-portrait"),
      avatar: rect(".personality-portrait > .profile-avatar"),
      camera: rect(".personality-camera"),
      name: rect(".personality-name"),
      heading: agent ? null : rect(".personality-heading"),
      title: agent ? null : rect(".personality-heading > :is(h2,h3)"),
      master: rect(".personality-master"),
      masterSwitch: rect(".personality-master > input"),
      headingChildren: [
        ...(element.querySelector<HTMLElement>(".personality-heading")
          ?.children ?? []),
      ].map((child) => child.tagName),
      hasRemoveAvatar: !!element.querySelector(".personality-text-action"),
      firstClasses: [...element.children]
        .slice(0, 2)
        .map((child) => child.className),
      mark: element.querySelector(".personality-portrait .brand-mark")
        ? rect(".personality-portrait .brand-mark")
        : null,
      left: bounds.left,
      right: bounds.right,
      viewport: innerWidth,
      overflow: element.scrollWidth > element.clientWidth + 1,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      descendants:
        element.scrollWidth > element.clientWidth + 1
          ? [...element.querySelectorAll<HTMLElement>("*")]
              .map((child) => {
                const box = child.getBoundingClientRect();
                return {
                  tag: child.tagName,
                  className: child.className,
                  aria: child.getAttribute("aria-label"),
                  hidden: child.hidden,
                  visible: child.checkVisibility({
                    contentVisibilityAuto: true,
                    opacityProperty: true,
                    visibilityProperty: true,
                  }),
                  clientWidth: child.clientWidth,
                  scrollWidth: child.scrollWidth,
                  left: box.left,
                  right: box.right,
                  width: box.width,
                  detailsOpen:
                    child instanceof HTMLDetailsElement ? child.open : null,
                  contentVisibility: getComputedStyle(child).contentVisibility,
                };
              })
              .filter(
                (child) =>
                  child.scrollWidth > child.clientWidth + 1 ||
                  child.right > bounds.right + 1 ||
                  child.tag === "DETAILS" ||
                  child.className === "personality-inline-editor",
              )
          : [],
    };
  });
  if (geometry.agent) {
    expect(geometry.firstClasses).toEqual([
      "personality-identity",
      "personality-preferences",
    ]);
    expect(geometry.headingChildren).toEqual([]);
    await expect(editor.locator(".personality-heading")).toHaveCount(0);
    await expect(
      editor.getByRole("heading", { name: "设定", exact: true }),
    ).toHaveCount(0);
    await expect(
      editor.locator('.personality-identity input[aria-label="使用人格设定"]'),
    ).toHaveCount(1);
    expect(geometry.master.left).toBeGreaterThan(geometry.name.right);
    expect(geometry.master.right).toBeLessThanOrEqual(geometry.identity.right);
    expect(
      Math.abs(
        (geometry.avatar.top + geometry.avatar.bottom) / 2 -
          (geometry.masterSwitch.top + geometry.masterSwitch.bottom) / 2,
      ) / scale,
    ).toBeLessThanOrEqual(1);
  } else {
    expect(geometry.firstClasses).toEqual([
      "personality-heading",
      "personality-identity",
    ]);
    expect(geometry.headingChildren).toEqual(["H2", "LABEL"]);
    expect(geometry.heading!.height / scale).toBeLessThanOrEqual(44);
    expect(geometry.master.left).toBeGreaterThan(geometry.title!.right);
    expect(geometry.master.right).toBeLessThanOrEqual(geometry.heading!.right);
    expect(
      Math.abs(
        (geometry.title!.top + geometry.title!.bottom) / 2 -
          (geometry.masterSwitch.top + geometry.masterSwitch.bottom) / 2,
      ) / scale,
    ).toBeLessThanOrEqual(1);
  }
  for (const portrait of [geometry.portrait, geometry.avatar]) {
    expect(portrait.cssWidth).toBeCloseTo(64, 1);
    expect(portrait.cssHeight).toBeCloseTo(64, 1);
    expect(portrait.width / scale).toBeCloseTo(64, 1);
    expect(portrait.height / scale).toBeCloseTo(64, 1);
    expect(portrait.radius).toBe(18);
  }
  expect(geometry.camera.width / scale).toBeCloseTo(32, 1);
  expect(geometry.camera.height / scale).toBeCloseTo(32, 1);
  if (geometry.mark) {
    expect(geometry.mark.cssWidth).toBe(40);
    expect(geometry.mark.cssHeight).toBe(40);
  }
  expect(geometry.name.left).toBeGreaterThan(geometry.portrait.right);
  expect(geometry.camera.right).toBeLessThanOrEqual(geometry.name.left);
  expect(geometry.name.right).toBeLessThanOrEqual(geometry.identity.right);
  // An uploaded portrait adds a real, keyboard-reachable remove action to the
  // name column; allow that row without weakening the avatar size/alignment.
  expect(geometry.identity.height / scale).toBeLessThanOrEqual(
    geometry.hasRemoveAvatar ? 136 : 120,
  );
  if (!geometry.agent)
    expect(geometry.identity.top).toBeGreaterThanOrEqual(
      geometry.heading!.bottom + 8 * scale,
    );
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.overflow, JSON.stringify(geometry)).toBe(false);
  return geometry;
}

async function cssProfileZoom(page: Page, scale: number) {
  await page.evaluate(async (zoom) => {
    document.documentElement.style.zoom = String(zoom);
    // Bound the shell's logical canvas, otherwise root CSS zoom multiplies
    // 100dvh too. This is CSS geometry coverage, NOT Electron native zoom.
    const shell = document.querySelector<HTMLElement>(".app");
    if (shell) shell.style.height = `calc(100dvh / ${zoom})`;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  }, scale);
}

async function profileSelectionPaint(editor: Locator) {
  return editor.evaluate((element) => {
    const probe = document.createElement("span");
    probe.hidden = true;
    element.append(probe);
    const color = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const background = (value: string) => {
      probe.style.background = value;
      return getComputedStyle(probe).backgroundImage;
    };
    const tokens = {
      accent: color("var(--accent)"),
      neutral: color("var(--muted)"),
      effective: color("var(--profile-accent)"),
      selectedText: color("var(--profile-selected-text)"),
      selectedSurface: color("var(--profile-selected-surface)"),
      badgeSurface: color(
        "color-mix(in srgb, var(--profile-accent) 10%, var(--paper))",
      ),
      range: background(
        "linear-gradient(90deg, color-mix(in srgb, var(--profile-accent) 36%, var(--paper)), color-mix(in srgb, var(--profile-accent) 70%, var(--paper))), linear-gradient(color-mix(in srgb, var(--ink) 9%, var(--paper)), color-mix(in srgb, var(--ink) 9%, var(--paper)))",
      ),
    };
    probe.remove();
    const choices = [
      ...element.querySelectorAll<HTMLInputElement>(
        '.personality-optional > input[type="checkbox"]',
      ),
    ].map((input) => {
      const style = getComputedStyle(input);
      return {
        name: input.getAttribute("aria-label"),
        checked: input.checked,
        disabled: input.disabled,
        background: style.backgroundColor,
        border: style.borderColor,
        opacity: style.opacity,
        outline: style.outlineStyle,
        shadow: style.boxShadow,
        dotTransform: getComputedStyle(input, "::before").transform,
      };
    });
    const ranges = [
      ...element.querySelectorAll<HTMLInputElement>('input[type="range"]'),
    ].map((input) => {
      const style = getComputedStyle(input);
      return {
        value: input.value,
        disabled: input.disabled,
        fill: style.getPropertyValue("--trait-fill").trim(),
        background: style.backgroundImage,
        opacity: style.opacity,
        outline: style.outlineStyle,
        shadow: style.boxShadow,
      };
    });
    const badges = [
      ...element.querySelectorAll<HTMLElement>(
        ".personality-trait-value output b",
      ),
    ].map((badge) => {
      const style = getComputedStyle(badge);
      return {
        text: badge.textContent,
        background: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
      };
    });
    const radio = element.querySelector<HTMLInputElement>(
      '.personality-speaking input[type="radio"]:checked',
    )!;
    const speaking = getComputedStyle(radio.nextElementSibling!);
    return {
      tokens,
      choices,
      ranges,
      badges,
      speaking: {
        value: radio.value,
        disabled: radio.matches(":disabled"),
        background: speaking.backgroundColor,
        color: speaking.color,
        weight: speaking.fontWeight,
        opacity: speaking.opacity,
      },
      rootOpacity: getComputedStyle(element).opacity,
    };
  });
}

async function expectProfileSelectionPaint(editor: Locator, enabled: boolean) {
  await expectProfileUsage(editor, enabled);
  // Wait for the actual painted switch transition, not only the data flag.
  await expect
    .poll(async () => {
      const paint = await profileSelectionPaint(editor);
      return paint.choices.every(
        (choice) => choice.background === paint.tokens.effective,
      );
    })
    .toBe(true);
  const paint = await profileSelectionPaint(editor);
  expect(paint.tokens.effective).toBe(
    enabled ? paint.tokens.accent : paint.tokens.neutral,
  );
  expect(paint.rootOpacity).toBe("1");
  expect(paint.choices).toHaveLength(5);
  for (const choice of paint.choices) {
    expect(choice.checked).toBe(true);
    expect(choice.disabled).toBe(false);
    expect(choice.background).toBe(paint.tokens.effective);
    expect(choice.border).toBe(paint.tokens.effective);
    expect(choice.dotTransform).toBe("matrix(1, 0, 0, 1, 12, 0)");
    expect(choice.opacity).toBe("1");
    expect(choice.outline).toBe("none");
    expect(choice.shadow).toBe("none");
  }
  expect(paint.ranges).toHaveLength(4);
  for (const range of paint.ranges) {
    expect(range.disabled).toBe(false);
    expect(range.background).toBe(paint.tokens.range);
    expect(range.fill).toBe(`${Number(range.value) * 20}%`);
    expect(range.opacity).toBe("1");
    expect(range.outline).toBe("none");
    expect(range.shadow).toBe("none");
  }
  for (const badge of paint.badges) {
    expect(badge.background).toBe(paint.tokens.badgeSurface);
    expect(badge.color).toBe(paint.tokens.selectedText);
    expect(badge.opacity).toBe("1");
  }
  expect(paint.speaking.disabled).toBe(false);
  expect(paint.speaking.background).toBe(paint.tokens.selectedSurface);
  expect(paint.speaking.color).toBe(paint.tokens.selectedText);
  expect(paint.speaking.weight).toBe(enabled ? "550" : "400");
  expect(paint.speaking.opacity).toBe("1");
  return paint;
}

for (const appearance of ["light", "dark"] as const) {
  test(`整体 Profile 关闭使用中性灰，${appearance}保留选择并可编辑，刷新与重新启用恢复实际颜色`, async ({
    page,
  }, testInfo) => {
    const snapshot = initialProfile();
    snapshot.agent.data = {
      ...snapshot.agent.data,
      name: "Echo",
      traits: { humor: 4, rigor: 5, warmth: 2, verbosity: 2 },
      speechStyle: "thoughtful",
      customStyle: "TEST 已确认的风格原文，关闭不能删除。",
    };
    const original = structuredClone(snapshot.agent.data);
    const fixture = await profileFixture(page, snapshot);
    await page.emulateMedia({
      colorScheme: appearance,
      reducedMotion: "reduce",
    });
    await enterDialogue(page);
    let editor = await openAgent(page);
    await openPreferences(editor);
    await page.mouse.move(1, 1);
    const on = await expectProfileSelectionPaint(editor, true);
    expect(on.ranges.map((range) => range.value)).toEqual(["4", "5", "2", "2"]);
    expect(on.badges.map((badge) => badge.text)).toEqual(["4", "5", "2", "2"]);
    expect(on.speaking.value).toBe("thoughtful");
    const custom = editor.locator('textarea[aria-label="自定义讲话风格"]');
    await expect(custom).toBeVisible();
    await expect(custom).toHaveValue(original.customStyle!);
    const confirmedExpression = await editor
      .locator(".personality-expression")
      .textContent();
    const onLabels = (await paintedProfileLabels(editor))
      .split("\n")
      .filter((label) => label !== confirmedExpression)
      .join("\n");
    expect(fixture.commands).toEqual([]);
    await editor.screenshot({
      path: testInfo.outputPath(`profile-usage-${appearance}-on.png`),
    });

    await setProfileUsage(editor, false);
    await waitForAutosave(editor);
    await page.mouse.move(1, 1);
    const off = await expectProfileSelectionPaint(editor, false);
    expect(off.tokens.effective).not.toBe(on.tokens.effective);
    expect(off.ranges.map((range) => range.value)).toEqual(
      on.ranges.map((range) => range.value),
    );
    expect(off.badges.map((badge) => badge.text)).toEqual(
      on.badges.map((badge) => badge.text),
    );
    expect(off.ranges[0]!.background).not.toBe(on.ranges[0]!.background);
    expect(off.badges[0]!.background).not.toBe(on.badges[0]!.background);
    expect(off.speaking.background).not.toBe(on.speaking.background);
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: false,
      data: original,
    });
    await expect(custom).toHaveValue(original.customStyle!);
    // No new banner, status label, outer ring, or save/restore action is
    // needed to communicate the global usage choice.
    expect(await paintedProfileLabels(editor)).toBe(onLabels);
    await expectQuietProfileLabels(editor, true);
    await editor.screenshot({
      path: testInfo.outputPath(`profile-usage-${appearance}-off.png`),
    });

    const writes = fixture.commands.length;
    await page.reload();
    editor = await openAgent(page);
    await expect(
      editor.locator("details.personality-preferences"),
    ).toHaveAttribute("open", "");
    const reloaded = await expectProfileSelectionPaint(editor, false);
    expect(reloaded).toEqual(off);
    expect(fixture.commands).toHaveLength(writes);
    await expect(
      editor.locator('textarea[aria-label="自定义讲话风格"]'),
    ).toHaveValue(original.customStyle!);
    await editor.screenshot({
      path: testInfo.outputPath(`profile-usage-${appearance}-off-reload.png`),
    });

    // Neutral means retained but not applied, not disabled or erased. All
    // original editing paths stay live without implicitly restoring usage.
    await setLevel(editor, "幽默", 3);
    await waitForAutosave(editor);
    await editor.getByRole("radio", { name: "自然", exact: true }).check();
    await waitForAutosave(editor);
    const editedStyle = `${original.customStyle} TEST 关闭后仍能修改。`;
    const reopenedCustom = editor.locator(
      'textarea[aria-label="自定义讲话风格"]',
    );
    await reopenedCustom.fill(editedStyle);
    await reopenedCustom.blur();
    await waitForAutosave(editor);
    await expectProfileUsage(editor, false);
    expect(
      fixture.commands
        .slice(writes)
        .every((command) => command.enabled === false),
    ).toBe(true);
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: false,
      data: {
        ...original,
        traits: { ...original.traits, humor: 3 },
        speechStyle: "natural",
        customStyle: editedStyle,
      },
    });
    await expectProfileSelectionPaint(editor, false);

    const retained = structuredClone(fixture.snapshot.agent.data);
    await setProfileUsage(editor, true);
    await waitForAutosave(editor);
    await page.mouse.move(1, 1);
    const restored = await expectProfileSelectionPaint(editor, true);
    expect(restored.tokens).toEqual(on.tokens);
    expect(restored.ranges.map((range) => range.value)).toEqual([
      "3",
      "5",
      "2",
      "2",
    ]);
    expect(restored.speaking.value).toBe("natural");
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: true,
      data: retained,
    });
    await expect(reopenedCustom).toHaveValue(editedStyle);
    await editor.screenshot({
      path: testInfo.outputPath(`profile-usage-${appearance}-reenabled.png`),
    });
  });
}

for (const appearance of ["light", "dark"] as const) {
  test(`自定义风格同一行开关，${appearance}关闭保留确认原文，刷新后重新开启恢复`, async ({
    page,
  }, testInfo) => {
    const snapshot = initialProfile();
    snapshot.agent.data = structuredClone(defaultAgentProfile);
    snapshot.agent.enabled = false;
    snapshot.agent.revision = 0;
    const fixture = await profileFixture(page, snapshot);
    await page.setViewportSize({ width: 390, height: 960 });
    await page.emulateMedia({
      colorScheme: appearance,
      reducedMotion: "reduce",
    });
    await enterDialogue(page);
    let editor = await openAgent(page);
    await expectCompactIdentity(editor);
    await expect(editor.locator(".personality-expression")).toHaveCount(0);
    await expect(
      editor.locator(".personality-preferences > summary"),
    ).toHaveText("个性与表达");
    await openCustom(editor);
    const row = editor.locator(".personality-custom > label");
    const choice = editor.getByRole("checkbox", {
      name: "设置自定义风格",
      exact: true,
    });
    const text = editor.locator('textarea[aria-label="自定义讲话风格"]');
    await expect(row.locator("summary,svg")).toHaveCount(0);
    await expect(row.locator("span")).toHaveText("自定义风格");
    await expect(text).toBeHidden();
    const geometry = await row.evaluate((element) => {
      const title = element.querySelector("span")!.getBoundingClientRect();
      const input = element.querySelector("input")!.getBoundingClientRect();
      return {
        gap: input.left - title.right,
        y: Math.abs((title.top + title.bottom - input.top - input.bottom) / 2),
        height: element.getBoundingClientRect().height,
      };
    });
    expect(geometry.gap).toBeGreaterThan(0);
    expect(geometry.y).toBeLessThanOrEqual(1);
    expect(geometry.height).toBe(44);
    await choice.check();
    await expect(text).toBeVisible();
    await expect(text).toBeFocused();
    await waitForAutosave(editor);
    expect(fixture.commands).toEqual([]);
    expect(fixture.snapshot.agent.revision).toBe(0);
    const value = "TEST 先给结论，再聊细节；保留这句原文。";
    await text.fill(value);
    await text.blur();
    await waitForAutosave(editor);
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: true,
      data: { customStyle: value },
    });
    await choice.uncheck();
    await waitForAutosave(editor);
    await expect(text).toBeHidden();
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: true,
      data: { customStyle: value, customStyleEnabled: false },
    });
    await expectEmptyProfileUsage(editor, true);
    await expect(editor.locator(".personality-expression")).toHaveCount(0);
    await page.reload();
    editor = await openAgent(page);
    await openCustom(editor);
    const reopenedChoice = editor.getByRole("checkbox", {
      name: "设置自定义风格",
      exact: true,
    });
    const reopenedText = editor.locator(
      'textarea[aria-label="自定义讲话风格"]',
    );
    await expect(reopenedChoice).not.toBeChecked();
    await expect(reopenedText).toBeHidden();
    await expect(reopenedText).toHaveValue(value);
    await reopenedChoice.check();
    await waitForAutosave(editor);
    await expect(reopenedText).toBeVisible();
    await expect(reopenedText).toHaveValue(value);
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: true,
      data: { customStyle: value },
    });
    expect(fixture.snapshot.agent.data.customStyleEnabled).toBeUndefined();
    expect(fixture.commands).toHaveLength(3);
    await editor.screenshot({
      path: testInfo.outputPath(`custom-style-single-row-${appearance}.png`),
    });
  });
}

test("资料分组和已安装执行方式客户端记住展开及折叠，刷新和重开不改资料或其他身份偏好", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  fixture.runtime.harnesses = [
    { id: "TEST-persisted-disclosure", version: "1" },
  ];
  await enterDialogue(page);
  const draft = "TEST 折叠刷新期间不丢失的未发送草稿";
  await (await openInput(page)).fill(draft);
  let editor = await openAgent(page);
  const expressions = () => editor.locator("details.personality-preferences");
  const capabilities = () => page.locator("details.subject-settings-system");
  const harnesses = () =>
    capabilities().locator(".subject-settings-group details");
  const boot = fixture.conversation.client.boot;
  const prefix = `${applicationStoragePrefix}${boot.centerId}:${boot.principalId}:disclosure:`;
  const keys = [
    "profile:agent:expression",
    "subject:capabilities",
    "subject:installed-harnesses",
  ].map((suffix) => prefix + suffix);
  const stored = () =>
    page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), keys);
  expect(await stored()).toEqual([null, null, null]);
  await openPreferences(editor);
  await openSystem(page);
  await harnesses().locator(":scope > summary").click();
  await expect.poll(stored).toEqual(["true", "true", "true"]);
  await page.reload();
  editor = await openAgent(page);
  for (const disclosure of [expressions(), capabilities(), harnesses()])
    await expect(disclosure).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "隐藏右侧栏", exact: true }).click();
  editor = await openAgent(page);
  for (const disclosure of [expressions(), capabilities(), harnesses()])
    await expect(disclosure).toHaveAttribute("open", "");
  await harnesses().locator(":scope > summary").click();
  await expect.poll(stored).toEqual(["true", "true", "false"]);
  await expect(capabilities()).toHaveAttribute("open", "");
  await expressions().locator(":scope > summary").click();
  await capabilities().locator(":scope > summary").click();
  await expect.poll(stored).toEqual(["false", "false", "false"]);
  const foreign = keys.map((key) =>
    key.replace(
      `${boot.centerId}:${boot.principalId}:`,
      `${boot.centerId}:TEST-other-principal:`,
    ),
  );
  await page.evaluate(
    (keys) => keys.forEach((key) => localStorage.setItem(key, "true")),
    foreign,
  );
  await page.reload();
  editor = await openAgent(page);
  for (const disclosure of [expressions(), capabilities(), harnesses()])
    await expect(disclosure).not.toHaveAttribute("open");
  expect(
    await page.evaluate(
      (keys) => keys.map((key) => localStorage.getItem(key)),
      foreign,
    ),
  ).toEqual(["true", "true", "true"]);
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify("true")),
    keys[0]!,
  );
  await page.reload();
  editor = await openAgent(page);
  await expect(expressions()).not.toHaveAttribute("open");
  await expect(await openInput(page)).toHaveValue(draft);
  expect(fixture.commands).toEqual([]);
});

for (const subject of ["agent", "human"] as const) {
  test(`${subject === "agent" ? "Agent" : "Human"} 查看资料与打开局部编辑零写入，IME和Escape不误关对话框`, async ({
    page,
  }, testInfo) => {
    const snapshot = initialProfile();
    snapshot.agent.data = structuredClone(defaultAgentProfile);
    snapshot.agent.enabled = false;
    snapshot.agent.revision = 0;
    snapshot.human.data = structuredClone(defaultHumanProfile);
    snapshot.human.enabled = false;
    snapshot.human.revision = 0;
    const fixture = await profileFixture(page, snapshot);
    await page.setViewportSize({ width: 390, height: 960 });
    await enterDialogue(page);
    const editor =
      subject === "agent" ? await openAgent(page) : await openHuman(page);
    await expectCompactIdentity(editor);
    await expect(editor.getByRole("textbox")).toHaveCount(0);
    await expect(editor.getByRole("slider")).toHaveCount(0);
    await expect(editor.getByRole("checkbox")).toHaveCount(1);
    await expectEmptyProfileUsage(editor);
    const display = editor.getByRole("button", {
      name: subject === "agent" ? "编辑智能体名字" : "编辑你的名字",
      exact: true,
    });
    await expect(display).toHaveText(subject === "agent" ? "Morphz" : "我");
    if (subject === "agent") {
      await expect(
        editor.locator(".personality-preferences"),
      ).not.toHaveAttribute("open", "");
      await expect(
        page.locator(".subject-settings-system"),
      ).not.toHaveAttribute("open", "");
    }
    await page.screenshot({
      path: testInfo.outputPath(`${subject}-personal-view.png`),
      fullPage: true,
    });
    const name = await editText(editor, "name");
    await expectInplaceOnly(editor);
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("data-configured", "false");
    expect(fixture.commands).toHaveLength(0);
    // Composition flags are DOM regression evidence, not native OS IME acceptance.
    for (const key of ["Enter", "Escape"]) {
      const notCancelled = await name.evaluate(
        (input, key) =>
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              isComposing: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        key,
      );
      // Escape must suppress the dialog's native cancel even during IME;
      // its editor remains open until a non-composition key completes it.
      if (key === "Escape") expect(notCancelled).toBe(false);
      await expect(name).toBeVisible();
      await expect(name).toBeFocused();
      expect(fixture.commands).toHaveLength(0);
    }
    await name.press("Escape");
    await expect(name).toBeHidden();
    await expect(display).toBeFocused();
    if (subject === "human") {
      const dialog = page.getByRole("dialog", { name: "设置", exact: true });
      await expect(dialog).toBeVisible();
      const address = await editText(editor, "preferredAddress");
      await expect(address).toHaveValue("");
      await expect(address).toHaveAttribute("data-configured", "false");
      await address.press("Escape");
      await expect(dialog).toBeVisible();
    }
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.snapshot[subject]).toMatchObject({
      revision: 0,
      enabled: false,
    });
    await clearText(editor, "name");
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.snapshot[subject].data.name).toBeNull();
    await expect(editor.getByRole("textbox")).toHaveCount(0);
  });
}

for (const appearance of ["light", "dark"] as const) {
  test(`原位编辑 ${appearance} 阅读与编辑文字和框同位置，390px及CSS200%不移头像或开关且零写入`, async ({
    page,
  }, testInfo) => {
    const fixture = await profileFixture(page);
    await page.emulateMedia({
      colorScheme: appearance,
      reducedMotion: "reduce",
    });
    await enterDialogue(page);
    for (const subject of ["agent", "human"] as const) {
      const editor =
        subject === "agent" ? await openAgent(page) : await openHuman(page);
      for (const [width, scale] of [
        [390, 1],
        [1440, 2],
      ] as const) {
        await page.setViewportSize({ width, height: 960 });
        await cssProfileZoom(page, scale);
        await expectCompactIdentity(editor, scale);
        await expectInplaceGeometry(editor, "name", scale);
        if (subject === "human")
          await expectInplaceGeometry(editor, "preferredAddress", scale);
        await expectInplaceOnly(editor);
        await editText(editor, "name");
        await page.screenshot({
          path: testInfo.outputPath(
            `${subject}-${appearance}-${width}-${scale}-inplace.png`,
          ),
          fullPage: true,
        });
        await profileText(editor, "name").press("Escape");
      }
      await cssProfileZoom(page, 1);
    }
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.snapshot.agent.revision).toBe(1);
    expect(fixture.snapshot.human.revision).toBe(1);
  });
}

test("原位空名字真实失焦清null且不抢目标，Enter清称呼后Human回到空资料，Agent清末项保留on", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.data = {
    ...structuredClone(defaultAgentProfile),
    name: "TEST 唯一名字",
  };
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const agent = await openAgent(page);
  const name = await editText(agent, "name");
  await name.fill("");
  const summary = agent.locator(".personality-preferences > summary");
  await summary.click();
  await expect(name).toBeHidden();
  await expect(summary).toBeFocused();
  const agentClear = await waitForAutosave(agent);
  expect(agentClear).toMatchObject({
    subject: "agent",
    enabled: true,
    data: defaultAgentProfile,
  });
  await expect(summary).toBeFocused();
  await expectEmptyProfileUsage(agent, true);
  await expectInplaceOnly(agent);
  const human = await openHuman(page);
  const humanName = await editText(human, "name");
  await humanName.fill("");
  await profileTextDisplay(human, "preferredAddress").click();
  const address = profileText(human, "preferredAddress");
  await expect(humanName).toBeHidden();
  await expect(address).toBeFocused();
  const humanClear = await waitForAutosave(human);
  expect(humanClear).toMatchObject({
    subject: "human",
    enabled: true,
    data: { name: null, preferredAddress: "TEST 称呼" },
  });
  await clearText(human, "preferredAddress");
  const addressClear = await waitForAutosave(human);
  expect(addressClear).toMatchObject({
    subject: "human",
    enabled: false,
    data: defaultHumanProfile,
  });
  await expectEmptyProfileUsage(human);
  await expectInplaceOnly(human);
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toBeVisible();
  expect(fixture.commands).toHaveLength(3);
  expect(fixture.commands.map((command) => command.subject)).toEqual([
    "agent",
    "human",
    "human",
  ]);
});

test("原位IME未完成不退出或清除，同frame组合尾input与单项合并最新名，空组合结束不复活旧名", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.data = {
    ...structuredClone(defaultAgentProfile),
    name: "Echo",
  };
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const editor = await openAgent(page);
  await openPreferences(editor);
  const clockStart = new Date("2026-10-02T04:00:00.000Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  let name = await editText(editor, "name");
  // These are real DOM composition handlers, not native-system IME acceptance.
  await name.dispatchEvent("compositionstart", { data: "" });
  await name.fill("");
  await page.clock.runFor(450);
  await name.press("Enter");
  await expect(name).toBeVisible();
  expect(fixture.commands).toHaveLength(0);
  expect(fixture.snapshot.agent.data.name).toBe("Echo");
  const summary = editor.locator(".personality-preferences > summary");
  await summary.focus();
  await expect(name).toBeVisible();
  await expect(summary).toBeFocused();
  expect(fixture.commands).toHaveLength(0);
  await name.evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    // The final DOM value was not an earlier React change. End, its trailing
    // input, and another field's click deliberately share one event turn.
    setter.call(input, "TEST 组合结束的最新文字");
    input.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "TEST 组合结束的最新文字",
        bubbles: true,
      }),
    );
    input.dispatchEvent(
      new InputEvent("input", {
        data: "TEST 组合结束的最新文字",
        inputType: "insertCompositionText",
        bubbles: true,
      }),
    );
    input
      .closest(".personality-profile")!
      .querySelector<HTMLInputElement>('input[aria-label="设置幽默"]')!
      .click();
  });
  await expect(name).toBeHidden();
  const composed = await waitForAutosave(editor);
  expect(composed).toMatchObject({
    enabled: true,
    data: {
      name: "TEST 组合结束的最新文字",
      traits: { ...defaultAgentProfile.traits, humor: 0 },
    },
  });
  await expect(summary).toBeFocused();
  await page.clock.resume();
  name = await editText(editor, "name");
  await name.dispatchEvent("compositionstart", { data: "" });
  await name.fill("");
  await name.press("Escape");
  await expect(name).toBeVisible();
  expect(fixture.commands).toHaveLength(1);
  await summary.focus();
  await expect(name).toBeVisible();
  await name.evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "");
    input.dispatchEvent(
      new CompositionEvent("compositionend", { data: "", bubbles: true }),
    );
    // A trailing old-value input cannot reopen a closed editing epoch or
    // replace the explicit null chosen by the completed empty blur.
    setter.call(input, "TEST 组合结束的最新文字");
    input.dispatchEvent(
      new InputEvent("input", {
        data: "TEST 组合结束的最新文字",
        inputType: "insertCompositionText",
        bubbles: true,
      }),
    );
    input
      .closest(".personality-profile")!
      .querySelector<HTMLInputElement>('input[aria-label="设置幽默"]')!
      .click();
  });
  await expect(name).toBeHidden();
  const cleared = await waitForAutosave(editor);
  expect(cleared).toMatchObject({ enabled: true, data: defaultAgentProfile });
  expect(fixture.commands).toHaveLength(2);
  const human = await openHuman(page);
  const address = await editText(human, "preferredAddress");
  await page.clock.pauseAt(
    await page.evaluate(() => new Date(Date.now() + 1000).toISOString()),
  );
  await address.dispatchEvent("compositionstart", { data: "" });
  await address.fill("");
  await page.clock.runFor(450);
  await expect(address).toBeFocused();
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.snapshot.human.data.preferredAddress).toBe("TEST 称呼");
  await address.fill("TEST 中文候选");
  await page.clock.runFor(450);
  await expect(address).toHaveValue("TEST 中文候选");
  expect(fixture.commands).toHaveLength(2);
  await address.evaluate((input) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "TEST 最终称呼");
    input.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "TEST 最终称呼",
        bubbles: true,
      }),
    );
  });
  await page.clock.runFor(449);
  expect(fixture.commands).toHaveLength(2);
  await page.clock.runFor(1);
  await expect
    .poll(() => fixture.snapshot.human.data.preferredAddress)
    .toBe("TEST 最终称呼");
  await address.press("Enter");
  const humanFinal = await waitForAutosave(human);
  expect(humanFinal).toMatchObject({
    subject: "human",
    enabled: true,
    data: { name: "TEST 本人", preferredAddress: "TEST 最终称呼" },
  });
  expect(fixture.commands).toHaveLength(3);
  await editText(human, "preferredAddress");
  await address.dispatchEvent("compositionstart", { data: "" });
  await address.fill("");
  await profileTextDisplay(human, "name").focus();
  await page.clock.runFor(450);
  await expect(address).toBeVisible();
  expect(fixture.commands).toHaveLength(3);
  expect(fixture.snapshot.human.data.preferredAddress).toBe("TEST 最终称呼");
  await address.evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "");
    input.dispatchEvent(
      new CompositionEvent("compositionend", { data: "", bubbles: true }),
    );
    setter.call(input, "TEST 最终称呼");
    input.dispatchEvent(
      new InputEvent("input", {
        data: "TEST 最终称呼",
        inputType: "insertCompositionText",
        bubbles: true,
      }),
    );
  });
  await expect(address).toBeHidden();
  const humanUnset = await waitForAutosave(human);
  expect(humanUnset).toMatchObject({
    subject: "human",
    enabled: true,
    data: { name: "TEST 本人", preferredAddress: null },
  });
  expect(fixture.commands).toHaveLength(4);
  await page.clock.resume();
});

for (const subject of ["agent", "human"] as const) {
  test(`${subject === "agent" ? "Agent" : "Human"} 相机仅悬停或键盘进入头像时显示，离开恢复隐藏且不写资料`, async ({
    page,
  }, testInfo) => {
    const fixture = await profileFixture(page);
    const avatarWrites: string[] = [];
    page.on("request", (request) => {
      if (avatarUrl.test(request.url()) && request.method() !== "GET")
        avatarWrites.push(request.url());
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await enterDialogue(page);
    const editor =
      subject === "agent" ? await openAgent(page) : await openHuman(page);
    const portrait = editor.locator(".personality-portrait");
    const camera = editor.getByRole("button", {
      name: subject === "agent" ? "上传智能体头像" : "上传自己的头像",
      exact: true,
    });
    await page.mouse.move(1, 1);
    await expect(camera).toHaveCSS("opacity", "0");
    await expect(camera).toHaveCSS("pointer-events", "none");
    expect(
      await camera.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return button === hit || button.contains(hit);
      }),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`${subject}-camera-idle.png`),
      fullPage: true,
    });
    await portrait.hover();
    await expect(camera).toHaveCSS("opacity", "1");
    await expect(camera).toHaveCSS("pointer-events", "auto");
    await page.screenshot({
      path: testInfo.outputPath(`${subject}-camera-hover.png`),
      fullPage: true,
    });
    await page.mouse.move(1, 1);
    await expect(camera).toHaveCSS("opacity", "0");
    if (subject === "agent") {
      // The visible whole-Profile switch follows the name in the identity row.
      await editor.locator(".personality-preferences > summary").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(profileUsageControl(editor)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(
        editor.getByRole("button", { name: "编辑智能体名字", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
    } else {
      const master = editor.getByRole("checkbox", {
        name: "使用个人资料",
        exact: true,
      });
      await master.focus();
      await master.press("Tab");
    }
    await expect(camera).toBeFocused();
    await expect(camera).toHaveCSS("opacity", "1");
    await expect(camera).toHaveCSS("pointer-events", "auto");
    await page.screenshot({
      path: testInfo.outputPath(`${subject}-camera-keyboard.png`),
      fullPage: true,
    });
    await camera.press("Tab");
    await expect(
      editor.getByRole("button", {
        name: subject === "agent" ? "编辑智能体名字" : "编辑你的名字",
        exact: true,
      }),
    ).toBeFocused();
    await expect(camera).toHaveCSS("opacity", "0");
    expect(fixture.commands).toHaveLength(0);
    expect(avatarWrites).toEqual([]);
  });
}

test("胶囊开关与滑杆鼠标没有额外圈线，键盘 Tab 内部提示不加外圈且保存实际选值", async ({
  page,
}, testInfo) => {
  const fixture = await profileFixture(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await enterDialogue(page);
  const editor = await openAgent(page);
  const usage = profileUsageControl(editor);
  await page.mouse.move(1, 1);
  const onAppearance = await expectUsageSwitchAppearance(usage);
  expect(onAppearance.checked).toBe(true);
  await usage.hover();
  await page.mouse.down();
  try {
    expect(fixture.commands).toHaveLength(0);
    // Release outside the target: pointer feedback alone must not toggle it.
    await page.mouse.move(1, 1);
  } finally {
    await page.mouse.up();
  }
  await expect(usage).toBeChecked();
  expect(fixture.commands).toHaveLength(0);
  await setProfileUsage(editor, false);
  await expectSwitchPointerFocus(profileUsageControl(editor));
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.enabled).toBe(false);
  const offAppearance = await expectUsageSwitchAppearance(usage);
  expect(offAppearance.checked).toBe(false);
  expect(offAppearance.background).not.toBe(onAppearance.background);
  const humor = editor.getByRole("checkbox", { name: "设置幽默", exact: true });
  await openPreferences(editor);
  await humor.click();
  await expectSwitchPointerFocus(humor);
  await expect(humor).not.toBeChecked();
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.data.traits.humor).toBeNull();
  await page.screenshot({
    path: testInfo.outputPath("switch-mouse-no-ring.png"),
    fullPage: true,
  });
  const rigor = editor.getByRole("checkbox", { name: "设置严谨", exact: true });
  await humor.press("Tab");
  await expectSwitchKeyboardFocus(rigor);
  await rigor.press("Shift+Tab");
  await expectSwitchKeyboardFocus(humor);
  await humor.press("Space");
  await expect(humor).toBeChecked();
  await expectSwitchKeyboardFocus(humor);
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.data.traits.humor).toBe(0);
  const slider = editor.getByRole("slider", {
    name: "幽默程度",
    exact: true,
  });
  await slider.click();
  await expect(slider).toBeFocused();
  await expect(slider).toHaveCSS("outline-style", "none");
  await expect(slider).toHaveCSS("box-shadow", "none");
  expect(
    await slider.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(false);
  const pointerLevel = Number(await slider.inputValue());
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.data.traits.humor).toBe(pointerLevel);
  expect(fixture.snapshot.agent.enabled).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("range-mouse-no-ring.png"),
    fullPage: true,
  });
  await slider.press("Shift+Tab");
  await expectSwitchKeyboardFocus(humor);
  await humor.press("Tab");
  await expect(slider).toBeFocused();
  await expect(slider).toHaveCSS("outline-style", "none");
  await expect(slider).toHaveCSS("box-shadow", "none");
  const thumbFocus = await slider.evaluate((element) => {
    const shadow = getComputedStyle(element).getPropertyValue(
      "--trait-thumb-shadow",
    );
    const probe = document.createElement("span");
    probe.hidden = true;
    probe.style.color = "var(--ink)";
    probe.style.boxShadow = shadow;
    element.parentElement!.append(probe);
    const style = getComputedStyle(probe);
    const ink = style.color;
    const resolvedShadow = style.boxShadow;
    probe.remove();
    return {
      visible: element.matches(":focus-visible"),
      // Chromium does not expose a reliable thumb pseudo-element style. Read
      // its live inherited paint variable and retain a real rendered image.
      shadow,
      resolvedShadow,
      ink,
    };
  });
  expect(thumbFocus.visible).toBe(true);
  expect(thumbFocus.shadow).toContain("inset 0 0 0 2px");
  expect(thumbFocus.resolvedShadow).toContain(
    `${thumbFocus.ink} 0px 0px 0px 2px inset`,
  );
  await slider.press("Home");
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  await expect(slider).toHaveAttribute("aria-valuetext", /^2，/);
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.data.traits.humor).toBe(2);
  expect(fixture.snapshot.agent.enabled).toBe(false);
  await expect(slider).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("range-keyboard-internal-cue.png"),
    fullPage: true,
  });
  // The identity-row native checkbox remains keyboard reachable independently
  // of field controls and has a keyboard-only internal cue, not an outer ring.
  await usage.focus();
  await usage.press("Shift+Tab");
  await expect(usage).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expectSwitchKeyboardFocus(usage);
  await page.screenshot({
    path: testInfo.outputPath("switch-keyboard-internal-cue.png"),
    fullPage: true,
  });
});

test.describe("触控资料操作", () => {
  test.use({ hasTouch: true });
  test("身份开关44px触控目标可用，双方相机取消选择不上传或改资料", async ({
    page,
  }, testInfo) => {
    const fixture = await profileFixture(page);
    const avatarWrites: string[] = [];
    page.on("request", (request) => {
      if (avatarUrl.test(request.url()) && request.method() !== "GET")
        avatarWrites.push(request.url());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await enterDialogue(page);
    expect(
      await page.evaluate(
        () => matchMedia("(hover: none), (pointer: coarse)").matches,
      ),
    ).toBe(true);
    for (const subject of ["agent", "human"] as const) {
      const editor =
        subject === "agent" ? await openAgent(page) : await openHuman(page);
      if (subject === "agent") {
        const usage = profileUsageControl(editor);
        await expectUsageSwitchAppearance(usage, { touch: true });
        await usage.scrollIntoViewIfNeeded();
        await expect(usage).toBeInViewport({ ratio: 1 });
        const selected = structuredClone(fixture.snapshot.agent.data);
        // Touch the 44px label outside the 32×20 painted switch. The extra
        // target area must actually toggle its associated native input.
        const target = usage.locator("..");
        await target.tap({ position: { x: 4, y: 4 } });
        await waitForAutosave(editor);
        await expectProfileUsage(editor, false);
        await expectUsageSwitchAppearance(usage, { touch: true });
        expect(fixture.snapshot.agent).toMatchObject({
          enabled: false,
          data: selected,
        });
        await target.tap({ position: { x: 4, y: 4 } });
        await waitForAutosave(editor);
        await expectProfileUsage(editor, true);
        expect(fixture.snapshot.agent).toMatchObject({
          enabled: true,
          data: selected,
        });
      }
      const camera = editor.getByRole("button", {
        name: subject === "agent" ? "上传智能体头像" : "上传自己的头像",
        exact: true,
      });
      const beforePicker = structuredClone(fixture.snapshot);
      const commandsBeforePicker = fixture.commands.length;
      await expect(camera).toHaveCSS("opacity", "1");
      await expect(camera).toHaveCSS("pointer-events", "auto");
      const picked = page.waitForEvent("filechooser");
      await camera.tap();
      const chooser = await picked;
      expect(chooser.isMultiple()).toBe(false);
      await chooser.setFiles([]);
      expect(fixture.commands).toHaveLength(commandsBeforePicker);
      expect(fixture.snapshot).toEqual(beforePicker);
      await page.screenshot({
        path: testInfo.outputPath(`${subject}-camera-touch.png`),
        fullPage: true,
      });
    }
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands.map((command) => command.subject)).toEqual([
      "agent",
      "agent",
    ]);
    expect(avatarWrites).toEqual([]);
  });
  test("触控原位输入不跳位，点出名字或称呼直接结束清空，不依赖额外按钮", async ({
    page,
  }) => {
    const snapshot = initialProfile();
    snapshot.agent.data = {
      ...structuredClone(defaultAgentProfile),
      name: "TEST 触控名字",
    };
    const fixture = await profileFixture(page, snapshot);
    await page.setViewportSize({ width: 390, height: 960 });
    await enterDialogue(page);
    const agent = await openAgent(page);
    const display = profileTextDisplay(agent, "name");
    const before = await display.boundingBox();
    expect(before).not.toBeNull();
    expect(before!.height).toBe(44);
    await display.tap();
    const name = profileText(agent, "name");
    await expect(name).toBeFocused();
    const after = await name.boundingBox();
    expect(after).not.toBeNull();
    for (const coordinate of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(after![coordinate] - before![coordinate]),
      ).toBeLessThanOrEqual(1);
    await expectInplaceOnly(agent);
    await name.fill("");
    const summary = agent.locator(".personality-preferences > summary");
    await summary.tap();
    await expect(name).toBeHidden();
    await waitForAutosave(agent);
    expect(fixture.snapshot.agent).toMatchObject({
      enabled: true,
      data: defaultAgentProfile,
    });
    const human = await openHuman(page);
    await profileTextDisplay(human, "name").tap();
    const humanName = profileText(human, "name");
    await expect(humanName).toBeFocused();
    await humanName.fill("");
    await profileTextDisplay(human, "preferredAddress").tap();
    const address = profileText(human, "preferredAddress");
    await expect(humanName).toBeHidden();
    await expect(address).toBeFocused();
    await waitForAutosave(human);
    const reopenedAddress = await editText(human, "preferredAddress");
    await reopenedAddress.fill("");
    await human.locator(".personality-heading > h2").tap();
    await expect(reopenedAddress).toBeHidden();
    await waitForAutosave(human);
    expect(fixture.snapshot.human).toMatchObject({
      enabled: false,
      data: defaultHumanProfile,
    });
    await expectInplaceOnly(human);
    await expect(
      page.getByRole("dialog", { name: "设置", exact: true }),
    ).toBeVisible();
    expect(fixture.commands).toHaveLength(3);
  });
});

test("资料状态不重复绘制，统一开关仍保持未设置、单项选择与停用的真实语义", async ({
  page,
}, testInfo) => {
  const snapshot = initialProfile();
  snapshot.agent.data = structuredClone(defaultAgentProfile);
  snapshot.agent.enabled = false;
  snapshot.agent.revision = 0;
  snapshot.human.data = structuredClone(defaultHumanProfile);
  snapshot.human.enabled = false;
  snapshot.human.revision = 0;
  const fixture = await profileFixture(page, snapshot);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await expectEmptyProfileUsage(editor);
  await expectQuietProfileLabels(editor, true);
  await expectUniformSwitches(editor);
  await expect(editor.getByRole("slider")).toHaveCount(0);
  await expect(profileText(editor, "name")).toBeHidden();
  expect(fixture.commands).toHaveLength(0);

  await setLevel(editor, "幽默", 5);
  await expectProfileUsage(editor, true);
  const selected = await waitForAutosave(editor);
  expect(selected).toMatchObject({
    enabled: true,
    data: {
      name: null,
      traits: { humor: 5, rigor: null, warmth: null, verbosity: null },
      speechStyle: null,
      customStyle: null,
    },
  });
  expect(fixture.snapshot.agent.enabled).toBe(true);
  await setProfileUsage(editor, false);
  await waitForAutosave(editor);
  await expectProfileUsage(editor, false);
  await expectQuietProfileLabels(editor, true);
  expect(await paintedProfileLabels(editor)).not.toContain("待保存");
  await page.screenshot({
    path: testInfo.outputPath("quiet-agent-selected-disabled.png"),
    fullPage: true,
  });

  // Editing an already selected value does not silently undo global off.
  await setLevel(editor, "幽默", 4);
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.enabled).toBe(false);
  await setProfileUsage(editor, true);
  await waitForAutosave(editor);
  await expectProfileUsage(editor, true);
  expect(fixture.snapshot.agent.enabled).toBe(true);
  expect(fixture.snapshot.agent.data.traits.humor).toBe(4);
  await expectQuietProfileLabels(editor, true);
  await editor.getByRole("radio", { name: "自然", exact: true }).check();
  await expectQuietProfileLabels(editor, true);
  await editor.getByRole("radio", { name: "不设置", exact: true }).check();
  await expect(
    editor.getByRole("radio", { name: "不设置", exact: true }),
  ).toBeChecked();
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.data).toMatchObject({ speechStyle: null });

  const human = await openHuman(page);
  const humanMaster = human.getByRole("checkbox", {
    name: "使用个人资料",
    exact: true,
  });
  await expect(humanMaster).not.toBeChecked();
  await expectQuietProfileLabels(human, false);
  await expectUniformSwitches(human);
  await (await editText(human, "name")).fill("TEST 清河");
  await (await editText(human, "preferredAddress")).fill("TEST 河哥");
  await expectQuietProfileLabels(human, false);
  const humanCommand = await waitForAutosave(human);
  await expect(humanMaster).toBeChecked();
  await expectQuietProfileLabels(human, false);
  expect(humanCommand).toMatchObject({
    subject: "human",
    enabled: true,
    data: { name: "TEST 清河", preferredAddress: "TEST 河哥" },
  });
  await humanMaster.uncheck();
  await waitForAutosave(human);
  expect(fixture.snapshot.human.enabled).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("quiet-human-selected-disabled.png"),
    fullPage: true,
  });
});

test("紧凑身份区和独立设定分组保留键盘自动保存路径，矮窗连接入口可达", async ({
  page,
}, testInfo) => {
  const snapshot = initialProfile();
  snapshot.agent.data = structuredClone(defaultAgentProfile);
  snapshot.agent.enabled = false;
  snapshot.agent.revision = 0;
  const fixture = await profileFixture(page, snapshot);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 760, height: 540 });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await expectCompactIdentity(editor);
  await expect(
    editor.locator(".personality-preferences > summary > span").first(),
  ).toHaveText("个性与表达");
  await openPreferences(editor);
  await expect(editor.locator(".personality-traits")).toHaveCount(1);
  const rows = editor.locator(".personality-trait");
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    await expect(row).toHaveAttribute("data-configured", "false");
    const bounds = await row.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(48);
    expect(bounds?.height).toBeLessThanOrEqual(51);
  }
  const camera = editor.getByRole("button", {
    name: "上传智能体头像",
    exact: true,
  });
  await expectEmptyProfileUsage(editor);
  await camera.focus();
  await camera.press("Shift+Tab");
  await expect(camera).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(camera).toBeFocused();
  await camera.press("Tab");
  const nameChoice = editor.getByRole("button", {
    name: "编辑智能体名字",
    exact: true,
  });
  await expect(nameChoice).toBeFocused();
  await editor.locator(".personality-preferences > summary").focus();
  await page.keyboard.press("Tab");
  const humor = editor.getByRole("checkbox", {
    name: "设置幽默",
    exact: true,
  });
  await expect(humor).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const slider = editor.getByRole("slider", {
    name: "幽默程度",
    exact: true,
  });
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue("0");
  await slider.press("End");
  await expect(slider).toHaveValue("5");
  const unset = editor.getByRole("radio", { name: "不设置", exact: true });
  await unset.focus();
  await unset.press("ArrowRight");
  await expect(
    editor.getByRole("radio", { name: "自然", exact: true }),
  ).toBeChecked();
  const custom = editor.getByRole("checkbox", {
    name: "设置自定义风格",
    exact: true,
  });
  await custom.focus();
  await expect(
    editor.getByRole("checkbox", { name: "设置自定义风格", exact: true }),
  ).toBeFocused();
  await expect(editor.locator(".personality-custom > summary")).toHaveCount(0);
  await page.keyboard.press("Space");
  const text = editor.getByRole("textbox", {
    name: "自定义讲话风格",
    exact: true,
  });
  // Enabling an empty text field now focuses it directly. A second Tab would
  // leave the editor; assert the intentional focus transfer before typing.
  await expect(text).toBeFocused();
  await text.fill("TEST 先给结论。");
  await text.press("Tab");
  const confirmed = await waitForAutosave(editor);
  expect(confirmed).toMatchObject({
    enabled: true,
    data: {
      name: null,
      traits: { humor: 5, rigor: null, warmth: null, verbosity: null },
      speechStyle: "natural",
      customStyle: "TEST 先给结论。",
    },
  });
  expect(fixture.snapshot.agent.revision).toBe(confirmed!.expectedRevision + 1);
  await expectProfileUsage(editor, true);
  const usage = profileUsageControl(editor);
  await expect(usage).toBeEnabled();
  await usage.focus();
  await usage.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expectSwitchKeyboardFocus(usage);
  await expect(usage).toBeInViewport();
  const system = await openSystem(page);
  await expect(system.locator(":scope > summary")).toHaveText("能力与连接");
  await expect(system.locator(".subject-settings-group")).toHaveCount(1);
  const connection = system.getByRole("button", {
    name: "智能体连接",
    exact: true,
  });
  await connection.focus();
  await expect(connection).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("agent-short-keyboard-saved.png"),
    fullPage: true,
  });
});

test("双方资料入口分离，关闭面板仍提交 Agent 修改，消息草稿保留，人名和称呼只写 human", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  await enterDialogue(page);
  const input = await openInput(page);
  await input.fill("TEST 不应丢失的消息草稿");
  let agent = await openAgent(page);
  await (await editText(agent, "name")).fill("星禾");
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  agent = await openAgent(page);
  await expect(profileText(agent, "name")).toHaveValue("星禾");
  const human = await openHuman(page);
  await expect(human.getByRole("slider")).toHaveCount(0);
  await (await editText(human, "name")).fill("清河");
  await (await editText(human, "preferredAddress")).fill("河哥");
  const humanCommand = await waitForAutosave(human);
  expect(humanCommand).toMatchObject({
    subject: "human",
    data: { name: "清河", preferredAddress: "河哥" },
  });
  await expect.poll(() => fixture.snapshot.agent.data.name).toBe("星禾");
  expect(
    fixture.commands.filter((command) => command.subject === "agent").at(-1)
      ?.data.name,
  ).toBe("星禾");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(profileText(await openAgent(page), "name")).toHaveValue("星禾");
  await expect(await openInput(page)).toHaveValue("TEST 不应丢失的消息草稿");
});

test("默认全部不设置且未启用，不强迫取名，Logo不冒充已配置名", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.revision = 0;
  snapshot.agent.data = structuredClone(defaultAgentProfile);
  snapshot.agent.enabled = false;
  snapshot.human.data = structuredClone(defaultHumanProfile);
  snapshot.human.enabled = false;
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const editor = await openAgent(page);
  await expect(
    editor.getByText("先给我起个名字吧。", { exact: true }),
  ).toHaveCount(0);
  await expectEmptyProfileUsage(editor);
  await expect(editor.getByRole("slider")).toHaveCount(0);
  const name = profileText(editor, "name");
  await expect(name).toHaveValue("");
  await expect(name).toBeHidden();
  await expect(name).toHaveAttribute("placeholder", "Morphz");
  await expect(
    editor.locator(".personality-portrait svg.brand-mark"),
  ).toHaveCount(1);
  await expect(
    editor.locator(
      '.personality-speaking input[value="on"],.personality-speaking input:not([value])',
    ),
  ).toBeChecked();
  expect(fixture.commands).toHaveLength(0);
  // Opening controls alone must not manufacture a ROM revision. Explicit
  // whole-Profile activation is independently available even while empty.
  await expectEmptyProfileUsage(editor);
  expect(fixture.snapshot.agent).toMatchObject({
    enabled: false,
    data: defaultAgentProfile,
  });
  expect(fixture.commands).toHaveLength(0);
  await expectEmptyProfileUsage(editor);
  await expectQuietProfileLabels(editor, true);
  const configuredName = await editText(editor, "name");
  await expect(configuredName).toBeFocused();
  await expect(configuredName).toHaveValue("");
  await expectEmptyProfileUsage(editor);
  expect(fixture.commands).toHaveLength(0);
  await configuredName.fill("阿禾");
  await configuredName.press("Enter");
  const named = await waitForAutosave(editor);
  expect(named?.expectedRevision).toBe(fixture.snapshot.agent.revision - 1);
  expect(fixture.snapshot.agent.enabled).toBe(true);
  expect(fixture.snapshot.agent.data.name).toBe("阿禾");
});

test("Agent 空资料可直接开关并刷新保留，清空最后字段不改已开启意图，显式关闭后新增仍关闭", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent = {
    ...snapshot.agent,
    data: structuredClone(defaultAgentProfile),
    enabled: false,
    revision: 0,
  };
  snapshot.human = {
    ...snapshot.human,
    data: structuredClone(defaultHumanProfile),
    enabled: false,
    revision: 0,
  };
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  let editor = await openAgent(page);
  await expectEmptyProfileUsage(editor);
  expect(fixture.commands).toHaveLength(0);
  await profileUsageControl(editor).click();
  await expectProfileUsage(editor, true);
  const emptyOn = await waitForAutosave(editor);
  expect(emptyOn).toMatchObject({
    subject: "agent",
    expectedRevision: 0,
    enabled: true,
    data: defaultAgentProfile,
  });
  expect(fixture.snapshot.agent).toMatchObject({
    revision: 1,
    enabled: true,
    data: defaultAgentProfile,
  });
  // This controlled typed API fixture verifies exact persisted data/readback,
  // not a production Runtime Context; no default name or trait is introduced.
  await page.reload();
  editor = await openAgent(page);
  await expectEmptyProfileUsage(editor, true);
  await expectCompactIdentity(editor);
  expect(fixture.commands).toHaveLength(1);
  await setLevel(editor, "幽默", 0);
  await waitForAutosave(editor);
  await editor
    .getByRole("checkbox", { name: "设置幽默", exact: true })
    .uncheck();
  const cleared = await waitForAutosave(editor);
  expect(cleared).toMatchObject({
    enabled: true,
    data: defaultAgentProfile,
  });
  expect(fixture.snapshot.agent).toMatchObject({
    revision: 3,
    enabled: true,
    data: defaultAgentProfile,
  });
  await expectEmptyProfileUsage(editor, true);
  await page.reload();
  editor = await openAgent(page);
  await expectEmptyProfileUsage(editor, true);
  expect(fixture.commands).toHaveLength(3);
  await profileUsageControl(editor).click();
  const emptyOff = await waitForAutosave(editor);
  expect(emptyOff).toMatchObject({
    enabled: false,
    data: defaultAgentProfile,
  });
  await page.reload();
  editor = await openAgent(page);
  await expectEmptyProfileUsage(editor);
  expect(fixture.commands).toHaveLength(4);
  await (await editText(editor, "name")).fill("TEST 空资料关闭后的新名字");
  const stillOff = await waitForAutosave(editor);
  expect(stillOff).toMatchObject({
    enabled: false,
    data: {
      ...defaultAgentProfile,
      name: "TEST 空资料关闭后的新名字",
    },
  });
  await expectProfileUsage(editor, false);
  await profileUsageControl(editor).click();
  const explicitOn = await waitForAutosave(editor);
  expect(explicitOn).toMatchObject({
    enabled: true,
    data: stillOff!.data,
  });
  expect(fixture.commands).toHaveLength(6);
  const human = await openHuman(page);
  await expectEmptyProfileUsage(human);
  expect(fixture.snapshot.human).toMatchObject({
    revision: 0,
    enabled: false,
    data: defaultHumanProfile,
  });
  expect(fixture.commands.every((command) => command.subject === "agent")).toBe(
    true,
  );
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
    const command = await waitForAutosave(editor);
    expect(command).toMatchObject({
      subject: "agent",
      data: {
        traits: { humor: level, rigor: level, warmth: level, verbosity: level },
      },
    });
    expect(command!.expectedRevision + 1).toBe(fixture.snapshot.agent.revision);
  }
});

for (const subject of ["agent", "human"] as const) {
  test(`${subject === "agent" ? "人格设定" : "个人资料"} 首个有效项自动使用，明确关闭后新增字段保留关闭，独立使用操作可显式恢复`, async ({
    page,
  }, testInfo) => {
    const snapshot = initialProfile();
    snapshot.agent.data = structuredClone(defaultAgentProfile);
    snapshot.agent.enabled = false;
    snapshot.agent.revision = 0;
    snapshot.human.data = structuredClone(defaultHumanProfile);
    snapshot.human.enabled = false;
    snapshot.human.revision = 0;
    const fixture = await profileFixture(page, snapshot);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 960 });
    await enterDialogue(page);
    const editor =
      subject === "agent" ? await openAgent(page) : await openHuman(page);
    await expectCompactIdentity(editor);
    await expectEmptyProfileUsage(editor);
    expect(fixture.commands).toHaveLength(0);
    if (subject === "agent") {
      await setLevel(editor, "幽默", 0);
    } else {
      await (await editText(editor, "name")).fill("TEST 清河");
    }
    await waitForAutosave(editor);
    expect(fixture.snapshot[subject].enabled).toBe(true);
    await expectProfileUsage(editor, true);
    await expect(profileUsageControl(editor)).toBeEnabled();
    const selected = structuredClone(fixture.snapshot[subject].data);
    await setProfileUsage(editor, false);
    await waitForAutosave(editor);
    expect(fixture.snapshot[subject]).toMatchObject({
      enabled: false,
      data: selected,
    });

    if (subject === "agent") {
      // A new zero-valued trait, previously unset speech style and newly
      // activated text fields are all additions, not an opt-in to the ROM.
      await setLevel(editor, "严谨", 0);
      await editor.getByRole("radio", { name: "直率", exact: true }).check();
      await openCustom(editor);
      await editor
        .getByRole("checkbox", { name: "设置自定义风格", exact: true })
        .check();
      await editor
        .getByRole("textbox", { name: "自定义讲话风格", exact: true })
        .fill("TEST 关闭时新增风格");
      await (await editText(editor, "name")).fill("Echo");
    } else {
      await (await editText(editor, "preferredAddress")).fill("TEST 河哥");
    }
    await waitForAutosave(editor);
    await expectProfileUsage(editor, false);
    expect(fixture.snapshot[subject].enabled).toBe(false);
    const retained = structuredClone(fixture.snapshot[subject].data);
    const disabledCommands = fixture.commands.filter(
      (command) => command.subject === subject && command.enabled === false,
    );
    expect(disabledCommands.length).toBeGreaterThanOrEqual(2);
    await setProfileUsage(editor, true);
    const resumed = await waitForAutosave(editor);
    expect(resumed).toMatchObject({ subject, enabled: true, data: retained });
    expect(fixture.snapshot[subject]).toMatchObject({
      enabled: true,
      data: retained,
    });
    await expectProfileUsage(editor, true);
    await expectQuietProfileLabels(editor, subject === "agent");
    await profileUsageControl(editor).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`${subject}-explicit-use-switch.png`),
      fullPage: true,
    });
  });
}

for (const lostReceipt of [false, true]) {
  test(`身份开关关闭${lostReceipt ? "丢失回执" : "延迟提交"}时不冒称已保存，仅确认读回后给出保存状态`, async ({
    page,
  }) => {
    const fixture = await profileFixture(page);
    const retained = structuredClone(fixture.snapshot.agent.data);
    const entered = deferred(),
      release = deferred();
    fixture.update(async (route, command) => {
      if (fixture.commands.length !== 1) return false;
      entered.release();
      if (lostReceipt) {
        fixture.commit(command);
        await route.abort("failed");
      } else {
        await release.promise;
        await route.fulfill({ json: fixture.commit(command) });
      }
      return true;
    });
    await enterDialogue(page);
    const editor = await openAgent(page);
    await expectProfileUsage(editor, true);
    await expect(profileUsageControl(editor)).toHaveAccessibleName(
      "使用人格设定",
    );
    try {
      await setProfileUsage(editor, false);
      await entered.promise;
      const original = structuredClone(fixture.commands[0]!);
      expect(original).toMatchObject({
        subject: "agent",
        expectedRevision: 1,
        enabled: false,
        data: retained,
      });
      if (lostReceipt) {
        await expect(editor.getByRole("alert")).toContainText(
          "保存结果未确认，请重试。",
        );
        await expect(editor.locator(".personality-save-state")).toHaveText(
          "资料修改尚未确认",
        );
      } else {
        await expect(editor).toHaveAttribute("aria-busy", "true");
        await expect(editor.locator(".personality-save-state")).toHaveText(
          "正在保存资料",
        );
        expect(fixture.snapshot.agent.enabled).toBe(true);
      }
      // UI intent may be off, but an unconfirmed action is neither a
      // successful receipt nor an authorized, disabled Profile readback.
      await expectProfileUsage(editor, false);
      await expect(editor.locator(".personality-save-state")).not.toHaveText(
        "资料已保存",
      );
      expect(fixture.readbacks.some((read) => !read.agent.enabled)).toBe(false);
      if (lostReceipt)
        await editor
          .getByRole("button", { name: "重试保存", exact: true })
          .click();
      else release.release();
      await waitForAutosave(editor);
      await expectProfileUsage(editor, false);
      await expect(editor.locator(".personality-save-state")).toHaveText(
        "资料已保存",
      );
      expect(fixture.snapshot.agent).toMatchObject({
        enabled: false,
        data: retained,
        revision: 2,
      });
      expect(fixture.commands).toHaveLength(lostReceipt ? 2 : 1);
      if (lostReceipt) expect(fixture.commands[1]).toEqual(original);
    } finally {
      release.release();
    }
  });
}

test("已确认 Echo 输入中临时空名字零写，Escape不清除，Enter明确null且关闭后编辑不偷偷恢复", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.data = {
    ...structuredClone(defaultAgentProfile),
    name: "Echo",
    traits: { ...defaultAgentProfile.traits, humor: 0 },
  };
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const editor = await openAgent(page);
  const clockStart = new Date("2026-10-02T04:00:00.000Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  let name = await editText(editor, "name");
  await name.fill("");
  await page.clock.runFor(450);
  await expect(name).toBeFocused();
  expect(fixture.commands).toHaveLength(0);
  expect(fixture.snapshot.agent.data).toEqual({
    ...defaultAgentProfile,
    name: "Echo",
    traits: { ...defaultAgentProfile.traits, humor: 0 },
  });
  await name.press("Escape");
  await expect(name).toBeHidden();
  await expect(
    editor.getByRole("button", { name: "编辑智能体名字", exact: true }),
  ).toHaveText("Echo");
  expect(fixture.commands).toHaveLength(0);
  await page.clock.resume();
  name = await editText(editor, "name");
  await name.fill("");
  await name.press("Enter");
  const cleared = await waitForAutosave(editor);
  expect(cleared).toMatchObject({
    enabled: true,
    data: { name: null, traits: { ...defaultAgentProfile.traits, humor: 0 } },
  });
  await expect(name).toBeHidden();
  await expect(profileUsageControl(editor)).toBeEnabled();
  await expectProfileUsage(editor, true);
  await setProfileUsage(editor, false);
  await waitForAutosave(editor);
  name = await editText(editor, "name");
  await name.fill("");
  await setLevel(editor, "严谨", 0);
  await waitForAutosave(editor);
  await expect(name).toBeHidden();
  expect(fixture.snapshot.agent.data.traits.rigor).toBe(0);
  expect(fixture.snapshot.agent.enabled).toBe(false);
  await editor.getByRole("radio", { name: "直率", exact: true }).check();
  await expect
    .poll(() => fixture.snapshot.agent.data.speechStyle)
    .toBe("direct");
  expect(fixture.snapshot.agent.enabled).toBe(false);
  await openCustom(editor);
  await editor
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .check();
  const custom = editor.getByRole("textbox", {
    name: "自定义讲话风格",
    exact: true,
  });
  await custom.fill("TEST 临时空名字时新增");
  await custom.blur();
  await expect
    .poll(() => fixture.snapshot.agent.data.customStyle)
    .toBe("TEST 临时空名字时新增");
  expect(fixture.snapshot.agent.enabled).toBe(false);
  expect(fixture.snapshot.agent.data.name).toBeNull();
  await expectProfileUsage(editor, false);
  name = await editText(editor, "name");
  await name.fill("Nova");
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent).toMatchObject({
    enabled: false,
    data: { name: "Nova", traits: { rigor: 0 }, speechStyle: "direct" },
  });
  await setProfileUsage(editor, true);
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent.enabled).toBe(true);
});

test("明确关闭后清空唯一风格仍保留关闭，已有版本的新字段不会偷偷恢复使用", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.data = structuredClone(defaultAgentProfile);
  snapshot.agent.revision = 0;
  snapshot.agent.enabled = false;
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const editor = await openAgent(page);
  await openCustom(editor);
  await editor
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .check();
  const custom = editor.getByRole("textbox", {
    name: "自定义讲话风格",
    exact: true,
  });
  await expect(custom).toHaveValue("");
  await expectEmptyProfileUsage(editor);
  expect(fixture.commands).toHaveLength(0);
  await custom.fill("TEST 唯一表达偏好");
  await waitForAutosave(editor);
  await expectProfileUsage(editor, true);
  await setProfileUsage(editor, false);
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent).toMatchObject({
    enabled: false,
    data: { customStyle: "TEST 唯一表达偏好" },
  });
  await custom.fill("");
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent).toMatchObject({
    enabled: false,
    data: defaultAgentProfile,
  });
  expect(fixture.commands).toHaveLength(3);
  await expectEmptyProfileUsage(editor);
  // A saved empty Profile still retains the user's explicit off intent.
  // New text or a zero-valued trait must not silently turn it on again.
  await expect(
    editor.getByRole("checkbox", { name: "设置自定义风格", exact: true }),
  ).toBeChecked();
  await custom.fill("TEST 重新开始的表达偏好");
  const restarted = await waitForAutosave(editor);
  expect(restarted).toMatchObject({
    enabled: false,
    data: { ...defaultAgentProfile, customStyle: "TEST 重新开始的表达偏好" },
  });
  await expect(profileUsageControl(editor)).toBeEnabled();
  await expectProfileUsage(editor, false);
  await editor
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .uncheck();
  await waitForAutosave(editor);
  expect(fixture.snapshot.agent).toMatchObject({
    enabled: false,
    data: {
      ...defaultAgentProfile,
      customStyle: "TEST 重新开始的表达偏好",
      customStyleEnabled: false,
    },
  });
  await expect(custom).toBeHidden();
  await expectEmptyProfileUsage(editor);
  await setLevel(editor, "幽默", 0);
  const firstZero = await waitForAutosave(editor);
  expect(firstZero).toMatchObject({
    enabled: false,
    data: {
      ...defaultAgentProfile,
      customStyle: "TEST 重新开始的表达偏好",
      customStyleEnabled: false,
      traits: { ...defaultAgentProfile.traits, humor: 0 },
    },
  });
  await expectProfileUsage(editor, false);
  expect(fixture.commands).toHaveLength(6);
  await setProfileUsage(editor, true);
  const explicitlyEnabled = await waitForAutosave(editor);
  expect(explicitlyEnabled).toMatchObject({
    enabled: true,
    data: firstZero!.data,
  });
  expect(fixture.commands).toHaveLength(7);
});

test("仅所选幽默5与严谨0进入资料，0不是不设置，停用保留值且恢复名字不冒用", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.data = structuredClone(defaultAgentProfile);
  snapshot.agent.revision = 0;
  snapshot.agent.enabled = false;
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const editor = await openAgent(page);
  await setLevel(editor, "幽默", 5);
  await setLevel(editor, "严谨", 0);
  await setProfileUsage(editor, true);
  const selected = await waitForAutosave(editor);
  expect(selected).toMatchObject({
    enabled: true,
    data: {
      name: null,
      traits: { humor: 5, rigor: 0, warmth: null, verbosity: null },
      speechStyle: null,
      customStyle: null,
    },
  });
  await expect(editor.getByRole("slider")).toHaveCount(2);
  await expect(
    editor.getByRole("checkbox", { name: "设置严谨", exact: true }),
  ).toBeChecked();
  await setProfileUsage(editor, false);
  const disabled = await waitForAutosave(editor);
  expect(disabled).toMatchObject({
    enabled: false,
    data: selected!.data,
  });
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  const reopened = await openAgent(page);
  await openPreferences(reopened);
  await expectProfileUsage(reopened, false);
  await expect(
    reopened.getByRole("slider", { name: "严谨程度", exact: true }),
  ).toHaveValue("0");
  for (const label of ["幽默", "严谨"])
    await reopened
      .getByRole("checkbox", { name: `设置${label}`, exact: true })
      .uncheck();
  await waitForAutosave(reopened);
  expect(fixture.snapshot.agent).toMatchObject({
    enabled: false,
    data: defaultAgentProfile,
  });
  await expectEmptyProfileUsage(reopened);
  expect(fixture.commands.at(-1)?.expectedRevision).toBe(
    fixture.snapshot.agent.revision - 1,
  );
});

test("名字、称呼、讲话风格和自定义文字可各自撤回为null，停用值不覆盖显示名", async ({
  page,
}) => {
  const snapshot = initialProfile();
  snapshot.agent.data.customStyle = "TEST 已配置的自定义风格";
  const fixture = await profileFixture(page, snapshot);
  await enterDialogue(page);
  const agent = await openAgent(page);
  await expect(page.locator(".agent-presence")).toHaveAttribute(
    "aria-label",
    /TEST 伙伴/,
  );
  await setProfileUsage(agent, false);
  await waitForAutosave(agent);
  await expect(page.locator(".agent-presence")).not.toHaveAttribute(
    "aria-label",
    /TEST 伙伴/,
  );
  await expect(profileText(agent, "name")).toHaveValue("TEST 伙伴");
  await clearText(agent, "name");
  await openPreferences(agent);
  await agent.getByRole("radio", { name: "不设置", exact: true }).check();
  await openCustom(agent);
  await agent
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .check();
  await agent
    .getByRole("textbox", { name: "自定义讲话风格", exact: true })
    .fill("TEST 已关闭时修改不重新启用");
  await waitForAutosave(agent);
  expect(fixture.snapshot.agent.enabled).toBe(false);
  await agent
    .getByRole("textbox", { name: "自定义讲话风格", exact: true })
    .fill("");
  const cleared = await waitForAutosave(agent);
  expect(cleared).toMatchObject({
    enabled: false,
    data: { name: null, speechStyle: null, customStyle: null },
  });
  const human = await openHuman(page);
  await clearText(human, "name");
  await clearText(human, "preferredAddress");
  const humanCleared = await waitForAutosave(human);
  expect(humanCleared).toMatchObject({
    subject: "human",
    enabled: false,
    data: defaultHumanProfile,
  });
  expect(fixture.snapshot.human.enabled).toBe(false);
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
  await openPreferences(editor);
  for (const style of ["自然", "干练", "细腻", "直率"]) {
    await editor.getByRole("radio", { name: style, exact: true }).check();
    await expect(
      editor.getByRole("radio", { name: style, exact: true }),
    ).toBeChecked();
  }
  await openCustom(editor);
  await editor
    .getByRole("checkbox", { name: "设置自定义风格", exact: true })
    .check();
  const text = "先给结论，再解释不确定性；叫我河哥。\n引用事实时标明来源。";
  await editor
    .getByRole("textbox", { name: "自定义讲话风格", exact: true })
    .fill(text);
  const styled = await waitForAutosave(editor);
  expect(styled).toMatchObject({
    subject: "agent",
    data: { speechStyle: "direct", customStyle: text },
  });
  expect(fixture.snapshot.agent.data.customStyle).toBe(text);
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  const reopened = await openAgent(page);
  await openCustom(reopened);
  await expect(
    reopened.getByRole("textbox", { name: "自定义讲话风格", exact: true }),
  ).toHaveValue(text);
  expect(otherWrites).toEqual([]);
});

test("写入成功但回执丢失时同 commandId 重试；CAS 冲突不冒称保存或丢草稿", async ({
  page,
}, testInfo) => {
  const fixture = await profileFixture(page);
  let first = true;
  fixture.update(async (route, command) => {
    if (!first) return false;
    first = false;
    fixture.commit(command);
    await route.abort("failed");
    return true;
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await enterDialogue(page);
  const editor = await openAgent(page);
  await (await editText(editor, "name")).fill("回执重试");
  await flushText(editor);
  await expect(editor.getByRole("alert")).toBeVisible();
  // A real browser fetch rejection is localized, while its durable command
  // remains frozen for the explicit retry below.
  await expect(editor.getByRole("alert")).toContainText(
    "保存结果未确认，请重试。",
  );
  await expect(editor.getByRole("alert")).not.toContainText("Failed to fetch");
  expect(fixture.commands).toHaveLength(1);
  await editor.locator(".personality-error").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("agent-dark-unknown-retry.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "重试保存", exact: true }).click();
  await waitForAutosave(editor);
  expect(fixture.commands[0]).toEqual(fixture.commands[1]);
  expect(fixture.snapshot.agent.revision).toBe(2);
  fixture.update(async (route) => {
    await route.fulfill({
      status: 409,
      json: { message: "资料已被其他操作修改，请重新读取。", code: "conflict" },
    });
    return true;
  });
  await (await editText(editor, "name")).fill("冲突后的本地草稿");
  await flushText(editor);
  await expect(editor.getByRole("alert")).toContainText("资料已被其他操作修改");
  await expect(profileText(editor, "name")).toHaveValue("冲突后的本地草稿");
  await expect(editor.locator(".personality-save-state")).toHaveText(
    "资料修改尚未确认",
  );
});

for (const keepChanges of [false, true]) {
  test(`真实资料 CAS 冲突后${keepChanges ? "保留修改" : "使用最新"}须显式选择，不自动覆盖；重存采用新版本与新 commandId`, async ({
    page,
  }, testInfo) => {
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
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await enterDialogue(page);
    const editor = await openAgent(page);
    await openPreferences(editor);
    const name = await editText(editor, "name");
    await name.fill("本地待确认草稿");
    // An independent writer advanced the authoritative revision after the UI
    // loaded. The controlled transport enforces CAS, not an unconditional error.
    fixture.snapshot.agent = {
      ...fixture.snapshot.agent,
      revision: 5,
      data: { ...fixture.snapshot.agent.data, name: "远端最新名字" },
    };
    await flushText(editor);
    await expect(editor.getByRole("alert")).toContainText(
      "TEST 资料版本已更新",
    );
    await expect(name).toHaveValue("本地待确认草稿");
    await expect(name).toBeDisabled();
    await expect(editor.getByRole("slider")).toHaveCount(4);
    for (const slider of await editor.getByRole("slider").all())
      await expect(slider).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "重试保存", exact: true }),
    ).toHaveCount(0);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]!.expectedRevision).toBe(1);
    await editor.locator(".personality-error").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(
        `agent-dark-conflict-${keepChanges ? "keep" : "latest"}.png`,
      ),
      fullPage: true,
    });
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
    if (keepChanges) {
      // Choosing keep is the explicit consent to rebase and autosave. There
      // must be no second write before this choice, and no reuse of stale CAS.
      await waitForAutosave(editor);
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
      expect(freshReads).toBe(2);
    } else {
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.snapshot.agent.revision).toBe(5);
      expect(fixture.snapshot.agent.data.name).toBe("远端最新名字");
      await expect(
        editor.getByRole("button", { name: "保存", exact: true }),
      ).toHaveCount(0);
      expect(freshReads).toBe(1);
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
  await (await editText(editor, "name")).fill("等待核对");
  await flushText(editor);
  await expect(editor.getByRole("alert")).toContainText(
    "TEST 保存结果暂无法读取",
  );
  await expect(editor.locator(".personality-save-state")).toHaveText(
    "资料修改尚未确认",
  );
  fixture.update();
  fixture.failReads("");
  await editor.getByRole("button", { name: "重试保存", exact: true }).click();
  await waitForAutosave(editor);
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
  await (await editText(editor, "name")).fill("重开仍是同一次保存");
  await flushText(editor);
  await expect(editor.getByRole("alert")).toBeVisible();
  await page
    .locator(".subject-sidebar")
    .getByRole("tab", { name: "活动", exact: true })
    .click();
  editor = await openAgent(page);
  await expect(profileText(editor, "name")).toHaveValue("重开仍是同一次保存");
  await editor.getByRole("button", { name: "重试保存", exact: true }).click();
  await waitForAutosave(editor);
  expect(fixture.commands[1]).toEqual(fixture.commands[0]);
  expect(fixture.snapshot.agent.revision).toBe(2);
});

test("保存进行中仍能连续输入和拖动分值，旧回执不覆盖最新意图，后续写入按实际版本串行", async ({
  page,
}, testInfo) => {
  const fixture = await profileFixture(page);
  const entered = deferred(),
    release = deferred();
  fixture.update(async (route, command) => {
    if (fixture.commands.length !== 1) return false;
    entered.release();
    await release.promise;
    await route.fulfill({ json: fixture.commit(command) });
    return true;
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await enterDialogue(page);
  const editor = await openAgent(page);
  const name = await editText(editor, "name");
  try {
    await name.fill("TEST 先发出的名字");
    await name.press("Enter");
    await entered.promise;
    await expect(editor.locator(".personality-save-state")).toHaveText(
      "正在保存资料",
    );
    await expect(name).toBeEnabled();
    await expect(
      editor.getByRole("button", { name: "编辑智能体名字", exact: true }),
    ).toHaveText("TEST 伙伴");
    await editText(editor, "name");
    await name.fill("Echo");
    await setLevel(editor, "幽默", 5);
    await flushText(editor);
    await expect(name).toHaveValue("Echo");
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.snapshot.agent.data.name).toBe("TEST 伙伴");
    release.release();
    const last = await waitForAutosave(editor);
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands[0]).toMatchObject({
      expectedRevision: 1,
      data: { name: "TEST 先发出的名字" },
    });
    expect(last).toMatchObject({
      expectedRevision: 2,
      data: { name: "Echo", traits: { humor: 5 } },
    });
    expect(last!.commandId).not.toBe(fixture.commands[0]!.commandId);
    expect(fixture.snapshot.agent.revision).toBe(3);
    await expect(name).toHaveValue("Echo");
    await editText(editor, "name");
    await name.press("Escape");
    await expect(
      editor.getByRole("button", { name: "编辑智能体名字", exact: true }),
    ).toHaveText("Echo");
    await expect(
      editor.getByRole("slider", { name: "幽默程度", exact: true }),
    ).toHaveValue("5");
    await editor.evaluate((element) => {
      const scroll = element.closest<HTMLElement>(".inspector-scroll");
      if (scroll) scroll.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath("agent-light-Echo-latest-confirmed.png"),
      fullPage: true,
    });
  } finally {
    release.release();
  }
});

test("未知回执冻结原 command，继续修改只排队，人工重试先核对原写入再提交最新值", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  let unknown = true;
  fixture.update(async (route, command) => {
    if (!unknown) return false;
    unknown = false;
    fixture.commit(command);
    await route.abort("failed");
    return true;
  });
  await enterDialogue(page);
  const editor = await openAgent(page);
  const name = await editText(editor, "name");
  await name.fill("TEST 未知回执版本");
  await name.press("Enter");
  await expect(editor.getByRole("alert")).toBeVisible();
  const original = structuredClone(fixture.commands[0]!);
  await expect(name).toBeEnabled();
  await editText(editor, "name");
  await name.fill("TEST 排队的新版本");
  await name.press("Enter");
  await openPreferences(editor);
  await editor.getByRole("radio", { name: "直率", exact: true }).check();
  expect(fixture.commands).toEqual([original]);
  expect(fixture.snapshot.agent.revision).toBe(2);
  await expect(
    editor.getByRole("button", { name: "重试保存", exact: true }),
  ).toBeEnabled();
  await editor.getByRole("button", { name: "重试保存", exact: true }).click();
  const last = await waitForAutosave(editor);
  expect(fixture.commands).toHaveLength(3);
  expect(fixture.commands[1]).toEqual(original);
  expect(last).toMatchObject({
    expectedRevision: 2,
    data: { name: "TEST 排队的新版本", speechStyle: "direct" },
  });
  expect(last!.commandId).not.toBe(original.commandId);
  expect(fixture.snapshot.agent.revision).toBe(3);
});

test("文本防抖只提交最后意图，Enter立即刷新；未设置空文本不制造配置或后台操作", async ({
  page,
}) => {
  const fixture = await profileFixture(page);
  await enterDialogue(page);
  const editor = await openAgent(page);
  const clockStart = new Date("2026-10-02T04:00:00.000Z");
  await page.clock.install({ time: clockStart });
  // A running synthetic clock still advances during browser action waits.
  // Pause first, then test the complete 450ms contract with exact steps.
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  const name = await editText(editor, "name");
  await name.fill("TEST 第一稿");
  await page.clock.runFor(200);
  await name.fill("TEST 最后一稿");
  await page.clock.runFor(449);
  expect(fixture.commands).toHaveLength(0);
  await page.clock.runFor(1);
  await expect
    .poll(() => fixture.snapshot.agent.data.name)
    .toBe("TEST 最后一稿");
  await waitForAutosave(editor);
  expect(fixture.commands).toHaveLength(1);
  await editText(editor, "name");
  await name.fill("Echo");
  await name.press("Enter");
  await waitForAutosave(editor);
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.commands[1]).toMatchObject({
    expectedRevision: 2,
    data: { name: "Echo" },
  });
});

for (const explicitOff of [false, true]) {
  test(`空名字编辑跨面板保留激活意图，首个有效值${explicitOff ? "尊重明确关闭" : "自动启用"}且不提前写入`, async ({
    page,
  }) => {
    const snapshot = initialProfile();
    snapshot.agent.data = structuredClone(defaultAgentProfile);
    snapshot.agent.enabled = false;
    snapshot.agent.revision = 0;
    const fixture = await profileFixture(page, snapshot);
    await enterDialogue(page);
    let editor = await openAgent(page);
    if (explicitOff) {
      // Keep this case's retained-choice opt-out separate from the new
      // all-null on/off case: both must preserve name activation boundaries.
      await setLevel(editor, "幽默", 0);
      await waitForAutosave(editor);
      await setProfileUsage(editor, false);
      await waitForAutosave(editor);
      expect(fixture.snapshot.agent.enabled).toBe(false);
      expect(fixture.snapshot.agent.data.traits.humor).toBe(0);
    }
    const baseline = structuredClone(fixture.snapshot.agent);
    const writesBeforeEmptyName = fixture.commands.length;
    const name = await editText(editor, "name");
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("");
    await page
      .locator(".subject-sidebar")
      .getByRole("tab", { name: "活动", exact: true })
      .click();
    editor = await openAgent(page);
    const reopened = await editText(editor, "name");
    await expect(reopened).toHaveAttribute("data-configured", "false");
    await expect(reopened).toHaveValue("");
    await expect(reopened).toBeEnabled();
    expect(fixture.commands).toHaveLength(writesBeforeEmptyName);
    expect(fixture.snapshot.agent).toEqual(baseline);
    await reopened.fill("Echo");
    await reopened.press("Enter");
    const command = await waitForAutosave(editor);
    expect(command).toMatchObject({
      expectedRevision: baseline.revision,
      enabled: !explicitOff,
      data: { name: "Echo" },
    });
    expect(fixture.commands).toHaveLength(writesBeforeEmptyName + 1);
    expect(fixture.snapshot.agent).toMatchObject({
      revision: baseline.revision + 1,
      enabled: !explicitOff,
      data: { name: "Echo" },
    });
  });
}

test("Logo头像由 Runtime 的真实阶段驱动，未知状态静止而非假空闲，减少动态停动效", async ({
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
  await expect(avatar.locator(".brand-mark")).toHaveCSS(
    "animation-name",
    "subject-mark-breathe",
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
  await expect(avatar.locator(".brand-mark")).toHaveCSS(
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
  fixture.snapshot.agent.enabled = false;
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
  await expectCompactIdentity(editor);
  await expect(image).toHaveCSS("object-fit", "cover");
  await expect(image).toHaveCSS("border-top-left-radius", "18px");
  await expect(image).toHaveCSS("width", "64px");
  await expect(image).toHaveCSS("height", "64px");
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
  await expect(profileText(editor, "name")).toHaveValue("TEST 伙伴");
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
  await expect(profileText(editor, "name")).toBeDisabled();
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
  await (await editText(editor, "name")).fill("撤权时仍应保留的本人草稿");
  fixture.read(async (route) => {
    await route.fulfill({
      status: 403,
      json: { message: "TEST 资料访问已撤回", code: "forbidden" },
    });
    return true;
  });
  await flushText(editor);
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
  await expect(profileText(editor, "name")).toHaveValue(
    "撤权时仍应保留的本人草稿",
  );
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect(image).not.toHaveAttribute("src", originalUrl!);
  expect(fixture.commands).toHaveLength(1);
  await editor.getByRole("button", { name: "重试保存", exact: true }).click();
  await waitForAutosave(editor);
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
    await (await editText(editor, "name")).fill("旧身份本地草稿");
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
          enabled:
            command.subject === "agent"
              ? (command.enabled ?? profileHasConfiguredFields(command.data))
              : command.enabled === true &&
                profileHasConfiguredFields(command.data),
        }),
      });
      return true;
    });
    await flushText(editor);
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
    await expect(profileText(next, "name")).toHaveValue("新身份伙伴");
    gate.release();
    await expect(profileText(next, "name")).toHaveValue("新身份伙伴");
    await expect(next.locator(".personality-save-state")).not.toHaveText(
      "正在保存资料",
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
    const snapshot = initialProfile();
    snapshot.agent.data = structuredClone(defaultAgentProfile);
    snapshot.agent.enabled = false;
    snapshot.agent.revision = 0;
    await profileFixture(page, snapshot);
    await page.emulateMedia({
      colorScheme: appearance,
      reducedMotion: "reduce",
    });
    await enterDialogue(page);
    const agent = await openAgent(page);
    await expectCompactIdentity(agent);
    await expect(
      agent.locator(".personality-preferences > summary > span").first(),
    ).toHaveText("个性与表达");
    await expect(agent.locator(".personality-preferences")).not.toHaveAttribute(
      "open",
      "",
    );
    await expect(page.locator(".subject-settings-system")).not.toHaveAttribute(
      "open",
      "",
    );
    await expect(agent.getByRole("textbox")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`agent-default-${appearance}-1440.png`),
      fullPage: true,
    });
    if (appearance === "light") {
      const panel = await page.locator(".subject-sidebar").boundingBox();
      expect(panel).not.toBeNull();
      await page.screenshot({
        path: testInfo.outputPath("agent-default-light-panel.png"),
        clip: panel!,
      });
    }
    await page.setViewportSize({ width: 390, height: 960 });
    await expectCompactIdentity(agent);
    await expectEmptyProfileUsage(agent);
    await expect(agent.getByRole("slider")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`agent-default-${appearance}-390.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await cssProfileZoom(page, 2);
    await expectCompactIdentity(agent, 2);
    await expect(agent.getByRole("textbox")).toHaveCount(0);
    await expect(agent.getByRole("slider")).toHaveCount(0);
    await expect(agent.locator(".personality-identity")).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: testInfo.outputPath(`agent-default-${appearance}-1440-2-view.png`),
      fullPage: true,
    });
    await cssProfileZoom(page, 1);
    await page.setViewportSize({ width: 390, height: 960 });
    const emptyAgentName = await editText(agent, "name");
    await expect(emptyAgentName).toHaveValue("");
    await page.screenshot({
      path: testInfo.outputPath(`agent-${appearance}-390-name-editor.png`),
      fullPage: true,
    });
    await emptyAgentName.press("Escape");
    for (const label of ["幽默", "严谨", "亲和", "详略"])
      await setLevel(agent, label, 3);
    await openCustom(agent);
    await agent
      .getByRole("checkbox", { name: "设置自定义风格", exact: true })
      .check();
    await agent
      .getByRole("textbox", { name: "自定义讲话风格", exact: true })
      .fill("先给结论，再解释细节。保持真诚，别堆说明文字。");
    for (const [width, zoom] of [
      [390, 1],
      [1440, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 960 });
      await cssProfileZoom(page, zoom);
      await expect(agent).toBeVisible();
      await expectCompactIdentity(agent, zoom);
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
      await agent.evaluate((element) => {
        const scroll = element.closest<HTMLElement>(".inspector-scroll");
        if (scroll) scroll.scrollTop = 0;
      });
      await expect(
        agent.locator(".personality-portrait > .profile-avatar"),
      ).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: testInfo.outputPath(`agent-${appearance}-${width}-${zoom}.png`),
        fullPage: true,
      });
      const customText = agent.getByRole("textbox", {
        name: "自定义讲话风格",
        exact: true,
      });
      // Settle the confirmed expression caption before measuring a scrolled
      // field. CSS-zoom coverage uses DOM scrollIntoView to avoid the driver's
      // logical/physical viewport mismatch; this is not native zoom evidence.
      await waitForAutosave(agent);
      await customText.focus();
      await customText.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      await expect(customText).toBeFocused();
      await expect(customText).toBeInViewport({ ratio: 1 });
      await waitForAutosave(agent);
      await expectQuietProfileLabels(agent, true);
      const usage = profileUsageControl(agent);
      await expectProfileUsage(agent, true);
      await usage.focus();
      await usage.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      await expect(usage).toBeFocused();
      await expect(usage).toBeInViewport({ ratio: 1 });
      await expectUsageSwitchAppearance(usage, { scale: zoom });
      await page.screenshot({
        path: testInfo.outputPath(
          `agent-${appearance}-${width}-${zoom}-identity-switch-expanded.png`,
        ),
        fullPage: true,
      });
      // Closing expression editing must not hide the independent identity
      // switch. Native Tab order places it just before the disclosure.
      const summary = agent.locator(".personality-preferences > summary");
      await summary.click();
      await expect(
        agent.locator(".personality-preferences"),
      ).not.toHaveAttribute("open", "");
      await summary.focus();
      await summary.press("Shift+Tab");
      await expectSwitchKeyboardFocus(usage);
      await expect(usage).toBeInViewport({ ratio: 1 });
      await expectCompactIdentity(agent, zoom);
      await page.screenshot({
        path: testInfo.outputPath(
          `agent-${appearance}-${width}-${zoom}-identity-switch-collapsed.png`,
        ),
        fullPage: true,
      });
      await usage.press("Space");
      await waitForAutosave(agent);
      await expectProfileUsage(agent, false);
      await expect(usage).toBeInViewport({ ratio: 1 });
      await expectUsageSwitchAppearance(usage, { scale: zoom });
      await usage.press("Tab");
      await expect(summary).toBeFocused();
      await summary.press("Shift+Tab");
      await expect(usage).toBeFocused();
      await usage.press("Space");
      await waitForAutosave(agent);
      await expectProfileUsage(agent, true);
      await openPreferences(agent);
      const connection = (await openSystem(page)).getByRole("button", {
        name: "智能体连接",
        exact: true,
      });
      await connection.focus();
      await expect(connection).toBeFocused();
      await expect(connection).toBeInViewport({ ratio: 1 });
    }
    await cssProfileZoom(page, 1);
    await page.setViewportSize({ width: 390, height: 960 });
    const human = await openHuman(page);
    await expectCompactIdentity(human);
    await expect(
      human.getByRole("button", { name: "编辑你的名字", exact: true }),
    ).toBeInViewport();
    await expect(
      human.getByRole("button", { name: "编辑称呼", exact: true }),
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
    await cssProfileZoom(page, 2);
    await expectCompactIdentity(human, 2);
    await expect(human.getByRole("textbox")).toHaveCount(0);
    await expect(human.locator(".personality-heading")).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: testInfo.outputPath(`human-${appearance}-1440-2-view.png`),
      fullPage: true,
    });
    await cssProfileZoom(page, 1);
    await page.setViewportSize({ width: 390, height: 960 });
    const name = await editText(human, "name");
    await name.fill(`TEST ${appearance} 资料草稿`);
    const address = await editText(human, "preferredAddress");
    await address.focus();
    await expect(address).toBeFocused();
    await expect(address).toBeInViewport({ ratio: 1 });
    await waitForAutosave(human);
    await expectQuietProfileLabels(human, false);
    await page.screenshot({
      path: testInfo.outputPath(`human-${appearance}-390-autosaved.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await cssProfileZoom(page, 2);
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
    await expectCompactIdentity(human, 2);
    await human.locator(".personality-identity").scrollIntoViewIfNeeded();
    await expect(human.locator(".personality-identity")).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: testInfo.outputPath(`human-${appearance}-1440-2.png`),
      fullPage: true,
    });
    expect(zoomGeometry.overflow).toBe(false);
    expect(zoomGeometry.right).toBeLessThanOrEqual(zoomGeometry.viewport + 1);
    // Exercise the last real field in the modal scroller. A removed save
    // footer is not a keyboard or geometry target in the immediate design.
    const bottomAddress = await editText(human, "preferredAddress");
    await bottomAddress.scrollIntoViewIfNeeded();
    await bottomAddress.focus();
    await expect(bottomAddress).toBeFocused();
    await expect(bottomAddress).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath(
        `human-${appearance}-1440-2-controls-visible.png`,
      ),
      fullPage: true,
    });
  });
}
