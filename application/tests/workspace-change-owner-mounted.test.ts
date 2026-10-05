import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Page } from "@playwright/test";

async function report(page: Page): Promise<any> {
  return page.evaluate(() =>
    Reflect.get(window, "workspaceChangeOwner").report(),
  );
}
async function action(
  page: Page,
  method: string,
  ...values: unknown[]
): Promise<any> {
  return page.evaluate(
    ({ method, values }) =>
      Reflect.get(window, "workspaceChangeOwner")[method](...values),
    { method, values },
  );
}
async function wait(
  page: Page,
  field: "held" | "null" | "ready" | "error" | "auth",
  title?: string,
) {
  await page.waitForFunction(
    ({ field, title }) => {
      const value = Reflect.get(window, "workspaceChangeOwner").report();
      return field === "held"
        ? value.held
        : field === "null"
          ? value.snapshot === null && !value.domPrivate
          : field === "ready"
            ? value.snapshot?.title === title && value.domPrivate
            : field === "auth"
              ? value.authenticationRequired
              : value.error.includes("目录在读取期间已更新");
    },
    { field, title },
    { timeout: 4000 },
  );
}
async function clearByActualReadMismatch(page: Page) {
  await action(page, "arm", "content.list");
  await action(page, "configure", { catalog: 2 });
  await action(page, "emit", false);
  await wait(page, "held");
  await action(page, "configure", { access: 2, catalog: 3 });
  await action(page, "release");
  await wait(page, "error");
  await wait(page, "null");
}

test(
  "ACTUAL mounted React Client workspace-change owner; CONTROLLED logical bridge, not SQL / HPA / Electron",
  { timeout: 60_000 },
  async (t) => {
    const bundle = (
      await build({
        entryPoints: ["tests/fixtures/workspace-change-owner-mounted.tsx"],
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2023",
        write: false,
        jsx: "automatic",
      })
    ).outputFiles[0]!.text;
    const server = createServer((req, res) => {
      res.setHeader(
        "Content-Type",
        req.url === "/fixture.js"
          ? "text/javascript"
          : "text/html; charset=utf-8",
      );
      res.end(
        req.url === "/fixture.js"
          ? bundle
          : '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium
      .launch({
        headless: true,
        executablePath:
          process.env.MORPHZ_TEST_BROWSER_EXECUTABLE ||
          chromium.executablePath(),
      })
      .catch(async (error) => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      });
    try {
      for (const reason of ["changed", "resync"] as const)
        await t.test(
          `cleared private projection keeps only its session hint owner for later ${reason}, then fully reauthorizes`,
          async () => {
            const page = await browser.newPage();
            try {
              await page.goto(origin);
              await wait(page, "ready", "one-1-desk");
              const original = await report(page);
              await action(page, "arm", "app-views.list");
              await action(page, "configure", { access: 2, catalog: 2 });
              await action(page, "emit", true);
              await wait(page, "held");
              await wait(page, "null");
              const cleared = await report(page);
              assert.equal(cleared.privateUnmounts, 1);
              assert.equal(cleared.listeners, 1);
              assert.equal(cleared.subscriptions.length, 1);
              assert.equal(cleared.subscriptions[0].closed, false);
              await action(page, "configure", { access: 3, catalog: 3 });
              await action(page, "emit", reason === "changed", reason);
              await action(page, "release");
              await wait(page, "ready", "one-3-desk");
              const restored = await report(page);
              assert.equal(restored.privateMounts, 2);
              assert.equal(restored.privateUnmounts, 1);
              assert.equal(restored.subscriptions.length, 1);
              assert.equal(restored.draft, original.draft);
              assert.ok(
                restored.calls.filter(
                  (entry: any) => entry.method === "platform.bootstrap",
                ).length >= 2,
              );
              assert.ok(
                restored.calls.every(
                  (entry: any) => !entry.method.includes("message"),
                ),
              );
              assert.ok(
                restored.publications.every(
                  (entry: any) => entry.title !== "one-2-desk",
                ),
              );
            } finally {
              await page.close();
            }
          },
        );
      await t.test(
        "actual final navigation mismatch still clears and refuses publication, but a later real session hint can recover",
        async () => {
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            await wait(page, "ready", "one-1-desk");
            await action(page, "arm", "content.list");
            await action(page, "configure", { catalog: 2 });
            await action(page, "emit", false);
            await wait(page, "held");
            await action(page, "configure", { access: 2, catalog: 3 });
            await action(page, "release");
            await wait(page, "error");
            await wait(page, "null");
            const denied = await report(page);
            assert.equal(
              denied.publications.some(
                (entry: any) => entry.title === "one-2-desk",
              ),
              false,
            );
            assert.equal(denied.listeners, 1);
            await action(page, "configure", { access: 3, catalog: 4 });
            await action(page, "emit", true);
            await wait(page, "ready", "one-4-desk");
            assert.equal((await report(page)).error, "");
          } finally {
            await page.close();
          }
        },
      );
      await t.test(
        "a same-turn hint after synchronous private clear survives before React effect cleanup or restoration",
        async () => {
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            await wait(page, "ready", "one-1-desk");
            const midway = await page.evaluate(() => {
              const owner = Reflect.get(window, "workspaceChangeOwner");
              owner.configure({ access: 2, catalog: 2 });
              owner.emit(true);
              const cleared = owner.report();
              owner.configure({ access: 3, catalog: 3 });
              owner.emit(true);
              return {
                snapshot: cleared.snapshot,
                subscriptions: cleared.subscriptions,
              };
            });
            assert.equal(
              midway.snapshot,
              null,
              "The first hint did synchronously clear protected refs",
            );
            assert.equal(midway.subscriptions[0].closed, false);
            await wait(page, "ready", "one-3-desk");
            const restored = await report(page);
            assert.equal(restored.subscriptions.length, 1);
            assert.equal(restored.listeners, 1);
            assert.equal(
              restored.publications.some(
                (entry: any) => entry.title === "one-2-desk",
              ),
              false,
            );
          } finally {
            await page.close();
          }
        },
      );
      for (const transition of ["401", "logout", "login", "unmount"] as const)
        await t.test(
          `${transition} retires old session hints and rejects an actually late controlled bridge reply without restoring private content`,
          async () => {
            const page = await browser.newPage();
            try {
              await page.goto(origin);
              await wait(page, "ready", "one-1-desk");
              const original = await report(page);
              const oldId = original.subscriptions[0].id;
              await action(page, "arm", "app-views.list");
              await action(page, "startRefresh");
              await wait(page, "held");
              if (transition === "401") {
                await action(page, "configure", { unauthorized: true });
                await action(page, "emit", true);
                await wait(page, "auth");
              } else if (transition === "unmount") {
                await action(page, "unmount");
              } else {
                await action(
                  page,
                  transition,
                  ...(transition === "login" ? ["two"] : []),
                );
                await wait(
                  page,
                  transition === "login" ? "ready" : "auth",
                  "two-1-desk",
                );
              }
              const retired = await report(page);
              assert.equal(retired.subscriptions[0].closed, true);
              if (transition !== "login") assert.equal(retired.listeners, 0);
              const calls = retired.calls.length;
              await action(page, "emit", true, "resync", oldId);
              assert.equal(
                (await report(page)).calls.length,
                calls,
                "An old hint cannot initiate a read",
              );
              await action(page, "release");
              await page.waitForFunction(
                () =>
                  Reflect.get(window, "workspaceChangeOwner").report()
                    .heldCompletions === 1,
              );
              const late = await report(page);
              assert.equal(
                late.calls.length,
                calls,
                "Late completion cannot create another read or owner",
              );
              assert.deepEqual(late.publications, retired.publications);
              assert.equal(late.draft, original.draft);
              assert.equal(late.domPrivate, transition === "login");
              if (transition === "login") {
                assert.equal(late.snapshot.principalId, "two");
                assert.equal(late.subscriptions.length, 2);
                assert.equal(
                  late.subscriptions[1].generation,
                  "generation-two",
                );
              } else if (transition !== "unmount")
                assert.equal(late.snapshot, null);
            } finally {
              await page.close();
            }
          },
        );
      await t.test(
        "validated bootstrap replaces the session guard before a delayed new private projection; old hints cannot cross identity",
        async () => {
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            await wait(page, "ready", "one-1-desk");
            const oldId = (await report(page)).subscriptions[0].id;
            await action(page, "arm", "app-views.list");
            await action(page, "configure", { identity: "two", catalog: 2 });
            await action(page, "emit", false);
            await wait(page, "held");
            await wait(page, "null");
            const replaced = await report(page);
            assert.equal(replaced.subscriptions[0].closed, true);
            assert.equal(replaced.subscriptions.length, 2);
            assert.equal(
              replaced.subscriptions[1].generation,
              "generation-two",
            );
            await action(page, "emit", true, "changed", oldId);
            assert.equal(
              (await report(page)).calls.length,
              replaced.calls.length,
            );
            await action(page, "release");
            await wait(page, "ready", "two-2-desk");
            const final = await report(page);
            assert.equal(
              final.publications.filter(
                (entry: any) => entry.principalId === "two",
              ).length,
              1,
            );
            assert.equal(
              final.publications.filter(
                (entry: any) => entry.principalId === "one",
              ).length,
              1,
            );
          } finally {
            await page.close();
          }
        },
      );
      await t.test(
        "logout after access clear uses only its still-authenticated session owner, cancels the private reread and really logs out",
        async () => {
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            await wait(page, "ready", "one-1-desk");
            const original = await report(page);
            await action(page, "arm", "app-views.list");
            await action(page, "configure", { access: 2, catalog: 2 });
            await action(page, "emit", true);
            await wait(page, "held");
            await wait(page, "null");
            assert.equal((await report(page)).subscriptions[0].closed, false);
            await action(page, "logout");
            const after = await report(page);
            const logouts = after.calls.filter(
              (entry: any) => entry.method === "logout",
            );
            assert.equal(
              logouts.length,
              1,
              "An empty private projection must not prevent real session logout",
            );
            assert.equal(logouts[0].generation, "generation-one");
            await wait(page, "auth");
            assert.equal((await report(page)).listeners, 0);
            const count = (await report(page)).calls.length;
            await action(
              page,
              "emit",
              true,
              "resync",
              original.subscriptions[0].id,
            );
            await action(page, "release");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "workspaceChangeOwner").report()
                  .heldCompletions === 1,
            );
            const retired = await report(page);
            assert.equal(retired.calls.length, count);
            assert.equal(retired.snapshot, null);
            assert.equal(retired.domPrivate, false);
            assert.equal(retired.draft, original.draft);
            assert.deepEqual(retired.publications, original.publications);
          } finally {
            await page.close();
          }
        },
      );
      await t.test(
        "logout retires the refresh epoch and controller before its held RPC reply, not only after success",
        async () => {
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            await wait(page, "ready", "one-1-desk");
            await action(page, "arm", "platform.bootstrap");
            await action(page, "startRefresh");
            await wait(page, "held");
            await action(page, "holdLogout");
            await action(page, "startLogout");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "workspaceChangeOwner").report().logoutHeld,
            );
            const waiting = await report(page);
            assert.equal(
              waiting.calls
                .filter((entry: any) => entry.method === "platform.bootstrap")
                .at(-1).cancelled,
              true,
            );
            assert.equal(waiting.outcomes.logout, undefined);
            const count = waiting.calls.length;
            await action(page, "release");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "workspaceChangeOwner").report()
                  .heldCompletions === 1,
            );
            assert.equal((await report(page)).calls.length, count);
            await action(page, "releaseLogout");
            await wait(page, "auth");
            const final = await report(page);
            assert.equal(final.listeners, 0);
            assert.equal(final.snapshot, null);
          } finally {
            await page.close();
          }
        },
      );
      for (const failure of ["500", "timeout"] as const)
        await t.test(
          `a real controlled logout ${failure} after private clear preserves its error, requests one fresh authorized read and permits another explicit logout`,
          async () => {
            const page = await browser.newPage();
            try {
              await page.goto(origin);
              await wait(page, "ready", "one-1-desk");
              await clearByActualReadMismatch(page);
              const cleared = await report(page);
              await action(page, "failLogout", failure);
              if (failure === "timeout") await action(page, "holdLogout");
              await action(page, "startLogout");
              await page.waitForFunction(
                () =>
                  typeof Reflect.get(window, "workspaceChangeOwner").report()
                    .outcomes.logout === "object",
                undefined,
                { timeout: 11_000 },
              );
              const rejected = await report(page);
              assert.equal(
                rejected.calls.filter(
                  (entry: any) => entry.method === "platform.bootstrap",
                ).length,
                cleared.calls.filter(
                  (entry: any) => entry.method === "platform.bootstrap",
                ).length + 1,
                "failure may request exactly one validated reread, never revive captured metadata",
              );
              if (failure === "500") {
                assert.equal(rejected.outcomes.logout.status, 500);
                assert.equal(
                  rejected.outcomes.logout.message,
                  "Controlled logout failed",
                );
              } else {
                assert.equal(rejected.outcomes.logout.name, "TimeoutError");
                assert.ok(rejected.outcomes.logout.elapsed >= 7900);
                assert.equal(
                  rejected.calls.find((entry: any) => entry.method === "logout")
                    .cancelled,
                  true,
                );
                await action(page, "releaseLogout");
              }
              await wait(page, "ready", "one-3-desk");
              const restored = await report(page);
              assert.equal(restored.subscriptions[0].closed, true);
              assert.equal(restored.subscriptions.length, 2);
              assert.equal(
                restored.subscriptions[1].generation,
                "generation-one",
              );
              assert.equal(restored.draft, cleared.draft);
              const recoveredCount = restored.calls.length;
              await action(
                page,
                "emit",
                true,
                "changed",
                restored.subscriptions[0].id,
              );
              assert.equal((await report(page)).calls.length, recoveredCount);
              await action(page, "configure", { access: 3, catalog: 4 });
              await action(page, "emit", true);
              await wait(page, "ready", "one-4-desk");
              assert.equal((await report(page)).subscriptions.length, 2);
              await action(page, "logout");
              await wait(page, "auth");
              const loggedOut = await report(page);
              assert.deepEqual(
                loggedOut.calls
                  .filter((entry: any) => entry.method === "logout")
                  .map((entry: any) => entry.generation),
                ["generation-one", "generation-one"],
              );
              assert.equal(loggedOut.snapshot, null);
              assert.equal(loggedOut.listeners, 0);
            } finally {
              await page.close();
            }
          },
        );
      for (const boundary of ["login", "unmount"] as const)
        await t.test(
          `a late failure-recovery bootstrap cannot cross actual ${boundary} into an old hint owner or logout a new identity`,
          async () => {
            const page = await browser.newPage();
            try {
              await page.goto(origin);
              await wait(page, "ready", "one-1-desk");
              await clearByActualReadMismatch(page);
              const cleared = await report(page);
              const oldId = cleared.subscriptions[0].id;
              await action(page, "arm", "platform.bootstrap");
              await action(page, "failLogout", "500");
              await action(page, "startLogout");
              await wait(page, "held");
              const recoveryId = (await report(page)).calls
                .filter((entry: any) => entry.method === "platform.bootstrap")
                .at(-1).id;
              if (boundary === "login") {
                await action(page, "login", "two");
                await wait(page, "ready", "two-3-desk");
              } else await action(page, "unmount");
              const retired = await report(page);
              assert.equal(
                retired.calls.find((entry: any) => entry.id === recoveryId)
                  ?.cancelled,
                true,
              );
              const count = retired.calls.length;
              await action(page, "release");
              await page.waitForFunction(
                () =>
                  Reflect.get(window, "workspaceChangeOwner").report()
                    .heldCompletions === 2,
              );
              await action(page, "emit", true, "changed", oldId);
              const late = await report(page);
              assert.equal(late.calls.length, count);
              assert.deepEqual(
                late.calls
                  .filter((entry: any) => entry.method === "logout")
                  .map((entry: any) => entry.generation),
                ["generation-one"],
              );
              assert.ok(
                late.publications.every(
                  (entry: any) => entry.title !== "one-3-desk",
                ),
              );
              if (boundary === "login") {
                assert.equal(late.snapshot.principalId, "two");
                assert.equal(
                  late.subscriptions.at(-1).generation,
                  "generation-two",
                );
              } else {
                assert.equal(late.snapshot, null);
                assert.equal(late.listeners, 0);
              }
            } finally {
              await page.close();
            }
          },
        );
      await t.test(
        "a failed logout's fresh actual 401 retires authentication instead of restoring old metadata or private content",
        async () => {
          const page = await browser.newPage();
          try {
            await page.goto(origin);
            await wait(page, "ready", "one-1-desk");
            await clearByActualReadMismatch(page);
            const cleared = await report(page);
            await action(page, "configure", { unauthorized: true });
            await action(page, "failLogout", "500");
            await action(page, "startLogout");
            await wait(page, "auth");
            const denied = await report(page);
            assert.equal(
              denied.outcomes.logout.message,
              "Controlled logout failed",
            );
            assert.equal(denied.snapshot, null);
            assert.equal(denied.listeners, 0);
            assert.equal(denied.calls.length, cleared.calls.length + 2);
            const count = denied.calls.length;
            await action(
              page,
              "emit",
              true,
              "changed",
              cleared.subscriptions[0].id,
            );
            await action(page, "logout");
            assert.equal((await report(page)).calls.length, count);
          } finally {
            await page.close();
          }
        },
      );
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
