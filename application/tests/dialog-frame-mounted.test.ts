import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { build, createServer, transformWithOxc } from "vite";
import {
  dialogFrameBrowserFixture,
  dialogFrameConsumers,
  dialogFramePrivateExports,
} from "./fixtures/dialog-frame-mounted.js";

// Current semantic contracts use complete real components and a fresh in-memory
// build of the actual App entry's CSS. App JS is compiled, never executed.
// Historical CSS is read only in explicitly selected migration mode. No Git,
// normal dist, production environment, business HTTP, Runtime or model requests.
const migration =
  process.env.MORPHZ_TEST_DIALOG_FRAME_MIGRATION_EQUIVALENCE === "1";
const sourceRoot = resolve("apps/web/src");
type Part = {
  identity: number;
  tag: string;
  classes: string;
  label: string;
  type: string | null;
  disabled: boolean;
  value: string | null;
  rect: { x: number; y: number; width: number; height: number };
  style: Record<string, string>;
  hit: boolean;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};
type Snapshot = {
  root: Part | null;
  native: boolean;
  modal: boolean;
  parts: Part[];
  workspace: Part["rect"];
  vars: string[];
  active: string;
  events: Array<[string, unknown]>;
  requests: string[];
  media: { coarse: boolean; reduced: boolean };
  facts: { zoom: number; left: number };
};
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function baselineCSS() {
  assert.ok(migration, "historical reads require explicit migration selection");
  const directory = process.env.MORPHZ_TEST_DIALOG_FRAME_BASELINE_DIR;
  assert.ok(directory, "migration requires explicit frozen baseline directory");
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  ) as {
    originalGit: string;
    lanes: {
      baseline: { root: string; assets: Record<string, string> };
    };
  };
  assert.equal(
    manifest.originalGit,
    "c525d217deafe2bc125b15186cf056edfd2e4037",
    "independently frozen pre-migration Git",
  );
  const lane = manifest.lanes.baseline;
  const css = Object.entries(lane.assets).filter(([file]) =>
    file.endsWith(".css"),
  );
  assert.equal(css.length, 1, "the original real entry has one compiled CSS");
  const [file, expected] = css[0]!;
  const bytes = readFileSync(join(lane.root, file));
  assert.equal(sha(bytes), expected, "exact archived compiled CSS bytes");
  return bytes.toString("utf8");
}
function close(a: number, b: number, label: string, tolerance = 0.2) {
  assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);
}
function find(snapshot: Snapshot, label: string) {
  const item = snapshot.parts.find((part) => part.label === label);
  assert.ok(item, "actual original control exists: " + label);
  return item;
}

test("finite native fixture inventories the 16 actual nodes and explicit additional roles", () => {
  assert.equal(dialogFrameConsumers.length, 16);
  assert.equal(new Set(dialogFrameConsumers).size, 16);
  assert.equal(Object.keys(dialogFramePrivateExports).length, 5);
  assert.ok(dialogFrameConsumers.includes("search"));
  assert.ok(dialogFrameConsumers.includes("speech-consent"));
  assert.ok(dialogFrameConsumers.includes("speech-voice"));
});

test(
  "real complete dialog consumers preserve native frame, controls, focus and bounded geometry",
  { timeout: 240_000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "actual browser capability is required; run through the npm test entry",
    );
    const oldCSS = migration ? baselineCSS() : undefined;
    const cache = mkdtempSync(join(tmpdir(), "morphz-dialog-frame-cache-"));
    context.after(() => rmSync(cache, { recursive: true, force: true }));
    // Vite/Rolldown follows the complete current entry's real dependency graph.
    // It determines final CSS order; static discovery order is not substituted.
    const compilation = await build({
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
    assert.ok(!Array.isArray(compilation) && "output" in compilation);
    const cssAssets = compilation.output.filter(
      (output) => output.type === "asset" && output.fileName.endsWith(".css"),
    );
    assert.equal(cssAssets.length, 1, "actual current main compiled CSS entry");
    const cssAsset = cssAssets[0]!;
    assert.equal(cssAsset.type, "asset");
    assert.ok("source" in cssAsset);
    const currentCSS = Buffer.from(cssAsset.source).toString("utf8");
    const increments: Array<{
      file: string;
      sourceSHA: string;
      increment: string;
    }> = [];
    const virtualFixture = dialogFrameBrowserFixture
      .replaceAll("__SOURCE__", "/@fs/" + sourceRoot)
      .replaceAll("__CORE__", "/@fs/" + resolve("packages/core/src"));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        {
          name: "actual-complete-dialog-frame-fixture",
          enforce: "pre",
          resolveId(id) {
            if (/^\/__dialog-frame-(current|old)\.(css|tsx)$/.test(id))
              return "\0" + id;
            if (id === "/__dialog-frame-fixture.tsx") return "\0" + id;
          },
          load(id) {
            if (id === "\0/__dialog-frame-current.css") return currentCSS;
            if (id === "\0/__dialog-frame-old.css") return oldCSS;
            if (id === "\0/__dialog-frame-fixture.tsx")
              return transformWithOxc(
                virtualFixture,
                "dialog-frame-fixture.tsx",
              );
            if (/^\0\/__dialog-frame-(current|old)\.tsx$/.test(id)) {
              const lane = id.includes("-old.") ? "old" : "current";
              return `import '/__dialog-frame-${lane}.css';import '/__dialog-frame-fixture.tsx';`;
            }
            // All styles are already present once, in the real compiled order.
            if (id.split("?")[0]!.endsWith(".css")) return "";
          },
          transform(code, id) {
            const name = Object.entries(dialogFramePrivateExports).find(
              ([file]) => id.split("?")[0] === join(sourceRoot, file),
            );
            if (!name) return;
            const [file, declaration] = name;
            const increment = `\nexport { ${declaration} as __dialogFrame_${declaration} };\n`;
            increments.push({ file, sourceSHA: sha(code), increment });
            // Append only: the entire original declaration, refs/hooks/DOM remain.
            return code + increment;
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__dialog-frame")
                return next();
              const lane = request.url.includes("lane=old") ? "old" : "current";
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__dialog-frame-${lane}.tsx"></script></body></html>`,
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
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const errors: string[] = [],
      business: string[] = [],
      coverage: string[] = [];
    const pages: Page[] = [];
    for (const lane of migration ? ["old", "current"] : ["current"]) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 820 },
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/**", (route) => {
        business.push(route.request().url());
        return route.abort();
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/__dialog-frame?lane=${lane}`,
      );
      await page.waitForFunction(() => (window as any).dialogFrame?.ready());
      pages.push(page);
    }
    context.after(() =>
      context.diagnostic(
        JSON.stringify({
          migration,
          currentCSS: sha(currentCSS),
          increments,
          coverage,
          errors,
          business,
        }),
      ),
    );
    async function settle() {
      await Promise.all(
        pages.map((page) =>
          page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
          ),
        ),
      );
      // Actual finite reveal duration; geometry is read after it has settled.
      await Promise.all(
        pages.map((page) =>
          page.waitForFunction(() =>
            [...document.getAnimations()].every(
              (animation) =>
                animation.playState !== "running" ||
                animation.effect?.getTiming().iterations === Infinity,
            ),
          ),
        ),
      );
    }
    async function read(): Promise<Snapshot> {
      await settle();
      const values = await Promise.all(
        pages.map((page) =>
          page.evaluate(
            () => (window as any).dialogFrame.snapshot() as Snapshot,
          ),
        ),
      );
      if (migration)
        assert.deepEqual(
          values[1],
          values[0],
          "complete current/frozen CSS semantic, style and geometry snapshot",
        );
      assert.deepEqual(errors, [], "real components have no uncaught errors");
      assert.deepEqual(business, [], "no business network or model calls");
      assert.ok(values[0]!.events.every(([name]) => name !== "forbidden"));
      return values.at(-1)!;
    }
    async function rpc(
      action: "open" | "close" | "configure" | "focusOrigin",
      value?: unknown,
    ) {
      await Promise.all(
        pages.map((page) =>
          page.evaluate(
            ({ action, value }) => (window as any).dialogFrame[action](value),
            { action, value },
          ),
        ),
      );
      return read();
    }
    async function open(name: string) {
      // Each new task follows actual unmount/remount. configure() intentionally
      // keeps the existing component/ref/input identity for live layout tests.
      await rpc("close");
      await rpc("focusOrigin");
      await rpc("open", name);
      await Promise.all(
        pages.map((page) =>
          page.waitForFunction(
            (name) =>
              name === "document" || name === "execution-embedded"
                ? !document.querySelector("dialog[open]")
                : !!document.querySelector("dialog[open]"),
            name,
          ),
        ),
      );
      // Speech/connection metadata publishes asynchronously through original effects.
      await Promise.all(
        pages.map((page) =>
          page.waitForFunction(
            () => !document.body.textContent?.includes("检查中…"),
          ),
        ),
      );
      const snapshot = await read();
      coverage.push(name);
      assert.ok(snapshot.root, "actual consumer has a rendered root: " + name);
      return snapshot;
    }
    async function click(selector: string) {
      for (const page of pages) {
        const locator = page.locator(selector).first();
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0);
        assert.ok(
          await locator.evaluate((node) => {
            const r = node.getBoundingClientRect(),
              hit = document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              );
            return !!hit && (hit === node || node.contains(hit));
          }),
          "actual coordinate hit, not dispatchEvent",
        );
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      return read();
    }

    await context.test(
      "all 16 original native nodes, compact rows and three real carrier consumers",
      async () => {
        for (const name of dialogFrameConsumers) {
          const snapshot = await open(name),
            root = snapshot.root!;
          assert.equal(snapshot.native, true, name);
          assert.equal(snapshot.modal, true, name);
          assert.ok(root.rect.width > 100 && root.rect.height > 20, name);
          assert.ok(
            root.rect.width <= 1200 && root.rect.height <= 820,
            "bounded original native geometry: " + name,
          );
          assert.ok(
            snapshot.parts.some((part) =>
              ["INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(part.tag),
            ),
            name,
          );
          assert.ok(
            snapshot.vars.every((value) => value.endsWith("px")),
            "real useModal workspace variables: " + name,
          );
          for (const part of snapshot.parts.filter((part) =>
            ["HEADER", "H2", "FOOTER"].includes(part.tag),
          )) {
            assert.ok(
              part.rect.width > 0 && part.rect.height > 0,
              "actual role BCR: " + name + ":" + part.tag,
            );
            assert.ok(
              part.rect.x >= root.rect.x - 0.2 &&
                part.rect.x + part.rect.width <=
                  root.rect.x + root.rect.width + 0.2,
              "original role remains inside native boundary: " + name,
            );
          }
          if (
            ["project-create", "project-action", "content-metadata"].includes(
              name,
            )
          ) {
            const input = snapshot.parts.find((part) => part.tag === "INPUT")!;
            const action = snapshot.parts.find(
              (part) =>
                part.tag === "BUTTON" && part.classes.includes("primary"),
            )!;
            close(
              input.rect.y,
              action.rect.y,
              name + " compact input/action top",
            );
            close(
              input.rect.height,
              action.rect.height,
              name + " compact input/action height",
            );
            close(input.rect.height, 32, name + " ordinary control height");
            assert.ok(
              root.rect.height < 130,
              name + " genuine two-row short form",
            );
          }
          if (name === "execution")
            assert.ok(root.classes.includes("library-dialog"));
          if (name === "install") {
            const footer = snapshot.parts.find(
              (part) => part.tag === "FOOTER",
            )!;
            assert.equal(footer.style.gap, "14px");
            assert.equal(footer.style["justify-content"], "space-between");
          }
          if (name === "connection")
            close(
              root.rect.width,
              460,
              "Connection carrier retains shared final width",
            );
          if (name === "search") {
            assert.ok(!root.classes.includes("create-dialog"));
            close(
              root.rect.width,
              640,
              "Search stays specialized, not create460",
            );
            assert.equal(snapshot.active, "全文搜索");
          }
          if (name === "search") {
            for (const page of pages) await page.keyboard.press("Escape");
          } else if (name === "speech-consent") {
            await click("dialog[open] footer button:first-child");
          } else {
            await click("dialog[open] header button:last-child");
          }
          assert.equal(
            (await read()).root,
            null,
            "actual original close action: " + name,
          );
          assert.equal(
            (await read()).active,
            "原输入草稿",
            "initiating focus restored: " + name,
          );
        }
        const library = await open("library-role");
        const footer = library.parts.find((part) => part.tag === "FOOTER")!;
        assert.equal(footer.style.gap, "16px");
        assert.equal(footer.style["justify-content"], "space-between");
        // Current Execution has no footer: this supplemental native role probe
        // covers the retained dormant carrier, not a claimed 17th product consumer.
        await rpc("close");
      },
    );

    await context.test(
      "single-line, textarea, select and excluded type policies remain distinct",
      async () => {
        const snapshot = await open("fields");
        for (const label of [
          "普通单行",
          "search",
          "email",
          "password",
          "url",
          "number",
          "tel",
          "date",
          "time",
          "单选",
        ]) {
          const field = find(snapshot, label);
          close(field.rect.height, 32, "single-line " + label);
          assert.equal(field.style["font-size"], "13px");
        }
        assert.ok(find(snapshot, "多行正文").rect.height > 32);
        assert.ok(find(snapshot, "多选").rect.height > 32);
        assert.ok(find(snapshot, "列表选择").rect.height > 32);
        for (const label of [
          "排除-checkbox",
          "排除-radio",
          "排除-range",
          "排除-file",
          "排除-color",
          "排除-hidden",
          "排除-button",
          "排除-submit",
          "排除-reset",
          "排除-image",
        ])
          assert.ok(find(snapshot, label), "full exclusion inventory " + label);
        assert.equal(find(snapshot, "排除-hidden").rect.height, 0);
        assert.notEqual(find(snapshot, "排除-checkbox").rect.height, 32);
        for (const page of pages)
          await page.locator('[aria-label="普通单行"]').focus();
        const focused = find(await read(), "普通单行");
        assert.equal(focused.style["outline-width"], "2px");
        assert.equal(focused.style["outline-offset"], "-2px");
        assert.equal(focused.style["box-shadow"], "none");
        // Multiple/size selects deliberately skip single-line metrics, but
        // still participate in the original all-selects focus recipe.
        for (const label of ["多选", "列表选择", "多行正文"]) {
          for (const page of pages)
            await page.locator(`[aria-label="${label}"]`).focus();
          const field = find(await read(), label);
          assert.equal(field.style["outline-width"], "2px", label);
          assert.equal(field.style["outline-offset"], "-2px", label);
        }
        await rpc("close");
      },
    );

    await context.test(
      "document header and embedded execution do not become native forms",
      async () => {
        const document = await open("document");
        assert.equal(document.native, false);
        assert.ok(
          document.parts.some(
            (part) => part.tag === "TEXTAREA" && part.rect.height > 100,
          ),
        );
        const headings = await Promise.all(
          pages.map((page) =>
            page.locator(".document-draft header").evaluate((header) => ({
              height: header.getBoundingClientRect().height,
              title: getComputedStyle(header.querySelector("h2")!).fontSize,
            })),
          ),
        );
        if (migration) assert.deepEqual(headings[1], headings[0]);
        close(headings[0]!.height, 32, "document shared actual header");
        assert.equal(headings[0]!.title, "14px");
        await rpc("close");
        const embedded = await open("execution-embedded");
        assert.equal(embedded.native, false);
        assert.equal(embedded.root!.classes, "execution-details");
        assert.equal(embedded.vars.length, 0);
        await rpc("close");
      },
    );

    await context.test(
      "four accents and light/dark, narrow/short and CSS200% retain exact original roles",
      async () => {
        for (const accent of ["cyan", "iris", "coral", "mono"])
          for (const appearance of ["light", "dark"]) {
            await rpc("configure", { accent, appearance });
            const snapshot = await open("project-create");
            // Original dialog-surface role (actual Git c525), not the UI
            // standard's approximate 12px panel guidance.
            assert.equal(snapshot.root!.style["border-radius"], "14px");
            assert.notEqual(
              snapshot.root!.style["background-color"],
              "rgba(0, 0, 0, 0)",
            );
            await rpc("close");
          }
        for (const [width, height, zoom] of [
          [760, 540, 1],
          [320, 440, 1],
          [1200, 820, 2],
        ] as const) {
          await Promise.all(
            pages.map((page) => page.setViewportSize({ width, height })),
          );
          await rpc("configure", {
            left: width === 320 ? 0 : 80,
            right: 0,
            top: 24,
            bottom: 24,
            zoom,
          });
          const snapshot = await open("project-create");
          assert.ok(
            snapshot.root!.rect.width <= snapshot.workspace.width + 0.2,
            "window/zoom width stays inside actual workspace",
          );
          assert.ok(snapshot.root!.rect.x >= snapshot.workspace.x - 0.2);
          assert.ok(
            snapshot.root!.rect.x + snapshot.root!.rect.width <= width + 0.2,
          );
          assert.ok(snapshot.root!.rect.height <= height + 0.2);
          await rpc("close");
        }
        await Promise.all(
          pages.map((page) =>
            page.setViewportSize({ width: 1200, height: 820 }),
          ),
        );
        await rpc("configure", {
          ...{
            accent: "cyan",
            appearance: "light",
            zoom: 1,
            left: 160,
            right: 24,
            top: 60,
            bottom: 48,
          },
        });
      },
    );

    await context.test(
      "workspace reanchors same native/ref/input, Tab loops and real close preserves selection",
      async () => {
        const before = await open("project-create"),
          input = find(before, "项目名称");
        for (const page of pages)
          await page.locator('[aria-label="项目名称"]').fill("保留改名草稿");
        for (const left of [280, 80, 0]) {
          const after = await rpc("configure", { left });
          assert.equal(
            after.root!.identity,
            before.root!.identity,
            "same native DOM identity",
          );
          assert.equal(
            find(after, "项目名称").identity,
            input.identity,
            "same original field node",
          );
          assert.equal(find(after, "项目名称").value, "保留改名草稿");
          close(
            Number.parseFloat(after.vars[0]!),
            after.workspace.x + after.workspace.width / 2,
            "ResizeObserver current workspace center",
          );
          close(
            Number.parseFloat(after.vars[1]!),
            after.workspace.width - 32,
            "ResizeObserver max width",
          );
        }
        for (const page of pages) {
          await page.locator(".project-dialog button.primary").focus();
          await page.keyboard.press("Tab");
        }
        assert.equal(
          (await read()).active,
          "关闭新建窗口",
          "last-to-first actual keyboard loop",
        );
        for (const page of pages) await page.keyboard.press("Shift+Tab");
        for (const page of pages)
          assert.equal(
            await page
              .locator(".project-dialog button.primary")
              .evaluate((node) => document.activeElement === node),
            true,
            "first-to-last actual keyboard loop",
          );
        await click(".project-dialog button.primary");
        for (const page of pages)
          await page.locator('[role="alert"]').waitFor();
        const failed = await read();
        assert.equal(failed.root!.identity, before.root!.identity);
        assert.equal(find(failed, "项目名称").value, "保留改名草稿");
        assert.ok(failed.events.some(([name]) => name === "execute"));
        for (const page of pages)
          assert.match(
            await page.locator('[role="alert"]').innerText(),
            /^受控保存失败：保留原草稿与权限。/,
          );
        await click('[aria-label="关闭新建窗口"]');
        for (const page of pages)
          assert.deepEqual(
            await page
              .locator("#origin")
              .evaluate((node) => [
                document.activeElement === node,
                (node as HTMLInputElement).value,
                (node as HTMLInputElement).selectionStart,
                (node as HTMLInputElement).selectionEnd,
              ]),
            [true, "不要丢弃的原始草稿", 3, 9],
          );
      },
    );

    await context.test(
      "long real script form scrolls to coordinate-hit footer without moving native task",
      async () => {
        await Promise.all(
          pages.map((page) =>
            page.setViewportSize({ width: 760, height: 400 }),
          ),
        );
        await rpc("configure", { left: 0, top: 16, bottom: 16, compact: true });
        const before = await open("script");
        const overflow = await Promise.all(
          pages.map((page) =>
            page.locator(".script-dialog form").evaluate((form) => ({
              scroll: form.scrollHeight,
              height: form.clientHeight,
            })),
          ),
        );
        assert.ok(
          overflow[0]!.scroll > overflow[0]!.height,
          "actual domain form carries bounded scroll",
        );
        await click('.script-dialog footer button[type="button"]');
        assert.equal((await read()).root, null);
        assert.ok(before.parts.some((part) => part.tag === "TEXTAREA"));
        await Promise.all(
          pages.map((page) =>
            page.setViewportSize({ width: 1200, height: 820 }),
          ),
        );
        await rpc("configure", {
          left: 160,
          top: 60,
          bottom: 48,
          compact: false,
        });
      },
    );

    await context.test(
      "dynamic coarse and reduced media keep native identity and original focus targets",
      async () => {
        const sessions = await Promise.all(
          pages.map((page) => page.context().newCDPSession(page)),
        );
        const before = await open("project-create");
        for (const session of sessions) {
          await session.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: "reduce" }],
          });
          await session.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 1,
          });
          await session.send("Emulation.setEmitTouchEventsForMouse", {
            enabled: true,
            configuration: "mobile",
          });
        }
        const reduced = await read();
        assert.equal(reduced.media.reduced, true);
        assert.equal(
          reduced.root!.style["animation-name"],
          "none",
          "actual reduced-motion suppression",
        );
        assert.equal(
          reduced.media.coarse,
          true,
          "actual dynamic pointer:coarse transition",
        );
        assert.equal(reduced.root!.identity, before.root!.identity);
        close(
          find(reduced, "项目名称").rect.height,
          44,
          "dynamic original coarse input",
        );
        assert.equal(
          find(reduced, "项目名称").identity,
          find(before, "项目名称").identity,
        );
        for (const session of sessions) {
          await session.send("Emulation.setTouchEmulationEnabled", {
            enabled: false,
          });
          await session.send("Emulation.setEmulatedMedia", {
            features: [
              { name: "prefers-reduced-motion", value: "no-preference" },
            ],
          });
        }
        const restored = await read();
        assert.equal(restored.media.coarse, false);
        assert.equal(restored.media.reduced, false);
        assert.equal(
          restored.root!.style["animation-name"],
          "dialog-reveal",
          "original finite reveal restores",
        );
        close(
          find(restored, "项目名称").rect.height,
          32,
          "dynamic original fine input",
        );
        assert.equal(restored.root!.identity, before.root!.identity);
        await rpc("close");
        for (const session of sessions) await session.detach();
        const touch = await browser.newContext({
          viewport: { width: 390, height: 660 },
          isMobile: true,
          hasTouch: true,
        });
        context.after(() => touch.close());
        const page = await touch.newPage();
        await page.goto(
          `http://127.0.0.1:${address.port}/__dialog-frame?lane=current`,
        );
        await page.waitForFunction(() => (window as any).dialogFrame?.ready());
        await page.evaluate(() => {
          (window as any).dialogFrame.configure({ left: 0, right: 0 });
          (window as any).dialogFrame.open("project-create");
        });
        await page.waitForFunction(() =>
          document.querySelector("dialog")?.matches(":modal"),
        );
        const snapshot = await page.evaluate(
          () => (window as any).dialogFrame.snapshot() as Snapshot,
        );
        assert.equal(
          snapshot.media.coarse,
          true,
          "actual pointer:coarse capability",
        );
        close(
          find(snapshot, "项目名称").rect.height,
          44,
          "original coarse input target",
        );
        assert.equal(find(snapshot, "项目名称").style["font-size"], "16px");
        const button = page.locator('[aria-label="关闭新建窗口"]');
        const box = await button.boundingBox();
        assert.ok(box);
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        assert.equal(
          await page.locator("dialog[open]").count(),
          0,
          "real coarse close hit",
        );
      },
    );
    assert.deepEqual(
      new Set(
        coverage.filter((name) => dialogFrameConsumers.includes(name as any)),
      ),
      new Set(dialogFrameConsumers),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(business, []);
  },
);
