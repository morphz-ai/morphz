import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { build, createServer, transformWithOxc } from "vite";
import { controlRoleBrowserFixture } from "./fixtures/control-role-57e7d4ce.js";
import { compareExchangePaint } from "./exchange-paint-comparison.js";

// Current contracts mount complete real components. Historical equality is an
// explicit one-time lane, not a permanent lock of adjacent component sources.
const migration =
  process.env.MORPHZ_TEST_CONTROL_ROLE_MIGRATION_EQUIVALENCE === "1";
type Part = {
  identity: number;
  tag: string;
  label: string;
  classes: string;
  type: string | null;
  disabled: boolean;
  value: string | null;
  pressed: string | null;
  rect: number[];
  style: Record<string, string>;
  svg: number[][];
};
type Snapshot = {
  facts: {
    mode: string;
    appearance: string;
    accent: string;
    zoom: number;
    outside: boolean;
  };
  media: { coarse: boolean; reduced: boolean; contrast: boolean };
  parts: Part[];
  dialog: boolean;
  portal: string | null;
  events: unknown[];
  requests: string[];
};
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function archivedCSS(path: string | undefined, lane: "baseline" | "candidate") {
  assert.ok(
    path,
    "explicit migration requires its independently frozen compiled lane",
  );
  const text = readFileSync(path, "utf8");
  const build = JSON.parse(
    text.split("R1_BUILD_JSON_BEGIN\n")[1]!.split("\nR1_BUILD_JSON_END")[0]!,
  ) as {
    baseline: string;
    lane: string;
    write: boolean;
    rendererSourceArchiveCount: number;
    files: Array<{ file: string; sha256: string; gzipBase64?: string }>;
  };
  assert.equal(build.baseline, "57e7d4ce97416bf39fc2a1eb2f00951bca6def8d");
  assert.equal(build.lane, lane);
  assert.equal(build.write, false);
  assert.equal(build.rendererSourceArchiveCount, 208);
  const css = build.files.filter((file) => file.file.endsWith(".css"));
  assert.equal(css.length, 1);
  const bytes = gunzipSync(Buffer.from(css[0]!.gzipBase64!, "base64"));
  assert.equal(digest(bytes), css[0]!.sha256);
  if (lane === "baseline")
    assert.equal(
      digest(bytes),
      "a3dbc05579ac7381225737c70bc3a246b366682dd18c2fffddb7f609d8357b28",
    );
  return bytes.toString();
}
async function settle(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
const snapshot = (page: Page) =>
  page.evaluate(() =>
    (window as any).controlRoles.snapshot(),
  ) as Promise<Snapshot>;
const configure = async (page: Page, facts: Partial<Snapshot["facts"]>) => {
  await page.evaluate(
    (value) => (window as any).controlRoles.configure(value),
    facts,
  );
  await settle(page);
};
const part = (value: Snapshot, label: string) => {
  const item = value.parts.find((item) => item.label === label);
  assert.ok(item, "real complete consumer: " + label);
  return item;
};

test(
  "real control consumers preserve role, Browser feature, native portal and interaction paint contracts",
  { timeout: 180_000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "required browser capability: use the default npm test preparation",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-control-role-cache-"));
    const resources: {
      browser?: Awaited<ReturnType<typeof chromium.launch>>;
      server?: Awaited<ReturnType<typeof createServer>>;
    } = {};
    context.after(async () => {
      try {
        await resources.browser?.close();
      } finally {
        try {
          await resources.server?.close();
        } finally {
          rmSync(cache, { recursive: true, force: true });
        }
      }
    });
    let currentCSS: string;
    if (migration)
      currentCSS = archivedCSS(
        process.env.MORPHZ_TEST_CONTROL_ROLE_CANDIDATE_BUILD,
        "candidate",
      );
    else {
      const result = await build({
        configFile: false,
        root: resolve("apps/web"),
        cacheDir: cache,
        plugins: [react()],
        logLevel: "error",
        build: {
          write: false,
          assetsInlineLimit: 0,
          rolldownOptions: { input: resolve("apps/web/index.html") },
        },
      });
      assert.ok(!Array.isArray(result) && "output" in result);
      const css = result.output.filter(
        (file) => file.type === "asset" && file.fileName.endsWith(".css"),
      );
      assert.equal(css.length, 1);
      const output = css[0]!;
      assert.equal(output.type, "asset");
      assert.ok("source" in output);
      currentCSS = Buffer.from(output.source).toString();
    }
    const oldCSS = migration
      ? archivedCSS(
          process.env.MORPHZ_TEST_CONTROL_ROLE_BASELINE_BUILD,
          "baseline",
        )
      : undefined;
    const fixture = controlRoleBrowserFixture
      .replaceAll("__SOURCE__", "/@fs/" + resolve("apps/web/src"))
      .replaceAll("__CORE__", "/@fs/" + resolve("packages/core/src"));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      logLevel: "error",
      plugins: [
        {
          name: "actual-control-role-components",
          enforce: "pre",
          resolveId(id) {
            if (
              /^\/__control-(fixture\.tsx|(old|current)\.(css|tsx))$/.test(id)
            )
              return "\0" + id;
          },
          load(id) {
            if (id === "\0/__control-current.css") return currentCSS;
            if (id === "\0/__control-old.css") return oldCSS;
            if (id === "\0/__control-fixture.tsx")
              return transformWithOxc(fixture, "control-role-fixture.tsx");
            if (/^\0\/__control-(old|current)\.tsx$/.test(id))
              return `import '/__control-${id.includes("-old.") ? "old" : "current"}.css';import '/__control-fixture.tsx';`;
            if (id.split("?")[0]!.endsWith(".css")) return ""; // Once, already compiled in real main order.
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__controls") return next();
              const lane = request.url.includes("lane=old") ? "old" : "current";
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__control-${lane}.tsx"></script></body></html>`,
                ),
              );
            });
          },
        },
        react(),
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    resources.server = server;
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    resources.browser = browser;
    const errors: string[] = [],
      business: string[] = [],
      coverage: string[] = [],
      paint: unknown[] = [];
    const lanes = migration ? ["old", "current"] : ["current"];
    const configurations = [
      ...["cyan", "iris", "coral", "mono"].flatMap((accent) =>
        ["light", "dark"].map((appearance) => ({
          accent,
          appearance,
          width: 1200,
          height: 900,
          zoom: 1,
          coarse: false,
          reduced: false,
          contrast: false,
          outside: false,
        })),
      ),
      {
        accent: "cyan",
        appearance: "light",
        width: 760,
        height: 720,
        zoom: 1,
        coarse: true,
        reduced: true,
        contrast: true,
        outside: false,
      },
      {
        accent: "coral",
        appearance: "dark",
        width: 1440,
        height: 960,
        zoom: 2,
        coarse: true,
        reduced: true,
        contrast: true,
        outside: false,
      },
      ...["light", "dark"].map((appearance) => ({
        accent: "cyan",
        appearance,
        width: 1200,
        height: 900,
        zoom: 1,
        coarse: false,
        reduced: false,
        contrast: false,
        outside: true,
      })),
    ];
    for (const configuration of configurations) {
      const records: Array<{ snapshots: Snapshot[]; images: Buffer[] }> = [];
      for (const lane of lanes) {
        const browserContext = await browser.newContext({
          viewport: {
            width: configuration.width,
            height: configuration.height,
          },
          isMobile: configuration.coarse,
          hasTouch: configuration.coarse,
          colorScheme: configuration.appearance as "light" | "dark",
          reducedMotion: configuration.reduced ? "reduce" : "no-preference",
          contrast: configuration.contrast ? "more" : "no-preference",
        });
        try {
          const page = await browserContext.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/api/**", (route) => {
            business.push(route.request().url());
            return route.abort();
          });
          await page.goto(
            `http://127.0.0.1:${address.port}/__controls?lane=${lane}`,
          );
          await page.waitForFunction(() =>
            (window as any).controlRoles?.ready(),
          );
          const snapshots: Snapshot[] = [],
            images: Buffer[] = [];
          const record = async (phase: string) => {
            await settle(page);
            const value = await snapshot(page);
            snapshots.push(value);
            assert.equal(value.media.coarse, configuration.coarse);
            assert.equal(value.media.reduced, configuration.reduced);
            assert.equal(value.media.contrast, configuration.contrast);
            if (!configuration.outside)
              assert.equal(value.facts.accent, configuration.accent);
            images.push(await page.screenshot());
            coverage.push(
              [
                lane,
                configuration.appearance,
                configuration.accent,
                configuration.zoom,
                configuration.outside,
                phase,
              ].join(":"),
            );
            return value;
          };
          await configure(page, configuration);
          const addressPart = part(await record("browser"), "网站地址");
          assert.equal(
            addressPart.style["font-size"],
            "12px",
            "feature Browser recipe follows coarse common16",
          );
          assert.equal(addressPart.style["min-width"], "60px");
          assert.equal(addressPart.style["border-top-width"], "0px");
          assert.equal(
            addressPart.style["background-color"],
            "rgba(0, 0, 0, 0)",
          );
          assert.equal(
            addressPart.type,
            null,
            "original native input type omission",
          );
          if (!configuration.outside) {
            const icon = part(await snapshot(page), "原交流图标");
            assert.equal(icon.type, null, "IconButton does not inject type");
            assert.equal(
              icon.rect[2],
              configuration.coarse
                ? 44 * configuration.zoom
                : 32 * configuration.zoom,
            );
            await page.evaluate(() => {
              (window as any).roleNodes = (
                window as any
              ).controlRoles.identity();
            });
            await page
              .getByRole("button", { name: "原交流图标", exact: true })
              .focus();
            const focused = part(await record("icon-focus"), "原交流图标");
            assert.equal(focused.style["outline-style"], "solid");
            assert.equal(
              await page.evaluate(() =>
                (window as any).controlRoles.same((window as any).roleNodes),
              ),
              true,
              "same actual native controls, not remount",
            );
          }
          await page
            .getByRole("button", { name: "编辑当前收藏", exact: true })
            .click();
          await page
            .getByRole("textbox", { name: "收藏名称", exact: true })
            .waitFor();
          await page.waitForFunction(() =>
            (window as any).controlRoles
              .snapshot()
              .requests.includes("bookmarkList"),
          );
          const portal = await record("bookmark-portal");
          assert.equal(portal.dialog, true);
          assert.equal(
            portal.portal,
            configuration.outside ? "" : "workspace",
            "original workspace-or-body portal target",
          );
          assert.notEqual(
            part(portal, "收藏名称").style["font-size"],
            "12px",
            "portaled form is not a Browser toolbar descendant",
          );
          await page
            .getByRole("button", { name: "关闭收藏", exact: true })
            .click();
          await configure(page, { mode: "project" });
          await page
            .getByRole("textbox", { name: "项目名称", exact: true })
            .waitFor();
          assert.equal(
            part(await record("native-primary-disabled"), "创建").disabled,
            true,
          );
          await page
            .getByRole("textbox", { name: "项目名称", exact: true })
            .fill("原项目名称");
          await page.getByRole("button", { name: "创建", exact: true }).hover();
          const enabled = part(await record("primary-hover"), "创建");
          assert.equal(enabled.disabled, false);
          assert.equal(enabled.type, null, "original submit default unchanged");
          await page.getByRole("button", { name: "创建", exact: true }).focus();
          await record("primary-focus");
          await page.mouse.down();
          await record("primary-active");
          await page.mouse.up();
          await page
            .getByRole("button", { name: "保存中…", exact: true })
            .waitFor();
          assert.equal(
            part(await record("primary-busy"), "保存中…").disabled,
            true,
          );
          await page.evaluate(() => (window as any).controlRoles.release());
          await configure(page, { mode: "document" });
          await page
            .getByRole("textbox", { name: "新对象标题", exact: true })
            .waitFor();
          const document = await record("document-fields");
          assert.equal(part(document, "新文档正文").tag, "TEXTAREA");
          assert.equal(part(document, "取消").type, "button");
          await configure(page, { mode: "editor" });
          await page
            .getByRole("button", { name: "围绕选中文本输入", exact: true })
            .waitFor();
          await page
            .getByRole("button", { name: "版本历史", exact: true })
            .hover();
          const editor = await record("real-secondary");
          assert.ok(
            part(editor, "版本历史").classes.includes("secondary-action"),
          );
          await page
            .getByRole("button", { name: "版本历史", exact: true })
            .focus();
          await record("secondary-focus");
          await page
            .getByRole("button", { name: "版本历史", exact: true })
            .click();
          assert.equal(
            part(await record("editor-select"), "查看版本").tag,
            "SELECT",
          );
          await configure(page, { mode: "table" });
          await page
            .getByRole("button", { name: "添加记录", exact: true })
            .waitFor();
          const table = await record("real-outline");
          assert.ok(part(table, "添加记录").classes.includes("outline"));
          assert.equal(part(table, "名称 row1").tag, "INPUT");
          await page
            .getByRole("button", { name: "添加记录", exact: true })
            .hover();
          await record("outline-hover");
          await page
            .getByRole("button", { name: "添加记录", exact: true })
            .focus();
          await record("outline-focus");
          records.push({ snapshots, images });
        } finally {
          await browserContext.close();
        }
      }
      if (migration) {
        assert.deepEqual(
          records[1]!.snapshots,
          records[0]!.snapshots,
          "all actual computed paint/geometry/attributes/actions, " +
            JSON.stringify(configuration),
        );
        for (let index = 0; index < records[0]!.images.length; index++) {
          const result = await compareExchangePaint(
            records[0]!.images[index]!,
            records[1]!.images[index]!,
          );
          paint.push({
            configuration,
            index,
            ...result,
            comparatorResult: result.comparatorResult?.errorMessage ?? null,
          });
          assert.equal(
            result.comparatorResult,
            null,
            "finite AA/1LSB screenshot oracle; paired exact tuples/computed geometry",
          );
        }
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(
      business,
      [],
      "no real business requests or Runtime/model capability",
    );
    context.diagnostic(
      JSON.stringify({
        migration,
        configurations: configurations.length,
        phases: coverage.length,
        paint,
        limits:
          "actual controlled React/native HTML modal, not Electron guest/native compositor, business authorization, or original user window",
      }),
    );
  },
);
