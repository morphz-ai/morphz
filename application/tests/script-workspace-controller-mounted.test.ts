import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, expect, type Page } from "@playwright/test";
import { createServer } from "vite";
import {
  emptyScriptBrief,
  defaultScriptExportTemplate,
} from "../packages/core/src/script-studio.js";

// The complete current ScriptStudio with its real Library, Navigation, Editor,
// four forms, useScriptEditorRead, useModal and scopedStorage. No App/Host/RPC,
// model, physical picker or OS focus claim. The explicit historical lane loads
// the independently captured complete Git component, not a hook/demo oracle.
const migration =
  process.env.MORPHZ_TEST_SCRIPT_WORKSPACE_MIGRATION_EQUIVALENCE === "1";
type Request = {
  id: number;
  kind: string;
  args: unknown[];
  client: string;
  held: boolean;
  settled: boolean;
  aborted: boolean;
};
type Report = {
  dom: string;
  active: {
    tag: string;
    id: string;
    label: string | null;
    text: string;
    class: string;
    selection?: (number | null)[];
  } | null;
  fields: {
    label: string | null;
    value: string;
    disabled: boolean;
    checked: boolean | null;
  }[];
  requests: Request[];
  events: unknown[][];
  storage: Record<string, string>;
  config: Record<string, unknown>;
  width: number | null;
  observers: number;
  listeners: [string, number][];
  unmounted: boolean;
};
const cssImports = [
  ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
    /import\s+["'](\.\/[^"']+\.css)["'];/g,
  ),
]
  .map((match) => `import ${JSON.stringify("/src/" + match[1]!.slice(2))};`)
  .join("\n");
const fixtureId =
  "/@fs" + resolve("tests/fixtures/script-workspace-controller-mounted.tsx");
const historyId =
  "/@fs" +
  resolve("tests/fixtures/script-workspace-controller-13dbe571-component.tsx");
const entry = `${cssImports}
import {mountScriptWorkspace} from ${JSON.stringify(fixtureId)};
const historical=${migration}&&new URL(location.href).searchParams.get('lane')==='historical';
const {ScriptStudio}=await import(historical?${JSON.stringify(historyId)}:'/src/ScriptStudio.tsx');
mountScriptWorkspace(ScriptStudio);`;

test(
  "complete ScriptStudio workspace lifecycle, actual consumers and controlled export",
  { timeout: 60000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "test entry must prepare an installed browser",
    );
    const cache = await mkdtemp(
      resolve(tmpdir(), "morphz-script-workspace-vite-"),
    );
    context.after(() => rm(cache, { recursive: true, force: true }));
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "complete-script-workspace-mounted",
          resolveId(id) {
            if (id === "/__script_workspace_entry.js")
              return "\0script_workspace_entry.js";
          },
          load(id) {
            if (id === "\0script_workspace_entry.js") return entry;
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__script_workspace")
                return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url!,
                  '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{margin:0}.workspace{height:820px;max-width:100vw}.workspace-body,.primary-panel{height:100%;min-width:0}.script-studio{height:100%}</style></head><body><button id="outside">较新的操作</button><div id="root"></div><script type="module" src="/__script_workspace_entry.js"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      // Hot-refresh signature instrumentation can remount the archived local
      // useId component differently from the extracted custom hook. This is a
      // finite initial mount, not a hot-editing session; keep actual React
      // StrictMode but disable Vite HMR for both independent pages.
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        fs: { allow: [resolve(".")] },
      },
      logLevel: "error",
    });
    context.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const pages: Page[] = [],
      errors: string[] = [],
      requests: string[] = [],
      ledger: { name: string; reports: Report[] }[] = [];
    let phase = "setup";
    context.after(() =>
      context.diagnostic(
        JSON.stringify({
          migration,
          phase,
          observations: ledger.length,
          errors,
          businessRequests: requests,
        }),
      ),
    );
    for (const lane of migration ? ["historical", "current"] : ["current"]) {
      const session = await browser.newContext({
        viewport: { width: 1440, height: 960 },
      });
      context.after(() => session.close());
      // Fix only the test-owned draft-window identity; useId/DOM/ARIA are not
      // normalized or removed to obtain equality between the independent pages.
      await session.addInitScript(() =>
        sessionStorage.setItem(
          "morphz:window",
          "script-workspace-controlled-window",
        ),
      );
      const page = await session.newPage();
      page.setDefaultTimeout(4000);
      page.on("pageerror", (error) => errors.push(lane + ": " + error.message));
      page.on("request", (request) => {
        if (
          ["fetch", "xhr"].includes(request.resourceType()) &&
          !request.url().includes("/@vite/")
        )
          requests.push(request.url());
      });
      await page.clock.install({ time: new Date("2026-10-04T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-04T00:00:00Z"));
      await page.goto(
        `http://127.0.0.1:${address.port}/__script_workspace?lane=${lane}`,
      );
      await page.waitForFunction(
        () => !!Reflect.get(window, "scriptWorkspaceFixture"),
      );
      pages.push(page);
    }
    async function tick() {
      // Drain actual React/Promise tasks before the original rAF/timers, then
      // drain the updates those callbacks scheduled. This is finite, not an
      // idle/timeout loop, and does not suppress animations or DOM fields.
      for (let turn = 0; turn < 3; turn++)
        await Promise.all(
          pages.map((page) =>
            page.evaluate(() =>
              Reflect.get(window, "scriptWorkspaceFixture").settle(),
            ),
          ),
        );
      await Promise.all(pages.map((page) => page.clock.runFor(250)));
      for (let turn = 0; turn < 3; turn++)
        await Promise.all(
          pages.map((page) =>
            page.evaluate(() =>
              Reflect.get(window, "scriptWorkspaceFixture").settle(),
            ),
          ),
        );
    }
    async function observe(name: string) {
      await tick();
      // Compare the real visible Library-ready frame, not independently timed
      // native IntersectionObserver delivery. Deliberately held directory/read
      // requests remain pending and are still compared without transformation.
      await each(async (page) => {
        if (await page.locator(".script-card-meta").count())
          await expect(
            page.locator(".script-card-meta").filter({ hasText: "读取详情中" }),
          ).toHaveCount(0);
      });
      await tick();
      const reports = await Promise.all(
        pages.map(
          (page) =>
            page.evaluate(() =>
              Reflect.get(window, "scriptWorkspaceFixture").report(),
            ) as Promise<Report>,
        ),
      );
      ledger.push({ name, reports });
      if (migration) {
        if (reports[1]!.dom !== reports[0]!.dom) {
          let at = 0;
          while (reports[1]!.dom[at] === reports[0]!.dom[at]) at++;
          context.diagnostic(
            JSON.stringify({
              name,
              firstDomDifference: at,
              old: reports[0]!.dom.slice(Math.max(0, at - 100), at + 200),
              current: reports[1]!.dom.slice(Math.max(0, at - 100), at + 200),
            }),
          );
        }
        assert.deepEqual(
          reports[1],
          reports[0],
          "complete old/new observation: " + name,
        );
      }
      return reports.at(-1)!;
    }
    async function command(name: string, value?: unknown) {
      await Promise.all(
        pages.map((page) =>
          page.evaluate(
            ({ name, value }) =>
              Reflect.get(window, "scriptWorkspaceFixture").run(name, value),
            { name, value },
          ),
        ),
      );
      return observe(name);
    }
    async function reset(value: unknown = {}, keepStorage = false) {
      await Promise.all(
        pages.map((page) =>
          page.evaluate(
            ({ value, keepStorage }) =>
              Reflect.get(window, "scriptWorkspaceFixture").reset(
                value,
                keepStorage,
              ),
            { value, keepStorage },
          ),
        ),
      );
      const initial = value as {
        ready?: boolean;
        start?: { view?: string };
      };
      if (initial.ready === false || initial.start?.view === "library") {
        await tick();
        // Real IntersectionObserver visibility may arrive on different browser
        // frames. Both cards are in this viewport; wait for their actual shared
        // child UI, rather than comparing one page's pending frame to ready UI.
        await each((page) =>
          expect(page.locator(".script-card-meta")).toHaveText([
            "原创",
            "原创",
          ]),
        );
      }
      return observe("reset");
    }
    async function each(fn: (page: Page) => Promise<unknown>) {
      await Promise.all(pages.map(fn));
    }
    const button = (page: Page, name: string) =>
      page.getByRole("button", { name, exact: true });
    const title = (page: Page) => page.getByLabel("文稿标题", { exact: true });
    const body = (page: Page) => page.getByLabel("剧本正文", { exact: true });
    const kinds = (report: Report, kind: string) =>
      report.requests.filter((request) => request.kind === kind);
    const pending = (report: Report, kind: string) => {
      const found = kinds(report, kind)
        .filter((request) => !request.settled)
        .at(-1);
      assert(found, "real held request: " + kind);
      return found;
    };
    const resolveHeld = (request: Request, reply?: unknown, error?: string) =>
      command("resolve", { id: request.id, reply, error });
    const current = async (name: string) => {
      phase = name;
      return observe(name);
    };
    async function openExport() {
      await each((page) => button(page, "导出 Word").click());
      await tick();
      await each((page) =>
        expect(
          page.getByRole("dialog", { name: "导出 Word", exact: true }),
        ).toBeVisible(),
      );
    }
    async function submitExport() {
      await each((page) =>
        page
          .getByRole("dialog", { name: "导出 Word", exact: true })
          .getByRole("button", { name: "导出所选", exact: true })
          .click(),
      );
      return observe("export submitted");
    }

    await context.test(
      "location/render storage, directory widths, keyboard and same DOM",
      async () => {
        await reset();
        await each((page) =>
          expect(body(page)).toHaveValue("TEST 原保存正文 item-production-A"),
        );
        let record = await current("initial editor");
        assert.equal(
          kinds(record, "editor").length,
          2,
          "real StrictMode read setup/cleanup",
        );
        assert.equal(kinds(record, "page-reviews").length, 0);
        assert.equal(kinds(record, "page-exports").length, 0);
        await each((page) => button(page, "剧本目录开关").click());
        await current("wide closed");
        await each((page) =>
          expect(
            page.getByRole("navigation", { name: "剧本目录", exact: true }),
          ).toBeHidden(),
        );
        assert(
          Object.values((await observe("wide preference")).storage).includes(
            "false",
          ),
        );
        await each((page) => button(page, "剧本目录开关").click());
        await tick();
        await each((page) =>
          expect(
            page.getByRole("button", {
              name: "TEST 雨夜第一集 草稿",
              exact: true,
            }),
          ).toBeFocused(),
        );
        await command("set", { width: 620 });
        await each((page) =>
          expect(button(page, "剧本目录开关")).toHaveAttribute(
            "aria-expanded",
            "false",
          ),
        );
        await each((page) => button(page, "剧本目录开关").click());
        await tick();
        await each((page) => page.keyboard.press("Escape"));
        await each((page) =>
          expect(button(page, "剧本目录开关")).toBeFocused(),
        );
        await current("narrow escape");
        await each((page) => button(page, "剧本目录开关").click());
        await each((page) => page.locator("#outside").click());
        await each((page) =>
          expect(button(page, "剧本目录开关")).toHaveAttribute(
            "aria-expanded",
            "false",
          ),
        );
        await current("narrow outside");
      },
    );
    await context.test(
      "explicit target waits for catalog readiness and navigation receipt retires editor",
      async () => {
        await reset({
          ready: false,
          locationRequest: {
            productionId: "production-B",
            itemId: "item-production-B",
            requestId: "explicit-B",
          },
        });
        let record = await current("target not ready");
        assert.equal(kinds(record, "editor").length, 0);
        await command("set", { ready: true });
        await each((page) =>
          expect(title(page)).toHaveValue("TEST 回信第一集"),
        );
        record = await current("explicit target ready");
        // The original ready render still observes the captured current A;
        // the independent layout effect then changes the selected target B.
        assert.deepEqual(
          kinds(record, "editor").map((r) => r.args[0]),
          ["production-A", "production-B"],
        );
        await command("set", {
          locationRequest: undefined,
          navigationId: "library-receipt",
          scriptTarget: null,
        });
        await each((page) =>
          expect(page.getByLabel("查找剧本", { exact: true })).toBeVisible(),
        );
        await current("library receipt");
        await reset();
        await command("hold", ["execute"]);
        await each((page) => button(page, "剧本设置").click());
        await tick();
        await each((page) =>
          page.getByLabel("剧名", { exact: true }).fill("TEST 修改规范"),
        );
        await each((page) =>
          page.getByLabel("受众", { exact: true }).fill("TEST 同一捕获规范"),
        );
        await each((page) =>
          page
            .getByRole("dialog", { name: "剧本设置", exact: true })
            .getByRole("button", { name: "保存规范", exact: true })
            .evaluate((element) => {
              (element as HTMLButtonElement).click();
              (element as HTMLButtonElement).click();
            }),
        );
        record = await current("settings same-frame captured action");
        const settings = kinds(record, "execute").filter(
          (request) =>
            (request.args[0] as { command?: { action?: string } }).command
              ?.action === "update-production",
        );
        assert.equal(
          settings.length,
          1,
          "original synchronous working ref excludes a same-frame second command",
        );
        assert.deepEqual(
          (settings[0]!.args[0] as { command: unknown }).command,
          {
            action: "update-production",
            productionId: "production-A",
            expectedRevision: 1,
            title: "TEST 修改规范",
            brief: {
              ...emptyScriptBrief,
              audience: "TEST 同一捕获规范",
            },
            reviewerPrincipalIds: ["local-owner"],
            template: defaultScriptExportTemplate,
          },
        );
        await each((page) =>
          expect(page.getByRole("dialog").getByRole("alert")).toContainText(
            "请在已连接的剧本工作区操作。",
          ),
        );
        await command("hold", []);
        await resolveHeld(settings[0]!);
        await each((page) => expect(page.getByRole("dialog")).toHaveCount(0));
        await each((page) =>
          expect(page.getByLabel("当前剧本", { exact: true })).toHaveText(
            "TEST 修改规范",
          ),
        );
        await current("settings closes after captured receipt");
        await command("set", { online: false });
        await each((page) => expect(title(page)).toBeDisabled());
        await each((page) => expect(button(page, "导出 Word")).toBeDisabled());
        await command("set", { online: true, active: false });
        await each((page) => expect(title(page)).toBeDisabled());
        await each((page) => expect(button(page, "剧本设置")).toBeDisabled());
        assert.equal(
          kinds(
            await current("offline/inactive do not write"),
            "execute",
          ).filter(
            (request) =>
              (request.args[0] as { type: string }).type === "script-command",
          ).length,
          1,
        );
      },
    );
    await context.test(
      "actual library preserves draft/query and delayed card focus yields to newer input",
      async () => {
        await reset();
        await each((page) => body(page).fill("TEST 本机未保存正文"));
        await command("hold", ["directory"]);
        await each((page) => button(page, "全部剧本").click());
        await tick();
        await each((page) =>
          expect(page.getByLabel("查找剧本", { exact: true })).toBeFocused(),
        );
        let record = await current("directory held");
        await each((page) =>
          page.getByLabel("查找剧本", { exact: true }).click(),
        );
        await resolveHeld(pending(record, "directory"));
        await each((page) =>
          expect(page.getByLabel("查找剧本", { exact: true })).toBeFocused(),
        );
        await command("hold", []);
        await each((page) =>
          page.getByLabel("查找剧本", { exact: true }).fill("TEST 雨夜"),
        );
        await tick();
        await command("hold", ["editor:production-A"]);
        await each((page) =>
          button(page, "打开剧本：TEST 雨夜").press("Enter"),
        );
        await tick();
        record = await current("reopen captured metadata held");
        await each((page) => page.locator("#outside").click());
        await resolveHeld(pending(record, "editor"));
        await each((page) =>
          expect(body(page)).toHaveValue("TEST 本机未保存正文"),
        );
        await current("reopened body ready focus");
        await each((page) => expect(page.locator("#outside")).toBeFocused());
        record = await current("original draft reopened");
        assert(
          record.events.some(
            (event) =>
              event[0] === "open" &&
              event[2] === "production-A" &&
              event[3] === "item-production-A",
          ),
        );
        await each((page) => button(page, "全部剧本").click());
        await tick();
        await each((page) =>
          expect(page.getByLabel("查找剧本", { exact: true })).toHaveValue(
            "TEST 雨夜",
          ),
        );
        await current("query retained");
      },
    );
    await context.test(
      "storage failure does not turn successful local navigation into a manuscript write",
      async () => {
        await reset();
        await command("storageFailure", "script-location");
        await each((page) =>
          page
            .getByRole("navigation", { name: "剧本目录", exact: true })
            .getByRole("button", { name: "概览", exact: true })
            .click(),
        );
        const record = await current("local location failure");
        assert(
          record.events.some(
            (event) =>
              event[0] === "notice" &&
              event[2] === "定位暂时无法保存；文稿未受影响。",
          ),
        );
        const operations = kinds(record, "execute").map(
          (r) => r.args[0] as { type: string; expectedRevision: number },
        );
        assert.deepEqual(
          operations.map((o) => [o.type, o.expectedRevision]),
          [["set-application-state", 7]],
        );
        await reset();
        await each((page) => button(page, "设置项目").click());
        await tick();
        await each((page) =>
          expect(
            page.getByRole("dialog", { name: "设置项目", exact: true }),
          ).toBeVisible(),
        );
        const metadata = await current(
          "metadata opened by actual catalog port",
        );
        assert.deepEqual(
          kinds(metadata, "catalog").map((r) => r.args),
          [["catalog-production-A"]],
        );
        await each((page) =>
          page.getByLabel("目标项目", { exact: true }).selectOption("new"),
        );
        await each((page) =>
          page.getByLabel("新项目名称", { exact: true }).fill("TEST 新归属"),
        );
        await command("hold", ["execute"]);
        await each((page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "保存", exact: true })
            .click(),
        );
        const heldMetadata = pending(
          await current("metadata captured catalog revision"),
          "execute",
        );
        assert.deepEqual(heldMetadata.args[0], {
          type: "organize-content",
          target: { kind: "script", id: "production-A" },
          expectedRevision: 1,
          changes: { newProjectTitle: "TEST 新归属" },
        });
        await resolveHeld(heldMetadata);
        await each((page) => expect(page.getByRole("dialog")).toHaveCount(0));
        assert(
          (
            await current(
              "metadata closes and hands original production to host",
            )
          ).events.some(
            (e) => e[0] === "open" && e[2] === "production-A" && e[3] === null,
          ),
        );
      },
    );
    await context.test(
      "create form failure, actual modal loop, flushSync close then exact item/header focus",
      async () => {
        await reset({
          start: { productionId: "", itemId: "", view: "library" },
        });
        await command("hold", ["execute"]);
        await each((page) => button(page, "手动新建剧本").click());
        await tick();
        await each((page) =>
          expect(page.getByLabel("剧本名称", { exact: true })).toBeFocused(),
        );
        await each((page) =>
          page.getByLabel("剧本名称", { exact: true }).fill("TEST 新创建"),
        );
        await each((page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "创建", exact: true })
            .click(),
        );
        let record = await current("creation held");
        await resolveHeld(
          pending(record, "execute"),
          undefined,
          "TEST 创建失败",
        );
        await each((page) =>
          expect(page.getByRole("dialog").getByRole("alert")).toContainText(
            "TEST 创建失败",
          ),
        );
        await each((page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "取消", exact: true })
            .focus(),
        );
        await each((page) => page.keyboard.press("Tab"));
        await each((page) =>
          expect(
            page
              .getByRole("dialog")
              .getByRole("button", { name: "关闭", exact: true }),
          ).toBeFocused(),
        );
        await each((page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "创建", exact: true })
            .click(),
        );
        record = await current("creation retry");
        await command("hold", []);
        await resolveHeld(pending(record, "execute"));
        await each((page) => expect(page.getByRole("dialog")).toHaveCount(0));
        await each((page) =>
          expect(page.getByLabel("当前剧本", { exact: true })).toHaveText(
            "TEST 新创建",
          ),
        );
        await each((page) =>
          expect(
            page.locator("[data-script-focus-anchor]").last(),
          ).toBeFocused(),
        );
        await current("create production close/focus");
        await each((page) =>
          page
            .getByRole("region", { name: "创作入口", exact: true })
            .getByRole("button", { name: "新建一集", exact: true })
            .click(),
        );
        await tick();
        await each((page) =>
          page
            .getByLabel("条目标题", { exact: true })
            .fill("TEST 新创建第一集"),
        );
        await each((page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "创建条目", exact: true })
            .click(),
        );
        await tick();
        await each((page) =>
          expect(title(page)).toHaveValue("TEST 新创建第一集"),
        );
        await current("created item body ready focus");
        await each((page) =>
          expect(
            page.locator(".script-editor [data-script-focus-anchor]"),
          ).toBeFocused(),
        );
        await current("create item close/focus");
      },
    );
    await context.test(
      "actual editor retains dirty CAS base and does not overwrite a fresh version",
      async () => {
        await reset();
        await each((page) => body(page).fill("TEST 旧基线草稿"));
        await command("revise");
        await each((page) =>
          expect(page.locator(".script-editor .script-warning")).toContainText(
            "中心已有 v2",
          ),
        );
        await each((page) => button(page, "保存文稿").click());
        await tick();
        await each((page) =>
          expect(
            page.locator(".script-editor .script-editor-error[role=alert]"),
          ).toContainText("TEST CAS"),
        );
        await each((page) => expect(body(page)).toHaveValue("TEST 旧基线草稿"));
        const record = await current("CAS dirty base");
        const op = kinds(record, "execute").at(-1)!.args[0] as {
          command: { expectedRevision: number };
        };
        assert.equal(op.command.expectedRevision, 1);
        await each((page) => button(page, "保留旧草稿并载入最新稿").click());
        await tick();
        await each((page) => expect(body(page)).toHaveValue("TEST 中心新稿"));
        await current("explicit new draft");
      },
    );
    await context.test(
      "late editor read and focus request cannot replace the newer selected item",
      async () => {
        await reset();
        await command("hold", ["version:production-B"]);
        await command("set", {
          locationRequest: {
            productionId: "production-B",
            itemId: "item-production-B",
            requestId: "later-B",
          },
        });
        let record = await current("B exact body held");
        const held = pending(record, "version");
        await command("set", {
          locationRequest: {
            productionId: "production-A",
            itemId: "item-production-A",
            requestId: "newer-A",
          },
        });
        await each((page) => body(page).fill("TEST 更新的A草稿"));
        await resolveHeld(held);
        await each((page) =>
          expect(body(page)).toHaveValue("TEST 更新的A草稿"),
        );
        await each((page) => expect(body(page)).toBeFocused());
        await current("late B retired");
      },
    );
    await context.test(
      "review/export panels are explicit; each historical record/title is read serially",
      async () => {
        await reset({
          start: { productionId: "production-A", itemId: "", view: "editor" },
        });
        await command("seedExports");
        let record = await current("overview closed panes");
        assert.equal(kinds(record, "page-reviews").length, 0);
        assert.equal(kinds(record, "page-exports").length, 0);
        assert.equal(kinds(record, "version").length, 0);
        await each((page) =>
          page
            .locator(".script-overview-details > summary")
            .filter({ hasText: "结构检查" })
            .click(),
        );
        await tick();
        record = await current("reviews explicit");
        assert.equal(kinds(record, "page-reviews").length, 1);
        await each((page) =>
          page
            .locator(".script-overview-details > summary")
            .filter({ hasText: "结构检查" })
            .click(),
        );
        await command("hold", ["page-reviews"]);
        await each((page) =>
          page
            .locator(".script-overview-details > summary")
            .filter({ hasText: "结构检查" })
            .click(),
        );
        record = await current("explicit review held");
        await resolveHeld(
          pending(record, "page-reviews"),
          undefined,
          "TEST 显式检查读取失败",
        );
        await each((page) =>
          expect(page.locator(".script-studio > [role=alert]")).toContainText(
            "TEST 显式检查读取失败",
          ),
        );
        const failedReviewCount = kinds(
          await current("read rejection is visible without automatic retry"),
          "page-reviews",
        ).length;
        assert.equal(failedReviewCount, 2);
        await each((page) =>
          page
            .locator(".script-overview-details > summary")
            .filter({ hasText: "结构检查" })
            .click(),
        );
        await command("hold", []);
        await command("hold", ["title", "export"]);
        await each((page) =>
          page
            .locator(".script-overview-details > summary")
            .filter({ hasText: "导出历史" })
            .click(),
        );
        record = await current("first export held");
        assert.equal(kinds(record, "export").length, 1);
        assert.equal(kinds(record, "title").length, 0);
        await resolveHeld(pending(record, "export"));
        record = await current("first title held");
        assert.equal(kinds(record, "export").length, 1);
        await resolveHeld(pending(record, "title"));
        record = await current("second export held");
        assert.equal(kinds(record, "export").length, 2);
        await resolveHeld(pending(record, "export"));
        record = await current("second title held");
        await resolveHeld(pending(record, "title"));
        await each((page) =>
          expect(page.locator(".script-export-record")).toHaveCount(2),
        );
        record = await current("historical titles rendered");
        assert.equal(kinds(record, "version").length, 0);
        assert.deepEqual(
          kinds(record, "title").map((r) => r.args),
          [
            ["production-A", "item-production-A", 1],
            ["production-A", "item-production-A", 1],
          ],
        );
      },
    );
    await context.test(
      "native cancellation and warning preserve original export record and trigger",
      async () => {
        await reset();
        await command("hold", ["native"]);
        await openExport();
        let record = await submitExport();
        await each((page) => expect(page.getByRole("dialog")).toHaveCount(0));
        const first = pending(record, "native"),
          input = first.args[0] as { exportId: string };
        assert(
          record.events.findIndex(
            (e) => e[0] === "native-dialog" && e[2] === true,
          ) < record.events.findIndex((e) => e[0] === "native-start"),
        );
        assert.equal(kinds(record, "manifest").length, 0);
        assert.equal(
          record.events.filter((e) => e[0] === "snapshot").length,
          3,
          "one post-record identity read plus two independent sameView field reads before native handoff",
        );
        await resolveHeld(first, {
          status: "cancelled",
          exportId: input.exportId,
        });
        await each((page) =>
          expect(page.locator(".script-export-status")).toContainText(
            "已取消保存",
          ),
        );
        await each((page) => expect(button(page, "导出 Word")).toBeFocused());
        await current("cancel return");
        await each((page) => button(page, "关闭导出提示").click());
        await each((page) => expect(button(page, "导出 Word")).toBeFocused());
        await openExport();
        record = await submitExport();
        const second = pending(record, "native");
        const next = second.args[0] as { exportId: string };
        await resolveHeld(second, {
          status: "saved",
          exportId: next.exportId,
          filename: "TEST.docx",
          bytes: 1234,
          warning: "temporary-file-cleanup-failed",
        });
        await each((page) =>
          expect(page.locator(".script-export-status")).toContainText(
            "临时文件清理失败",
          ),
        );
        await current("save warning");
        await each((page) => button(page, "查看导出历史").click());
        await tick();
        await each((page) =>
          expect(
            page
              .locator("details[open] > summary")
              .filter({ hasText: "导出历史" }),
          ).toBeFocused(),
        );
        await current("status opens exact history");
      },
    );
    await context.test(
      "native failure/mismatched receipt yields one local error and keeps latest focus",
      async () => {
        await reset();
        await command("hold", ["native"]);
        await openExport();
        let record = await submitExport();
        await resolveHeld(
          pending(record, "native"),
          undefined,
          "TEST 原生保存失败",
        );
        await each((page) =>
          expect(page.locator(".script-studio > [role=alert]")).toContainText(
            "TEST 原生保存失败",
          ),
        );
        await each((page) => expect(button(page, "导出 Word")).toBeFocused());
        await current("save failure focus");
        await openExport();
        record = await submitExport();
        await each((page) => page.locator("#outside").click());
        await resolveHeld(pending(record, "native"), {
          status: "saved",
          exportId: "wrong-export",
          filename: "wrong.docx",
          bytes: 1,
        });
        await each((page) =>
          expect(page.locator(".script-studio > [role=alert]")).toContainText(
            "保存回执与导出记录不一致",
          ),
        );
        await each((page) => expect(page.locator("#outside")).toBeFocused());
        await current("mismatch preserves later focus");
        await reset();
        await command("hold", ["native"]);
        await openExport();
        record = await submitExport();
        const oldNative = pending(record, "native");
        await command("set", {
          locationRequest: {
            productionId: "production-B",
            itemId: "item-production-B",
            requestId: "native-newer-production",
          },
        });
        await each((page) =>
          expect(title(page)).toHaveValue("TEST 回信第一集"),
        );
        await each((page) => page.locator("#outside").focus());
        await resolveHeld(oldNative, {
          status: "saved",
          exportId: (oldNative.args[0] as { exportId: string }).exportId,
          filename: "old-A.docx",
          bytes: 5,
        });
        await each((page) =>
          expect(page.locator(".script-export-status")).toHaveCount(0),
        );
        await each((page) => expect(page.locator("#outside")).toBeFocused());
        await current(
          "completed original export never publishes or focuses newer production",
        );
      },
    );
    await context.test(
      "captured command source and current identity/view keep late export out of a new surface",
      async () => {
        await reset();
        await command("hold", ["execute"]);
        await openExport();
        let record = await submitExport();
        const commandRequest = pending(record, "execute");
        await command("set", {
          client: "B",
          center: "center-B",
          principal: "other-human",
          active: false,
        });
        await resolveHeld(commandRequest);
        record = await current("export identity changed");
        assert.equal(commandRequest.client, "A");
        assert.equal(kinds(record, "native").length, 0);
        assert(!record.dom.includes("Word 已保存"));
        const op = commandRequest.args[0] as {
          command: {
            productionId: string;
            expectedRevision: number;
            items: unknown[];
          };
        };
        assert.equal(op.command.productionId, "production-A");
        assert.equal(op.command.expectedRevision, 1);
        assert.deepEqual(op.command.items, [
          { itemId: "item-production-A", revision: 1 },
        ]);
      },
    );
    await context.test(
      "unmount retires reads/observers and native completion does not create or focus DOM",
      async () => {
        await reset();
        await command("hold", ["native"]);
        await openExport();
        let record = await submitExport(),
          held = pending(record, "native");
        await command("unmount");
        await each((page) => page.locator("#outside").focus());
        await resolveHeld(held, {
          status: "cancelled",
          exportId: (held.args[0] as { exportId: string }).exportId,
        });
        record = await current("native after unmount");
        assert.equal(record.dom, "");
        assert.equal(record.observers, 0);
        assert.deepEqual(record.listeners, []);
        assert.equal(record.active?.id, "outside");
        if (migration) {
          await reset();
          await command("hold", ["execute"]);
          await each((page) =>
            page
              .getByRole("navigation", { name: "剧本目录", exact: true })
              .getByRole("button", { name: "概览", exact: true })
              .click(),
          );
          record = await current("historical choose late catch held");
          held = pending(record, "execute");
          await command("unmount");
          await resolveHeld(held, undefined, "TEST 迟到位置回执");
          record = await current("migration-only original late notice");
          assert(
            record.events.some(
              (e) =>
                e[0] === "notice" &&
                e[2] === "定位同步失败：TEST 迟到位置回执；本机定位已保留。",
            ),
          );
        }
      },
    );
    const closed = await Promise.all(
      pages.map(
        (page) =>
          page.evaluate(() =>
            Reflect.get(window, "scriptWorkspaceFixture").cleanup(),
          ) as Promise<Report>,
      ),
    );
    for (const value of closed) {
      assert.equal(value.observers, 0);
      assert.deepEqual(value.listeners, []);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    // Optional output-only evidence archive. Normal CI never reads this path,
    // Git, historical temporary evidence, dist or a whole-component hash.
    if (process.env.MORPHZ_TEST_SCRIPT_WORKSPACE_EVIDENCE)
      await writeFile(
        process.env.MORPHZ_TEST_SCRIPT_WORKSPACE_EVIDENCE,
        JSON.stringify({ migration, ledger, closed, errors, requests }),
      );
    context.diagnostic(
      JSON.stringify(
        ledger.map(({ name, reports }) => ({
          name,
          reports: reports.map((report) => ({
            sha256: createHash("sha256")
              .update(JSON.stringify(report))
              .digest("hex"),
            requests: report.requests.length,
            scope: [report.config.center, report.config.principal],
            active: report.active && {
              tag: report.active.tag,
              id: report.active.id,
              label: report.active.label,
              selection: report.active.selection,
            },
          })),
        })),
      ),
    );
  },
);
