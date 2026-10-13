import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("MORPHZ") &&
      key !== "DOUBAO_API_KEY" &&
      key !== "ELECTRON_RUN_AS_NODE" &&
      key !== "NODE_OPTIONS",
  ),
);
let application;
let applicationChild;
async function launch(hang = false) {
  application = await _electron.launch({
    args: ["tests/fixtures/desktop-shutdown-entry.cjs"],
    env: {
      ...env,
      MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
      MORPHZ_APP_ENV_FILE: "",
      ...(hang ? { MORPHZ_TEST_QUIT_NATIVE_HANG: "1" } : {}),
    },
    timeout: 20000,
  });
  applicationChild = application.process();
  await expect
    .poll(
      () =>
        application.windows().some((page) => page.url() === "morphz://app/"),
      { timeout: 20000 },
    )
    .toBe(true);
  const page = application
    .windows()
    .find((page) => page.url() === "morphz://app/");
  await expect(
    page.getByRole("region", { name: "认知应用工作空间" }),
  ).toBeVisible();
  return page;
}
async function quit(hang) {
  const child = applicationChild;
  let committed = false;
  child.stdout.on("data", (bytes) => {
    if (bytes.toString().includes("MORPHZ_SHUTDOWN_COMMITTED"))
      committed = true;
  });
  const exited = once(child, "exit");
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, 9000);
  const start = performance.now();
  try {
    void application
      .evaluate(({ app }) => {
        app.quit();
      })
      .catch(() => {
        // A committed quit may retire the inspector connection before its
        // evaluate response. Only the marker AND actual OS exit below can pass.
      });
    const [code, signal] = await exited;
    assert.equal(
      expired,
      false,
      "test cleanup must not pass as native quit protection",
    );
    assert.equal(committed, true);
    assert.equal(code, hang ? null : 0);
    assert.equal(signal, hang ? "SIGKILL" : null);
    console.log(
      JSON.stringify({
        actualProductionEntry: true,
        nativeExitFault: hang,
        code,
        signal,
        elapsedMs: Math.round(performance.now() - start),
        hostCleanupCompleted: true,
      }),
    );
    application = undefined;
    applicationChild = undefined;
  } finally {
    clearTimeout(timeout);
  }
}
try {
  let page = await launch();
  const saved = await page.evaluate(async () => {
    const bridge = window.morphzDesktop.application;
    const boot = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "platform.bootstrap",
    });
    if (!boot.ok) throw new Error("bootstrap refused");
    const projectId = crypto.randomUUID();
    const created = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "projects.create",
      params: {
        commandId: crypto.randomUUID(),
        projectId,
        title: "TEST 正常退出保留",
      },
      identityGeneration: boot.value.csrfToken,
    });
    if (!created.ok) throw new Error("project write refused");
    localStorage.setItem("TEST-desktop-quit-storage", "retained");
    return { projectId, centerId: boot.value.centerId };
  });
  await quit(false);
  page = await launch(true);
  const verify = async () =>
    page.evaluate(async () => {
      const bridge = window.morphzDesktop.application;
      const boot = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "platform.bootstrap",
      });
      const projects = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "projects.list",
        params: { status: "active" },
        identityGeneration: boot.ok ? boot.value.csrfToken : undefined,
      });
      if (!boot.ok || !projects.ok) throw new Error("reopen read refused");
      return {
        centerId: boot.value.centerId,
        projects: projects.value,
        storage: localStorage.getItem("TEST-desktop-quit-storage"),
      };
    });
  let restored = await verify();
  assert.equal(restored.centerId, saved.centerId);
  assert.equal(restored.storage, "retained");
  assert.ok(
    restored.projects.some((project) => project.id === saved.projectId),
  );
  await quit(true);
  page = await launch();
  restored = await verify();
  assert.equal(restored.centerId, saved.centerId);
  assert.equal(restored.storage, "retained");
  assert.ok(
    restored.projects.some((project) => project.id === saved.projectId),
  );
  await quit(false);
  console.log(
    "PASS actual Electron production quit, native-exit fault guard, two reopens and durable Platform/localStorage retention; no user profile or Runtime touched.",
  );
} finally {
  if (applicationChild) {
    const child = applicationChild;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  rmSync(fixture, { recursive: true });
}
