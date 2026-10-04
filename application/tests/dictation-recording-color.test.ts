import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, expect, type Page } from "@playwright/test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isJsxAttribute,
  isJsxElement,
  isJsxSelfClosingElement,
  type Node,
} from "typescript/unstable/ast";
import { createServer, transformWithOxc } from "vite";

const workflowPath = resolve("apps/web/src/workflow.css"),
  workflow = readFileSync(workflowPath, "utf8"),
  app = readFileSync(resolve("apps/web/src/App.tsx"), "utf8"),
  main = readFileSync(resolve("apps/web/src/main.tsx"), "utf8"),
  fixture = readFileSync(
    new URL("./fixtures/dictation-recording-color.tsx", import.meta.url),
    "utf8",
  );
const selector =
    '.app .composer-action-trailing > button[data-recording="true"]',
  oldSelector = '.app .composer-media-tools > button[data-recording="true"]',
  declaration = "color: light-dark(#ae3535, #ee8d8d);",
  executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
  available = existsSync(executable || chromium.executablePath());

test("recording uses only the direct trailing-slot rule and preserves the original light/dark reds", () => {
  assert.equal(workflow.split(selector).length - 1, 1);
  assert.ok(workflow.includes(`${selector} {\n  ${declaration}\n}`));
  assert.equal(workflow.includes(oldSelector), false);
  // The existing inline recording glyph has its own unchanged rule.
  assert.ok(
    workflow.includes(
      `.inline-dictation[data-recording="true"] .dictation-controls > svg {\n  ${declaration}\n}`,
    ),
  );
});

function microphoneMarkup(source: string) {
  const directory = "/dictation-color-contract",
    config = directory + "/tsconfig.json",
    file = directory + "/source.tsx";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [file]: source,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["source.tsx"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const shape = (node: Node): unknown => {
    if (node.kind === SyntaxKind.JsxText && !node.getText().trim()) return null;
    const children: unknown[] = [];
    node.forEachChild((child) => {
      const value = shape(child);
      if (value !== null) children.push(value);
    });
    return [node.kind, children.length ? children : node.getText()];
  };
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(project.program.getSyntacticDiagnostics(), []);
    const slots: Node[] = [];
    const visit = (node: Node) => {
      const opening = isJsxElement(node)
        ? node.openingElement
        : isJsxSelfClosingElement(node)
          ? node
          : null;
      if (opening?.tagName.getText() === "ComposerActionBar")
        for (const attribute of opening.attributes.properties)
          if (
            isJsxAttribute(attribute) &&
            attribute.name.getText() === "microphone"
          )
            slots.push(attribute);
      node.forEachChild(visit);
    };
    visit(project.program.getSourceFile(file)!);
    assert.equal(
      slots.length,
      1,
      "one actual ComposerActionBar microphone slot",
    );
    return shape(slots[0]!);
  } finally {
    snapshot.dispose();
    api.close();
  }
}

test("the mounted fixture uses the real ComposerActionBar and exact current App microphone JSX", () => {
  assert.deepEqual(microphoneMarkup(fixture), microphoneMarkup(app));
  assert.match(
    fixture,
    /import \{ ComposerActionBar \} from "\.\.\/\.\.\/apps\/web\/src\/ComposerActionBar\.js";/,
  );
  assert.doesNotMatch(fixture, /function ComposerActionBar/);
});

type Report = {
  same: boolean;
  focused: boolean;
  focusVisible: boolean;
  label: string;
  pressed: string;
  recording: string | null;
  title: string;
  disabled: boolean;
  direct: string;
  color: string;
  iconColor: string;
  opacity: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  background: string;
  width: number;
  height: number;
  iconWidth: number;
  iconHeight: number;
  glyph: string;
  draft: string;
  others: { label: string; color: string }[];
};
const report = (page: Page): Promise<Report> =>
  page.evaluate(() => Reflect.get(window, "dictationColorFixture").report());

test(
  "real StrictMode ComposerActionBar cascade: four accents × light/dark, recording stop red and idle restoration, unchanged ARIA/focus/geometry",
  {
    timeout: 45000,
    skip: !available ? "No matching Playwright browser" : false,
  },
  async (context) => {
    // Borrow the entire production entrypoint CSS list and order, including
    // later visual-system rules. Only the old lane inverts this single selector.
    const styles = [...main.matchAll(/import "\.\/(.*\.css)";/g)].map(
      (match) => match[1]!,
    );
    assert.ok(
      styles.indexOf("workflow.css") < styles.indexOf("visual-system.css"),
    );
    const source = (old: boolean) =>
      fixture
        .replace(
          /"\.\.\/\.\.\/apps\/web\/src\/ComposerActionBar\.js"/,
          '"/src/ComposerActionBar.tsx"',
        )
        .replace(
          "// Actual main.tsx CSS imports are inserted here by the isolated test server.",
          styles
            .map(
              (path) =>
                `import "/src/${path}${old && path === "workflow.css" ? "?dictationBaseline" : ""}";`,
            )
            .join("\n"),
        );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      logLevel: "error",
      plugins: [
        {
          name: "dictation-color-old-selector",
          enforce: "pre",
          transform(code, id) {
            if (id === `${workflowPath}?dictationBaseline`) {
              assert.equal(code, workflow);
              return code.replace(selector, oldSelector);
            }
          },
        },
        react(),
        {
          name: "dictation-color-real-action-bar",
          resolveId(id) {
            if (/^\/__dictation-color-(old|new)\.tsx$/.test(id))
              return "\0" + id;
          },
          async load(id) {
            if (/^\0\/__dictation-color-(old|new)\.tsx$/.test(id))
              return transformWithOxc(
                source(id.includes("-old")),
                "fixture.tsx",
              );
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              const match = request.url?.match(
                /^\/__dictation-color-(old|new)$/,
              );
              if (!match) return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url!,
                  `<!doctype html><html><body><div id="root"></div><script type="module" src="/__dictation-color-${match[1]}.tsx"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    context.after(() => server.close());
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    const errors: string[] = [],
      queries: string[] = [];
    for (const [index, page] of pages.entries()) {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (["fetch", "xhr"].includes(request.resourceType()))
          queries.push(request.url());
      });
      await page.goto(
        `http://127.0.0.1:${address.port}/__dictation-color-${index ? "new" : "old"}`,
      );
      await page
        .getByRole("button", { name: "语音输入", exact: true })
        .waitFor();
    }
    const baseline = pages[0]!,
      candidate = pages[1]!;
    const patch = (page: Page, value: Record<string, unknown>) =>
      page.evaluate(
        (next) => Reflect.get(window, "dictationColorFixture").patch(next),
        value,
      );
    const geometry = (value: Report) => [
      value.width,
      value.height,
      value.iconWidth,
      value.iconHeight,
    ];
    for (const accent of ["cyan", "iris", "coral", "mono"])
      for (const appearance of ["light", "dark"]) {
        await context.test(`${accent}/${appearance}`, async (check) => {
          const red =
            appearance === "light" ? "rgb(174, 53, 53)" : "rgb(238, 141, 141)";
          const initial: Report[] = [];
          for (const page of pages) {
            await patch(page, {
              accent,
              appearance,
              recording: false,
              sending: false,
            });
            // Theme transitions are real production CSS. Await their actual
            // completion before comparing stable colors, without disabling or
            // replacing animations or guessing a sleep duration.
            await page.locator(".app").evaluate(async (root) => {
              await new Promise(requestAnimationFrame);
              await Promise.all(
                root
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation instanceof CSSTransition)
                  .map((animation) =>
                    animation.finished.catch(() => undefined),
                  ),
              );
            });
            const button = page.getByRole("button", {
              name: "语音输入",
              exact: true,
            });
            await button.focus();
            await page.evaluate(() =>
              Reflect.get(window, "dictationColorFixture").remember(),
            );
            initial.push(await report(page));
            await button.press("Space");
            await expect(button).toHaveAttribute("aria-pressed", "true");
          }
          const old = await report(baseline);
          await expect(
            candidate.getByRole("button", { name: "语音输入", exact: true }),
          ).toHaveCSS("color", red);
          const current = await report(candidate);
          assert.notEqual(
            old.color,
            red,
            "old unmatched rule reproduces the original defect",
          );
          assert.equal(current.iconColor, red);
          assert.equal(current.direct, "composer-action-trailing");
          assert.equal(
            current.same && current.focused && current.focusVisible,
            true,
          );
          assert.equal(current.label, "语音输入");
          assert.equal(current.recording, "true");
          assert.equal(current.title, "停止听写");
          assert.equal(current.disabled, false);
          assert.equal(current.glyph, "stop");
          assert.equal(current.opacity, "1");
          assert.equal(current.outlineStyle, initial[1]!.outlineStyle);
          assert.equal(current.outlineWidth, initial[1]!.outlineWidth);
          assert.notEqual(current.outlineStyle, "none");
          assert.equal(current.outlineColor, initial[1]!.outlineColor);
          assert.deepEqual(geometry(current), geometry(initial[1]!));
          assert.deepEqual(geometry(current), geometry(old));
          assert.deepEqual(geometry(current), [32, 32, 16, 16]);
          assert.equal(current.background, old.background);
          assert.deepEqual(current.others, old.others);
          assert.equal(
            current.others.some((value) => value.color === red),
            false,
          );
          assert.equal(current.draft, "原稿保留");
          // Starting a send while recording must leave the existing stop usable.
          await patch(candidate, { sending: true });
          assert.equal((await report(candidate)).disabled, false);
          await patch(candidate, { sending: false });
          await candidate
            .getByRole("button", { name: "语音输入", exact: true })
            .press("Space");
          await expect(
            candidate.getByRole("button", { name: "语音输入", exact: true }),
          ).toHaveCSS("color", initial[1]!.color);
          const idle = await report(candidate);
          assert.equal(idle.same && idle.focused, true);
          assert.equal(idle.pressed, "false");
          assert.equal(idle.recording, null);
          assert.equal(idle.title, "开始听写");
          assert.equal(idle.glyph, "microphone");
          assert.equal(idle.iconColor, idle.color);
          assert.notEqual(idle.color, red);
          assert.deepEqual(geometry(idle), geometry(current));
          assert.equal(idle.draft, "原稿保留");
          await patch(candidate, { sending: true });
          assert.equal((await report(candidate)).disabled, true);
          await expect(
            candidate.getByRole("button", { name: "语音输入", exact: true }),
          ).toHaveCSS("color", initial[1]!.color);
          check.diagnostic(
            JSON.stringify({
              oldStop: old.color,
              newStop: current.color,
              idle: idle.color,
              geometry: geometry(current),
              focused: idle.focused,
            }),
          );
        });
      }
    await context.test(
      "coarse pointer keeps the existing 44px hit target",
      async () => {
        const touch = await browser.newContext({
          hasTouch: true,
          viewport: { width: 320, height: 600 },
        });
        try {
          const page = await touch.newPage();
          await page.goto(
            `http://127.0.0.1:${address.port}/__dictation-color-new`,
          );
          const button = page.getByRole("button", {
            name: "语音输入",
            exact: true,
          });
          await button.waitFor();
          assert.equal(
            await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
            true,
          );
          await page.evaluate(() =>
            Reflect.get(window, "dictationColorFixture").remember(),
          );
          const idle = await report(page);
          assert.deepEqual(geometry(idle), [44, 44, 16, 16]);
          await button.tap();
          await expect(button).toHaveCSS("color", "rgb(174, 53, 53)");
          const recording = await report(page);
          assert.equal(recording.same, true);
          assert.equal(recording.pressed, "true");
          assert.deepEqual(geometry(recording), geometry(idle));
          await button.tap();
          await expect(button).toHaveCSS("color", idle.color);
          const restored = await report(page);
          assert.equal(restored.recording, null);
          assert.equal(restored.pressed, "false");
          assert.equal(restored.same, true);
          assert.deepEqual(geometry(restored), geometry(idle));
        } finally {
          await touch.close();
        }
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
  },
);
