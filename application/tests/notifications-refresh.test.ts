import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";

// This mounts the actual React components and refresh-drain. The scoped RPC
// authority below is a fixture, not real SQL/Host/SSE acceptance (covered by the
// separately run notification spec). No input is submitted and no model runs.
const fixtureModule = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Notifications, NotificationPreferences } from '/src/Notifications.tsx';
import { RequestError } from '/src/client.ts';
let actor = 'A', authority = 'A', revision = 0, mounted = true, preferences = false, remount = 0;
let visibility = 'visible', holdRead = false, releaseRead, holdVerify = false, releaseVerify;
let failReceipts = 0, failSettings = 0, failRead = false;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const ids = { A: 'a'.repeat(64), B: 'b'.repeat(64) };
const heads = Object.fromEntries(['A','B'].map(id => [id, { mode: 'all', revision: 0, unread: 1, items: [{ id: ids[id], artifactId: 'task-' + id, title: 'Notification ' + id, reason: 'Needs participation', read: false }] }]));
const calls = [], navigations = [], publications = [];
new MutationObserver(() => publications.push(document.body.textContent)).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true });
const root = createRoot(document.getElementById('root'));
function clientFor(id) {
 return { boot: { centerId: 'test-center', principalId: 'human-' + id, csrfToken: 'generation-' + id }, online: true, workspaceChangeRevision: revision,
   async notifications(command) {
     calls.push({ actor: id, kind: command ? command.action : 'read', command: structuredClone(command) });
     if (id !== authority) throw new RequestError(403, 'Old identity revoked');
     if (!command) {
       if (failRead) throw new RequestError(503, 'Read unavailable');
       const snapshot = structuredClone(heads[id]);
       if (holdRead) { holdRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
       return snapshot;
     }
     if (command.action === 'read' && failReceipts-- > 0) throw new RequestError(503, 'Unknown receipt');
     if (command.action === 'settings' && failSettings-- > 0) throw new RequestError(503, 'Unknown setting receipt');
     if (command.expectedRevision !== heads[id].revision) throw new RequestError(409, 'Revision conflict');
     if (command.action === 'read') { for (const item of heads[id].items) if (command.ids.includes(item.id)) item.read = true; }
     else heads[id].mode = command.mode;
     heads[id].revision++;
     heads[id].unread = heads[id].mode === 'all' ? heads[id].items.filter(item => !item.read).length : 0;
     return structuredClone(heads[id]);
   },
   async verifyArtifact(id) {
     calls.push({ actor: id, kind: 'verify' });
     if (holdVerify) { holdVerify = false; await new Promise(resolve => { releaseVerify = resolve; }); }
     if (id !== 'task-' + authority) throw new RequestError(403, 'Old identity revoked');
   }
 };
}
const busy = () => {};
function render() { flushSync(() => root.render(mounted ? preferences ? <NotificationPreferences key={remount} client={clientFor(actor)} onBusy={busy}/> : <Notifications key={remount} client={clientFor(actor)} onOpen={id => navigations.push(id)} onSettings={() => { preferences = true; render(); }}/> : null)); }
window.notificationRefreshFixture = {
 report: () => ({ calls: structuredClone(calls), navigations: [...navigations], heads: structuredClone(heads), publications: [...publications], body: document.body.textContent }),
 mutate: (title, mode = 'all') => { heads[actor].items[0].title = title; heads[actor].mode = mode; heads[actor].revision++; heads[actor].unread = mode === 'all' && !heads[actor].items[0].read ? 1 : 0; },
 bump: () => { revision++; render(); },
 burst: () => { for(let i = 0; i < 100; i++) window.dispatchEvent(new Event('morphz:notifications-changed')); },
 hold: () => { holdRead = true; }, release: () => releaseRead?.(),
 hide: () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
 show: () => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); },
 focus: () => window.dispatchEvent(new Event('focus')),
 unmount: () => { mounted = false; render(); },
 switch: () => { authority = actor = 'B'; revision++; render(); },
 queue: (failures) => { localStorage.setItem('morphz:test-center:human-' + actor + ':notification-reads', JSON.stringify([ids[actor]])); failReceipts = failures; remount++; render(); },
 settleReceipts: () => { failReceipts = 0; },
 prefs: () => { preferences = true; render(); },
 failSettings: () => { failSettings = 1; },
 failRead: (failed) => { failRead = failed; },
 holdVerify: () => { holdVerify = true; }, releaseVerify: () => releaseVerify?.(),
};
render();
`;

type Call = {
  actor: string;
  kind: string;
  command?: { commandId: string; expectedRevision: number; ids?: string[] };
};
type Report = {
  calls: Call[];
  navigations: string[];
  publications: string[];
  body: string;
};
async function report(page: Page): Promise<Report> {
  return page.evaluate(() =>
    Reflect.get(window, "notificationRefreshFixture").report(),
  );
}
async function action(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(
    ({ name, args }) =>
      Reflect.get(window, "notificationRefreshFixture")[name](...args),
    { name, args },
  );
}
async function readCount(page: Page, expected: number) {
  await page.waitForFunction(
    (expected) =>
      Reflect.get(window, "notificationRefreshFixture")
        .report()
        .calls.filter((call: Call) => call.kind === "read").length === expected,
    expected,
  );
}

const browserExecutable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
test(
  "Notification mounted production refresh lifecycle",
  {
    timeout: 60_000,
    skip:
      !browserExecutable && !existsSync(chromium.executablePath())
        ? "Set MORPHZ_TEST_BROWSER_EXECUTABLE for the actual React/browser fixture"
        : false,
  },
  async (context) => {
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      plugins: [
        react(),
        {
          name: "notifications-refresh-isolated-components",
          resolveId(id) {
            if (id === "/__notifications-refresh.tsx")
              return "\0notifications-refresh.tsx";
          },
          async load(id) {
            if (id === "\0notifications-refresh.tsx")
              return transformWithOxc(
                fixtureModule,
                "notifications-refresh.tsx",
              );
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__notifications-refresh") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<html><body><div id="root"></div><script type="module" src="/__notifications-refresh.tsx"></script></body></html>',
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
    async function open() {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.clock.install();
      await page.goto(
        `http://127.0.0.1:${(address as { port: number }).port}/__notifications-refresh`,
      );
      await readCount(page, 1);
      await page.getByRole("button", { name: "通知，1 项未读" }).waitFor();
      return { page, errors };
    }
    async function scenario(name: string, run: (page: Page) => Promise<void>) {
      await context.test(name, async () => {
        const { page, errors } = await open();
        try {
          await run(page);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }

    await scenario(
      "initial read then healthy 30 seconds produces no repeated requests; open is explicit reconciliation",
      async (page) => {
        await page.clock.runFor(30_000);
        assert.equal((await report(page)).calls.length, 1);
        await page.getByRole("button", { name: "通知，1 项未读" }).click();
        await readCount(page, 2);
        await page.getByRole("button", { name: /Notification A/ }).waitFor();
      },
    );
    await scenario(
      "a synchronous burst performs one read, with no periodic tail",
      async (page) => {
        await action(page, "mutate", "Burst final");
        await action(page, "burst");
        await readCount(page, 2);
        await page.clock.runFor(30_000);
        assert.equal((await report(page)).calls.length, 2);
      },
    );
    await scenario(
      "a revision arriving during a held read gets a final reread and never publishes the stale title",
      async (page) => {
        await page.getByRole("button", { name: "通知，1 项未读" }).click();
        await readCount(page, 2);
        await action(page, "hold");
        await action(page, "mutate", "Stale intermediate");
        await action(page, "bump");
        await readCount(page, 3);
        await action(page, "mutate", "Latest committed title");
        await action(page, "bump");
        await action(page, "release");
        await page
          .getByRole("button", { name: /Latest committed title/ })
          .waitFor();
        assert.equal((await report(page)).calls.length, 4);
        assert.ok(
          (await report(page)).publications.every(
            (text) => !text?.includes("Stale intermediate"),
          ),
        );
      },
    );
    await scenario(
      "hidden revisions produce no reads, foreground and focus reconcile missed hints without a loop",
      async (page) => {
        await action(page, "hide");
        await action(page, "mutate", "Changed while hidden");
        await action(page, "bump");
        await action(page, "burst");
        await page.clock.runFor(30_000);
        assert.equal((await report(page)).calls.length, 1);
        await action(page, "show");
        await readCount(page, 2);
        await action(page, "mutate", "Hint was missed");
        await action(page, "focus");
        await readCount(page, 3);
        await page.clock.runFor(30_000);
        assert.equal((await report(page)).calls.length, 3);
      },
    );
    await scenario(
      "unmount cancels listeners and cannot publish or replay a held pending read receipt",
      async (page) => {
        await action(page, "hold");
        await action(page, "queue", 0);
        await readCount(page, 2);
        await action(page, "unmount");
        await action(page, "release");
        await action(page, "focus");
        await action(page, "burst");
        await page.clock.runFor(30_000);
        assert.equal((await report(page)).calls.length, 2);
        assert.equal((await report(page)).body, "");
        assert.equal(
          await page.evaluate(
            () =>
              JSON.parse(
                localStorage.getItem(
                  "morphz:test-center:human-A:notification-reads",
                )!,
              )[0],
          ),
          "a".repeat(64),
        );
      },
    );
    await scenario(
      "rekeying identity prevents old held snapshots and pending commands from leaking into B",
      async (page) => {
        await action(page, "hold");
        await action(page, "queue", 0);
        await readCount(page, 2);
        await action(page, "switch");
        await readCount(page, 3);
        await action(page, "release");
        await page.clock.runFor(30_000);
        assert.deepEqual(
          (await report(page)).calls.map((call) => [call.actor, call.kind]),
          [
            ["A", "read"],
            ["A", "read"],
            ["B", "read"],
          ],
        );
        await page.getByRole("button", { name: "通知，1 项未读" }).click();
        await page.getByRole("button", { name: /Notification B/ }).waitFor();
        assert.ok(!(await report(page)).body.includes("Notification A"));
      },
    );
    await scenario(
      "unknown read acknowledgement has exactly two same-command retries then stops; explicit retry reuses the frozen receipt",
      async (page) => {
        await action(page, "queue", 20);
        await page.waitForFunction(() =>
          Reflect.get(window, "notificationRefreshFixture")
            .report()
            .calls.some((call: Call) => call.kind === "read" && call.command),
        );
        await page.clock.runFor(4_000);
        const first = (await report(page)).calls.filter((call) => call.command);
        assert.equal(first.length, 3);
        assert.equal(
          new Set(first.map((call) => call.command!.commandId)).size,
          1,
        );
        assert.equal(
          new Set(first.map((call) => call.command!.expectedRevision)).size,
          1,
        );
        const settled = (await report(page)).calls.length;
        await page.clock.runFor(30_000);
        assert.equal((await report(page)).calls.length, settled);
        await page.getByRole("button", { name: "通知", exact: true }).click();
        await page
          .getByRole("button", { name: "重试同步", exact: true })
          .waitFor();
        await action(page, "settleReceipts");
        await page
          .getByRole("button", { name: "重试同步", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            JSON.parse(
              localStorage.getItem(
                "morphz:test-center:human-A:notification-reads",
              ) ?? "null",
            )?.length === 0,
        );
        const allReceipts = (await report(page)).calls.filter(
          (call) => call.command,
        );
        assert.equal(
          new Set(allReceipts.map((call) => call.command!.commandId)).size,
          1,
        );
        assert.equal(
          new Set(allReceipts.map((call) => call.command!.expectedRevision))
            .size,
          1,
        );
        assert.equal(allReceipts.length, 5);
        await page.clock.runFor(30_000);
        assert.equal(
          (await report(page)).calls.filter((call) => call.command).length,
          5,
        );
      },
    );
    await scenario(
      "a read completing after hide cannot send a new read receipt; foreground reconciles it once",
      async (page) => {
        await action(page, "hold");
        await action(page, "queue", 0);
        await readCount(page, 2);
        await action(page, "hide");
        await action(page, "release");
        await page.clock.runFor(30_000);
        assert.equal(
          (await report(page)).calls.filter((call) => call.command).length,
          0,
        );
        await action(page, "show");
        await page.waitForFunction(
          () =>
            JSON.parse(
              localStorage.getItem(
                "morphz:test-center:human-A:notification-reads",
              ) ?? "null",
            )?.length === 0,
        );
        assert.equal(
          (await report(page)).calls.filter((call) => call.command).length,
          1,
        );
      },
    );
    await scenario(
      "a delayed permission check after identity replacement cannot navigate or save an old read intent",
      async (page) => {
        await page.getByRole("button", { name: "通知，1 项未读" }).click();
        await page.getByRole("button", { name: /Notification A/ }).waitFor();
        await action(page, "holdVerify");
        await page.getByRole("button", { name: /Notification A/ }).click();
        await action(page, "switch");
        await action(page, "releaseVerify");
        await page.clock.runFor(30_000);
        assert.deepEqual((await report(page)).navigations, []);
        assert.equal(
          (await report(page)).calls.filter((call) => call.command).length,
          0,
        );
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem(
              "morphz:test-center:human-A:notification-reads",
            ),
          ),
          null,
        );
      },
    );
    await scenario(
      "notification preferences consume external revisions and preserve unknown-save error and command identity on retry",
      async (page) => {
        await action(page, "prefs");
        await readCount(page, 2);
        await action(page, "mutate", "External setting", "off");
        await action(page, "bump");
        await page
          .getByRole("radio", { name: "不提示", exact: true })
          .waitFor();
        await page.waitForFunction(
          () =>
            (document.querySelector('input[value="off"]') as HTMLInputElement)
              ?.checked,
        );
        await action(page, "failSettings");
        await page
          .getByRole("radio", { name: "全部提醒", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "通知设置未确认保存" })
          .waitFor();
        await readCount(page, 4);
        assert.match((await report(page)).body, /通知设置未确认保存/);
        await page
          .getByRole("radio", { name: "全部提醒", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            (document.querySelector('input[value="all"]') as HTMLInputElement)
              ?.checked,
        );
        const commands = (await report(page)).calls.filter(
          (call) => call.kind === "settings",
        );
        assert.equal(commands.length, 2);
        assert.equal(
          commands[0]!.command!.commandId,
          commands[1]!.command!.commandId,
        );
      },
    );
  },
);
