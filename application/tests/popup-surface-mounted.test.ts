import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page, type BrowserContext } from "@playwright/test";
import { createServer, transformWithOxc } from "vite";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isImportDeclaration,
  isExportDeclaration,
  isNamedImports,
  isNamedExports,
  isStringLiteral,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { PopupSnapshot } from "./fixtures/popup-surface-9708abbd-mounted.js";

// Real React/ComposerOptions/Dock/SelectionActions/Provider, full source CSS.
// No App, business HTTP/ACL, native guest/compositor, or pixel-screen proof.
const fixture = resolve("tests/fixtures/popup-surface-9708abbd-mounted.tsx");
const root = resolve("apps/web/src");
type Frozen = {
  git: string;
  cssOrder: string[];
  css: Record<string, { bytes: number; sha256: string }>;
  components: Record<string, { bytes: number; sha256: string }>;
  compressedCSS: string[];
};
const metadata = readFileSync(fixture, "utf8").match(
  /\/\* FIXED_POPUP_JSON_BEGIN \*\/\s*export const fixedPopupBaseline = String\.raw`([\s\S]*?)`;\s*\/\* FIXED_POPUP_JSON_END \*\//,
);
assert.ok(metadata, "embedded fixed original CSS provenance must exist");
const fixed = JSON.parse(metadata[1]!) as Frozen;
const oldCSS = JSON.parse(
  gunzipSync(Buffer.from(fixed.compressedCSS.join(""), "base64")).toString(),
) as Record<string, string>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Follow today's runtime module closure, not a historical fixed CSS file list.
// This finite fixture resolver handles the application's relative TS/JS imports;
// third-party dependencies keep their normal Vite behavior.
function runtimeCSSClosure(entry: string) {
  const visited = new Set<string>(),
    styles = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.endsWith(".css")) {
      styles.add(file);
      return;
    }
    const config = "/popup/tsconfig.json",
      name = "/popup/source" + (file.endsWith(".tsx") ? ".tsx" : ".ts");
    const api = new API({
      cwd: "/popup",
      fs: createVirtualFileSystem({
        [name]: readFileSync(file, "utf8"),
        [config]: JSON.stringify({
          compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
          files: [name],
        }),
      }),
    });
    const dependencies: string[] = [];
    let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
    try {
      snapshot = api.updateSnapshot({ openProjects: [config] });
      const program = snapshot.getProject(config)!.program;
      assert.deepEqual(
        program.getSyntacticDiagnostics(),
        [],
        "current runtime source parses: " + file,
      );
      const parsed = program.getSourceFile(name)!;
      for (const statement of parsed.statements) {
        if (!isImportDeclaration(statement) && !isExportDeclaration(statement))
          continue;
        if (
          isImportDeclaration(statement) &&
          (statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword ||
            (statement.importClause?.namedBindings &&
              isNamedImports(statement.importClause.namedBindings) &&
              !statement.importClause.name &&
              statement.importClause.namedBindings.elements.length > 0 &&
              statement.importClause.namedBindings.elements.every(
                (item) => item.isTypeOnly,
              )))
        )
          continue;
        if (
          isExportDeclaration(statement) &&
          (statement.isTypeOnly ||
            (statement.exportClause &&
              isNamedExports(statement.exportClause) &&
              statement.exportClause.elements.length > 0 &&
              statement.exportClause.elements.every((item) => item.isTypeOnly)))
        )
          continue;
        const specifier = statement.moduleSpecifier;
        if (
          !specifier ||
          !isStringLiteral(specifier) ||
          !specifier.text.startsWith(".")
        )
          continue;
        const base = resolve(dirname(file), specifier.text);
        const candidates = base.endsWith(".js")
          ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
          : [base, base + ".ts", base + ".tsx", join(base, "index.ts")];
        const target = candidates.find(existsSync);
        assert.ok(
          target,
          "actual relative runtime import exists: " + specifier.text,
        );
        dependencies.push(target);
      }
    } finally {
      snapshot?.dispose();
      api.close();
    }
    for (const dependency of dependencies) visit(dependency);
  }
  visit(entry);
  return styles;
}
const actualCSSFiles = runtimeCSSClosure(resolve(root, "main.tsx"));
const actualCSS = [...actualCSSFiles]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const baselineCSS = fixed.cssOrder.map((file) => oldCSS[file]).join("\n");
const equivalence = process.env.MORPHZ_TEST_POPUP_MIGRATION_EQUIVALENCE === "1";

test("popup mounted oracle preserves complete independently frozen actual Git 9708 CSS", () => {
  assert.equal(fixed.git, "9708abbde92a1efe813863bca281e29884d14bf1");
  assert.equal(fixed.cssOrder.length, 26);
  assert.deepEqual(new Set(Object.keys(oldCSS)), new Set(fixed.cssOrder));
  for (const [file, proof] of Object.entries(fixed.css)) {
    assert.equal(Buffer.byteLength(oldCSS[file]!), proof.bytes, file);
    assert.equal(sha(oldCSS[file]!), proof.sha256, file);
  }
  assert.ok(
    baselineCSS.includes(".app .composer-options.application-dock-menu"),
  );
  assert.ok(
    actualCSSFiles.has(resolve(root, "ui/popup-surface.css")),
    "actual runtime CSS closure consumes popup owner",
  );
});

const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
const available = existsSync(executable || chromium.executablePath());
type Run = { motion: unknown[]; snapshot: PopupSnapshot };
test(
  "actual popup material/lifecycle contracts, with opt-in full frozen migration equivalence",
  {
    skip: available
      ? false
      : "set MORPHZ_TEST_BROWSER_EXECUTABLE or install existing Playwright Chromium capability",
  },
  async (context) => {
    const cache = mkdtempSync(join(tmpdir(), "morphz-popup-mounted-cache-"));
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    const entry = (lane: string) =>
      `import '/__popup-${lane}.css';import {mountPopupSurfaceFixture} from '/@fs/${fixture}';mountPopupSurfaceFixture(new URL(location.href).searchParams.has('compatibility'));`;
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        {
          name: "complete-popup-css-lanes",
          enforce: "pre",
          resolveId(id) {
            if (/^\/__popup-(old|actual)\.(css|tsx)$/.test(id))
              return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__popup-old.css") return baselineCSS;
            if (id === "\0/__popup-actual.css") return actualCSS;
            if (id === "\0/__popup-old.tsx")
              return transformWithOxc(entry("old"), "popup-old.tsx");
            if (id === "\0/__popup-actual.tsx")
              return transformWithOxc(entry("actual"), "popup-actual.tsx");
            // These real components import their own CSS. The complete lane above
            // already contains it once, in the actual application's full order.
            if (actualCSSFiles.has(id.split("?")[0]!)) return "";
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__popup") return next();
              const lane = request.url.includes("lane=old") ? "old" : "actual";
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html data-appearance="light"><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__popup-${lane}.tsx"></script></body></html>`,
                ),
              );
            });
          },
        },
        react(),
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    context.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__popup`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const errors: string[] = [],
      businessReads: string[] = [];
    const coverage: unknown[] = [];
    let phase = "initial";
    context.after(() =>
      context.diagnostic(
        JSON.stringify({
          phase,
          equivalence,
          actualCSSClosure: [...actualCSSFiles].map((file) =>
            file.slice(root.length + 1),
          ),
          errors,
          businessReads,
          coverage,
        }),
      ),
    );

    async function pair(
      options: { touch?: boolean; compatibility?: boolean } = {},
    ) {
      const pages: Page[] = [];
      const contexts: BrowserContext[] = [];
      for (const lane of equivalence ? ["old", "actual"] : ["actual"]) {
        const isolated = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          hasTouch: options.touch,
        });
        contexts.push(isolated);
        await isolated.addInitScript(
          `Object.defineProperty(crypto,'randomUUID',{value:()=> '11111111-1111-4111-8111-111111111111'});window.focusCalls=[];const original=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(options){window.focusCalls.push({id:this.id,label:this.getAttribute('aria-label'),options:options??null});original.call(this,options);};`,
        );
        const page = await isolated.newPage();
        page.setDefaultTimeout(10000);
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (
            ["fetch", "xhr"].includes(request.resourceType()) &&
            !request.url().includes("/@vite/")
          )
            businessReads.push(request.url());
        });
        await page.goto(
          url +
            "?lane=" +
            lane +
            (options.compatibility ? "&compatibility" : ""),
        );
        await page
          .waitForFunction(() => !!Reflect.get(window, "popupFixture"))
          .catch((error) => {
            context.diagnostic(JSON.stringify({ phase, lane, errors }));
            throw error;
          });
        await page.evaluate(() => Reflect.get(window, "popupFixture").settle());
        pages.push(page);
      }
      context.after(() => Promise.all(contexts.map((item) => item.close())));
      async function read() {
        const snapshots = await Promise.all(
          pages.map(
            (page) =>
              page.evaluate(() =>
                Reflect.get(window, "popupFixture").snapshot(),
              ) as Promise<PopupSnapshot>,
          ),
        );
        if (equivalence)
          assert.deepEqual(
            snapshots[1],
            snapshots[0],
            "complete old/new DOM, material, exact 0.01px geometry and focus parity: " +
              phase,
          );
        return snapshots[0]!;
      }
      async function run(action: string, value?: unknown) {
        const results = await Promise.all(
          pages.map(
            (page) =>
              page.evaluate(
                ({ action, value }) =>
                  Reflect.get(window, "popupFixture").run(action, value),
                { action, value },
              ) as Promise<Run>,
          ),
        );
        if (equivalence)
          assert.deepEqual(
            results[1],
            results[0],
            "old/new real action, unsuppressed motion and snapshot parity: " +
              phase,
          );
        return results[0]!;
      }
      async function click(selector: string) {
        for (const page of pages) {
          await page.locator(selector).click();
          await page.evaluate(() =>
            Reflect.get(window, "popupFixture").settle(),
          );
        }
        return read();
      }
      async function key(value: string) {
        for (const page of pages) {
          await page.keyboard.press(value);
          await page.evaluate(() =>
            Reflect.get(window, "popupFixture").settle(),
          );
        }
        return read();
      }
      async function hover(selector: string) {
        for (const page of pages) {
          await page.locator(selector).hover();
          await page.evaluate(() =>
            Reflect.get(window, "popupFixture").settle(),
          );
        }
        return read();
      }
      return {
        pages,
        read,
        run,
        click,
        key,
        hover,
        async close() {
          await Promise.all(contexts.map((item) => item.close()));
        },
      };
    }
    const panel = (snapshot: PopupSnapshot, name: string) => {
      const found = snapshot.panels.find((item) =>
        item.html.includes(`aria-label="${name}"`),
      );
      assert.ok(found, "actual panel exists: " + name);
      return found;
    };

    await context.test(
      "native popover keeps stable nodes, closed inert/hit policy, keyboard focus and close-before-action order",
      async () => {
        phase = "popover-lifecycle";
        const p = await pair();
        const before = panel(await p.read(), "原更多选项");
        assert.equal(before.open, false);
        assert.equal(before.inert, true);
        assert.equal(before.material.pointerEvents, "none");
        const opened = await p.run("open", "原更多菜单");
        const open = panel(opened.snapshot, "原更多选项");
        assert.equal(open.id, before.id);
        assert.equal(open.open, true);
        assert.equal(open.inert, false);
        assert.equal(opened.snapshot.active.label, "第一个动作");
        assert.ok(
          opened.motion.some((value) =>
            JSON.stringify(value).includes("menu-content-reveal"),
          ),
          "normal original entry motion is observed before settling",
        );
        for (const page of p.pages) {
          const hit = await page
            .locator('[aria-label="原更多选项"]')
            .evaluate((node) => {
              const r = node.getBoundingClientRect();
              return node.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
              );
            });
          assert.equal(
            hit,
            true,
            "open real top-layer panel participates in hit testing",
          );
        }
        assert.equal((await p.key("End")).active.label, "最后一个动作");
        assert.equal(
          (await p.key("ArrowDown")).active.label,
          "第一个动作",
          "disabled action is skipped",
        );
        const closed = await p.key("Escape");
        assert.equal(closed.active.label, "原更多菜单");
        assert.equal(panel(closed, "原更多选项").id, before.id);
        assert.equal(panel(closed, "原更多选项").inert, true);
        for (const page of p.pages) {
          assert.equal(
            await page
              .locator('[aria-label="原更多选项"]')
              .evaluate((node) => node.getClientRects().length),
            0,
            "closed original native popover has no hit geometry",
          );
        }
        assert.equal(
          closed.events.some((item) => item[0] === "disabled-action"),
          false,
        );
        await p.run("open", "原更多菜单");
        const action = await p.click('[aria-label="最后一个动作"]');
        const receipt = action.events.find((item) => item[0] === "last-action");
        assert.ok(receipt);
        assert.equal(
          receipt[2],
          "原更多菜单",
          "original closeToTrigger focuses before calling action",
        );
        assert.equal(panel(action, "原更多选项").open, false);
        // setOpen is batched: do not invent a synchronous DOM-close-before-callback contract.
        await p.run("open", "原更多菜单");
        const outside = await p.click("#outside");
        assert.equal(outside.active.id, "outside");
        assert.equal(panel(outside, "原更多选项").open, false);
        for (let i = 0; i < 4; i++) {
          const rapid = await p.run("open", "原更多菜单");
          assert.equal(panel(rapid.snapshot, "原更多选项").id, before.id);
        }
        assert.equal(panel(await p.read(), "原更多选项").open, false);
        await p.close();
      },
    );

    await context.test(
      "actual Appearance/Profile/Scope consumers preserve controls, focus and persistent child state",
      async () => {
        phase = "actual-menu-consumers";
        const p = await pair();
        await p.run("open", "外观设置");
        const mode = await p.click(
          '[aria-label="外观设置面板"] button:has-text("暗色")',
        );
        assert.equal(mode.prefs?.appearance, "dark");
        assert.equal(
          panel(mode, "外观设置面板").open,
          true,
          "mode retains original menu lifetime",
        );
        const accent = await p.click(
          '[aria-label="外观设置面板"] button:has-text("鸢尾紫")',
        );
        assert.equal(accent.prefs?.accent, "iris");
        assert.equal(panel(accent, "外观设置面板").open, false);
        assert.equal(accent.active.label, "外观设置");
        await p.run("open", "用户菜单");
        for (const page of p.pages) {
          const widths = await page.evaluate(() => {
            const trigger = document.querySelector(
              '[aria-label="用户菜单"][aria-expanded]',
            )!;
            const menu = document.querySelector(
              '[aria-label="用户菜单"][popover]',
            )!;
            return [
              trigger.getBoundingClientRect().width,
              menu.getBoundingClientRect().width,
            ];
          });
          assert.equal(
            widths[0],
            widths[1],
            "expanded profile keeps real trigger-width match",
          );
        }
        const settings = await p.click(
          '[aria-label="用户菜单"][popover] button[aria-label="设置"]',
        );
        assert.equal(panel(settings, "用户菜单").open, false);
        assert.ok(
          settings.events.some(
            (item) => item[0] === "profile-settings" && item[2] === "用户菜单",
          ),
        );
        await p.run("open", "输入关联");
        for (const page of p.pages)
          await page.locator("#scope-persistent").fill("真实保持的关联草稿");
        const persistent = await p.read();
        const oldId = panel(persistent, "本次输入关联").id;
        await p.key("Escape");
        assert.equal((await p.read()).persistent, "真实保持的关联草稿");
        await p.run("open", "输入关联");
        const restored = await p.read();
        assert.equal(restored.persistent, "真实保持的关联草稿");
        assert.equal(panel(restored, "本次输入关联").id, oldId);
        await p.close();
      },
    );

    await context.test(
      "real authorized Launcher preserves 20px material variant, pin lifetime and launch/manage focus ordering",
      async () => {
        phase = "actual-launcher";
        const p = await pair();
        const opened = await p.run("open", "全部应用");
        const menu = panel(opened.snapshot, "选择应用");
        assert.equal(menu.material.radius, "20px");
        assert.equal(menu.open, true);
        assert.equal(opened.snapshot.active.label, "选择应用");
        await p.hover('[aria-label="打开阅读"]');
        const pin = await p.click('[aria-label="固定到 Dock：阅读"]');
        assert.equal(
          panel(pin, "选择应用").open,
          true,
          "pin does not launch or dismiss",
        );
        assert.ok(pin.pinned.includes("morphz.reader@1.0.0"));
        const launch = await p.click(
          '.application-dock-menu button.application-dock-launch:has-text("阅读")',
        );
        assert.equal(panel(launch, "选择应用").open, false);
        assert.ok(
          launch.events.some(
            (item) => item[0] === "launch" && item[2] === "全部应用",
          ),
        );
        await p.run("open", "全部应用");
        const manage = await p.click(".application-dock-manage");
        assert.ok(
          manage.events.some(
            (item) => item[0] === "manage" && item[2] === "全部应用",
          ),
        );
        assert.equal(manage.draft, "保持原输入草稿");
        await p.close();
      },
    );

    await context.test(
      "actual SelectionActions body portal and Provider retain text/source/version and original action lifecycle",
      async () => {
        phase = "actual-selection-portal";
        const p = await pair();
        const selected = await p.run("select");
        const toolbar = panel(selected.snapshot, "选中文本操作");
        assert.equal(
          toolbar.parent,
          "",
          "real createPortal target is body, not app",
        );
        assert.equal(toolbar.material.radius, "8px");
        assert.equal(
          selected.snapshot.selection,
          "完整选文，关联原件和历史版本，不改变来源。",
        );
        const annotated = await p.click(
          '.selection-actions button[aria-label="批注"]',
        );
        assert.ok(
          annotated.events.some(
            (item) =>
              item[0] === "selection-annotate" &&
              item[1] === selected.snapshot.selection,
          ),
        );
        assert.equal(
          annotated.panels.some((item) =>
            item.html.includes('aria-label="选中文本操作"'),
          ),
          false,
        );
        await p.run("select");
        const comment = await p.click(
          '.selection-actions button[aria-label="评论选中文字"]',
        );
        assert.equal(comment.quotes.length, 1);
        assert.deepEqual(comment.quotes[0]?.source, {
          kind: "artifact",
          projectId: "project-popup",
          artifactId: "artifact-popup",
          revision: 3,
          title: "材料原件 · v3",
        });
        assert.equal(comment.quotes[0]?.text, selected.snapshot.selection);
        assert.equal(
          comment.quotes[0]?.id,
          "11111111-1111-4111-8111-111111111111",
        );
        assert.equal(comment.draft, "保持原输入草稿");
        assert.equal(comment.selection, "");
        // The one-quote fixture controls UUID only; it does not prove UUID generation/uniqueness.
        await p.close();
      },
    );

    await context.test(
      "four actual accents × light/dark × wide/narrow × CSS 200% preserve full popup/Dock/portal material and exact geometry",
      async () => {
        phase = "theme-geometry-motion";
        const p = await pair();
        const widths: number[] = [],
          heights: number[] = [];
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"])
            for (const width of [1440, 390])
              for (const zoom of [1, 2]) {
                phase = ["matrix", accent, appearance, width, zoom].join(":");
                for (const page of p.pages)
                  await page.setViewportSize({
                    width,
                    height: width === 390 ? 844 : 900,
                  });
                await p.run("theme", { accent, appearance, zoom });
                const generic = await p.run("open", "原更多菜单");
                const genericPanel = panel(generic.snapshot, "原更多选项");
                assert.equal(genericPanel.material.radius, "10px");
                assert.ok(Number(genericPanel.box?.width) > 0);
                assert.ok(Number(generic.snapshot.geometry.main?.width) > 0);
                widths.push(Number(generic.snapshot.geometry.main?.width));
                heights.push(Number(generic.snapshot.geometry.main?.height));
                await p.run("open", "原更多菜单");
                const dock = await p.run("open", "全部应用");
                assert.equal(
                  panel(dock.snapshot, "选择应用").material.radius,
                  "20px",
                );
                await p.run("open", "全部应用");
                const selected = await p.run("select");
                const portal = panel(selected.snapshot, "选中文本操作");
                assert.equal(portal.material.radius, "8px");
                coverage.push({
                  accent,
                  appearance,
                  width,
                  zoom,
                  main: generic.snapshot.geometry.main,
                  popup: genericPanel.box,
                  dock: panel(dock.snapshot, "选择应用").box,
                  portal: portal.box,
                  motion: generic.motion,
                });
                await p.run("clearSelection");
              }
        assert.ok(
          new Set(widths).size >= 3 && new Set(heights).size >= 4,
          "viewport/zoom actually alter real center geometry, not just requested matrix labels",
        );
        assert.equal(coverage.length, 32);
        await p.close();
      },
    );

    await context.test(
      "actual auxiliary media/native datasets and guest fallback retain opaque materials and legitimate motion policy",
      async () => {
        phase = "auxiliary-material-policy";
        const p = await pair();
        const mediaSessions = await Promise.all(
          p.pages.map((page) => page.context().newCDPSession(page)),
        );
        for (const preference of ["transparency", "contrast", "motion"]) {
          for (const cdp of mediaSessions) {
            await cdp.send("Emulation.setEmulatedMedia", {
              features: [
                {
                  name:
                    preference === "transparency"
                      ? "prefers-reduced-transparency"
                      : preference === "contrast"
                        ? "prefers-contrast"
                        : "prefers-reduced-motion",
                  value: preference === "contrast" ? "more" : "reduce",
                },
              ],
            });
          }
          const opened = await p.run("open", "原更多菜单");
          assert.equal(
            opened.snapshot.media[preference as keyof PopupSnapshot["media"]],
            true,
            "requested CSS preference actually matches",
          );
          if (preference !== "motion")
            assert.equal(
              panel(opened.snapshot, "原更多选项").material.blur,
              "none",
            );
          else
            assert.equal(
              opened.motion.some((value) =>
                JSON.stringify(value).includes('"name":"menu-content-reveal"'),
              ),
              false,
            );
          await p.run("open", "原更多菜单");
          const selected = await p.run("select");
          if (preference !== "motion")
            assert.equal(
              panel(selected.snapshot, "选中文本操作").material.blur,
              "none",
            );
          await p.run("clearSelection");
          for (const cdp of mediaSessions) {
            await cdp.send("Emulation.setEmulatedMedia", { features: [] });
          }
        }
        for (const values of [
          { reducedTransparency: "true" },
          { nativeContrast: "more" },
        ]) {
          await p.run("dataset", values);
          const open = await p.run("open", "原更多菜单");
          assert.equal(
            panel(open.snapshot, "原更多选项").material.blur,
            "none",
          );
          await p.run("open", "原更多菜单");
          const selected = await p.run("select");
          assert.equal(
            panel(selected.snapshot, "选中文本操作").material.blur,
            "none",
          );
          await p.run("clearSelection");
          await p.run("dataset", {
            reducedTransparency: null,
            nativeContrast: null,
          });
        }
        await p.run("dataset", { appMotion: "reduce" });
        const motionDataset = await p.run("open", "原更多菜单");
        assert.equal(
          motionDataset.motion.some((value) =>
            JSON.stringify(value).includes('"name":"menu-content-reveal"'),
          ),
          false,
          "real native preference fallback disables app motion without fixture overrides",
        );
        await p.run("open", "原更多菜单");
        await p.run("dataset", { appMotion: null });
        await p.run("theme", { guest: true });
        const guest = await p.run("open", "原更多菜单");
        assert.equal(panel(guest.snapshot, "原更多选项").material.blur, "none");
        await p.run("open", "原更多菜单");
        const selected = await p.run("select");
        assert.equal(
          panel(selected.snapshot, "选中文本操作").material.blur,
          "none",
          ":root:has guest selector reaches actual body portal",
        );
        await Promise.all(mediaSessions.map((cdp) => cdp.detach()));
        await p.close();
      },
    );

    await context.test(
      "touch capability is effective and real Launcher/menus keep original target geometry and hit behavior",
      async () => {
        phase = "touch";
        const p = await pair({ touch: true });
        for (const page of p.pages) {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate(() =>
            Reflect.get(window, "popupFixture").settle(),
          );
        }
        const state = await p.read();
        assert.equal(state.media.touch, true);
        assert.equal(state.media.hoverNone, true);
        const dock = await p.run("open", "全部应用");
        const launcher = panel(dock.snapshot, "选择应用");
        assert.equal(launcher.open, true);
        assert.equal(launcher.material.radius, "20px");
        for (const page of p.pages) {
          const target = page
            .locator(".application-dock-menu .application-dock-launch")
            .first();
          const rect = await target.boundingBox();
          assert.ok(
            rect && rect.width >= 44 && rect.height >= 44,
            "actual coarse-pointer app launch target",
          );
          await target.tap();
          await page.evaluate(() =>
            Reflect.get(window, "popupFixture").settle(),
          );
        }
        const launched = await p.read();
        assert.equal(panel(launched, "选择应用").open, false);
        assert.ok(launched.events.some((item) => item[0] === "launch"));
        await p.close();
      },
    );

    await context.test(
      "non-app and compound fallback remain distinct, and real cleanup removes portal/popover subscriptions",
      async () => {
        phase = "compatibility-and-cleanup";
        const p = await pair({ compatibility: true });
        const state = await p.read();
        const probes = state.panels.filter((item) => item.parent === "");
        assert.ok(probes.length >= 5);
        const radius = state.panels.filter((item) =>
          item.html.startsWith('<div class="theme-menu"'),
        )[0]?.material.radius;
        assert.equal(
          radius,
          "12px",
          "non-app theme fallback is not unified to app 10px",
        );
        const compound = state.panels.find((item) =>
          item.html.startsWith(
            '<div class="composer-options theme-menu workspace-options-menu"',
          ),
        );
        assert.equal(
          compound?.material.radius,
          "10px",
          "original later composer fallback wins compound case",
        );
        const dock = state.panels.find((item) =>
          item.html.startsWith(
            '<div class="composer-options application-dock-menu"',
          ),
        );
        assert.equal(
          dock?.material.radius,
          "10px",
          "20px Launcher variant requires .app ancestor",
        );
        await p.run("open", "非 app 原更多菜单");
        assert.equal(panel(await p.read(), "非 app 原更多选项").open, true);
        await p.key("Escape");
        await p.run("unmount");
        for (const page of p.pages)
          assert.equal(
            await page.locator("[popover],.selection-actions").count(),
            0,
          );
        await p.close();
        const normal = await pair();
        await normal.run("select");
        await normal.run("unmount");
        for (const page of normal.pages) {
          assert.equal(
            await page.locator("[popover],.selection-actions").count(),
            0,
          );
          await page.evaluate(() => {
            document.dispatchEvent(new Event("selectionchange"));
            window.dispatchEvent(new Event("resize"));
          });
        }
        await normal.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(businessReads, []);
      },
    );
  },
);
