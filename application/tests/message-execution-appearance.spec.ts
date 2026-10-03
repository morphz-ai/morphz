import { expect, type Locator, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

async function prepare(page: Page) {
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      messages: [],
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "completed" as const,
        error: null,
        retryable: false,
      })),
      activity: {
        available: true,
        truncated: false,
        threads: inputs.map((input) => ({
          id: "execution-appearance-thread",
          kind: "execution" as const,
          ...fixture.scope,
          inputId: input.id,
          rootId: "execution-appearance-root",
          sessionId: "execution-appearance-session",
          title: "核对当前称呼",
          phase: "running",
          lifecycle: "open" as const,
          revision: 3,
          updatedAt: input.createdAt,
          continuation: {
            mode: "supplement" as const,
            inputId: input.id,
            threadId: "execution-appearance-thread",
            generation: 1,
          },
        })),
      },
    },
  }));
  inputs.push(
    fixture.input(
      "execution-appearance-input",
      "TEST 请核对当前称呼，不修改任何资料。",
      "2026-10-02T09:00:00.000Z",
    ),
  );
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.capabilities.directedInput = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const message = page.locator(
    '.human-message[data-input-id="execution-appearance-input"]',
  );
  const status = message.getByRole("button", {
    name: "后台执行中",
    exact: true,
  });
  const supplement = message.getByRole("button", {
    name: "补充要求",
    exact: true,
  });
  await expect(status).toBeVisible();
  await expect(supplement).toBeVisible();
  return { message, status, supplement };
}

async function colors(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const token = (name: string) => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;color:var(${name})`;
      element.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return rgba(value);
    };
    const background = rgba(style.backgroundColor);
    const ink = rgba(style.color);
    const hover = token("--human-message-hover");
    const pressed = token("--human-message-pressed");
    const neutral = token("--hover");
    const ancestors: Element[] = [];
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    )
      ancestors.push(current);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    for (const ancestor of ancestors.reverse()) {
      context.fillStyle = getComputedStyle(ancestor).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const surface = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (rgb: number[]) => {
      const values = rgb.slice(0, 3).map((v) => {
        const channel = v / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    const a = luminance(ink),
      b = luminance(surface);
    const rect = element.getBoundingClientRect();
    return {
      background,
      hover,
      pressed,
      neutral,
      contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      width: rect.width,
      height: rect.height,
      padding: style.padding,
      border: style.borderWidth,
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      focusVisible: element.matches(":focus-visible"),
      hovered: element.matches(":hover"),
      active: element.matches(":active"),
    };
  });
}

async function settled(button: Locator, token: "hover" | "pressed") {
  await expect
    .poll(async () => {
      const state = await colors(button);
      return state.background.join(",") === state[token].join(",");
    })
    .toBe(true);
  return colors(button);
}

function assertState(
  state: Awaited<ReturnType<typeof colors>>,
  normal: Awaited<ReturnType<typeof colors>>,
) {
  expect(state.contrast).toBeGreaterThanOrEqual(4.5);
  expect([state.width, state.height, state.padding, state.border]).toEqual([
    normal.width,
    normal.height,
    normal.padding,
    normal.border,
  ]);
  expect(state.background).not.toEqual(state.neutral);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("气泡内后台与补充入口：四强调色亮暗悬停、Tab、按下不出现中性白块", async ({
  page,
}, info) => {
  const { status, supplement, message } = await prepare(page);
  const observations = [];
  for (const appearance of ["亮色", "暗色"]) {
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: appearance, exact: true })
        .click();
      await settings.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      for (const button of [status, supplement]) {
        await button.evaluate((element) => (element as HTMLElement).blur());
        await page.mouse.move(0, 0);
        const normal = await colors(button);
        expect(normal.background[3]).toBe(0);
        expect(normal.contrast).toBeGreaterThanOrEqual(4.5);
        // Work controls are intentionally hover-only; enter the real card
        // before crossing its footer, rather than clicking an invisible action.
        await message.hover();
        await button.hover();
        const hovered = await settled(button, "hover");
        assertState(hovered, normal);
        expect(hovered.hovered).toBe(true);
        const name = await button.textContent();
        await message.screenshot({
          path: info.outputPath(`${appearance}-${accent}-${name}-hover.png`),
        });
        await button.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(button).toBeFocused();
        await page.mouse.move(0, 0);
        const focused = await settled(button, "hover");
        assertState(focused, normal);
        expect(focused.focusVisible).toBe(true);
        expect(focused.outline).toBe("solid");
        expect(parseFloat(focused.outlineWidth)).toBeGreaterThan(0);
        await message.screenshot({
          path: info.outputPath(`${appearance}-${accent}-${name}-focused.png`),
        });
        await button.hover();
        await page.mouse.down();
        const active = await settled(button, "pressed");
        assertState(active, normal);
        expect(active.active).toBe(true);
        await message.screenshot({
          path: info.outputPath(`${appearance}-${accent}-${name}-pressed.png`),
        });
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await button.evaluate((element) => (element as HTMLElement).blur());
        observations.push({
          appearance,
          accent,
          name,
          normal,
          hovered,
          focused,
          active,
        });
      }
    }
  }
  await info.attach("message-execution-color-and-contrast", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
});

test("状态入口仍打开对应活动，补充保留草稿并不提交消息", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/messages(?:\?|$)/.test(request.url())
    )
      writes.push(request.url());
  });
  const { message, status, supplement } = await prepare(page);
  const composer = page.getByLabel("AI 输入内容");
  const draft = "TEST 未发送的补充草稿";
  await composer.fill(draft);
  await message.hover();
  await status.click();
  const panel = page.getByRole("complementary", { name: "Morphz 信息" });
  await expect(
    panel
      .getByRole("region", { name: "执行分支" })
      .getByText("核对当前称呼", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "补充目标" })).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  await message.hover();
  await supplement.click();
  await expect(page.getByRole("group", { name: "补充目标" })).toContainText(
    "核对当前称呼",
  );
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
  expect(writes).toHaveLength(0);
});
