import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { expect, test, type Page } from "@playwright/test";
import {
  initialTopbarScenario,
  type TopbarScenario,
} from "./fixtures/workspace-topbar-baseline.js";

// Source-only React + frozen original chrome, no App/client/Host/Runtime/API.
// Actual stable slot refs, portals and CSS are not established by SSR alone.
let server: Awaited<ReturnType<typeof createServer>>, url: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [
      react(),
      {
        name: "workspace-topbar-isolated",
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url?.split("?")[0] !== "/__workspace-topbar")
              return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${resolve("tests/fixtures/workspace-topbar.tsx")}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/__workspace-topbar`;
});
test.afterAll(async () => {
  await server?.close();
});
type Report = {
  events: string[];
  mounts: Record<string, number>;
  cleanups: Record<string, number>;
  ready: boolean;
};
const run = (page: Page, patch: Partial<TopbarScenario>) =>
  page.evaluate(
    (patch) => Reflect.get(window, "topbarFixture").run(patch),
    patch,
  );
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "topbarFixture").report());
const remember = (page: Page, selector: string, key: string) =>
  page.evaluate(
    ({ selector, key }) =>
      Reflect.get(window, "topbarFixture").remember(selector, key),
    { selector, key },
  );
const same = (page: Page, selector: string, key: string): Promise<boolean> =>
  page.evaluate(
    ({ selector, key }) =>
      Reflect.get(window, "topbarFixture").same(selector, key),
    { selector, key },
  );
async function open(page: Page, baseline = false) {
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) requests.push(r.url());
  });
  await page.goto(url + (baseline ? "?baseline" : ""));
  await page.waitForFunction(
    () => Reflect.get(window, "topbarFixture")?.report().ready,
  );
  return () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  };
}

test("three portal destinations and tools retain node/value identity through all chrome branches", async ({
  page,
}) => {
  const check = await open(page),
    initial = await report(page);
  const selectors = [
    ".topbar",
    ".sidebar-toggle",
    ".navigation-history button:first-child",
    ".application-toolbar-slot",
    ".page-toolbar-slot",
    ".detail-toolbar-slot",
    '[data-portal-input="application"]',
    '[data-portal-input="page"]',
    '[data-portal-input="detail"]',
  ];
  for (const selector of selectors) await remember(page, selector, selector);
  await page
    .getByLabel("page input", { exact: true })
    .fill("unsaved portal content");
  await page.getByLabel("page input", { exact: true }).focus();
  for (const patch of [
    { prefs: { ...initialTopbarScenario.prefs, view: "inbox" as const } },
    { applicationWorkspaceOpen: true },
    {
      applicationWorkspaceOpen: false,
      artifact: { title: "Task", content: { kind: "task" } },
    },
    {
      artifact: { title: "PDF", content: { kind: "pdf" } },
      openingObject: true,
    },
    { artifact: null, openingObject: false, creating: "document" as const },
    {
      creating: null,
      prefs: {
        ...initialTopbarScenario.prefs,
        view: "projects" as const,
        projectOpen: true,
      },
    },
  ]) {
    await run(page, patch);
    for (const selector of selectors)
      assert.equal(await same(page, selector, selector), true, selector);
    assert.equal(
      await page.getByLabel("page input", { exact: true }).inputValue(),
      "unsaved portal content",
    );
    assert.deepEqual((await report(page)).mounts, initial.mounts);
    assert.deepEqual((await report(page)).cleanups, initial.cleanups);
    await expect(page.locator(".workspace > .topbar")).toHaveCount(1);
  }
  await page.evaluate(() => Reflect.get(window, "topbarFixture").closeHeader());
  await expect(page.locator(".topbar")).toHaveCount(0);
  await expect(page.locator("[data-portal-input]")).toHaveCount(0);
  assert.equal(
    await page.evaluate(() =>
      Reflect.get(window, "topbarFixture").targetsConnected(),
    ),
    false,
  );
  for (const name of ["application", "page", "detail"])
    assert.equal(
      (await report(page)).cleanups[name],
      initial.cleanups[name]! + 1,
      name,
    );
  check();
});

test("unrelated updates preserve focused native controls and actions dispatch exactly once", async ({
  page,
}) => {
  const check = await open(page);
  const back = page.getByRole("button", { name: "返回上一位置", exact: true });
  await back.focus();
  await remember(page, ".navigation-history button:first-child", "back");
  await run(page, { project: { title: "项目 B" } });
  await expect(back).toBeFocused();
  assert.equal(
    await same(page, ".navigation-history button:first-child", "back"),
    true,
  );
  await back.click();
  await page.getByRole("button", { name: "前往下一位置", exact: true }).click();
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await run(page, {
    prefs: {
      ...initialTopbarScenario.prefs,
      view: "projects",
      projectOpen: true,
    },
    artifact: { title: "Document", content: { kind: "document" } },
    collaborationVisible: true,
  });
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "项目 B", exact: true }).click();
  await page.getByRole("button", { name: "收起批注栏", exact: true }).click();
  assert.deepEqual((await report(page)).events, [
    "travel:-1",
    "travel:1",
    "sidebar",
    "view",
    "project",
    "collaboration",
  ]);
  await run(page, { history: { index: 0, length: 1 } });
  await expect(back).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "前往下一位置", exact: true }),
  ).toBeDisabled();
  check();
});

async function metrics(page: Page) {
  return page.locator(".topbar").evaluate((header) => {
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    };
    const style = getComputedStyle(header);
    return {
      html: header.outerHTML,
      rect: rect(header),
      style: [
        style.display,
        style.backgroundColor,
        style.color,
        style.paddingTop,
        style.paddingRight,
        style.marginRight,
        style.borderBottomWidth,
        getComputedStyle(header, "::before").height,
      ],
      children: [...header.children].map((e) => ({
        name: e.tagName,
        class: e.className,
        rect: rect(e),
        display: getComputedStyle(e).display,
        hidden: e.hasAttribute("hidden"),
      })),
      controls: [...header.querySelectorAll("button, input")].map((e) => ({
        rect: rect(e),
        appRegion: getComputedStyle(e).getPropertyValue("-webkit-app-region"),
        fontSize: getComputedStyle(e).fontSize,
      })),
    };
  });
}
test("fixed baseline and candidate retain computed chrome across four accents/light-dark/wide-narrow/200 percent", async ({
  page,
  context,
}) => {
  const original = await context.newPage();
  const check = await open(page),
    checkOriginal = await open(original, true);
  try {
    for (const width of [1440, 1000, 760]) {
      await page.setViewportSize({ width, height: 800 });
      await original.setViewportSize({ width, height: 800 });
      for (const accent of ["teal", "iris", "coral", "mono"])
        for (const appearance of ["light", "dark"]) {
          for (const target of [page, original])
            await target.locator(".app").evaluate(
              (e, values) => {
                (e as HTMLElement).dataset.accent = values.accent;
                (e as HTMLElement).dataset.appearance = values.appearance;
                (e as HTMLElement).dataset.desktop = "mac";
              },
              { accent, appearance },
            );
          for (const zoom of ["1", "2"]) {
            for (const target of [page, original])
              await target.evaluate((zoom) => {
                document.documentElement.style.zoom = zoom;
              }, zoom);
            assert.deepEqual(
              await metrics(page),
              await metrics(original),
              `${width}/${accent}/${appearance}/${zoom}`,
            );
          }
        }
    }
    check();
    checkOriginal();
  } finally {
    await original.close();
  }
});

test("portal :has visibility/branch cascade remains equal without extra wrappers", async ({
  page,
  context,
}) => {
  const original = await context.newPage(),
    check = await open(page),
    checkOriginal = await open(original, true);
  try {
    for (const patch of [
      { applicationWorkspaceOpen: true },
      {
        applicationWorkspaceOpen: false,
        artifact: { title: "Task", content: { kind: "task" } },
      },
      { artifact: null, creating: "document" as const },
      { openingObject: true },
      {
        openingObject: false,
        creating: null,
        prefs: {
          ...initialTopbarScenario.prefs,
          view: "projects" as const,
          projectOpen: true,
        },
      },
    ]) {
      await run(page, patch);
      await run(original, patch);
      assert.deepEqual(await metrics(page), await metrics(original));
    }
    check();
    checkOriginal();
  } finally {
    await original.close();
  }
});

test("coarse pointer and reduced motion keep the same native header and focus behavior", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 760, height: 600 },
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage(),
      original = await context.newPage(),
      check = await open(page),
      checkOriginal = await open(original, true);
    assert.equal(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      true,
    );
    assert.deepEqual(await metrics(page), await metrics(original));
    await page.getByLabel("page input", { exact: true }).focus();
    await run(page, { history: { index: 2, length: 4 } });
    await expect(page.getByLabel("page input", { exact: true })).toBeFocused();
    check();
    checkOriginal();
  } finally {
    await context.close();
  }
});
