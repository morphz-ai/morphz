import type { Locator, Page } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
} from "../packages/core/src/applications.js";
import { applicationKey } from "../apps/web/src/application-dock-model.js";

const browser = applicationKey(browserApplication),
  reader = applicationKey(readerApplication),
  studio = applicationKey(scriptStudioApplication);
const draft = "TEST Dock 拖拽：保留原草稿，不发送。";
const pins = (page: Page) => page.locator(".application-dock-pins");
const shortcut = (page: Page, key: string) =>
  pins(page).locator(`[data-dock-key="${key}"]`);
const order = (page: Page) =>
  pins(page)
    .locator("[data-dock-key]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-dock-key")),
    );

async function point(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}
async function drag(
  page: Page,
  source: Locator,
  target: { x: number; y: number },
) {
  const origin = await point(source);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(page.locator(".application-dock")).toHaveAttribute(
    "data-dragging",
    "true",
  );
  await page.mouse.up();
  await expect(page.locator(".application-dock")).not.toHaveAttribute(
    "data-dragging",
    "true",
  );
}
async function prepare(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "应用列表", exact: true }),
  ).toBeVisible();
  const input = await openInput(page);
  await input.fill(draft);
  await expect(shortcut(page, studio)).toBeVisible();
  await expect(shortcut(page, browser)).toBeVisible();
  return input;
}

async function unchangedDomain(page: Page) {
  const client = await conversationClient(page);
  const snapshot = async () => {
    const response = await page.request.get("/api/platform/app-views");
    expect(response.ok(), await response.text()).toBe(true);
    return {
      conversations: await client.allNavigationConversations(),
      appViews: await response.json(),
    };
  };
  const before = await snapshot();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return async (reloaded = false) => {
    // A normal reload idempotently ensures the existing personal spaces. It is
    // not a drag command; enforce zero writes before reload, and no other write
    // afterward (in particular no launch, Input or Session operation).
    expect(writes).toEqual(reloaded ? ["POST /api/platform/spaces/ensure"] : []);
    expect(await snapshot()).toEqual(before);
  };
}

test("production Host Dock reorder persists without launching, navigating or losing the input draft", async ({
  page,
}) => {
  const input = await prepare(page);
  const verify = await unchangedDomain(page);
  const target = await point(shortcut(page, studio));
  await drag(page, shortcut(page, browser), { x: target.x - 9, y: target.y });
  expect(await order(page)).toEqual([browser, studio]);
  await expect(input).toHaveValue(draft);
  await expect(
    page.getByRole("list", { name: "应用列表", exact: true }),
  ).toBeVisible();
  await verify();
  await page.reload();
  const restored = await openInput(page);
  expect(await order(page)).toEqual([browser, studio]);
  await expect(restored).toHaveValue(draft);
  await verify(true);
});

test("production Host drag-out unpins and Launcher drag-in adds without starting an app or a Session", async ({
  page,
}) => {
  const input = await prepare(page);
  const verify = await unchangedDomain(page);
  const origin = await point(shortcut(page, browser));
  await drag(page, shortcut(page, browser), { x: origin.x, y: origin.y - 120 });
  expect(await order(page)).toEqual([studio]);
  await page.getByRole("button", { name: "全部应用", exact: true }).click();
  const launcher = page.getByRole("group", { name: "选择应用", exact: true });
  await expect(launcher).toBeVisible();
  await expect(
    launcher.getByRole("button", {
      name: `打开${browserApplication.title}`,
      exact: true,
    }),
  ).toBeVisible();
  const dock = await point(shortcut(page, studio));
  await drag(
    page,
    launcher.getByRole("button", {
      name: `打开${readerApplication.title}`,
      exact: true,
    }),
    { x: dock.x - 9, y: dock.y },
  );
  expect(await order(page)).toEqual([reader, studio]);
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue(draft);
  await expect(
    page.getByRole("list", { name: "应用列表", exact: true }),
  ).toBeVisible();
  await verify();
  await page.reload();
  const restored = await openInput(page);
  expect(await order(page)).toEqual([reader, studio]);
  await expect(restored).toHaveValue(draft);
  await verify(true);
});
