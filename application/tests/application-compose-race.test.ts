import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, expect, type Page } from "@playwright/test";

// Real ApplicationHost + its opaque SandboxApplication iframe in StrictMode.
// Only the WorkspaceClient reads and the consumer callback are fixtures; no
// original Host/center/model is accessed and no old dist is loaded.
const fixtureModule = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApplicationHost } from '/src/ApplicationHost.tsx';
const app = { format: 'morphz-app/v1', id: 'fixture.compose', version: '1.0.0', title: 'Compose fixture', description: '', icon: 'document', permissions: ['artifacts.read', 'input.compose'], harness: null, ui: { type: 'sandbox', html: 'fixture' }, installedBy: 'human-A' };
const instance = { id: 'instance', workspaceId: 'project', applicationId: app.id, applicationVersion: app.version, revision: 1, state: {}, status: 'open', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
const otherInstance = { ...instance, id: 'other-instance', workspaceId: 'other-project' };
const artifact = { id: 'artifact', projectId: 'project', title: '目标对象', revision: 9, versions: [], content: { kind: 'document', body: '' } };
let hold = false;
let release: (() => void) | undefined;
let control: (action: string) => void;
let current: any;
let callbacks: any[] = [];
let resolvedReads = 0;
const client: any = { boot: { centerId: 'center-A', principalId: 'human-A', actantId: 'human-A', csrfToken: 'identity-A', workspace: { revision: 1, projects: [{ id: 'project', title: 'TEST', kind: 'project' }, { id: 'other-project', title: 'OTHER TEST', kind: 'project' }], applicationInstances: [instance, otherInstance], applications: [app], artifacts: [artifact], scriptProductions: [] } }, contentCatalog: [], async resolveArtifact(id: string) { if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); } resolvedReads++; return id === artifact.id ? artifact : null; }, async execute() { throw new Error('No fixture writes or sends'); } };
function Fixture() {
  const [state, setState] = useState({ body: '读取前正文', model: 'old-route', effort: 'low', active: true, mounted: true, workspace: 'project', navigation: 1, reject: false, sequence: 0 });
  current = state;
  control = action => {
    if (action === 'hold') { hold = true; return; }
    if (action === 'release') { if (!release) throw new Error('No held read'); const resolve = release; release = undefined; resolve(); return; }
    if (action === 'edit') setState(s => ({ ...s, body: '读取中最新正文', model: 'new-route', effort: 'max', sequence: s.sequence + 1 }));
    else if (action === 'reject') setState(s => ({ ...s, reject: true, sequence: s.sequence + 1 }));
    else if (action === 'inactive') setState(s => ({ ...s, active: false, sequence: s.sequence + 1 }));
    else if (action === 'navigate-aba') setState(s => ({ ...s, navigation: s.navigation + 2, sequence: s.sequence + 1 }));
    else if (action === 'unmount') setState(s => ({ ...s, mounted: false, sequence: s.sequence + 1 }));
    else if (action === 'workspace') setState(s => ({ ...s, workspace: 'other-project', navigation: s.navigation + 1, sequence: s.sequence + 1 }));
    else if (action === 'wrapper') setState(s => ({ ...s, sequence: s.sequence + 1 }));
    else if (action === 'identity') { client.boot = { ...client.boot, principalId: 'human-B', csrfToken: 'identity-B' }; setState(s => ({ ...s, sequence: s.sequence + 1 })); }
    else if (action === 'identity-generation') { client.boot = { ...client.boot, csrfToken: 'identity-A-new-generation' }; setState(s => ({ ...s, sequence: s.sequence + 1 })); }
  };
  const onCompose = (text: string) => {
    callbacks.push({ body: state.body, model: state.model, effort: state.effort, rejected: state.reject });
    if (state.reject) return { ok: false, error: '原输入绑定了补充请求，请先处理原请求。' };
    setState(s => ({ ...s, body: [state.body, text].filter(Boolean).join('\\n'), model: state.model, effort: state.effort, sequence: s.sequence + 1 }));
    return { ok: true };
  };
  // useWorkspace returns a fresh wrapper each render; identity is not object ref.
  const renderedClient = { ...client };
  return state.mounted ? <ApplicationHost client={renderedClient} workspaceId={state.workspace} activeId={state.workspace === 'project' ? 'instance' : 'other-instance'} navigationId={state.navigation} foreground={state.active} toolbarTarget={null} applicationActions={{activate() {}, launch() { throw new Error('No fixture writes or sends'); }, close() { throw new Error('No fixture writes or sends'); }}} onOpen={() => {}} onCompose={onCompose} onNotice={() => {}} renderBuiltin={({ fallback }) => fallback} onOpenRecent={() => {}}><span>fixture</span></ApplicationHost> : <span>unmounted</span>;
}
Object.assign(window, { composeFixture: { run(action: string) { control(action); }, report() { return { ...current, held: Boolean(release), resolvedReads, callbacks: structuredClone(callbacks) }; } } });
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
`;

const frameHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><button id="compose" disabled>准备输入</button><script>
let channel; const pending = new Map(); window.ready = false;
window.handshake = { initializations: 0, readyRequests: 0, responses: 0 };
window.composeInput = { clicks: 0, trusted: 0, reply: null };
window.request = request => new Promise(resolve => { const requestId = crypto.randomUUID(); pending.set(requestId, resolve); parent.postMessage({ type: 'morphz-app:request', channel, requestId, request }, '*'); });
document.getElementById('compose').onclick = async event => { window.composeInput.clicks++; if (event.isTrusted) window.composeInput.trusted++; window.composeInput.reply = await window.request({ method: 'compose', text: '鼠标追加' }); };
window.addEventListener('message', async event => {
 if (event.source !== parent) return;
 if (event.data.type === 'morphz-app:init') { window.handshake.initializations++; if (!channel) { channel = event.data.channel; window.handshake.readyRequests++; const reply = await window.request({ method: 'ready' }); window.ready = !reply.error; document.getElementById('compose').disabled = !window.ready; } return; }
 if (event.data.type === 'morphz-app:response' && event.data.channel === channel) { window.handshake.responses++; const resolve = pending.get(event.data.requestId); if (resolve) { pending.delete(event.data.requestId); resolve(event.data); } }
});
</script></body></html>`;
type Report = {
  body: string;
  model: string;
  effort: string;
  held: boolean;
  sequence: number;
  callbacks: { rejected: boolean }[];
};
const report = (page: Page) =>
  page.evaluate(() =>
    (window as any).composeFixture.report(),
  ) as Promise<Report>;
const run = (page: Page, action: string) =>
  page.evaluate((value) => (window as any).composeFixture.run(value), action);
const browserExecutable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;

test(
  "真实 Sandbox compose 桥保留最新回调、精确范围，并返回真实拒绝",
  {
    // Independent real-browser cases share setup, not a single short
    // readiness deadline. An unready frame must fail its own bounded probe
    // with evidence before cleanup closes the browser for all later cases.
    timeout: 150000,
    skip:
      !browserExecutable && !existsSync(chromium.executablePath())
        ? "No matching Playwright browser"
        : false,
  },
  async (context) => {
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      plugins: [
        react(),
        {
          name: "application-compose-isolated",
          resolveId(id) {
            if (id === "/__compose-fixture.tsx") return "\0compose-fixture.tsx";
          },
          async load(id) {
            if (id === "\0compose-fixture.tsx")
              return transformWithOxc(fixtureModule, "compose-fixture.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.startsWith("/api/application-view/")) {
                response.setHeader("Content-Type", "text/html");
                response.end(frameHtml);
                return;
              }
              if (request.url !== "/__compose-fixture") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<html><body><div id="root"></div><script type="module" src="/__compose-fixture.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
      logLevel: "error",
    });
    context.after(() => server.close());
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable || undefined,
    });
    context.after(() => browser.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__compose-fixture`;
    async function fixture({ holdPaint = false } = {}) {
      const page = await browser.newPage();
      const errors: string[] = [];
      const signals: { kind: string; value: string }[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("framenavigated", (frame) =>
        signals.push({ kind: "navigation", value: frame.url() }),
      );
      page.on("console", (message) => {
        if (message.type() === "error" || message.text().includes("[vite]"))
          signals.push({ kind: "console", value: message.text() });
      });
      try {
        if (holdPaint)
          await page.addInitScript(() => {
            if (window !== window.top) return;
            // Model a non-painting host without replacing its DOM, iframe,
            // postMessage transport or React lifecycle. Messaging must not
            // depend on whether the compositor offers an animation frame.
            const request = window.requestAnimationFrame.bind(window);
            const cancel = window.cancelAnimationFrame.bind(window);
            const pending = new Map<number, FrameRequestCallback>();
            const state = {
              requested: 0,
              delivered: 0,
              released: false,
              presented: false,
            };
            window.requestAnimationFrame = (callback) => {
              const id = ++state.requested;
              pending.set(id, callback);
              return id;
            };
            window.cancelAnimationFrame = (id) => {
              pending.delete(id);
            };
            Object.assign(window, {
              fixturePaint: {
                state,
                async release() {
                  state.released = true;
                  window.requestAnimationFrame = request;
                  window.cancelAnimationFrame = cancel;
                  for (const callback of pending.values())
                    request((time) => {
                      state.delivered++;
                      callback(time);
                    });
                  pending.clear();
                  // Logical handshake readiness is deliberately checked before
                  // any host frame. Physical input must wait until painting
                  // has really resumed, not merely until RAF was reassigned.
                  await new Promise<void>((resolve) =>
                    request(() => request(() => resolve())),
                  );
                  state.presented = true;
                },
              },
            });
          });
        await page.goto(url);
        const frame = page.frameLocator(
          'iframe[title="Compose fixture应用界面"]',
        );
        await expect
          .poll(
            () =>
              frame.locator("body").evaluate(() => ({
                ready: (window as any).ready === true,
                handshake: (window as any).handshake,
              })),
            {
              timeout: 12_000,
              message: "actual isolated iframe ready handshake",
            },
          )
          .toMatchObject({ ready: true });
        return { page, frame, errors, signals };
      } catch (error) {
        console.error(
          "[compose fixture readiness]",
          JSON.stringify({
            errors,
            frames: await Promise.all(
              page.frames().map(async (frame) => ({
                url: frame.url(),
                detached: frame.isDetached(),
                state: await frame
                  .evaluate(() => ({
                    readyState: document.readyState,
                    ready: (window as any).ready === true,
                    handshake: (window as any).handshake ?? null,
                  }))
                  .catch(() => null),
              })),
            ),
            host: await page
              .evaluate(() => ({
                readyState: document.readyState,
                visibility: document.visibilityState,
                report: (window as any).composeFixture?.report(),
                paint: (window as any).fixturePaint?.state,
              }))
              .catch(() => null),
          }),
        );
        await page.close();
        throw error;
      }
    }
    await context.test(
      "宿主没有绘制帧时仍完成真实握手，恢复绘制后单击可准备输入",
      async () => {
        const { page, frame, errors, signals } = await fixture({
          holdPaint: true,
        });
        try {
          assert.deepEqual(
            await page.evaluate(() => ({
              delivered: (window as any).fixturePaint.state.delivered,
              released: (window as any).fixturePaint.state.released,
              presented: (window as any).fixturePaint.state.presented,
            })),
            { delivered: 0, released: false, presented: false },
          );
          assert.equal((await report(page)).callbacks.length, 0);
          await page.evaluate(() => (window as any).fixturePaint.release());
          assert.equal(
            await page.evaluate(
              () => (window as any).fixturePaint.state.presented,
            ),
            true,
          );
          const button = frame.getByRole("button", { name: "准备输入" });
          await expect(button).toBeEnabled();
          // Opaque iframes have a separate hit-test surface. Observe its actual
          // presented pixels before the one real mouse click; no forced or
          // repeated click can stand in for a delivered user action.
          await button.screenshot();
          await button.click();
          await expect
            .poll(async () => (await report(page)).body)
            .toBe("读取前正文\n鼠标追加");
          assert.equal((await report(page)).callbacks.length, 1);
          assert.deepEqual(
            await frame.locator("body").evaluate(() => ({
              clicks: (window as any).composeInput.clicks,
              trusted: (window as any).composeInput.trusted,
            })),
            { clicks: 1, trusted: 1 },
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          const details = {
            host: await report(page).catch(() => null),
            frame: await frame
              .locator("body")
              .evaluate(() => ({
                ready: (window as any).ready,
                handshake: (window as any).handshake,
                input: (window as any).composeInput,
              }))
              .catch(() => null),
            paint: await page
              .evaluate(() => (window as any).fixturePaint?.state)
              .catch(() => null),
            errors,
            signals,
          };
          console.error(
            "[compose paint/click failure]",
            JSON.stringify(details),
          );
          try {
            mkdirSync("test-results", { recursive: true });
            const directory = mkdtempSync(
              "test-results/compose-paint-failure-",
            );
            writeFileSync(
              `${directory}/state.json`,
              JSON.stringify(details, null, 2),
            );
            await page.screenshot({ path: `${directory}/window.png` });
          } catch (captureError) {
            console.error(
              "Compose failure evidence could not be captured",
              captureError,
            );
          }
          throw error;
        } finally {
          await page.close();
        }
      },
    );
    await context.test(
      "对象读取期间编辑正文和最高推理，不被旧 onCompose 回滚",
      async () => {
        const { page, frame, errors } = await fixture();
        try {
          await run(page, "hold");
          const response = frame.locator("body").evaluate(() =>
            (window as any).request({
              method: "compose",
              artifactId: "artifact",
              text: "应用追加",
            }),
          );
          await page.waitForFunction(
            () => (window as any).composeFixture.report().held,
          );
          await run(page, "edit");
          await page.waitForFunction(
            () => (window as any).composeFixture.report().effort === "max",
          );
          await run(page, "release");
          assert.equal((await response).error, undefined);
          await page.waitForFunction(
            () =>
              (window as any).composeFixture.report().callbacks.length === 1,
          );
          const actual = await report(page);
          assert.equal(actual.body, "读取中最新正文\n应用追加");
          assert.equal(actual.model, "new-route");
          assert.equal(actual.effort, "max");
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
    await context.test(
      "消费端拒绝专用请求时 iframe 收到 error 而非假成功",
      async () => {
        const { page, frame, errors } = await fixture();
        try {
          await run(page, "reject");
          await page.waitForFunction(
            () => (window as any).composeFixture.report().reject,
          );
          const before = await report(page);
          const response = await frame.locator("body").evaluate(() =>
            (window as any).request({
              method: "compose",
              artifactId: "artifact",
              text: "不应追加",
            }),
          );
          assert.match(response.error ?? "", /原请求/);
          const actual = await report(page);
          assert.equal(actual.body, before.body);
          assert.equal(actual.callbacks.length, 1);
          assert.equal(actual.callbacks[0]!.rejected, true);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
    for (const action of [
      "inactive",
      "navigate-aba",
      "identity",
      "identity-generation",
    ])
      await context.test(`迟到读取后 ${action} 不得写入新范围`, async () => {
        const { page, frame, errors } = await fixture();
        try {
          await run(page, "hold");
          const response = frame.locator("body").evaluate(() =>
            (window as any).request({
              method: "compose",
              artifactId: "artifact",
              text: "旧范围文字",
            }),
          );
          await page.waitForFunction(
            () => (window as any).composeFixture.report().held,
          );
          await run(page, action);
          await page.waitForFunction(
            () => (window as any).composeFixture.report().sequence === 1,
          );
          await run(page, "release");
          assert.match((await response).error ?? "", /激活|范围|身份|切换/);
          assert.equal((await report(page)).callbacks.length, 0);
          assert.equal((await report(page)).body, "读取前正文");
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    await context.test(
      "同身份正常重建 client wrapper 不误拒合法 compose",
      async () => {
        const { page, frame, errors } = await fixture();
        try {
          await run(page, "hold");
          const response = frame.locator("body").evaluate(() =>
            (window as any).request({
              method: "compose",
              artifactId: "artifact",
              text: "合法追加",
            }),
          );
          await page.waitForFunction(
            () => (window as any).composeFixture.report().held,
          );
          await run(page, "wrapper");
          await page.waitForFunction(
            () => (window as any).composeFixture.report().sequence === 1,
          );
          await run(page, "release");
          assert.equal((await response).error, undefined);
          await page.waitForFunction(
            () =>
              (window as any).composeFixture.report().body ===
              "读取前正文\n合法追加",
          );
          assert.equal((await report(page)).callbacks.length, 1);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
    for (const action of ["unmount", "workspace"])
      await context.test(
        `真实 ${action} 后旧 iframe 的迟到读取不能提交`,
        async () => {
          const { page, frame, errors } = await fixture();
          try {
            await run(page, "hold");
            // A detached opaque frame cannot receive an ACK. Handle destruction
            // while independently asserting no consumer callback ran.
            const response = frame
              .locator("body")
              .evaluate(() =>
                (window as any).request({
                  method: "compose",
                  artifactId: "artifact",
                  text: "已卸载应用文字",
                }),
              )
              .then(
                () => ({ detached: false }),
                () => ({ detached: true }),
              );
            await page.waitForFunction(
              () => (window as any).composeFixture.report().held,
            );
            await run(page, action);
            await page.waitForFunction(
              () => (window as any).composeFixture.report().sequence === 1,
            );
            assert.equal((await response).detached, true);
            await run(page, "release");
            await page.waitForFunction(
              () => (window as any).composeFixture.report().resolvedReads === 1,
            );
            const actual = await report(page);
            assert.equal(actual.callbacks.length, 0);
            assert.equal(actual.body, "读取前正文");
            assert.equal(actual.model, "old-route");
            assert.equal(actual.effort, "low");
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        },
      );
  },
);
