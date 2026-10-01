import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const embedded = process.argv.includes("--embedded");
const port = Number(process.env.MORPHZ_APP_DESKTOP_TEST_PORT ?? 65420);
if (!embedded) {
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const origin = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
    throw new Error(`${port} is already in use`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already in use"))
      throw error;
  }
}

const root = mkdtempSync(join(tmpdir(), "morphz-platform-desktop-"));
const origin = `http://127.0.0.1:${port}`;
// This smoke owns an isolated center. Never inherit a developer's configured
// Platform, app-private PostgreSQL or cloud byte-store destinations.
const isolatedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("MORPHZ_APP_") &&
      !key.startsWith("MORPHZWORK_") &&
      key !== "DOUBAO_API_KEY",
  ),
);
const service = embedded
  ? null
  : spawn(process.execPath, ["dist/service/apps/service/src/main.js"], {
      env: {
        ...isolatedEnv,
        MORPHZ_APP_PORT: String(port),
        MORPHZ_APP_DATA_DIR: join(root, "data"),
        MORPHZ_APP_ENV_FILE: "",
      },
      stdio: "pipe",
    });
let serviceErrors = "";
service?.stderr.on("data", (chunk) => {
  serviceErrors += String(chunk).slice(0, 2000);
});
const electronEnv = {
  ...isolatedEnv,
  MORPHZ_APP_PROFILE: join(root, "profile"),
  MORPHZ_APP_DATA_DIR: join(root, "data"),
  MORPHZ_APP_ENV_FILE: "",
};
delete electronEnv.ELECTRON_RUN_AS_NODE;
let app;
let electronErrors = "";
try {
  if (service) {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (
          await fetch(`${origin}/api/health`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
        if (ready) break;
      } catch {}
      await delay(100);
    }
    assert.ok(ready, `service did not start: ${serviceErrors}`);
  }
  const launch = async () => {
    const opened = await _electron.launch({
      args: [
        "apps/desktop/main.cjs",
        ...(embedded ? [] : [`--center=${origin}`]),
      ],
      env: electronEnv,
    });
    opened.process().stderr?.on("data", (chunk) => {
      electronErrors += String(chunk).slice(0, 4000);
    });
    return opened;
  };
  const mainWindow = async (opened) => {
    if (!embedded) return opened.firstWindow();
    // The real local entry briefly opens hidden preference-recovery windows.
    // firstWindow() can select one of those instead of the product window.
    await expect
      .poll(
        () => opened.windows().some((page) => page.url() === "morphz://app/"),
        { timeout: 20_000 },
      )
      .toBe(true);
    return opened.windows().find((page) => page.url() === "morphz://app/");
  };
  app = await launch();
  let window = await mainWindow(app);
  const browserErrors = [];
  const watch = (page) =>
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
  watch(window);
  try {
    await expect(
      window.getByRole("heading", { name: "工作台", exact: true }),
    ).toBeVisible();
  } catch (error) {
    const details = await window
      .evaluate(async () => {
        const invoke = window.morphzDesktop?.application?.invoke;
        if (!invoke)
          return {
            text: document.body.innerText.slice(0, 2000),
            invoke: false,
          };
        const boot = await invoke({
          id: crypto.randomUUID(),
          method: "platform.bootstrap",
        });
        const generation = boot.ok ? boot.value.csrfToken : "";
        const probes = [];
        for (const method of [
          "runtime.navigation",
          "spaces.ensure",
          "projects.list",
          "conversations.navigation",
          "tasks.list",
          "content.list",
        ]) {
          const params =
            method === "projects.list"
              ? { status: "active", limit: 100 }
              : method === "conversations.navigation"
                ? { limit: 100 }
                : method === "tasks.list"
                  ? { owner: "all", limit: 100 }
                  : method === "content.list"
                    ? { limit: 100 }
                    : undefined;
          const result = await invoke({
            id: crypto.randomUUID(),
            method,
            params,
            identityGeneration: generation,
          });
          probes.push([method, result.ok ? "ok" : result.error]);
        }
        return {
          text: document.body.innerText.slice(0, 2000),
          boot: boot.ok ? "ok" : boot.error,
          probes,
        };
      })
      .catch((diagnosticError) => ({
        diagnosticError: String(diagnosticError),
        exitCode: app.process().exitCode,
      }));
    throw new Error(
      `Desktop boot failed: ${JSON.stringify({ details, browserErrors, serviceErrors, electronErrors })}`,
      { cause: error },
    );
  }
  const title = "TEST Platform Desktop 重启持久化";
  await window.getByRole("button", { name: "新建项目" }).click();
  await window.getByLabel("项目名称").fill(title);
  await window.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    window.locator(".sidebar-project-list").getByText(title, { exact: true }),
  ).toBeVisible();
  const browserPage = await window.evaluate(async (projectTitle) => {
    const invoke = async (method, params, identityGeneration) => {
      const reply = await window.morphzDesktop.application.invoke({
        id: crypto.randomUUID(),
        method,
        params,
        ...(identityGeneration ? { identityGeneration } : {}),
      });
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.value;
    };
    const boot = await invoke("platform.bootstrap");
    const projects = await invoke(
      "projects.list",
      { status: "active", limit: 50 },
      boot.csrfToken,
    );
    const project = projects.find((entry) => entry.title === projectTitle);
    if (!project) throw new Error("Platform browser project missing");
    const page = await window.morphzDesktop.browser.open({
      projectId: project.id,
      url: "https://example.com/",
    });
    await window.morphzDesktop.browser.close(page.pageId);
    return page;
  }, title);
  assert.equal(browserPage.url, "https://example.com/");
  assert.equal(browserPage.artifactId, null);
  await window.getByRole("button", { name: "查看项目内容" }).click();
  try {
    await expect(
      window.getByLabel("其他内容创作", { exact: true }),
    ).toBeVisible({ timeout: 5000 });
  } catch (error) {
    const diagnostics = await window.evaluate(() => ({
      text: document.body.innerText.slice(0, 2500),
      buttons: Array.from(document.querySelectorAll("button"))
        .map((button) => ({
          text: button.textContent?.trim(),
          label: button.getAttribute("aria-label"),
        }))
        .filter((button) => button.text || button.label)
        .slice(0, 50),
    }));
    throw new Error(
      `项目内容入口未显示创作操作：${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  await window.getByLabel("其他内容创作", { exact: true }).click();
  await window.getByRole("button", { name: "手动写文档" }).click();
  const documentTitle = "TEST Platform 私库原件";
  await window.getByLabel("新对象标题").fill(documentTitle);
  await window
    .getByLabel("新文档正文")
    .fill("# 原件验证\n\n重启后仍为同一文档。");
  await window.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    window.getByRole("heading", { name: documentTitle, exact: true }),
  ).toBeVisible();
  await app.close();
  app = await launch();
  window = await mainWindow(app);
  watch(window);
  await expect(
    window.locator(".sidebar-project-list").getByText(title, { exact: true }),
  ).toBeVisible();
  await window.getByRole("button", { name: title, exact: true }).click();
  await window.getByRole("button", { name: "查看项目内容" }).click();
  await expect(
    window.getByRole("heading", { name: documentTitle, exact: true }),
  ).toBeVisible();
  const stored = await window.evaluate(
    async ({ targetTitle, projectTitle }) => {
      const bridge = window.morphzDesktop.application;
      const call = async (method, params, identityGeneration) => {
        const reply = await bridge.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          ...(identityGeneration ? { identityGeneration } : {}),
        });
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.value;
      };
      const boot = await call("platform.bootstrap");
      const projects = await call(
        "projects.list",
        { status: "active", limit: 50 },
        boot.csrfToken,
      );
      const project = projects.find((entry) => entry.title === projectTitle);
      if (!project) throw new Error("created project missing from Platform");
      const entries = await call("content.list", { limit: 50 }, boot.csrfToken);
      const matches = entries.filter((entry) => entry.title === targetTitle);
      const original =
        matches.length === 1
          ? await call(
              "objects.read",
              { contentId: matches[0].id },
              boot.csrfToken,
            )
          : null;
      const taskId = crypto.randomUUID();
      await call(
        "tasks.create",
        {
          commandId: taskId,
          taskId,
          projectId: project.id,
          title: "TEST Platform 事项入口",
          assigneeId: boot.actantId,
        },
        boot.csrfToken,
      );
      return { matches, original, projectId: project.id, taskId };
    },
    { targetTitle: documentTitle, projectTitle: title },
  );
  assert.equal(
    stored.matches.length,
    1,
    "one directory entry must locate one original",
  );
  assert.equal(stored.matches[0].appId, "morphz.objects");
  assert.equal(
    stored.original?.content?.markdown,
    "# 原件验证\n\n重启后仍为同一文档。",
  );
  await window
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /事项/ })
    .click();
  await expect(
    window.getByText("TEST Platform 事项入口", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await window.getByLabel("事项状态", { exact: true }).selectOption("active");
  try {
    await expect(window.getByLabel("事项状态", { exact: true })).toHaveValue(
      "active",
    );
  } catch (error) {
    const diagnostics = await window.evaluate(() => ({
      text: document.body.innerText.slice(0, 2500),
      state: document.querySelector('[aria-label="事项状态"]')?.outerHTML,
    }));
    const direct = await window.evaluate(async (taskId) => {
      const bridge = window.morphzDesktop.application;
      const boot = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "platform.bootstrap",
      });
      return bridge.invoke({
        id: crypto.randomUUID(),
        method: "tasks.versions",
        params: { taskId, limit: 100 },
        identityGeneration: boot.value.csrfToken,
      });
    }, stored.taskId);
    throw new Error(
      `Task status change failed: ${JSON.stringify({ diagnostics, browserErrors, serviceErrors, direct })}`,
      { cause: error },
    );
  }
  await app.close();
  app = await launch();
  window = await mainWindow(app);
  await window
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /事项/ })
    .click();
  await expect(window.getByLabel("事项状态", { exact: true })).toHaveValue(
    "active",
  );
  const pdf = [...readFileSync("tests/fixtures/reader.pdf")];
  const imported = await window.evaluate(
    async ({ projectId, data }) => {
      const bridge = window.morphzDesktop.application;
      const boot = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "platform.bootstrap",
      });
      if (!boot.ok) throw new Error(boot.error.message);
      const result = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "reader.import",
        identityGeneration: boot.value.csrfToken,
        params: {
          commandId: crypto.randomUUID(),
          projectId,
          relativePath: "TEST Desktop 原件.pdf",
          data: new Uint8Array(data),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    { projectId: stored.projectId, data: pdf },
  );
  assert.ok(imported.entityId);
  await window
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await window.getByRole("button", { name: "应用启动台", exact: true }).click();
  await window
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  await window.getByRole("button", { name: "阅读：TEST Desktop 原件" }).click();
  await expect(
    window.locator(".reading-app:visible .reader-pdf-page canvas"),
  ).toBeVisible();
  const pdfReader = window.locator(".reading-app:visible");
  await pdfReader
    .getByRole("button", { name: "阅读设置", exact: true })
    .click();
  const pdfSettings = pdfReader.getByRole("complementary", {
    name: "阅读设置",
  });
  await expect(pdfSettings.getByLabel("阅读字号", { exact: true })).toHaveCount(
    0,
  );
  await expect(pdfSettings.getByLabel("阅读字体", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    pdfSettings.getByLabel("阅读主题", { exact: true }),
  ).toBeVisible();
  await app.close();
  app = await launch();
  window = await mainWindow(app);
  await window
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await window.getByRole("button", { name: "应用启动台", exact: true }).click();
  await window
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  await window.getByRole("button", { name: "阅读：TEST Desktop 原件" }).click();
  await expect(
    window.locator(".reading-app:visible .reader-pdf-page canvas"),
  ).toBeVisible();
  const tablesIn = (name) => {
    const database = new DatabaseSync(join(root, "data", name), {
      readOnly: true,
    });
    try {
      return new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
      );
    } finally {
      database.close();
    }
  };
  const transport = tablesIn("workspace.sqlite");
  for (const legacy of ["workspace", "commands", "assets"])
    assert.equal(
      transport.has(legacy),
      false,
      `${legacy} is not a live Desktop store`,
    );
  assert.equal(transport.has("runtime_deliveries"), true);
  const platform = tablesIn("platform.sqlite");
  const objects = tablesIn("objects.sqlite");
  const scripts = tablesIn("script-studio.sqlite");
  const reader = tablesIn("reader.sqlite");
  assert.equal(platform.has("projects"), true);
  assert.equal(platform.has("object_versions"), false);
  assert.equal(objects.has("object_versions"), true);
  assert.equal(objects.has("projects"), false);
  assert.equal(scripts.has("script_productions"), true);
  assert.equal(scripts.has("projects"), false);
  assert.equal(reader.has("books"), true);
  assert.equal(reader.has("projects"), false);
  console.log(
    `PASS: Platform ${embedded ? "embedded" : "remote"} Desktop project, document, task status and PDF original survive restart`,
  );
} finally {
  await app?.close().catch(() => {});
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = new Promise((resolve) => service.once("exit", resolve));
    service.kill("SIGTERM");
    await Promise.race([exited, delay(2000)]);
    if (service.exitCode === null && service.signalCode === null) {
      service.kill("SIGKILL");
      await exited;
    }
  }
  rmSync(root, { recursive: true, force: true });
}
