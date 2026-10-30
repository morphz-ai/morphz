import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { scriptEditorHeadSchema } from "../packages/core/src/script-editor.js";
import { observeScriptSnapshotReads } from "./script-browser-read-proof.js";
import { settleTransitions } from "./interaction-helpers.js";
import { compareExchangePaint } from "./exchange-paint-comparison.js";

// Finite compiled Host proof against actual saved 4ce98b64 assets, not a
// reconstructed old component. All script objects are real isolated Platform
// data. Two desktop themes and six read phases are not native App acceptance,
// all viewport coverage or raw RGBA equality (the paint oracle has AA limits).
type Asset = { url: string; sha256: string };
type Manifest = { html: string; assets: Asset[] };
const oldDirectory = process.env.MORPHZ_SCRIPT_READS_BASELINE_DIR;
const candidatePath = process.env.MORPHZ_SCRIPT_READS_CANDIDATE_MANIFEST;
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const urls = (html: string) =>
  [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(
    (match) => match[1]!,
  );
function manifests() {
  const html = readFileSync(join(oldDirectory!, "index.html"), "utf8");
  const old: Manifest = {
    html,
    assets: urls(html).map((url) => ({
      url,
      sha256: digest(
        readFileSync(join(oldDirectory!, "assets", basename(url))),
      ),
    })),
  };
  expect(old.assets).toContainEqual({
    url: "/assets/app-C3_7G4YY.js",
    sha256: "d892c329627e19446ace0292364e47ad824e8a6de9caee0d11fc0b2b9aedf1c1",
  });
  expect(old.assets).toContainEqual({
    url: "/assets/app-B_zOsesV.css",
    sha256: "552d58cb432d3559ca7b754f8839ca2e9305c2ce726543970e6005c25841f3d9",
  });
  const candidate = JSON.parse(
    readFileSync(candidatePath!, "utf8"),
  ) as Manifest;
  expect(candidate.assets.map((asset) => asset.url).sort()).toEqual(
    urls(candidate.html).sort(),
  );
  return { old, candidate };
}
async function capture(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await settleTransitions(page);
  const panel = page.locator(".script-studio");
  const state = await panel.evaluate((root) => {
    const properties = [
      "display",
      "position",
      "padding",
      "margin",
      "gap",
      "overflow",
      "color",
      "background-color",
      "border-color",
      "border-radius",
      "box-shadow",
      "font-size",
      "font-weight",
      "line-height",
      "transform",
    ];
    const selectors = [
      ".script-toolbar",
      ".script-directory",
      ".script-tree-row",
      ".script-overview",
      ".script-export-record",
      ".script-editor",
      ".script-editor-header",
      "[role=tab]",
      "[role=tabpanel]",
      ".script-text",
      ".script-history",
      "input",
      "select",
      "textarea",
    ];
    return {
      text: (root as HTMLElement).innerText,
      nodes: selectors.flatMap((selector) =>
        [...root.querySelectorAll<HTMLElement>(selector)].map((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            selector,
            rect: [box.x, box.y, box.width, box.height],
            style: Object.fromEntries(
              properties.map((key) => [key, style.getPropertyValue(key)]),
            ),
            icons: [...element.querySelectorAll("svg")].map(
              (svg) => svg.outerHTML,
            ),
            selected: element.getAttribute("aria-selected"),
            expanded: element.getAttribute("aria-expanded"),
            label: element.getAttribute("aria-label"),
            value: "value" in element ? element.value : null,
            disabled: "disabled" in element ? element.disabled : null,
          };
        }),
      ),
      focusedLabel: document.activeElement?.getAttribute("aria-label"),
    };
  });
  return {
    state,
    paint: await panel.screenshot({ caret: "hide", animations: "allow" }),
  };
}
type Capture = Awaited<ReturnType<typeof capture>>;
async function renderer(
  browser: Browser,
  baseURL: string,
  manifest: Manifest,
  old: boolean,
  appearance: string,
  title: string,
  itemTitle: string,
  contentId: string,
) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  try {
    const receipts: Promise<Asset & { status: number }>[] = [];
    const errors: string[] = [],
      mutations: string[] = [];
    const snapshots = observeScriptSnapshotReads(page);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.origin === baseURL &&
        manifest.assets.some((asset) => asset.url === url.pathname)
      )
        receipts.push(
          response.body().then((body) => ({
            url: url.pathname,
            status: response.status(),
            sha256: digest(body),
          })),
        );
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      // Launch/view receipts are legitimate navigation, not script writes.
      if (
        !["GET", "HEAD"].includes(request.method()) &&
        (url.pathname.startsWith(`/api/platform/scripts/${contentId}`) ||
          url.pathname.startsWith("/api/inputs") ||
          url.pathname.startsWith("/api/platform/inputs"))
      )
        mutations.push(`${request.method()} ${url.pathname}`);
    });
    if (old) {
      await page.route(`${baseURL}/`, (route) =>
        route.fulfill({ body: manifest.html, contentType: "text/html" }),
      );
      for (const asset of manifest.assets)
        await page.route(`${baseURL}${asset.url}`, (route) =>
          route.fulfill({
            body: readFileSync(
              join(oldDirectory!, "assets", basename(asset.url)),
            ),
            contentType: asset.url.endsWith(".css")
              ? "text/css"
              : "text/javascript",
          }),
        );
    }
    await page.clock.setFixedTime(new Date("2026-10-04T00:00:00Z"));
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page
      .getByRole("region", { name: "应用", exact: true })
      .getByRole("button", { name: "剧本工作室 1.0.0", exact: true })
      .click();
    const search = page.getByLabel("查找剧本", { exact: true });
    const library = page.getByRole("button", { name: "全部剧本", exact: true });
    await expect(search.or(library).first()).toBeVisible();
    if (!(await search.isVisible())) await library.click();
    await search.fill(title);
    await page
      .getByRole("button", { name: `打开剧本：${title}`, exact: true })
      .click();
    await expect(page.getByLabel("当前剧本", { exact: true })).toContainText(
      title,
    );
    await page
      .locator(".app")
      .evaluate(
        (element, appearance) =>
          element.setAttribute("data-appearance", appearance),
        appearance,
      );
    // Both Hosts restore the actual persisted application location. Enter the
    // same phase explicitly instead of rewriting view/store data for a test.
    await page
      .getByRole("navigation", { name: "剧本目录", exact: true })
      .getByRole("button", { name: "概览", exact: true })
      .click();
    await expect(page.locator(".script-overview")).toBeVisible();
    const phases: Record<string, Capture> = {};
    phases.overview = await capture(page);
    await page
      .locator(".script-overview-details > summary", {
        hasText: "导出历史（1）",
      })
      .click();
    await expect(page.locator(".script-export-record")).toContainText(
      "TEST 不可变旧标题 · v1",
    );
    phases.exportTitles = await capture(page);
    await page
      .getByRole("navigation", { name: "剧本目录", exact: true })
      .getByRole("button", { name: new RegExp(itemTitle) })
      .click();
    const body = page.getByLabel("剧本正文", { exact: true });
    await expect(body).toHaveValue("TEST 当前第二版实际正文");
    phases.currentBody = await capture(page);
    await page.getByRole("tab", { name: "历史", exact: true }).click();
    await page
      .getByRole("combobox", { name: "查看版本", exact: true })
      .selectOption("1");
    await expect(page.locator(".script-history pre")).toHaveText(
      "TEST 第一版实际正文",
    );
    phases.history = await capture(page);
    await page.getByRole("tab", { name: "正文", exact: true }).click();
    await expect(body).toHaveValue("TEST 当前第二版实际正文");
    await body.fill("TEST 未保存原草稿\n保持第二行和选区");
    await body.evaluate((element) =>
      (element as HTMLTextAreaElement).setSelectionRange(5, 11),
    );
    phases.draft = await capture(page);
    await page.getByRole("tab", { name: "检查与影响", exact: true }).click();
    await expect(
      page.getByRole("tabpanel", { name: "检查与影响", exact: true }),
    ).toBeVisible();
    phases.checks = await capture(page);
    await page.getByRole("tab", { name: "正文", exact: true }).click();
    await expect(body).toHaveValue("TEST 未保存原草稿\n保持第二行和选区");
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
    expect(snapshots).toEqual({ requests: [], responses: [] });
    const loaded = await Promise.all(receipts);
    for (const asset of manifest.assets)
      expect(loaded).toContainEqual({ ...asset, status: 200 });
    return { phases, loaded };
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await context.close();
    }
  }
}
for (const appearance of ["light", "dark"])
  test(`剧本读取实际编译 Host 旧新等价：1440/${appearance}`, async ({
    browser,
    baseURL,
  }, info) => {
    test.skip(
      !oldDirectory || !candidatePath,
      "需要保存的 4ce98b64 编译包与实际候选 manifest",
    );
    const { old, candidate } = manifests();
    const remote = new HttpApplicationClient(baseURL!);
    const source = await PlatformClient.connect(remote);
    const { deskId } = await source.ensurePersonalSpaces();
    const productionId = randomUUID(),
      itemId = randomUUID();
    const title = `TEST 查询等价 ${randomUUID().slice(0, 8)}`,
      itemTitle = "TEST 当前第二版标题";
    await source.createScript({
      commandId: randomUUID(),
      productionId,
      projectId: deskId,
      title,
    });
    const catalog = await source.resolveContent({
      appId: "morphz.script-studio",
      appObjectId: productionId,
    });
    const head = () =>
      remote
        .call(
          "scripts.editor.head",
          { contentId: catalog.id },
          { identityGeneration: source.boot.csrfToken },
        )
        .then((value) => scriptEditorHeadSchema.parse(value));
    await source.createScriptItem({
      commandId: randomUUID(),
      contentId: catalog.id,
      itemId,
      kind: "episode",
      expectedActivityRevision: (await head()).activityRevision,
      draft: {
        ...emptyScriptDraft("TEST 不可变旧标题"),
        sources: [],
        text: "TEST 第一版实际正文",
      },
    });
    const exportHead = await head();
    await source.recordScriptExport({
      commandId: randomUUID(),
      contentId: catalog.id,
      expectedRevision: exportHead.revision,
      items: [{ itemId, revision: 1 }],
      template: exportHead.template,
      workingCopy: true,
    });
    await source.reviseScriptItem({
      commandId: randomUUID(),
      contentId: catalog.id,
      itemId,
      expectedRevision: 1,
      draft: {
        ...emptyScriptDraft(itemTitle),
        sources: [],
        text: "TEST 当前第二版实际正文",
      },
    });
    const before = digest(JSON.stringify(await source.readScript(catalog.id)));
    const left = await renderer(
      browser,
      baseURL!,
      old,
      true,
      appearance,
      title,
      itemTitle,
      catalog.id,
    );
    const right = await renderer(
      browser,
      baseURL!,
      candidate,
      process.env.MORPHZ_SCRIPT_READS_CALIBRATE === "1",
      appearance,
      title,
      itemTitle,
      catalog.id,
    );
    expect(digest(JSON.stringify(await source.readScript(catalog.id)))).toBe(
      before,
    );
    await info.attach("verified-asset-responses", {
      body: JSON.stringify(
        { old: left.loaded, candidate: right.loaded },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(Object.keys(right.phases)).toEqual(Object.keys(left.phases));
    for (const [name, original] of Object.entries(left.phases)) {
      const next = right.phases[name]!;
      await info.attach(`${name}-old`, {
        body: original.paint,
        contentType: "image/png",
      });
      await info.attach(`${name}-candidate`, {
        body: next.paint,
        contentType: "image/png",
      });
      await info.attach(`${name}-states`, {
        body: JSON.stringify(
          { old: original.state, candidate: next.state },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(
        next.state,
        `${name}: unchanged geometry/styles/icons/selection/text`,
      ).toEqual(original.state);
      const { comparatorResult, ...summary } = await compareExchangePaint(
        original.paint,
        next.paint,
      );
      await info.attach(`${name}-paint-diagnostic`, {
        body: JSON.stringify(
          {
            ...summary,
            classifiedDifference: comparatorResult?.errorMessage ?? null,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      if (comparatorResult?.diff)
        await info.attach(`${name}-diff`, {
          body: comparatorResult.diff,
          contentType: "image/png",
        });
      expect(
        comparatorResult,
        `${name}: finite non-AA/one-LSB paint oracle`,
      ).toBeNull();
    }
  });
