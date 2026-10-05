import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "vite";

async function action(
  page: Page,
  name: string,
  ...args: unknown[]
): Promise<any> {
  await page.evaluate(
    ({ name, args }) =>
      Reflect.get(window, "cognitiveViewFixture")[name](...args),
    { name, args },
  );
  return page.evaluate(() =>
    Reflect.get(window, "cognitiveViewFixture").report(),
  );
}
async function report(page: Page): Promise<any> {
  return page.evaluate(() =>
    Reflect.get(window, "cognitiveViewFixture").report(),
  );
}
async function waitPending(page: Page, method: string) {
  await page.waitForFunction(
    (method) =>
      Reflect.get(window, "cognitiveViewFixture")
        .report()
        .pending.some(
          (p: any) =>
            p.method === "cognitive-app-views." + method &&
            !p.done &&
            !p.aborted,
        ),
    method,
  );
  const state = await report(page);
  return state.pending.find(
    (p: any) =>
      p.method === "cognitive-app-views." + method && !p.done && !p.aborted,
  ).index;
}
async function ready(page: Page, label = "PRIVATE_INITIAL") {
  await action(page, "settle", await waitPending(page, "locate"));
  await action(
    page,
    "settle",
    await waitPending(page, "read-ui"),
    "ready",
    label,
  );
  await page.waitForFunction(
    () =>
      Reflect.get(window, "cognitiveViewFixture").report().state?.status ===
      "ready",
  );
  return report(page);
}
test(
  "real React StrictMode read-only view owner with controlled Human ports, not SQL/HPA/production App acceptance",
  { timeout: 90_000 },
  async (t) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "formal entry must prepare real Chromium",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-view-owner-vite-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixture = resolve("tests/fixtures/cognitive-view-owner-mounted.tsx");
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "controlled-view-owner-mounted",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__view-owner") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url!,
                  `<!doctype html><html><head><link rel="icon" href="data:,"/></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    t.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [],
      forbiddenRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/"))
        forbiddenRequests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__view-owner`);
    await page.waitForSelector("#state");

    await t.test(
      "valid view positions do not call or block the original reader; null is idle without reads",
      async () => {
        let state = await ready(page);
        assert.equal(state.state.originalRequested, false);
        assert.equal(state.state.originalBlocked, false);
        assert.deepEqual(state.originalCalls, []);
        state = await action(page, "reset", { location: null });
        assert.equal(state.state.status, "idle");
        assert.equal(state.state.blocked, false);
        assert.equal(state.pending.length, 0);
        assert.deepEqual(state.originalCalls, []);
      },
    );
    await t.test(
      "absent/closed/unbound restore does no UI read or mutation and keeps original local bytes",
      async () => {
        for (const status of ["absent", "closed", "unbound"]) {
          await action(page, "reset");
          await action(
            page,
            "settle",
            await waitPending(page, "locate"),
            status,
          );
          await page.waitForFunction(
            (status) =>
              Reflect.get(window, "cognitiveViewFixture").report().state
                ?.status === status,
            status,
          );
          const state = await report(page);
          assert.equal(state.state.html, null);
          assert.equal(state.state.blocked, true);
          assert(
            state.pending.every(
              (p: any) => p.method === "cognitive-app-views.locate",
            ),
          );
          assert.deepEqual(state.records, state.initialRecords);
        }
      },
    );
    await t.test(
      "ready read exact CAS and a trusted own-save source advances CAS without shared latest-source or new read",
      async () => {
        await action(page, "reset");
        const before = await ready(page);
        await action(page, "capture");
        await action(page, "capture", 3);
        await action(page, "capture", 4);
        const state = await report(page);
        assert.deepEqual(
          state.leases.map((l: any) => l.revision),
          [2, 3, 4],
        );
        assert(
          state.leases.every((l: any) => l.current && l.bindingRevision === 3),
        );
        assert.equal(
          state.state.viewRevision,
          2,
          "preparation leases never rewrite the restored initial source",
        );
        assert.equal(state.pending.length, before.pending.length);
        const ui = state.pending.find((p: any) => p.method.endsWith("read-ui"));
        assert.deepEqual(ui.parameters, {
          viewId: "view_project",
          expectedViewRevision: 2,
          expectedBindingRevision: 3,
        });
        assert.deepEqual(state.records, state.initialRecords);
      },
    );
    await t.test(
      "fixed binding/grant/connection/authority premise changes and regressed CAS reject source leases",
      async () => {
        await action(page, "reset");
        await ready(page);
        for (const change of ["binding", "grant", "connection", "authority"])
          await action(page, "capture", 3, change);
        await action(page, "capture", 1);
        assert.deepEqual((await report(page)).leases, [
          null,
          null,
          null,
          null,
          null,
        ]);
      },
    );
    await t.test(
      "identity/CSRF tuple changes synchronously hide source and retire already-captured lease",
      async () => {
        for (const identity of [
          {
            centerId: "other-center",
            principalId: "human",
            csrfToken: "session",
          },
          { centerId: "center", principalId: "other", csrfToken: "session" },
          {
            centerId: "center",
            principalId: "human",
            csrfToken: "new-session",
          },
        ]) {
          await action(page, "reset");
          await ready(page, "PRIVATE_OLD_IDENTITY");
          await action(page, "capture");
          const state = await action(page, "config", { identity });
          assert.equal(state.state.html, null);
          assert.equal(state.leases[0].current, false);
          assert(
            state.commits
              .filter(
                (c: any) =>
                  JSON.stringify(c.identity) === JSON.stringify(identity),
              )
              .every((c: any) => c.html === null),
          );
          assert.deepEqual(state.records, state.initialRecords);
        }
      },
    );
    await t.test(
      "location/epoch change retires old lease; returning to identical values cannot revive old source",
      async () => {
        await action(page, "reset");
        await ready(page, "PRIVATE_OLD_LOCATION");
        await action(page, "capture");
        const slot = await page.evaluate(
          () => Reflect.get(window, "cognitiveViewFixture").slot,
        );
        let state = await action(page, "config", {
          location: {
            kind: "view",
            slot: { ...slot, projectId: "other_project" },
          },
          epoch: 2,
        });
        assert.equal(state.state.html, null);
        assert.equal(state.leases[0].current, false);
        state = await action(page, "config", {
          location: { kind: "view", slot },
          epoch: 1,
        });
        assert.equal(state.state.html, null);
        assert.equal(state.leases[0].current, false);
        state = await ready(page, "PRIVATE_FRESH_LOCATION");
        assert.equal(state.state.html, "PRIVATE_FRESH_LOCATION");
      },
    );
    await t.test(
      "late ignored-abort locate and UI replies cannot publish or perform another read",
      async () => {
        for (const phase of ["locate", "read-ui"]) {
          await action(page, "reset");
          if (phase === "read-ui")
            await action(page, "settle", await waitPending(page, "locate"));
          const old = await waitPending(page, phase);
          await action(page, "config", { epoch: 2 });
          let state = await report(page);
          assert.equal(state.pending[old].aborted, true);
          const count = state.pending.length;
          await action(page, "settle", old, "ready", "PRIVATE_TOO_LATE");
          // This wait is a queued actual browser task, not an invented commit.
          await page.evaluate(
            () => new Promise<void>((resolve) => queueMicrotask(resolve)),
          );
          state = await report(page);
          assert.equal(state.state.html, null);
          assert.equal(state.pending.length, count);
          assert(
            state.commits.every((c: any) => c.html !== "PRIVATE_TOO_LATE"),
          );
        }
      },
    );
    await t.test(
      "layout cleanup/unmount retires exact source lease before same-scope fresh remount",
      async () => {
        await action(page, "reset");
        await ready(page, "PRIVATE_BEFORE_UNMOUNT");
        await action(page, "capture");
        let state = await action(page, "mount", false);
        assert.equal(state.state, null);
        assert.equal(state.leases[0].current, false);
        state = await action(page, "mount", true);
        assert.equal(state.state.html, null);
        assert.equal(state.leases[0].current, false);
        state = await ready(page, "PRIVATE_NEW_MOUNT");
        assert.equal(state.state.html, "PRIVATE_NEW_MOUNT");
      },
    );
    await t.test(
      "current-owner loss fails closed and cannot resurrect after callback returns true; explicit reload reads anew",
      async () => {
        await action(page, "reset");
        await ready(page);
        await action(page, "capture");
        let state = await action(page, "config", { valid: false });
        assert.equal(state.state.html, null);
        assert.equal(state.leases[0].current, false);
        const count = state.pending.length;
        state = await action(page, "config", { valid: true });
        assert.equal(state.state.html, null);
        assert.equal(state.leases[0].current, false);
        assert.equal(state.pending.length, count);
        await action(page, "retry");
        state = await ready(page, "AFTER_CURRENT_OWNER_RELOAD");
        assert.equal(state.state.html, "AFTER_CURRENT_OWNER_RELOAD");
        assert.equal(state.leases[0].current, false);
      },
    );
    await t.test(
      "StrictMode discarded first read and explicit retry late reply never revive a retired incarnation",
      async () => {
        await action(page, "reset");
        const state = await report(page);
        const discarded = state.pending.find((p: any) => p.aborted && !p.done);
        assert(
          discarded,
          "actual StrictMode must have retired its first effect read",
        );
        const held = await waitPending(page, "locate");
        await action(page, "retry");
        await action(page, "settle", discarded.index);
        await action(page, "settle", held);
        let after = await report(page);
        assert.equal(after.state.html, null);
        after = await ready(page, "AFTER_STRICT_RETRY");
        assert.equal(after.state.html, "AFTER_STRICT_RETRY");
      },
    );
    await t.test(
      "saved retry callbacks cannot invalidate a new identity/epoch owner or schedule reads under its current scope",
      async () => {
        for (const change of [
          { epoch: 2 },
          {
            identity: {
              centerId: "center",
              principalId: "other",
              csrfToken: "other-session",
            },
          },
        ]) {
          await action(page, "reset");
          await ready(page, "OLD_RETRY_OWNER");
          await action(page, "saveReload");
          await action(page, "config", change);
          const before = await ready(page, "NEW_RETRY_OWNER");
          await action(page, "oldReload", 0);
          const after = await report(page);
          assert.equal(after.state.html, "NEW_RETRY_OWNER");
          assert.equal(after.pending.length, before.pending.length);
          assert.deepEqual(after.records, after.initialRecords);
        }
      },
    );
    await t.test(
      "bounded read deadline and service denial retain honest error without mutation or retry",
      async () => {
        await action(page, "reset");
        const held = await waitPending(page, "locate");
        await action(page, "expire");
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveViewFixture").report().state
              ?.status === "error",
        );
        let state = await report(page);
        assert(state.state.message.includes("超时"));
        assert.equal(state.pending[held].aborted, true);
        await action(page, "settle", held);
        assert.equal((await report(page)).state.html, null);
        await action(page, "reset");
        await action(page, "fail", await waitPending(page, "locate"));
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveViewFixture").report().state
              ?.status === "error",
        );
        state = await report(page);
        assert.equal(state.state.message, "ACTUAL_CONTROLLED_READ_DENIED");
        assert(state.pending.every((p: any) => p.method.endsWith("locate")));
        assert.deepEqual(state.records, state.initialRecords);
      },
    );
    await t.test(
      "monotonic budget rejects late UI bytes even before a busy browser fires its deadline timer",
      async () => {
        await action(page, "reset");
        await action(page, "settle", await waitPending(page, "locate"));
        const held = await waitPending(page, "read-ui");
        await action(page, "advanceWithoutTimer");
        await action(page, "settle", held, "ready", "PRIVATE_AFTER_DEADLINE");
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveViewFixture").report().state
              ?.status === "error",
        );
        const state = await report(page);
        assert.equal(state.state.html, null);
        assert(state.state.message.includes("超时"));
        assert.equal(state.pending[held].aborted, true);
        assert(
          state.commits.every(
            (row: any) => row.html !== "PRIVATE_AFTER_DEADLINE",
          ),
        );
        assert.deepEqual(state.records, state.initialRecords);
      },
    );
    await t.test(
      "initial metadata-only verification covers close before observer install and immediately retires captured business lease while displaying honest closed fact",
      async () => {
        await action(page, "reset");
        await ready(page, "INITIAL_OBSERVER_SOURCE");
        await action(page, "capture");
        const held = await waitPending(page, "locate");
        await action(page, "metadata", held, "closed", 3);
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveViewFixture").report().state
              ?.status === "closed",
        );
        const state = await report(page);
        assert.equal(state.state.blocked, true);
        assert.equal(state.state.html, null);
        assert.equal(state.leases[0].current, false);
        assert.equal(state.state.message, "此应用窗口已关闭。");
        assert.equal(
          state.pending.filter((p: any) => p.method.endsWith("read-ui")).length,
          1,
        );
        assert.deepEqual(state.pending[held].parameters, {
          projectId: "project",
          appId: "example.notes",
          version: "1.1.0",
          expectedDefinitionHash: "a".repeat(64),
        });
        const count = state.pending.length;
        await action(page, "hints", [1, 2, 3]);
        assert.equal((await report(page)).pending.length, count);
        assert.deepEqual(state.records, state.initialRecords);
      },
    );
    await t.test(
      "metadata hint storm coalesces one latest read, own-save CAS keeps the exact source warm, and only latest closed reply retires it",
      async () => {
        await action(page, "reset");
        const initial = await ready(page, "WARM_OBSERVER_SOURCE");
        await action(page, "capture", 3);
        const held = await waitPending(page, "locate");
        await action(
          page,
          "hints",
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
        assert.equal(
          (await report(page)).pending.length,
          initial.pending.length,
        );
        await action(page, "metadata", held, "closed", 3);
        const latest = await waitPending(page, "locate");
        assert.notEqual(latest, held);
        assert.equal((await report(page)).state.status, "ready");
        await action(page, "metadata", latest, "ready", 3);
        await page.evaluate(
          () => new Promise<void>((resolve) => queueMicrotask(resolve)),
        );
        let state = await report(page);
        assert.equal(state.state.html, "WARM_OBSERVER_SOURCE");
        assert.equal(
          state.state.viewRevision,
          2,
          "metadata does not impersonate own CAS3 ACK",
        );
        assert.equal(state.leases[0].revision, 3);
        assert.equal(state.leases[0].current, true);
        assert.equal(
          state.pending.filter((p: any) => p.method.endsWith("read-ui")).length,
          1,
        );
        await action(page, "hints", [21]);
        await action(
          page,
          "metadata",
          await waitPending(page, "locate"),
          "closed",
          3,
        );
        await page.waitForFunction(
          () =>
            Reflect.get(window, "cognitiveViewFixture").report().state
              ?.status === "closed",
        );
        state = await report(page);
        assert.equal(state.leases[0].current, false);
        assert.deepEqual(state.records, state.initialRecords);
      },
    );
    await t.test(
      "pending observer layout disposal and ignored-abort old metadata never retire a newer identity/navigation incarnation",
      async () => {
        for (const change of [
          { epoch: 2 },
          {
            identity: {
              centerId: "center",
              principalId: "other",
              csrfToken: "other-session",
            },
          },
        ]) {
          await action(page, "reset");
          await ready(page, "OLD_OBSERVER_SOURCE");
          await action(page, "capture");
          const held = await waitPending(page, "locate");
          await action(page, "config", change);
          assert.equal((await report(page)).pending[held].aborted, true);
          await ready(page, "NEW_OBSERVER_SOURCE");
          await action(page, "metadata", held, "closed", 3);
          await page.evaluate(
            () => new Promise<void>((resolve) => queueMicrotask(resolve)),
          );
          const state = await report(page);
          assert.equal(state.state.status, "ready");
          assert.equal(state.state.html, "NEW_OBSERVER_SOURCE");
          assert.equal(state.leases[0].current, false);
          assert.deepEqual(state.records, state.initialRecords);
        }
      },
    );
    await t.test(
      "observer metadata denial or absolute deadline retires the source but keeps honest error without automatic UI read/retry",
      async () => {
        for (const event of ["fail", "expire"]) {
          await action(page, "reset");
          await ready(page, "OBSERVER_PENDING_SOURCE");
          await action(page, "capture");
          const held = await waitPending(page, "locate");
          if (event === "fail") await action(page, "fail", held);
          else await action(page, "expire");
          await page.waitForFunction(
            () =>
              Reflect.get(window, "cognitiveViewFixture").report().state
                ?.status === "error",
          );
          const state = await report(page);
          assert.equal(state.state.html, null);
          assert.equal(state.state.blocked, true);
          assert.equal(state.leases[0].current, false);
          assert.equal(state.pending[held].aborted, true);
          assert.equal(
            state.pending.filter((p: any) => p.method.endsWith("read-ui"))
              .length,
            1,
          );
          if (event === "expire") assert.match(state.state.message, /超时/);
          const count = state.pending.length;
          await action(page, "hints", [1, 2]);
          assert.equal((await report(page)).pending.length, count);
          assert.deepEqual(state.records, state.initialRecords);
        }
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(forbiddenRequests, []);
  },
);
