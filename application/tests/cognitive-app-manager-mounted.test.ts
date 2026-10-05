import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page, type Locator } from "@playwright/test";
import { createServer } from "vite";
import type { ApplicationInvocation } from "../packages/core/src/application-api.js";
import type { CognitiveAppManagerMountedReport } from "./fixtures/cognitive-app-manager-mounted.js";

// ACTUAL mounted UI/React/useWorkspace/public owner/facade/local persistence.
// Logical replies are controlled, NOT SQL/HPA/native IPC or original App proof.
type Snapshot = CognitiveAppManagerMountedReport;
const appId = "example.notes",
  hash = "a".repeat(64);
const managementMethods = [
  "cognitive-apps.describe",
  "cognitive-apps.install",
  "cognitive-apps.grant",
  "cognitive-apps.connect",
  "cognitive-apps.connection-state",
];
const calls = (r: Snapshot, method: string) =>
  r.requests.filter((x) => x.method === "cognitive-apps." + method);
async function report(page: Page): Promise<Snapshot> {
  return page.evaluate(() =>
    Reflect.get(window, "cognitiveAppManagerFixture").report(),
  );
}
async function action(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(
    ({ name, args }) =>
      Reflect.get(window, "cognitiveAppManagerFixture")[name](...args),
    { name, args },
  );
}
async function wait(
  page: Page,
  condition: (r: Snapshot) => boolean,
): Promise<Snapshot> {
  const deadline = Date.now() + 12000;
  for (;;) {
    const value = await report(page);
    if (condition(value)) return value;
    if (Date.now() >= deadline)
      assert.fail(
        "mounted manager condition timed out: " + JSON.stringify(value),
      );
    await page.waitForTimeout(20);
  }
}
function safe(
  r: Snapshot,
  errors: string[],
  external: string[],
  allowed: string[],
) {
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    r.rendererErrors,
    [],
    "actual production React must not emit console errors",
  );
  assert.deepEqual(external, []);
  assert.equal(
    r.storedDraft,
    r.unsentBytes,
    "every unsent input byte stays unchanged",
  );
  assert.deepEqual(
    r.requests.filter(
      (x) =>
        managementMethods.includes(x.method) && !allowed.includes(x.method),
    ),
    [],
    "opening, selecting files or explicit management never implicitly grants/connects/sends",
  );
  const forbidden = r.requests.filter((x) =>
    /message|launch|create|start|invoke|read-object|read-ui/.test(x.method),
  );
  assert.deepEqual(
    forbidden,
    [],
    "manager must not create Sessions, launch UI, read originals or start Runtime",
  );
}
async function queued(
  page: Page,
  method: string,
  label: string,
  hold = false,
  fail = false,
) {
  await action(page, "queue", "cognitive-apps." + method, label, hold, fail);
}
async function select(
  page: Page,
  version: string,
  label: string,
  hold = false,
) {
  await queued(page, "describe", label, hold);
  await page
    .getByRole("button", { name: "独立笔记 " + version, exact: false })
    .click();
  if (!hold)
    await wait(page, (r) => r.preview.includes("PRIVATE_PREVIEW_" + label));
}
const params = (request: ApplicationInvocation) =>
  request.params as Record<string, unknown>;
async function file(locator: Locator, name: string, json: unknown) {
  await locator.setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json)),
  });
}

test(
  "actual Chromium manager: explicit Human management, cancellation, exact CAS, persistent retry and responsive modal; controlled transport only",
  { timeout: 240000 },
  async (t) => {
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "formal entry must supply actual Chromium, never skip",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-manager-mounted-cache-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const screenshots = await mkdtemp(
      resolve(tmpdir(), "morphz-manager-mounted-screens-"),
    );
    const fixture = resolve("tests/fixtures/cognitive-app-manager-mounted.tsx");
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "actual-cognitive-manager-mount",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__cognitive-manager")
                return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html data-appearance="light"><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`,
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
    t.after(() => server.close());
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__cognitive-manager`;
    const browser = await chromium.launch({ headless: true, executablePath });
    t.after(() => browser.close());
    const definition = JSON.parse(
      await readFile(
        resolve("examples/cognitive-notes/definition.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const html =
      "<!doctype html><html><body><h1>Explicit selected GUI bytes</h1></body></html>\n";
    const guiDefinition = {
      ...definition,
      id: "example.gui-notes",
      title: "界面笔记",
      ui: {
        packageVersion: "1.0.0",
        sha256: createHash("sha256").update(html).digest("hex"),
      },
    };
    const manifest = {
      format: "morphz-app/v1",
      id: "example.gui-notes",
      version: "1.0.0",
      title: "界面笔记",
      description: definition.description,
      icon: "document",
      permissions: [],
      harness: null,
      ui: { type: "sandbox", html },
    };
    async function load() {
      const page = await browser.newPage({
        viewport: { width: 1120, height: 800 },
      });
      const errors: string[] = [],
        external: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          message.text().includes("createRoot")
        ) {
          void page
            .evaluate(() =>
              Reflect.get(window, "cognitiveAppManagerFixture")?.report(),
            )
            .then(
              (value) =>
                t.diagnostic(
                  "Duplicate fixture entry evidence: " + JSON.stringify(value),
                ),
              () => {},
            );
        }
      });
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
          external.push(request.url());
      });
      await page.goto(url);
      await page.waitForFunction(
        () => !!Reflect.get(window, "cognitiveAppManagerFixture"),
      );
      await wait(
        page,
        (r) => !!r.boot && r.online && r.catalog.versions.length === 2,
      );
      await page.getByRole("button", { name: "管理应用", exact: true }).click();
      await page
        .getByRole("dialog", { name: "管理应用", exact: true })
        .waitFor();
      return { page, errors, external };
    }
    async function connectionFields(page: Page) {
      const form = page.locator(".cognitive-app-manager-connect");
      if (!(await form.evaluate((node) => node.hasAttribute("open"))))
        await form.locator("summary").click();
      await page
        .getByRole("textbox", { name: "服务标识", exact: true })
        .fill("author/s-original");
      await page
        .getByRole("textbox", { name: "数据保存方标识", exact: true })
        .fill("author/d-original");
    }
    async function unknownConnect(page: Page) {
      await action(page, "setGrant", "1.0.0", 3, "active");
      await wait(page, (r) => r.catalog.versions[0]?.grant?.revision === 3);
      await select(page, "1.0.0", "unknown-connect");
      await connectionFields(page);
      await queued(page, "connect", "unknown", false, true);
      await page.getByRole("button", { name: "建立连接", exact: true }).click();
      await page
        .getByRole("heading", { name: "连接结果待核对", exact: true })
        .waitFor();
      const snapshot = await wait(
        page,
        (r) =>
          calls(r, "connect").length === 1 &&
          r.actualConnectRuns[0]?.state === "rejected",
      );
      assert.equal(snapshot.connectionRetryRecords.length, 1);
      return calls(snapshot, "connect")[0]!;
    }
    await t.test(
      "mount and explicit exact-version describe do not authorize; null and disabled grants use original CAS",
      async () => {
        const { page, errors, external } = await load();
        try {
          let r = await report(page);
          safe(r, errors, external, []);
          assert.equal(r.preview, "");
          assert.equal(calls(r, "describe").length, 0);
          assert.equal(
            await page
              .getByRole("button", { name: "允许数据访问", exact: true })
              .count(),
            0,
          );
          await select(page, "1.0.0", "null-grant");
          r = await report(page);
          assert.deepEqual(params(calls(r, "describe")[0]!), {
            mode: "registered-management",
            appId,
            version: "1.0.0",
            expectedDefinitionHash: hash,
          });
          assert.ok(
            await page.getByRole("region", { name: "应用能力" }).textContent(),
          );
          await queued(page, "grant", "allow-null");
          await page
            .getByRole("button", { name: "允许数据访问", exact: true })
            .click();
          await wait(page, (v) => v.notice === "已保存");
          r = await report(page);
          assert.deepEqual(params(calls(r, "grant")[0]!), {
            appId,
            version: "1.0.0",
            expectedRevision: 0,
            state: "active",
          });
          await select(page, "2.0.0", "disabled-grant");
          await queued(page, "grant", "allow-disabled");
          await page
            .getByRole("button", { name: "允许数据访问", exact: true })
            .click();
          await wait(page, (v) => v.notice === "已保存");
          r = await report(page);
          assert.deepEqual(params(calls(r, "grant")[1]!), {
            appId,
            version: "2.0.0",
            expectedRevision: 7,
            state: "active",
          });
          safe(r, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.grant",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "connection state preserves original ID/revision, explicit connect preserves typed public service/data identifiers",
      async () => {
        const { page, errors, external } = await load();
        try {
          await select(page, "1.0.0", "connection");
          await queued(page, "connection-state", "disable-original");
          await page
            .getByRole("button", { name: "停用连接", exact: true })
            .click();
          await wait(page, (r) => r.notice === "已保存");
          assert.deepEqual(
            params(calls(await report(page), "connection-state")[0]!),
            {
              appId,
              version: "1.0.0",
              expectedDefinitionHash: hash,
              connectionId: "connection-original",
              expectedRevision: 4,
              state: "disabled",
            },
          );
          assert.equal(
            await page
              .getByRole("button", { name: "启用连接", exact: true })
              .isDisabled(),
            true,
          );
          await queued(page, "grant", "connection-allow");
          await page
            .getByRole("button", { name: "允许数据访问", exact: true })
            .click();
          await wait(page, (r) => r.notice === "已保存");
          await page.locator(".cognitive-app-manager-connect summary").click();
          await page
            .getByRole("textbox", { name: "服务标识", exact: true })
            .fill("author/service-精确");
          await page
            .getByRole("textbox", { name: "数据保存方标识", exact: true })
            .fill("author/data-精确");
          await queued(page, "connect", "explicit-new");
          await page
            .getByRole("button", { name: "建立连接", exact: true })
            .click();
          await wait(page, (r) => r.notice === "连接操作已确认");
          const r = await report(page),
            p = params(calls(r, "connect")[0]!);
          assert.match(String(p.connectionId), /^[A-Za-z0-9_-]+$/);
          assert.deepEqual(
            { ...p, connectionId: "original-id" },
            {
              appId,
              version: "1.0.0",
              expectedDefinitionHash: hash,
              expectedGrantRevision: 1,
              connectionId: "original-id",
              expectedRevision: 0,
              serviceId: "author/service-精确",
              dataAuthorityId: "author/data-精确",
            },
          );
          safe(r, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.grant",
            "cognitive-apps.connection-state",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "unknown connection keeps its original request; catalogue metadata cannot ACK it and only explicit original retry sends",
      async () => {
        const { page, errors, external } = await load();
        try {
          const original = await unknownConnect(page);
          const stored = (await report(page)).connectionRetryRecords;
          assert.equal(
            await page
              .getByRole("button", { name: "建立连接", exact: true })
              .isDisabled(),
            true,
          );
          assert.equal(
            await page
              .getByRole("textbox", { name: "服务标识", exact: true })
              .isDisabled(),
            false,
            "Human may explicitly select a different public target; never auto-generate a replacement attempt",
          );
          await action(page, "materializeConnect", true);
          await wait(page, (r) =>
            r.catalog.connections.some(
              (c) =>
                c.connectionId === params(original).connectionId &&
                c.dataAuthorityId === "author/wrong-data",
            ),
          );
          assert.deepEqual((await report(page)).connectionRetryRecords, stored);
          await action(page, "materializeConnect", false);
          await wait(page, (r) =>
            r.catalog.connections.some(
              (c) =>
                c.connectionId === params(original).connectionId &&
                c.dataAuthorityId === "author/d-original",
            ),
          );
          assert.deepEqual((await report(page)).connectionRetryRecords, stored);
          assert.equal(calls(await report(page), "connect").length, 1);
          await queued(page, "connect", "receipt-current");
          await page
            .getByRole("button", { name: "按原请求重试", exact: true })
            .click();
          await wait(page, (r) => r.notice === "连接操作已确认");
          const r = await report(page);
          assert.equal(calls(r, "connect").length, 2);
          assert.deepEqual(calls(r, "connect")[0], original);
          assert.deepEqual(params(calls(r, "connect")[1]!), params(original));
          assert.deepEqual(r.connectionRetryRecords, []);
          safe(r, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "close and reopen recovers the complete original request without sending; only explicit retry reuses the original ID",
      async () => {
        const { page, errors, external } = await load();
        try {
          const original = await unknownConnect(page);
          const stored = (await report(page)).connectionRetryRecords;
          await page
            .getByRole("button", { name: "关闭应用管理", exact: true })
            .click();
          await page
            .getByRole("button", { name: "管理应用", exact: true })
            .click();
          await select(page, "1.0.0", "reopened");
          await connectionFields(page);
          await page
            .getByRole("button", { name: "建立连接", exact: true })
            .click();
          await wait(page, (r) => r.notice.includes("已找到原连接请求"));
          const before = await report(page);
          assert.equal(calls(before, "connect").length, 1);
          assert.deepEqual(before.connectionRetryRecords, stored);
          const originalPanel = page.getByRole("region", {
            name: "原连接请求",
            exact: true,
          });
          assert.ok(
            (await originalPanel.textContent())?.includes(
              String(params(original).connectionId),
            ),
          );
          assert.ok((await originalPanel.textContent())?.includes(hash));
          await queued(page, "connect", "replay-create");
          await page
            .getByRole("button", { name: "按原请求重试", exact: true })
            .click();
          const r = await wait(page, (r) => r.notice === "连接操作已确认");
          assert.deepEqual(params(calls(r, "connect")[1]!), params(original));
          assert.deepEqual(r.connectionRetryRecords, []);
          assert.equal(calls(r, "connection-state").length, 0);
          safe(r, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "real same-window reload retains original CAS; disabled permission lookup is read-only and confirmed disabled/unavailable reply never enables",
      async () => {
        for (const state of ["disabled", "unavailable"] as const) {
          const { page, errors, external } = await load();
          try {
            const original = await unknownConnect(page),
              dto = params(original);
            const stored = (await report(page)).connectionRetryRecords;
            await page.reload();
            await page.waitForFunction(
              () => !!Reflect.get(window, "cognitiveAppManagerFixture"),
            );
            await wait(
              page,
              (r) => !!r.boot && r.catalog.versions.length === 2,
            );
            assert.deepEqual(
              (await report(page)).connectionRetryRecords,
              stored,
              "genuine window reload preserves exact storage bytes, no re-seeding",
            );
            await action(page, "setGrant", "1.0.0", 11, "disabled");
            await wait(
              page,
              (r) => r.catalog.versions[0]?.grant?.revision === 11,
            );
            await page
              .getByRole("button", { name: "管理应用", exact: true })
              .click();
            await select(page, "1.0.0", "disabled-reload");
            await connectionFields(page);
            assert.equal(
              await page
                .getByRole("button", { name: "建立连接", exact: true })
                .isDisabled(),
              true,
            );
            const beforeLookup = await report(page);
            await page
              .getByRole("button", { name: "查看原重试记录", exact: true })
              .click();
            const found = await wait(page, (r) =>
              r.notice.includes("已找到原连接请求"),
            );
            assert.equal(calls(found, "connect").length, 0);
            assert.equal(
              found.uuidCalls,
              beforeLookup.uuidCalls,
              "pure recovered lookup never creates a candidate UUID",
            );
            assert.deepEqual(found.connectionRetryRecords, stored);
            const panel = page.getByRole("region", {
              name: "原连接请求",
              exact: true,
            });
            assert.equal(
              await panel
                .locator("dl > div")
                .filter({ hasText: "原权限修订" })
                .locator("dd")
                .textContent(),
              "3",
            );
            assert.ok(
              (await panel.textContent())?.includes(String(dto.connectionId)),
            );
            await action(page, "materializeConnectionRequest", dto, state, 9);
            await wait(page, (r) =>
              r.catalog.connections.some(
                (c) => c.connectionId === dto.connectionId && c.state === state,
              ),
            );
            await queued(page, "connect", "receipt-current");
            await page
              .getByRole("button", { name: "按原请求重试", exact: true })
              .click();
            const confirmed = await wait(
              page,
              (r) => r.notice === "连接操作已确认",
            );
            assert.deepEqual(params(calls(confirmed, "connect")[0]!), dto);
            assert.deepEqual(confirmed.connectionRetryRecords, []);
            assert.equal(
              confirmed.catalog.connections.find(
                (c) => c.connectionId === dto.connectionId,
              )?.state,
              state,
            );
            assert.equal(
              confirmed.catalog.connections.find(
                (c) => c.connectionId === dto.connectionId,
              )?.revision,
              9,
            );
            assert.equal(calls(confirmed, "connection-state").length, 0);
            assert.equal(calls(confirmed, "grant").length, 0);
            safe(confirmed, errors, external, [
              "cognitive-apps.describe",
              "cognitive-apps.connect",
            ]);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "forget requires inline Human risk confirmation, never sends or revokes; cancellation retains bytes and a new creation is a separate explicit action",
      async () => {
        const { page, errors, external } = await load();
        try {
          const original = await unknownConnect(page),
            stored = (await report(page)).connectionRetryRecords;
          await page
            .getByRole("button", { name: "不再重试", exact: true })
            .click();
          await page
            .getByRole("group", { name: "确认放弃本机重试", exact: true })
            .waitFor();
          assert.ok(
            (
              await page
                .getByRole("group", { name: "确认放弃本机重试", exact: true })
                .textContent()
            )?.includes("再次创建可能产生第二条连接"),
          );
          await page
            .getByRole("button", { name: "保留原记录", exact: true })
            .click();
          assert.deepEqual((await report(page)).connectionRetryRecords, stored);
          assert.equal(calls(await report(page), "connect").length, 1);
          await page
            .getByRole("button", { name: "不再重试", exact: true })
            .click();
          await page
            .getByRole("button", { name: "确认放弃本机重试", exact: true })
            .click();
          const forgotten = await wait(page, (r) =>
            r.notice.includes("已放弃本机重试记录"),
          );
          assert.deepEqual(forgotten.connectionRetryRecords, []);
          assert.equal(calls(forgotten, "connect").length, 1);
          assert.equal(calls(forgotten, "connection-state").length, 0);
          await queued(page, "connect", "human-new-attempt");
          await page
            .getByRole("button", { name: "建立连接", exact: true })
            .click();
          const newAttempt = await wait(
            page,
            (r) => r.notice === "连接操作已确认",
          );
          assert.notEqual(
            params(calls(newAttempt, "connect")[1]!).connectionId,
            params(original).connectionId,
          );
          safe(newAttempt, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "busy original retry cannot be forgotten; replaced local attempt is not cleared by a stale forget capability",
      async () => {
        const { page, errors, external } = await load();
        try {
          const original = await unknownConnect(page);
          await queued(page, "connect", "held-original", true, true);
          await page
            .getByRole("button", { name: "按原请求重试", exact: true })
            .click();
          await wait(page, (r) => r.held.length === 1);
          assert.equal(
            await page
              .getByRole("button", { name: "不再重试", exact: true })
              .isDisabled(),
            true,
          );
          await action(page, "settle", 0);
          await wait(page, (r) => r.actualConnectRuns[1]?.state === "rejected");
          assert.deepEqual(
            params(calls(await report(page), "connect")[1]!),
            params(original),
          );
          await page
            .getByRole("button", { name: "不再重试", exact: true })
            .click();
          await action(page, "replaceConnectionRetry");
          const replacement = (await report(page)).connectionRetryRecords;
          assert.ok(
            replacement[0]?.bytes?.includes("separately_prepared_attempt"),
          );
          await page
            .getByRole("button", { name: "确认放弃本机重试", exact: true })
            .click();
          const refused = await wait(page, (r) =>
            r.notice.includes("未能清理原本机记录"),
          );
          assert.deepEqual(refused.connectionRetryRecords, replacement);
          assert.equal(calls(refused, "connect").length, 2);
          assert.equal(calls(refused, "connection-state").length, 0);
          safe(refused, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "missing local retry lookup writes nothing; corrupt durable record blocks recovery dispatch",
      async () => {
        const { page, errors, external } = await load();
        try {
          await select(page, "1.0.0", "pure-lookup");
          await connectionFields(page);
          const beforeLookup = await report(page);
          await page
            .getByRole("button", { name: "查看原重试记录", exact: true })
            .click();
          const missing = await wait(page, (r) =>
            r.notice.includes("本窗口没有这个目标"),
          );
          assert.deepEqual(missing.connectionRetryRecords, []);
          assert.equal(calls(missing, "connect").length, 0);
          assert.equal(
            missing.uuidCalls,
            beforeLookup.uuidCalls,
            "missing local lookup generates no UUID",
          );
          const original = await unknownConnect(page);
          await page
            .getByRole("button", { name: "关闭应用管理", exact: true })
            .click();
          await action(page, "corruptConnectionRetry");
          const corrupt = (await report(page)).connectionRetryRecords;
          await page
            .getByRole("button", { name: "管理应用", exact: true })
            .click();
          await select(page, "1.0.0", "corrupt-lookup");
          await connectionFields(page);
          await page
            .getByRole("button", { name: "查看原重试记录", exact: true })
            .click();
          await page.getByRole("alert").waitFor();
          const refused = await report(page);
          assert.deepEqual(refused.connectionRetryRecords, corrupt);
          assert.equal(calls(refused, "connect").length, 1);
          assert.deepEqual(calls(refused, "connect")[0], original);
          safe(refused, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "known connection ACK survives visual close and self-access unmount, clears fixed-scope retry bytes and never reopens the modal",
      async () => {
        for (const unmount of [false, true]) {
          const { page, errors, external } = await load();
          try {
            await action(page, "setGrant", "1.0.0", 3, "active");
            await wait(
              page,
              (r) => r.catalog.versions[0]?.grant?.revision === 3,
            );
            await select(page, "1.0.0", "known-connect");
            await connectionFields(page);
            if (unmount) await action(page, "conditionalHost", true);
            await queued(page, "connect", "known-held", true);
            if (unmount) await queued(page, "list", "own-access-refresh", true);
            await page
              .getByRole("button", { name: "建立连接", exact: true })
              .click();
            const pending = await wait(
              page,
              (r) =>
                r.held.length === 1 && r.connectionRetryRecords.length === 1,
            );
            const original = calls(pending, "connect")[0]!;
            if (!unmount)
              await page
                .getByRole("button", { name: "关闭应用管理", exact: true })
                .click();
            await action(page, "settle", 0);
            if (unmount) {
              const refreshing = await wait(
                page,
                (r) =>
                  r.boot === null &&
                  r.held.some((h) => h.method === "cognitive-apps.list"),
              );
              assert.equal(
                await page
                  .getByRole("dialog", { name: "管理应用", exact: true })
                  .count(),
                0,
              );
              assert.equal(refreshing.actualConnectRuns[0]?.state, "pending");
              assert.equal(refreshing.cancelled.includes(original.id), false);
              await action(
                page,
                "settle",
                refreshing.held.find((h) => h.method === "cognitive-apps.list")!
                  .index,
              );
            }
            const completed = await wait(
              page,
              (r) =>
                r.actualConnectRuns[0]?.state === "fulfilled" &&
                r.connectionRetryRecords.length === 0,
            );
            assert.equal(completed.cancelled.includes(original.id), false);
            assert.equal(completed.notice, "");
            assert.equal(
              await page
                .getByRole("dialog", { name: "管理应用", exact: true })
                .count(),
              0,
              "access refresh never reopens the retired visual manager",
            );
            assert.equal(calls(completed, "connect").length, 1);
            safe(completed, errors, external, [
              "cognitive-apps.describe",
              "cognitive-apps.connect",
            ]);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "a real owner timeout keeps the original request but does not permanently lock explicit local forgetting",
      async () => {
        const { page, errors, external } = await load();
        try {
          await action(page, "setGrant", "1.0.0", 3, "active");
          await wait(page, (r) => r.catalog.versions[0]?.grant?.revision === 3);
          await select(page, "1.0.0", "timeout-connect");
          await connectionFields(page);
          await page.clock.install();
          await queued(page, "connect", "real-owner-timeout", true);
          await page
            .getByRole("button", { name: "建立连接", exact: true })
            .click();
          await wait(page, (r) => r.held.length === 1);
          await page.clock.fastForward(30001);
          const timedout = await wait(
            page,
            (r) => r.actualConnectRuns[0]?.state === "rejected",
          );
          assert.equal(timedout.connectionRetryRecords.length, 1);
          await page
            .getByRole("button", { name: "不再重试", exact: true })
            .click();
          await page
            .getByRole("button", { name: "确认放弃本机重试", exact: true })
            .click();
          const forgotten = await wait(page, (r) =>
            r.notice.includes("已放弃本机重试记录"),
          );
          assert.deepEqual(forgotten.connectionRetryRecords, []);
          assert.equal(calls(forgotten, "connect").length, 1);
          assert.equal(
            forgotten.held[0]?.settled,
            false,
            "late backend outcome remains unknown, no rollback simulated",
          );
          safe(forgotten, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "forget re-read cannot delete the original after identity, window owner or selection changes while real WebCrypto is pending",
      async () => {
        for (const change of [
          "identity",
          "window",
          "selection",
          "close",
        ] as const) {
          const { page, errors, external } = await load();
          try {
            await unknownConnect(page);
            const stored = (await report(page)).connectionRetryRecords;
            await page
              .getByRole("button", { name: "不再重试", exact: true })
              .click();
            await action(page, "holdDigest");
            await page
              .getByRole("button", { name: "确认放弃本机重试", exact: true })
              .click();
            await wait(page, (r) => r.digestReads === 1);
            if (change === "identity") {
              await action(
                page,
                "changeIdentity",
                "csrfToken",
                "session-after-forget-read",
              );
              await wait(
                page,
                (r) => r.boot?.csrfToken === "session-after-forget-read",
              );
            } else if (change === "window")
              await action(page, "loseWindowOwner");
            else if (change === "selection")
              await select(page, "2.0.0", "new-selection-during-forget");
            else
              await page
                .getByRole("button", { name: "关闭应用管理", exact: true })
                .click();
            await action(page, "settleDigest", 0);
            await page.waitForTimeout(35);
            const preserved = await report(page);
            assert.deepEqual(preserved.connectionRetryRecords, stored);
            assert.equal(calls(preserved, "connect").length, 1);
            assert.equal(calls(preserved, "connection-state").length, 0);
            assert.ok(!preserved.notice.includes("已放弃"));
            safe(preserved, errors, external, [
              "cognitive-apps.describe",
              "cognitive-apps.connect",
            ]);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "files are only local previews; explicit headless, exact GUI and registered installations never grant or connect",
      async () => {
        for (const kind of ["headless", "gui", "register"] as const) {
          const { page, errors, external } = await load();
          try {
            await page
              .getByRole("button", { name: "添加应用", exact: true })
              .click();
            if (kind === "register") {
              await page
                .getByRole("button", { name: "登记已安装应用", exact: true })
                .click();
              await page
                .getByRole("textbox", { name: "应用标识", exact: true })
                .fill(appId);
              await page
                .getByRole("textbox", { name: "版本", exact: true })
                .fill("1.0.0");
              await page
                .getByRole("textbox", { name: "定义 SHA-256", exact: true })
                .fill(hash);
            } else {
              await file(
                page.getByLabel("应用定义 JSON", { exact: true }),
                "definition.json",
                kind === "gui" ? guiDefinition : definition,
              );
              await page
                .getByRole("heading", {
                  name: kind === "gui" ? "界面笔记 1.0.0" : "独立笔记 1.0.0",
                  exact: true,
                })
                .waitFor();
              if (kind === "gui")
                await file(
                  page.getByLabel("界面包 JSON", { exact: true }),
                  "ui.json",
                  manifest,
                );
            }
            let r = await report(page);
            safe(r, errors, external, []);
            assert.equal(calls(r, "install").length, 0);
            await queued(page, "install", kind);
            if (kind === "gui")
              await queued(
                page,
                "list",
                "known-gui-ack-refresh-failed",
                false,
                true,
              );
            const button = page.getByRole("button", {
              name: kind === "register" ? "登记应用" : "安装应用",
              exact: true,
            });
            await button.click();
            await wait(
              page,
              (v) =>
                v.notice ===
                (kind === "gui"
                  ? "已接入，目录刷新失败；尚未新增数据访问权限。"
                  : "已接入，尚未新增数据访问权限。"),
            );
            r = await report(page);
            const p = params(calls(r, "install")[0]!);
            if (kind === "headless") assert.deepEqual(p, { definition });
            else {
              assert.match(String(p.commandId), /^[A-Za-z0-9_-]+$/);
              if (kind === "gui") {
                assert.deepEqual(p.definition, guiDefinition);
                assert.deepEqual(p.manifest, manifest);
              } else
                assert.deepEqual(
                  { ...p, commandId: "original" },
                  {
                    mode: "register-installed",
                    appId,
                    version: "1.0.0",
                    definitionHash: hash,
                    commandId: "original",
                  },
                );
            }
            assert.deepEqual(
              r.retryRecords,
              [],
              "only real acknowledged install clears retry metadata",
            );
            assert.equal(
              await page
                .getByRole("region", { name: "添加应用", exact: true })
                .getByRole("button", { name: "已接入", exact: true })
                .isDisabled(),
              true,
            );
            safe(r, errors, external, ["cognitive-apps.install"]);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "unknown install reuses original full-request ID; bad storage blocks sends; ACK cleanup failure stays visibly confirmed",
      async () => {
        const { page, errors, external } = await load();
        try {
          await page
            .getByRole("button", { name: "添加应用", exact: true })
            .click();
          await page
            .getByRole("button", { name: "登记已安装应用", exact: true })
            .click();
          await page
            .getByRole("textbox", { name: "应用标识", exact: true })
            .fill(appId);
          await page
            .getByRole("textbox", { name: "版本", exact: true })
            .fill("1.0.0");
          await page
            .getByRole("textbox", { name: "定义 SHA-256", exact: true })
            .fill(hash);
          await queued(page, "install", "unknown-install", false, true);
          await page
            .getByRole("button", { name: "登记应用", exact: true })
            .click();
          await wait(page, (r) =>
            r.notice.includes("CONTROLLED_MANAGEMENT_FAILURE"),
          );
          let r = await report(page);
          assert.equal(r.retryRecords.length, 1);
          const original = params(calls(r, "install")[0]!);
          const persisted = JSON.parse(r.retryRecords[0]!.bytes!);
          assert.deepEqual(Object.keys(persisted).sort(), [
            "commandId",
            "requestSha",
          ]);
          assert.equal(persisted.commandId, original.commandId);
          await action(page, "corruptRetry");
          await page
            .getByRole("button", { name: "登记应用", exact: true })
            .click();
          await wait(page, (v) => v.notice.includes("操作未完成"));
          assert.equal(
            calls(await report(page), "install").length,
            1,
            "stored JSON null is corrupt, not absence",
          );
          // Restore exactly the original persisted record in this isolated origin.
          await page.evaluate(
            ({ key, bytes }) => localStorage.setItem(key, bytes!),
            r.retryRecords[0]!,
          );
          await action(page, "failCleanup");
          await queued(page, "install", "retry-known");
          await page
            .getByRole("button", { name: "登记应用", exact: true })
            .click();
          await wait(
            page,
            (v) =>
              v.notice === "应用已安装，本机操作标识未能清理，请勿重复安装。",
          );
          r = await report(page);
          assert.deepEqual(params(calls(r, "install")[1]!), original);
          assert.equal(r.retryRecords.length, 1);
          assert.equal(
            await page
              .getByRole("region", { name: "添加应用", exact: true })
              .getByRole("button", { name: "已接入", exact: true })
              .isDisabled(),
            true,
          );
          safe(r, errors, external, ["cognitive-apps.install"]);
        } finally {
          await page.close();
        }
        const second = await load();
        try {
          await second.page
            .getByRole("button", { name: "添加应用", exact: true })
            .click();
          await second.page
            .getByRole("button", { name: "登记已安装应用", exact: true })
            .click();
          await second.page
            .getByRole("textbox", { name: "应用标识", exact: true })
            .fill(appId);
          await second.page
            .getByRole("textbox", { name: "版本", exact: true })
            .fill("1.0.0");
          await second.page
            .getByRole("textbox", { name: "定义 SHA-256", exact: true })
            .fill(hash);
          await action(second.page, "loseWindowOwner");
          await second.page
            .getByRole("button", { name: "登记应用", exact: true })
            .click();
          await wait(second.page, (r) => r.notice.includes("操作未完成"));
          safe(await report(second.page), second.errors, second.external, []);
        } finally {
          await second.page.close();
        }
      },
    );
    await t.test(
      "late preview cannot return after close, catalog disappearance or exact identity retirement",
      async () => {
        for (const retire of [
          "close",
          "gone",
          "csrfToken",
          "principalId",
          "centerId",
        ] as const) {
          const { page, errors, external } = await load();
          try {
            await select(page, "1.0.0", "retired-" + retire, true);
            await wait(page, (r) => r.held.length === 1);
            if (retire === "close")
              await page
                .getByRole("button", { name: "关闭应用管理", exact: true })
                .click();
            else if (retire === "gone") {
              await action(page, "removeSelected", "1.0.0");
              await wait(page, (r) => r.catalog.versions.length === 1);
            } else {
              const changed =
                retire === "centerId"
                  ? "22222222-2222-4222-8222-222222222222"
                  : "retired-" + retire;
              await action(page, "changeIdentity", retire, changed);
              await wait(page, (r) => r.boot?.[retire] === changed);
            }
            await action(page, "settle", 0);
            await page.waitForTimeout(50);
            let r = await report(page);
            assert.equal(r.preview, "");
            assert.equal(r.notice, "");
            assert.ok(
              r.cancelled.length >= 1,
              "actual transport receives cancellation even when late reply is still resolvable",
            );
            if (retire === "close") {
              assert.equal(
                await page.evaluate(() => document.activeElement?.id),
                "manager-trigger",
              );
              await page
                .getByRole("button", { name: "管理应用", exact: true })
                .click();
              assert.equal(
                (await report(page)).preview,
                "",
                "reopening never republishes late private preview",
              );
            }
            r = await report(page);
            safe(r, errors, external, ["cognitive-apps.describe"]);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "the same mounted component clears selected files and registration fields for every real identity tuple change",
      async () => {
        for (const field of ["centerId", "principalId", "csrfToken"] as const) {
          const { page, errors, external } = await load();
          try {
            await page
              .getByRole("button", { name: "添加应用", exact: true })
              .click();
            await file(
              page.getByLabel("应用定义 JSON", { exact: true }),
              "OLD_IDENTITY_definition.json",
              guiDefinition,
            );
            await page
              .getByRole("heading", { name: "界面笔记 1.0.0", exact: true })
              .waitFor();
            await file(
              page.getByLabel("界面包 JSON", { exact: true }),
              "OLD_IDENTITY_ui.json",
              manifest,
            );
            await page
              .getByText("OLD_IDENTITY_ui.json", { exact: true })
              .waitFor();
            await page
              .getByRole("button", { name: "登记已安装应用", exact: true })
              .click();
            await page
              .getByRole("textbox", { name: "应用标识", exact: true })
              .fill("example.old-identity");
            await page
              .getByRole("textbox", { name: "版本", exact: true })
              .fill("9.0.0");
            await page
              .getByRole("textbox", { name: "定义 SHA-256", exact: true })
              .fill(hash);
            const changed =
              field === "centerId"
                ? "33333333-3333-4333-8333-333333333333"
                : "new-" + field;
            await action(page, "changeIdentity", field, changed);
            await wait(page, (r) => r.boot?.[field] === changed);
            for (const name of ["应用标识", "版本", "定义 SHA-256"])
              assert.equal(
                await page
                  .getByRole("textbox", { name, exact: true })
                  .inputValue(),
                "",
              );
            assert.equal(
              await page
                .getByRole("button", { name: "登记应用", exact: true })
                .isDisabled(),
              true,
            );
            await page
              .getByRole("button", { name: "从文件安装", exact: true })
              .click();
            assert.equal(
              await page
                .getByRole("heading", { name: "界面笔记 1.0.0", exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page
                .getByText("OLD_IDENTITY_ui.json", { exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page
                .getByRole("button", { name: "安装应用", exact: true })
                .isDisabled(),
              true,
            );
            safe(await report(page), errors, external, []);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "a real File.arrayBuffer completing after identity retirement cannot restore or install the old carrier",
      async () => {
        const { page, errors, external } = await load();
        try {
          await page
            .getByRole("button", { name: "添加应用", exact: true })
            .click();
          await action(page, "holdFile");
          await file(
            page.getByLabel("应用定义 JSON", { exact: true }),
            "LATE_OLD_IDENTITY.json",
            guiDefinition,
          );
          await wait(page, (r) => r.fileReads === 1);
          await action(
            page,
            "changeIdentity",
            "csrfToken",
            "retired-file-session",
          );
          await wait(page, (r) => r.boot?.csrfToken === "retired-file-session");
          await action(page, "settleFile", 0);
          await page.waitForTimeout(40);
          assert.equal(
            await page
              .getByText("LATE_OLD_IDENTITY.json", { exact: true })
              .count(),
            0,
          );
          assert.equal(
            await page
              .getByRole("heading", { name: "界面笔记 1.0.0", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await page
              .getByRole("button", { name: "安装应用", exact: true })
              .isDisabled(),
            true,
          );
          safe(await report(page), errors, external, []);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "confirmed ACK survives real owner refresh failure and its 30-second deadline, never a second install",
      async () => {
        for (const kind of ["failure", "deadline"] as const) {
          const { page, errors, external } = await load();
          try {
            if (kind === "deadline") await page.clock.install();
            await select(page, "1.0.0", "ack-" + kind);
            await queued(page, "grant", "ack-before-refresh");
            await queued(
              page,
              "list",
              "refresh-" + kind,
              kind === "deadline",
              kind === "failure",
            );
            await page
              .getByRole("button", { name: "允许数据访问", exact: true })
              .click();
            if (kind === "deadline") {
              await wait(page, (r) =>
                r.held.some((h) => h.method === "cognitive-apps.list"),
              );
              await page.clock.fastForward(30001);
            }
            const r = await wait(
              page,
              (v) => v.notice === "已保存，目录刷新失败。",
            );
            assert.equal(calls(r, "grant").length, 1);
            assert.equal(calls(r, "install").length, 0);
            safe(r, errors, external, [
              "cognitive-apps.describe",
              "cognitive-apps.grant",
            ]);
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      "closing a dispatched write preserves its real ACK owner, draft and suppresses late UI publication",
      async () => {
        const { page, errors, external } = await load();
        try {
          await select(page, "1.0.0", "close-write");
          await queued(page, "grant", "late-write", true);
          await page
            .getByRole("button", { name: "允许数据访问", exact: true })
            .click();
          await wait(page, (r) => r.held.length === 1);
          const originalWrite = calls(await report(page), "grant")[0]!;
          assert.equal(
            await page
              .getByRole("button", { name: "添加应用", exact: true })
              .isDisabled(),
            true,
          );
          await page
            .getByRole("button", { name: "关闭应用管理", exact: true })
            .click();
          await action(page, "settle", 0);
          await page.waitForTimeout(30);
          const r = await report(page);
          assert.equal(r.notice, "");
          assert.equal(r.preview, "");
          assert.equal(calls(r, "grant").length, 1);
          assert.equal(
            r.cancelled.includes(originalWrite.id),
            false,
            "closing presentation is not cancellation of an already dispatched transaction",
          );
          safe(r, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.grant",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "real access revision clear conditionally unmounts the presentation but does not retire its acknowledged actual management Promise",
      async () => {
        const { page, errors, external } = await load();
        try {
          await action(page, "conditionalHost", true);
          await select(page, "1.0.0", "conditional-host");
          await queued(page, "grant", "own-access-clear");
          await queued(page, "list", "held-own-access-refresh", true);
          await page
            .getByRole("button", { name: "允许数据访问", exact: true })
            .click();
          const pending = await wait(
            page,
            (r) =>
              r.boot === null &&
              r.held.some((h) => h.method === "cognitive-apps.list"),
          );
          assert.equal(
            await page
              .getByRole("dialog", { name: "管理应用", exact: true })
              .count(),
            0,
          );
          assert.equal(pending.actualGrantRuns[0]?.state, "pending");
          const original = calls(pending, "grant")[0]!;
          assert.equal(pending.cancelled.includes(original.id), false);
          await action(
            page,
            "settle",
            pending.held.find((h) => h.method === "cognitive-apps.list")!.index,
          );
          const completed = await wait(
            page,
            (r) => !!r.boot && r.actualGrantRuns[0]?.state !== "pending",
          );
          assert.equal(
            completed.actualGrantRuns[0]?.state,
            "fulfilled",
            JSON.stringify(completed.actualGrantRuns),
          );
          assert.deepEqual(completed.actualGrantRuns[0]?.value, {
            value: {
              appId,
              version: "1.0.0",
              state: "active",
              revision: 1,
              consentedAt: "2026-10-05T00:00:00.000Z",
              updatedAt: "2026-10-05T00:00:00.000Z",
            },
            refreshed: true,
          });
          assert.equal(calls(completed, "grant").length, 1);
          safe(completed, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.grant",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "a known install ACK cleans only its original retry record even after presentation closes",
      async () => {
        const { page, errors, external } = await load();
        try {
          await page
            .getByRole("button", { name: "添加应用", exact: true })
            .click();
          await page
            .getByRole("button", { name: "登记已安装应用", exact: true })
            .click();
          await page
            .getByRole("textbox", { name: "应用标识", exact: true })
            .fill(appId);
          await page
            .getByRole("textbox", { name: "版本", exact: true })
            .fill("1.0.0");
          await page
            .getByRole("textbox", { name: "定义 SHA-256", exact: true })
            .fill(hash);
          await queued(page, "install", "closed-known-ACK", true);
          await page
            .getByRole("button", { name: "登记应用", exact: true })
            .click();
          await wait(
            page,
            (r) => r.held.length === 1 && r.retryRecords.length === 1,
          );
          const original = calls(await report(page), "install")[0]!;
          await page
            .getByRole("button", { name: "关闭应用管理", exact: true })
            .click();
          await action(page, "settle", 0);
          const r = await wait(page, (v) => v.retryRecords.length === 0);
          assert.equal(r.notice, "");
          assert.equal(r.cancelled.includes(original.id), false);
          assert.equal(calls(r, "install").length, 1);
          safe(r, errors, external, ["cognitive-apps.install"]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "actual Vite fixture entry replacement disposes its previous React root without clearing real same-window retry bytes",
      async () => {
        const { page, errors, external } = await load();
        try {
          await unknownConnect(page);
          const stored = (await report(page)).connectionRetryRecords;
          const module = server.moduleGraph.getModuleById(fixture);
          assert.ok(
            module,
            "the actual mounted TSX entry is in Vite's module graph",
          );
          await server.reloadModule(module);
          const replaced = await wait(
            page,
            (r) => r.entryEvidence.length === 2,
          );
          assert.equal(
            replaced.entryEvidence[1]?.existingChildren,
            0,
            "the retired root must unmount before the replacement creates one",
          );
          assert.deepEqual(
            replaced.connectionRetryRecords,
            stored,
            "development entry replacement does not clear durable attempts",
          );
          safe(replaced, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "original request and explicit forget risk remain readable and keyboard reachable in narrow and 200-percent modal geometry",
      async () => {
        const { page, errors, external } = await load();
        try {
          await unknownConnect(page);
          await page
            .getByRole("button", { name: "不再重试", exact: true })
            .click();
          for (const variant of [
            {
              name: "pending-wide-light",
              width: 1120,
              height: 800,
              zoom: 1,
              appearance: "light",
            },
            {
              name: "pending-narrow-light",
              width: 360,
              height: 640,
              zoom: 1,
              appearance: "light",
            },
            {
              name: "pending-zoom-dark",
              width: 1024,
              height: 768,
              zoom: 2,
              appearance: "dark",
            },
          ]) {
            await page.setViewportSize({
              width: variant.width,
              height: variant.height,
            });
            await page.evaluate(({ zoom, appearance }) => {
              document.documentElement.style.zoom = String(zoom);
              document.documentElement.dataset.appearance = appearance;
              window.dispatchEvent(new Event("resize"));
            }, variant);
            const geometry = await page.evaluate(() => {
              const d = document.querySelector("dialog")!,
                body = d.querySelector<HTMLElement>(
                  ".cognitive-app-manager-body",
                )!,
                rect = d.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                overflow: body.scrollWidth - body.clientWidth,
              };
            });
            assert.ok(
              geometry.left >= -1 &&
                geometry.right <= variant.width + 1 &&
                geometry.top >= -1 &&
                geometry.bottom <= variant.height + 1,
              JSON.stringify(geometry),
            );
            assert.ok(
              geometry.overflow <= 1,
              "full original opaque identifiers never horizontally overflow " +
                variant.name +
                JSON.stringify(geometry),
            );
            for (const name of [
              "按原请求重试",
              "确认放弃本机重试",
              "保留原记录",
            ]) {
              const button = page.getByRole("button", { name, exact: true });
              await button.scrollIntoViewIfNeeded();
              await button.focus();
              assert.equal(
                await button.evaluate(
                  (node) => document.activeElement === node,
                ),
                true,
              );
              const box = await button.boundingBox();
              assert.ok(
                box &&
                  box.x >= -1 &&
                  box.y >= -1 &&
                  box.x + box.width <= variant.width + 1 &&
                  box.y + box.height <= variant.height + 1,
                "risk action is actually visible: " + variant.name + " " + name,
              );
            }
            await page.screenshot({
              path: resolve(screenshots, variant.name + "-actions.png"),
            });
            await page
              .locator(".cognitive-app-manager-body")
              .evaluate((body) => (body.scrollTop = 0));
            await page.screenshot({
              path: resolve(screenshots, variant.name + ".png"),
            });
          }
          const r = await report(page);
          assert.equal(calls(r, "connect").length, 1);
          assert.equal(r.connectionRetryRecords.length, 1);
          safe(r, errors, external, [
            "cognitive-apps.describe",
            "cognitive-apps.connect",
          ]);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "native modal Tab/Escape/focus and wide/narrow/200-percent geometry keep key actions reachable; light/dark screenshots",
      async () => {
        const { page, errors, external } = await load();
        try {
          assert.equal(
            await page.evaluate(() => document.activeElement?.tagName),
            "H2",
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await page.evaluate(() =>
              document.activeElement?.getAttribute("aria-label"),
            ),
            "关闭应用管理",
          );
          await page.keyboard.press("Shift+Tab");
          assert.ok(
            await page.evaluate(
              () => !!document.activeElement?.closest("dialog"),
            ),
            "native modal keeps reverse Tab internal",
          );
          await page.keyboard.press("Escape");
          await page
            .getByRole("dialog", { name: "管理应用", exact: true })
            .waitFor({ state: "detached" });
          assert.equal(
            await page.evaluate(() => document.activeElement?.id),
            "manager-trigger",
          );
          await page
            .getByRole("button", { name: "管理应用", exact: true })
            .click();
          await select(page, "2.0.0", "layout");
          await page.locator(".cognitive-app-manager-connect summary").click();
          for (const variant of [
            {
              name: "wide-light",
              width: 1120,
              height: 800,
              zoom: 1,
              appearance: "light",
            },
            {
              name: "wide-dark",
              width: 1120,
              height: 800,
              zoom: 1,
              appearance: "dark",
            },
            {
              name: "narrow-light",
              width: 360,
              height: 640,
              zoom: 1,
              appearance: "light",
            },
            {
              name: "zoom-200-dark",
              width: 1024,
              height: 768,
              zoom: 2,
              appearance: "dark",
            },
          ]) {
            await page.setViewportSize({
              width: variant.width,
              height: variant.height,
            });
            await page.evaluate(({ zoom, appearance }) => {
              document.documentElement.style.zoom = String(zoom);
              document.documentElement.dataset.appearance = appearance;
              window.dispatchEvent(new Event("resize"));
            }, variant);
            await page.waitForTimeout(50);
            const geometry = await page.evaluate(() => {
              const d = document.querySelector<HTMLDialogElement>("dialog")!,
                body = d.querySelector<HTMLElement>(
                  ".cognitive-app-manager-body",
                )!;
              const box = d.getBoundingClientRect();
              return {
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
                width: window.innerWidth,
                height: window.innerHeight,
                workspaceWidth: document
                  .querySelector(".workspace")!
                  .getBoundingClientRect().width,
                dialogWidth: box.width,
                overflow: body.scrollWidth - body.clientWidth,
                scrollable: body.scrollHeight >= body.clientHeight,
              };
            });
            assert.ok(
              geometry.left >= -1 &&
                geometry.right <= geometry.width + 1 &&
                geometry.top >= -1 &&
                geometry.bottom <= geometry.height + 1,
              "actual dialog stays within viewport at " +
                variant.name +
                ": " +
                JSON.stringify(geometry),
            );
            assert.ok(
              geometry.overflow <= 1,
              "ordinary management controls do not horizontally overflow: " +
                JSON.stringify(geometry),
            );
            assert.ok(
              Math.abs(geometry.workspaceWidth - variant.width) <= 1,
              "fixture defines the actual full-width workspace, not an accidental empty sidebar column",
            );
            if (variant.name.startsWith("wide"))
              assert.ok(
                Math.abs(geometry.dialogWidth - 780) <= 1,
                "wide fixture exercises the real two-column 780px manager, not the narrow container branch",
              );
            assert.ok(geometry.scrollable);
            for (const name of ["允许数据访问", "停用连接", "建立连接"]) {
              const button = page.getByRole("button", { name, exact: true });
              await button.scrollIntoViewIfNeeded();
              const b = await button.boundingBox();
              assert.ok(
                b &&
                  b.x >= -1 &&
                  b.x + b.width <= variant.width + 1 &&
                  b.y >= -1 &&
                  b.y + b.height <= variant.height + 1,
                "key action scrolls into actual visible viewport: " +
                  variant.name +
                  " " +
                  name,
              );
            }
            await page
              .locator(".cognitive-app-manager-body")
              .evaluate((body) => (body.scrollTop = 0));
            await page.screenshot({
              path: resolve(screenshots, variant.name + ".png"),
            });
          }
          safe(await report(page), errors, external, [
            "cognitive-apps.describe",
          ]);
          t.diagnostic(
            "Rendered manager screenshots (controlled mounted UI, not native App): " +
              screenshots,
          );
        } finally {
          await page.close();
        }
      },
    );
  },
);
