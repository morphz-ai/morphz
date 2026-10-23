import assert from "node:assert/strict";
import test from "node:test";
import {
  createTopbarPortalLifecycle,
  topbarPortalNames,
} from "./fixtures/workspace-topbar-lifecycle.js";

test("portal lifecycle starts at explicit zero rather than undefined/NaN", () => {
  const lifecycle = createTopbarPortalLifecycle();
  const initial = lifecycle.report();
  assert.deepEqual(initial.mounts, { application: 0, page: 0, detail: 0 });
  assert.deepEqual(initial.cleanups, { application: 0, page: 0, detail: 0 });
  const remove = topbarPortalNames.map((name) => lifecycle.mount(name));
  for (const cleanup of remove) cleanup();
  for (const name of topbarPortalNames) {
    assert.equal(lifecycle.report().cleanups[name], initial.cleanups[name] + 1);
    assert.equal(Number.isFinite(initial.cleanups[name] + 1), true);
  }
  assert.deepEqual(initial.cleanups, { application: 0, page: 0, detail: 0 });
});

test("visible portal DOM is not ready while effect registration is delayed", async () => {
  const lifecycle = createTopbarPortalLifecycle();
  assert.equal(lifecycle.ready(3), false);
  const removeApplication = lifecycle.mount("application");
  const removePage = lifecycle.mount("page");
  let release!: () => void;
  const effect = new Promise<void>((resolve) => {
    release = resolve;
  }).then(() => lifecycle.mount("detail"));
  assert.equal(lifecycle.ready(3), false);
  await Promise.resolve();
  assert.equal(lifecycle.ready(3), false);
  release();
  const removeDetail = await effect;
  assert.equal(lifecycle.ready(3), true);
  assert.equal(lifecycle.ready(2), false);
  const before = lifecycle.report();
  removeApplication();
  assert.equal(lifecycle.ready(3), false);
  removePage();
  removeDetail();
  for (const name of topbarPortalNames) {
    assert.equal(lifecycle.report().cleanups[name], before.cleanups[name] + 1);
  }
});

test("StrictMode cleanup/remount retains exact active counts and final cleanup increments", () => {
  const lifecycle = createTopbarPortalLifecycle();
  for (const name of topbarPortalNames) {
    lifecycle.mount(name)();
  }
  assert.equal(lifecycle.ready(3), false);
  const remove = topbarPortalNames.map((name) => lifecycle.mount(name));
  assert.equal(lifecycle.ready(3), true);
  const before = lifecycle.report();
  assert.deepEqual(before.mounts, { application: 2, page: 2, detail: 2 });
  assert.deepEqual(before.cleanups, { application: 1, page: 1, detail: 1 });
  for (const cleanup of remove) cleanup();
  for (const name of topbarPortalNames) {
    assert.equal(lifecycle.report().cleanups[name], before.cleanups[name] + 1);
  }
  assert.equal(lifecycle.ready(3), false);
});
