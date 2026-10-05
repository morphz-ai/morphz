import test from "node:test";
import assert from "node:assert/strict";
import { createCognitiveAppRecovery } from "../packages/application/src/cognitive-app-recovery.js";

test("UNIT lifecycle: startup recovers, ordinary commit only projects, idle does no work", async () => {
  let networks = 0,
    projections = 0,
    lists = 0;
  const recovery = createCognitiveAppRecovery({
    tenantId: "tenant",
    platform: {
      async listRecoverableCognitiveAppCommands() {
        lists++;
        return [{ commandId: "old", connectionId: "connection" }];
      },
    },
    gateway: {
      async recoverCommand() {
        networks++;
        return undefined;
      },
      async projectPending() {
        projections++;
        return [];
      },
    },
  });
  recovery.start();
  await recovery.whenIdle();
  assert.equal(networks, 1);
  recovery.wake("projection");
  await recovery.whenIdle();
  assert.equal(networks, 1);
  assert.equal(lists, 1);
  const before = projections;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(projections, before);
  await recovery.close();
  recovery.wake("retry");
  await recovery.whenIdle();
  assert.equal(networks, 1);
});

test("UNIT: bounded cursors, two workers, failed commands and projection pages remain finite", async () => {
  const commands = Array.from({ length: 20 }, (_, index) => ({
    commandId: `c${String(index).padStart(2, "0")}`,
    connectionId: "connection",
  }));
  const projected = Array.from({ length: 140 }, (_, index) => ({
    commandId: `p${String(index).padStart(3, "0")}`,
  }));
  const seen: string[] = [],
    pageStarts: Array<string | undefined> = [];
  let active = 0,
    maximum = 0;
  const recovery = createCognitiveAppRecovery({
    tenantId: "tenant",
    platform: {
      async listRecoverableCognitiveAppCommands(page) {
        return commands
          .filter(
            (row) =>
              !page.afterCommandId || row.commandId > page.afterCommandId,
          )
          .slice(0, page.limit);
      },
    },
    gateway: {
      async projectPending(page) {
        pageStarts.push(page.afterCommandId);
        return projected
          .filter(
            (row) =>
              !page.afterCommandId || row.commandId > page.afterCommandId,
          )
          .slice(0, page.limit);
      },
      async recoverCommand({ commandId }) {
        seen.push(commandId);
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active--;
        throw new Error("simulated offline");
      },
    },
  });
  recovery.start();
  await recovery.whenIdle();
  assert.equal(maximum, 2);
  assert.equal(seen.length, 8);
  assert.equal(pageStarts.length, 4);
  assert.deepEqual(
    seen,
    commands.slice(0, 8).map((row) => row.commandId),
  );
  recovery.wake("projection");
  await recovery.whenIdle();
  assert.equal(pageStarts[4], "p127");
  assert.equal(seen.length, 8);
  recovery.wake("connected");
  await recovery.whenIdle();
  assert.deepEqual(
    seen.slice(8),
    commands.slice(8, 16).map((row) => row.commandId),
  );
  recovery.wake("retry");
  await recovery.whenIdle();
  assert.equal(seen.length, 20);
  await recovery.close();
});

test("UNIT: monotonic whole-round deadline and close abort running receipt reads without reinvoke", async () => {
  let aborted = 0,
    started = 0;
  const recovery = createCognitiveAppRecovery({
    tenantId: "tenant",
    deadlineMs: 25,
    platform: {
      async listRecoverableCognitiveAppCommands() {
        return Array.from({ length: 8 }, (_, i) => ({
          commandId: `c${i}`,
          connectionId: "connection",
        }));
      },
    },
    gateway: {
      async projectPending() {
        return [];
      },
      async recoverCommand(_request, signal) {
        started++;
        await new Promise<void>((resolve) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted++;
              resolve();
            },
            { once: true },
          );
        });
      },
    },
  });
  recovery.start();
  await recovery.whenIdle();
  assert.equal(started, 2);
  assert.equal(aborted, 2);
  recovery.wake("retry");
  await new Promise((resolve) => setTimeout(resolve, 3));
  await Promise.all([recovery.close(), recovery.close()]);
  assert.equal(started, 4);
  assert.equal(aborted, 4);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(started, 4);
});
