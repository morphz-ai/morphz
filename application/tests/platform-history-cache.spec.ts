import { test, expect } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

test("正式 Platform 会话定时刷新复用正文，新事件版本才重读", async ({
  page,
}) => {
  let version = "a".repeat(64);
  let catalogBump = 0;
  const historyCalls: string[] = [];
  let catalogCalls = 0;
  const navigationScopes: string[] = [];
  page.on("request", (request) => {
    if (
      [
        "/api/platform/spaces/ensure",
        "/api/platform/projects",
        "/api/platform/conversations/navigation",
        "/api/platform/tasks",
        "/api/platform/content",
        "/api/platform/tasks/order",
      ].includes(new URL(request.url()).pathname)
    )
      catalogCalls++;
  });
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      navigationScopes.push(new URL(route.request().url()).search);
      const response = await route.fetch();
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          catalogVersion: navigation.catalogVersion + catalogBump,
          historyVersion: version,
          runtime: { ...navigation.runtime, configured: true },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history$/,
    async (route) => {
      historyCalls.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        json: {
          inputs: [],
          nextCursor: null,
          runtime: { ...disconnectedRuntime, configured: true },
        },
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  await expect.poll(() => historyCalls.length).toBe(1);
  await expect
    .poll(
      () => navigationScopes.some((scope) => scope.includes("projectId=")),
      {
        timeout: 10_000,
      },
    )
    .toBe(true);
  const initialCatalogCalls = catalogCalls;
  expect(initialCatalogCalls).toBeGreaterThan(0);
  await page.waitForTimeout(5_600);
  expect(historyCalls).toHaveLength(1);
  expect(catalogCalls).toBe(initialCatalogCalls);

  version = "b".repeat(64);
  await expect.poll(() => historyCalls.length, { timeout: 10_000 }).toBe(2);
  expect(historyCalls[1]).toBe(historyCalls[0]);
  expect(catalogCalls).toBe(initialCatalogCalls);

  catalogBump++;
  await expect
    .poll(() => catalogCalls, { timeout: 10_000 })
    .toBeGreaterThan(initialCatalogCalls);
});
