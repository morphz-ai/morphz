import { test, expect, type Request } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

test("正式 Platform 会话显式唤醒复用正文，健康空闲不读取，新事件版本才重读", async ({
  page,
}) => {
  let version = "a".repeat(64);
  let catalogBump = 0;
  const historyCalls: string[] = [];
  let catalogCalls = 0;
  const navigationScopes: string[] = [];
  const pendingReads = new Set<Request>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname.startsWith("/api/platform/") &&
      !url.pathname.endsWith("/stream")
    )
      pendingReads.add(request);
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
  page.on("requestfinished", (request) => pendingReads.delete(request));
  page.on("requestfailed", (request) => pendingReads.delete(request));
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
  // Initial navigation has no selected scope until the authorized catalog and
  // latest page commit. Enter the existing foreground trigger explicitly;
  // there is intentionally no idle ticker to issue that second scoped read.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(
      () => navigationScopes.some((scope) => scope.includes("projectId=")),
      {
        timeout: 10_000,
      },
    )
    .toBe(true);
  // A request starting is not a foreground reconciliation completing. The
  // original assertion captured this counter during the first scoped read,
  // then counted its CAS and already-queued startup resync as idle polling.
  // Drain only in-flight reads/React commits; the full 5.6s zero-read window
  // below remains unchanged and still catches a healthy-period scanner.
  for (let pass = 0; pass < 10; pass++) {
    await expect.poll(() => pendingReads.size).toBe(0);
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    if (!pendingReads.size) break;
  }
  expect(pendingReads.size).toBe(0);
  const initialCatalogCalls = catalogCalls;
  const initialNavigationCalls = navigationScopes.length;
  expect(initialCatalogCalls).toBeGreaterThan(0);
  await page.waitForTimeout(5_600);
  expect(historyCalls).toHaveLength(1);
  expect(catalogCalls).toBe(initialCatalogCalls);
  expect(navigationScopes).toHaveLength(initialNavigationCalls);

  version = "b".repeat(64);
  // Changing this routed snapshot is not a server event. Foregrounding is an
  // existing explicit refresh trigger; healthy idle remains zero polling.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => historyCalls.length, { timeout: 10_000 }).toBe(2);
  expect(historyCalls[1]).toBe(historyCalls[0]);
  expect(catalogCalls).toBe(initialCatalogCalls);

  catalogBump++;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(() => catalogCalls, { timeout: 10_000 })
    .toBeGreaterThan(initialCatalogCalls);
});
