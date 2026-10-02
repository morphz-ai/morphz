import type { Page } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { conversationRuntimeSchema } from "../packages/core/src/conversation.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";

const subject = (page: Page) => page.locator(".subject-sidebar");
const left = (page: Page) =>
  page.getByRole("complementary", { name: "工作空间导航", exact: true });
const categories = [
  ["activity", "活动"],
  ["permissions", "授权"],
  ["schedules", "定时任务"],
  ["settings", "设定"],
] as const;
const tab = (page: Page, name: string) =>
  subject(page)
    .getByRole("tablist", { name: "Morphz 信息分类", exact: true })
    .getByRole("tab", { name, exact: true });

async function start(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const client = await conversationClient(page);
  const key = `${applicationStoragePrefix}${client.boot.centerId}:${client.boot.principalId}:preferences`;
  return { client, key };
}

async function preferences(page: Page, key: string) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
    key,
  );
}

async function savePreference(
  page: Page,
  key: string,
  change: Record<string, unknown>,
) {
  await page.evaluate(
    ({ key, change }) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...saved, ...change }));
    },
    { key, change },
  );
}

async function openSubject(page: Page) {
  if (!(await subject(page).isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await expect(subject(page)).toBeVisible();
}

function watchExecutionRequests(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/(?:platform\/(?:messages|conversations\/start)|executions\/control|command|execute)(?:[/?]|$)/.test(
        request.url(),
      )
    )
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return writes;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

for (const [id, name] of categories) {
  test(`${name}分类开关及宽度刷新恢复，不改变左栏、草稿或执行`, async ({
    page,
    messageHost,
  }, testInfo) => {
    const { key } = await start(page);
    const writes = watchExecutionRequests(page);
    const draft = `TEST ${name}分类刷新保留的未发送草稿`;
    await (await openInput(page)).fill(draft);
    await page
      .getByRole("separator", { name: "调整左侧栏宽度", exact: true })
      .focus();
    await page.keyboard.press("Home");
    await expect
      .poll(async () => Math.round((await left(page).boundingBox())!.width))
      .toBe(80);
    // Both hidden and compact left states remain independent of the subject.
    const hideLeft = id === "permissions" || id === "schedules";
    if (hideLeft)
      await page
        .getByRole("button", { name: "隐藏侧边栏", exact: true })
        .click();
    await openSubject(page);
    await tab(page, name).click();
    const resize = subject(page).getByRole("separator", {
      name: "调整 Morphz 信息栏宽度",
      exact: true,
    });
    await resize.focus();
    for (let i = 0; i < 3; i++) await resize.press("ArrowLeft");
    await expect(resize).toHaveAttribute("aria-valuenow", "388");
    const before = await preferences(page, key);
    expect(before.subjectOpen).toBe(true);
    expect(before.subjectTab).toBe(id);
    expect(before.inspectorWidth).toBe(388);
    await page.reload();
    await expect(subject(page)).toBeVisible();
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(subject(page)).toHaveCSS("width", "388px");
    if (hideLeft) await expect(left(page)).toBeHidden();
    else
      await expect
        .poll(async () => Math.round((await left(page).boundingBox())!.width))
        .toBe(80);
    await expect(await openInput(page)).toHaveValue(draft);
    await page.screenshot({
      path: testInfo.outputPath(`subject-reload-${id}.png`),
    });
    await page.getByRole("button", { name: "隐藏右侧栏", exact: true }).click();
    await page.reload();
    await expect(subject(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "显示右侧栏", exact: true }),
    ).toBeVisible();
    const closed = await preferences(page, key);
    expect(closed.subjectOpen).toBe(false);
    expect(closed.subjectTab).toBe(id);
    expect(closed.inspectorWidth).toBe(before.inspectorWidth);
    expect(closed.sidebar).toBe(before.sidebar);
    expect(closed.sidebarWidth).toBe(before.sidebarWidth);
    expect(closed.sidebarCompact).toBe(before.sidebarCompact);
    await openSubject(page);
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(await openInput(page)).toHaveValue(draft);
    expect(writes).toEqual([]);
    expect(messageHost.deliveries()).toEqual([]);
  });
}

test("旧执行固定记录不强开信息栏，非法分类安全回到活动且不恢复旧详情", async ({
  page,
  messageHost,
}) => {
  const { key } = await start(page);
  const writes = watchExecutionRequests(page);
  const draft = "TEST 非法偏好和旧固定记录不丢失的草稿";
  await (await openInput(page)).fill(draft);
  for (const value of [undefined, false, "true", 1]) {
    await savePreference(page, key, {
      subjectOpen: value,
      subjectTab: "settings",
      executionPinned: true,
      executionScope: {
        inputId: "retired-private-input",
        projectId: "old-project",
      },
    });
    await page.reload();
    await expect(subject(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "显示右侧栏", exact: true }),
    ).toBeVisible();
    await expect(await openInput(page)).toHaveValue(draft);
  }
  for (const invalid of ["unknown", "__proto__", null]) {
    await savePreference(page, key, {
      subjectOpen: true,
      subjectTab: invalid,
      executionPinned: true,
    });
    await page.reload();
    await expect(subject(page)).toBeVisible();
    await expect(tab(page, "活动")).toHaveAttribute("aria-selected", "true");
    await expect(
      subject(page).getByRole("button", { name: "返回活动列表", exact: true }),
    ).toHaveCount(0);
    await expect(subject(page)).not.toContainText("retired-private-input");
    await expect(await openInput(page)).toHaveValue(draft);
  }
  expect(writes).toEqual([]);
  expect(messageHost.deliveries()).toEqual([]);
});

test("异身份及中心的存储键不能覆盖当前偏好与草稿，当前操作不改外部作用域", async ({
  page,
  messageHost,
}) => {
  const { client, key } = await start(page);
  const writes = watchExecutionRequests(page);
  const draft = "TEST 原身份下的信息栏草稿";
  await (await openInput(page)).fill(draft);
  await openSubject(page);
  await tab(page, "设定").click();
  const original = await preferences(page, key);
  const currentPrefix = `${applicationStoragePrefix}${client.boot.centerId}:${client.boot.principalId}:`;
  const foreignPrefixes = [
    `${applicationStoragePrefix}${client.boot.centerId}:TEST-other-subject-human:`,
    `${applicationStoragePrefix}00000000-0000-4000-8000-000000000002:${client.boot.principalId}:`,
  ];
  // The real authenticated bootstrap remains untouched. Deliberately seed
  // neighboring storage scopes; this checks local isolation, not login/auth.
  async function seedForeign(open: boolean) {
    await page.evaluate(
      ({ currentPrefix, foreignPrefixes, open }) => {
        const drafts = Object.entries(localStorage).filter(
          ([key]) => key.startsWith(currentPrefix) && key.includes(":draft:"),
        );
        for (const prefix of foreignPrefixes) {
          localStorage.setItem(
            `${prefix}preferences`,
            JSON.stringify({
              subjectOpen: open,
              subjectTab: "permissions",
              inspectorWidth: 520,
              sidebar: false,
            }),
          );
          for (const [key] of drafts)
            localStorage.setItem(
              prefix + key.slice(currentPrefix.length),
              JSON.stringify({
                foreign: { body: "TEST 不应出现的其他作用域草稿" },
              }),
            );
        }
      },
      { currentPrefix, foreignPrefixes, open },
    );
  }
  const foreignValues = () =>
    page.evaluate(
      (prefixes) =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) =>
            prefixes.some((prefix) => key.startsWith(prefix)),
          ),
        ),
      foreignPrefixes,
    );
  await seedForeign(false);
  const closedForeign = await foreignValues();
  await page.reload();
  await expect(subject(page)).toBeVisible();
  await expect(tab(page, "设定")).toHaveAttribute("aria-selected", "true");
  await expect(await openInput(page)).toHaveValue(draft);
  expect(await preferences(page, key)).toEqual(original);
  expect(await foreignValues()).toEqual(closedForeign);
  await page.getByRole("button", { name: "隐藏右侧栏", exact: true }).click();
  await seedForeign(true);
  const openForeign = await foreignValues();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "显示右侧栏", exact: true }),
  ).toBeVisible();
  await expect(subject(page)).toHaveCount(0);
  expect((await preferences(page, key)).subjectOpen).toBe(false);
  await expect(await openInput(page)).toHaveValue(draft);
  await openSubject(page);
  await expect(tab(page, "设定")).toHaveAttribute("aria-selected", "true");
  expect((await preferences(page, key)).subjectOpen).toBe(true);
  expect(await foreignValues()).toEqual(openForeign);
  await expect(page.locator(".app")).not.toContainText(
    "TEST 不应出现的其他作用域草稿",
  );
  expect(writes).toEqual([]);
  expect(messageHost.deliveries()).toEqual([]);
});

test("页签默认Logo随分类图标同色，四主题明暗均保持静态及未发送草稿", async ({
  page,
  messageHost,
}, testInfo) => {
  const { key } = await start(page);
  const writes = watchExecutionRequests(page);
  const draft = "TEST 页签配色刷新保留的原草稿";
  await (await openInput(page)).fill(draft);
  await openSubject(page);
  for (const appearance of ["light", "dark"])
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await savePreference(page, key, {
        appearance,
        accent,
        subjectOpen: true,
      });
      await page.reload();
      await expect(subject(page)).toBeVisible();
      const settings = tab(page, "设定");
      const logo = settings.locator("svg.brand-mark");
      await expect(logo).toHaveCount(1);
      for (const selected of ["设定", "活动"]) {
        await tab(page, selected).click();
        await expect
          .poll(() =>
            settings.evaluate((button) => {
              const color = getComputedStyle(button).color;
              const selected = button.getAttribute("aria-selected") === "true";
              return {
                matchesTab:
                  getComputedStyle(
                    button.querySelector("svg.brand-mark > path")!,
                  ).fill === color,
                matchesInactiveGroup:
                  selected ||
                  getComputedStyle(
                    button.parentElement!.querySelector(
                      '[data-view="permissions"]',
                    )!,
                  ).color === color,
              };
            }),
          )
          .toEqual({ matchesTab: true, matchesInactiveGroup: true });
        await expect(logo).toHaveCSS("animation-name", "none");
      }
      await expect(await openInput(page)).toHaveValue(draft);
      if (accent === "cyan")
        await subject(page).screenshot({
          path: testInfo.outputPath(`subject-tabs-${appearance}.png`),
        });
    }
  expect(writes).toEqual([]);
  expect(messageHost.deliveries()).toEqual([]);
});

test("显式打开线程详情刷新后恢复活动总览，不保存原执行范围或发送输入", async ({
  page,
  messageHost,
}) => {
  const { client, key } = await start(page);
  const spaces = await client.ensurePersonalSpaces();
  const runtime = conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "TEST-sidebar-reload-model",
    error: "",
    messages: [],
    deliveries: [],
    attention: { available: true, approvals: [] },
    activity: {
      available: true,
      truncated: false,
      openWorkComplete: true,
      threads: [
        {
          id: "TEST-sidebar-reload-thread",
          kind: "execution",
          projectId: spaces.dialogueId,
          conversationId: spaces.dialogueId,
          artifactId: null,
          inputId: null,
          rootId: "TEST-sidebar-reload-root",
          sessionId: "TEST-sidebar-reload-session",
          title: "TEST 刷新不恢复的具体执行",
          phase: "running",
          lifecycle: "open",
          controlState: "active",
          revision: 1,
          updatedAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    },
  });
  // Controlled read-only activity projection; no actual execution is started.
  await page.route("**/api/models", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({
      json: {
        current: runtime.model,
        options: [{ id: runtime.model, label: runtime.model }],
      },
    });
  });
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const { "if-none-match": _etag, ...headers } = route.request().headers();
      const response = await route.fetch({ headers });
      const actual = await response.json();
      await route.fulfill({ response, json: { ...actual, runtime } });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const actual = await response.json();
      await route.fulfill({ response, json: { ...actual, runtime } });
    },
  );
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.reload();
  const writes = watchExecutionRequests(page);
  const draft = "TEST 线程详情刷新后的原草稿";
  await (await openInput(page)).fill(draft);
  // Explicit Logo access is a separate opening path from the visibility toggle.
  await page.locator(".sidebar .agent-presence").click();
  await expect(subject(page)).toBeVisible();
  await subject(page)
    .locator('[data-thread-id="TEST-sidebar-reload-thread"]')
    .click();
  await expect(
    subject(page).getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  const saved = await preferences(page, key);
  expect(saved.subjectOpen).toBe(true);
  expect(saved.subjectTab).toBe("activity");
  expect(JSON.stringify(saved)).not.toContain("TEST-sidebar-reload-thread");
  expect(JSON.stringify(saved)).not.toContain("TEST-sidebar-reload-root");
  await page.reload();
  await expect(subject(page)).toBeVisible();
  await expect(tab(page, "活动")).toHaveAttribute("aria-selected", "true");
  await expect(
    subject(page).getByRole("button", { name: "返回活动列表", exact: true }),
  ).toHaveCount(0);
  await expect(
    subject(page).locator('[data-thread-id="TEST-sidebar-reload-thread"]'),
  ).toBeVisible();
  await expect(await openInput(page)).toHaveValue(draft);
  expect(writes).toEqual([]);
  expect(messageHost.deliveries()).toEqual([]);
});
