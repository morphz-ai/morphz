import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { applicationManifestSchema } from "../packages/core/src/applications.js";
import {
  canonicalInvokeIdentityBytes,
  canonicalJsonBytes,
  parseCognitiveAppDefinition,
  type CognitiveAppDefinition,
} from "../packages/cognitive-app-sdk/src/index.js";
import {
  packCognitiveNotesGui,
  startNotesGuiAuthor,
  expectNotesGuiStartupRefusal,
  openNotesGuiBrowser,
} from "./fixtures/cognitive-notes-gui-package.js";

let packed: ReturnType<typeof packCognitiveNotesGui>;
let old: CognitiveAppDefinition;
let gui: CognitiveAppDefinition;
const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const oldByteHash =
  "9fb7bbea47fb891a103fb342e4d2d7cb3d75f74221ba8bfaa1bcc79027af7acd";
const credential = "isolated_gui_author_credential_abcdefghijklmnopqrstuvwxyz";
const actor = {
  tenantId: "tenant",
  principalId: "alice",
  actantId: "human_alice",
  kind: "human" as const,
  source: { kind: "human" as const },
};
before(() => {
  packed = packCognitiveNotesGui();
  packed.build();
  old = parseCognitiveAppDefinition(
    JSON.parse(readFileSync(join(packed.root, "definition.json"), "utf8")),
  );
  gui = parseCognitiveAppDefinition(
    JSON.parse(
      readFileSync(join(packed.root, "dist/definition.gui.json"), "utf8"),
    ),
  );
});
after(() => packed?.close());
const guiPath = () => join(packed.root, "dist/definition.gui.json");
function rows(database: string, sql: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
function privateDatabase() {
  const directory = mkdtempSync(join(packed.directory, "author-data-"));
  const database = join(directory, "notes.sqlite"),
    config = join(directory, "bootstrap.json");
  writeFileSync(
    config,
    JSON.stringify({
      format: "cognitive-notes-bootstrap/v1",
      integrations: [
        {
          credentialSha256: digest(credential),
          issuer: "trusted_host",
          tenantId: "tenant",
          principalId: "alice",
          humanActantId: "human_alice",
          agentActantIds: [],
          projects: [{ projectId: "project_one", read: true, write: true }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  return { database, config };
}
async function post(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: (await response.json()) as any };
}
function reference(definition: CognitiveAppDefinition) {
  return {
    appId: definition.id,
    version: definition.version,
    definitionHash: digest(canonicalJsonBytes(definition)),
  };
}
function invoke(
  authority: object,
  definition: CognitiveAppDefinition,
  id: string | null,
  operationId: string,
  parameters: any,
  resources: { objectId: string; versionRef: string }[] = [],
) {
  const operation = definition.operations.find(
    (item) => item.id === operationId,
  )!;
  const request = {
    protocol: "morphz-domain/v1" as const,
    delegation: {
      issuer: "trusted_host",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: "invoke" as const,
      authority: authority as any,
      actor,
      projectId: "project_one",
      operationId,
      resources,
      command:
        id === null ? null : { commandId: id, requestHash: "0".repeat(64) },
    },
    parameters,
  };
  if (request.delegation.command)
    request.delegation.command.requestHash = digest(
      canonicalInvokeIdentityBytes(request, operation.effect, operation.scope),
    );
  return request;
}

test("independently packed optional GUI builds deterministically with only the public SDK and fixed compiler", () => {
  for (const file of [
    "gui/index.html",
    "gui/index.ts",
    "build-gui.mjs",
    "definition.json",
    "service.mjs",
  ])
    assert.ok(
      packed.files.includes(file),
      `Actual tarball must include ${file}`,
    );
  const package_ = JSON.parse(
    readFileSync(join(packed.sourcePackage, "package.json"), "utf8"),
  );
  assert.deepEqual(package_.dependencies, {
    "@morphz/cognitive-app-sdk": "0.3.0",
  });
  assert.deepEqual(package_.devDependencies, { esbuild: "0.28.2" });
  const files = ["notes.html", "definition.gui.json", "install.gui.json"];
  const first = files.map((file) =>
    readFileSync(join(packed.root, "dist", file)),
  );
  packed.build();
  files.forEach((file, i) =>
    assert.deepEqual(readFileSync(join(packed.root, "dist", file)), first[i]),
  );
  assert.equal(
    digest(readFileSync(join(packed.root, "definition.json"))),
    oldByteHash,
  );
  const carrier = JSON.parse(first[2]!.toString());
  const manifest = applicationManifestSchema.parse(carrier.manifest);
  assert.deepEqual(carrier.definition, gui);
  assert.equal(gui.version, "1.1.0");
  assert.equal(gui.ui!.packageVersion, "1.1.0");
  assert.equal(gui.ui!.sha256, digest(first[0]!));
  assert.equal(manifest.ui.type, "sandbox");
  if (manifest.ui.type !== "sandbox") assert.fail("Expected sandbox carrier");
  assert.deepEqual(Buffer.from(manifest.ui.html), first[0]);
  assert.ok(first[0]!.byteLength < 1_000_000);
  assert.deepEqual(manifest.permissions, ["input.compose"]);
  const { version: _a, ui: _b, ...before } = old;
  const { version: _c, ui: _d, ...after } = gui;
  assert.deepEqual(
    after,
    before,
    "All non-UI metadata and domain operations remain exact",
  );
  assert.doesNotMatch(manifest.ui.html, /<script\s+src=|<link\s/);
  new Script(manifest.ui.html.match(/<script>([\s\S]*)<\/script>/)![1]!, {
    filename: "actual-packed-author.js",
  });
  packed.checkGuiTypes();
  const builtPackage = packed.packBuilt();
  for (const path of [
    "dist/notes.html",
    "dist/definition.gui.json",
    "dist/install.gui.json",
  ])
    assert.ok(
      builtPackage[0]!.files.some((file) => file.path === path),
      `Actual built tarball includes ${path}`,
    );
});

test("actual author SQLite retains old bytes, notes, ACL, authority and receipts while explicitly supporting both exact releases", async () => {
  const { database, config } = privateDatabase();
  let service = await startNotesGuiAuthor(packed.root, database, config, false);
  const base = {
    instanceId: "host_instance",
    serviceId: service.ready.serviceId,
    dataAuthorityId: service.ready.dataAuthorityId,
  };
  const oldAuthority = { ...base, ...reference(old) };
  const create = invoke(
    oldAuthority,
    old,
    "original_old_command",
    "notes.create",
    { title: "旧原件", markdown: "旧正文\n保留原始换行" },
  );
  try {
    assert.equal(
      (
        await post(service.origin, "/describe", {
          protocol: "morphz-domain/v1",
          definition: reference(gui),
        })
      ).status,
      409,
      "Building GUI bytes does not opt the service in",
    );
    const saved = await post(service.origin, "/invoke", create);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, "committed");
    const snapshot = Object.fromEntries(
      [
        "metadata",
        "integrations",
        "allowed_agent_actants",
        "project_acl",
        "notes",
        "note_versions",
        "author_commands",
        "author_definitions",
      ].map((table) => [table, rows(database, `SELECT * FROM ${table}`)]),
    );
    await service.stop();
    service = await startNotesGuiAuthor(packed.root, database, config, true);
    assert.equal(service.ready.dataAuthorityId, base.dataAuthorityId);
    for (const table of Object.keys(snapshot).filter(
      (table) => table !== "author_definitions",
    ))
      assert.deepEqual(
        rows(database, `SELECT * FROM ${table}`),
        snapshot[table],
        table,
      );
    assert.deepEqual(
      rows(database, "SELECT * FROM author_definitions WHERE version='1.0.0'"),
      snapshot.author_definitions,
    );
    assert.equal(rows(database, "SELECT * FROM author_definitions").length, 2);
    for (const definition of [old, gui]) {
      const described = await post(service.origin, "/describe", {
        protocol: "morphz-domain/v1",
        definition: reference(definition),
      });
      assert.equal(described.status, 200);
      assert.deepEqual(described.body.definition, reference(definition));
    }
    assert.deepEqual(
      (await post(service.origin, "/invoke", create)).body,
      saved.body,
      "Old admitted request replays the same terminal fact",
    );
    const newAuthority = { ...base, ...reference(gui) };
    const listed = await post(
      service.origin,
      "/invoke",
      invoke(newAuthority, gui, null, "notes.list", { limit: 32 }),
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.objects[0].title, "旧原件");
    const original = saved.body.objects[0];
    const object = {
      objectId: original.objectId,
      versionRef: original.versionRef,
    };
    const revise = invoke(
      newAuthority,
      gui,
      "new_gui_command",
      "notes.revise",
      {
        objectId: object.objectId,
        baselineVersionRef: object.versionRef,
        title: "新修订",
        markdown: "新版正文",
      },
      [object],
    );
    const revised = await post(service.origin, "/invoke", revise);
    assert.equal(revised.status, 200);
    assert.equal(revised.body.status, "committed");
    assert.notEqual(revised.body.objects[0].versionRef, object.versionRef);
    const read = await post(service.origin, "/objects/read", {
      protocol: "morphz-domain/v1",
      delegation: {
        issuer: "trusted_host",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        purpose: "object-read",
        authority: newAuthority,
        actor,
        projectId: "project_one",
        resource: object,
      },
      object,
      maxBytes: 128_000,
    });
    assert.equal(read.status, 200);
    assert.equal(
      read.body.content.value.markdown,
      "旧正文\n保留原始换行",
      "GUI release does not silently substitute latest",
    );
    const beforeCold = rows(database, "SELECT * FROM author_definitions");
    await service.stop();
    service = await startNotesGuiAuthor(packed.root, database, config, false);
    assert.deepEqual(
      rows(database, "SELECT * FROM author_definitions"),
      beforeCold,
      "Headless restart leaves GUI fact intact but does not enable it",
    );
    assert.equal(
      (
        await post(service.origin, "/describe", {
          protocol: "morphz-domain/v1",
          definition: reference(gui),
        })
      ).status,
      409,
    );
  } finally {
    await service.stop();
  }
});

test("explicit GUI startup rejects a different release, package version, domain Schema or metadata before opening any database", async () => {
  const bytes = readFileSync(guiPath());
  try {
    for (const bad of [
      { ...gui, version: "1.2.0" },
      { ...gui, ui: { ...gui.ui, packageVersion: "1.2.0" } },
      { ...gui, title: "不同应用" },
      { ...gui, operations: gui.operations.slice(1) },
    ]) {
      writeFileSync(guiPath(), JSON.stringify(bad));
      const { database, config } = privateDatabase();
      await expectNotesGuiStartupRefusal(packed.root, database, config);
      assert.equal(
        existsSync(database),
        false,
        "Invalid GUI release cannot initialize or migrate author data",
      );
    }
  } finally {
    writeFileSync(guiPath(), bytes);
  }
});

test("a different GUI SHA under the same release is rejected atomically without rewriting old or new facts", async () => {
  const { database, config } = privateDatabase();
  const service = await startNotesGuiAuthor(
    packed.root,
    database,
    config,
    true,
  );
  await service.stop();
  const tables = [
    "metadata",
    "author_definitions",
    "integrations",
    "project_acl",
  ];
  const before = tables.map((table) =>
    rows(database, `SELECT * FROM ${table}`),
  );
  const bytes = readFileSync(guiPath());
  try {
    writeFileSync(
      guiPath(),
      JSON.stringify({ ...gui, ui: { ...gui.ui, sha256: "a".repeat(64) } }),
    );
    await expectNotesGuiStartupRefusal(packed.root, database, config);
    tables.forEach((table, i) =>
      assert.deepEqual(
        rows(database, `SELECT * FROM ${table}`),
        before[i],
        table,
      ),
    );
  } finally {
    writeFileSync(guiPath(), bytes);
  }
});

test("missing optional GUI release refuses only explicit --gui without creating data; default headless remains usable", async () => {
  const path = guiPath(),
    held = `${path}.held`;
  renameSync(path, held);
  try {
    const { database, config } = privateDatabase();
    await expectNotesGuiStartupRefusal(packed.root, database, config);
    assert.equal(existsSync(database), false);
    const service = await startNotesGuiAuthor(
      packed.root,
      database,
      config,
      false,
    );
    try {
      assert.equal(
        (
          await post(service.origin, "/describe", {
            protocol: "morphz-domain/v1",
            definition: reference(old),
          })
        ).status,
        200,
      );
      assert.equal(
        rows(database, "SELECT * FROM author_definitions").length,
        1,
      );
    } finally {
      await service.stop();
    }
  } finally {
    renameSync(held, path);
  }
});

test("Notes GUI diagnostics are bounded and never replace the original failure", async () => {
  const { notesGuiDiagnostic } =
    await import("./fixtures/cognitive-notes-gui-package.js");
  assert.deepEqual(await notesGuiDiagnostic(() => new Promise(() => {}), 10), {
    unavailable: "Diagnostic read timed out",
  });
  assert.deepEqual(
    await notesGuiDiagnostic(() =>
      Promise.reject(new Error("controlled diagnostic failure")),
    ),
    { unavailable: "controlled diagnostic failure" },
  );
});

test("Notes GUI cleanup preserves the original failure but still rejects a successful test's failed cleanup", async (t) => {
  const { notesGuiCleanup } =
    await import("./fixtures/cognitive-notes-gui-package.js");
  const original = new Error("controlled original failure");
  const secondary = new Error("controlled cleanup failure");
  const logs = t.mock.method(console, "error", () => {});
  await assert.rejects(
    (async () => {
      try {
        throw original;
      } finally {
        await notesGuiCleanup(() => Promise.reject(secondary), {
          preserveFailure: true,
        });
      }
    })(),
    (error) => error === original,
  );
  assert.equal(logs.mock.calls.length, 1);
  assert.equal(logs.mock.calls[0]!.arguments[1], secondary);
  await assert.rejects(
    notesGuiCleanup(() => Promise.reject(secondary)),
    (error) => error === secondary,
  );
});

test(
  "Node timeout cancels the actual notes GUI fixture and exits failed without an owned Browser or server",
  { timeout: 45_000 },
  async () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      MORPHZ_TEST_NOTES_GUI_ABORT_ROOT: packed.root,
    };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-isolation=none",
        "--test-reporter=tap",
        fileURLToPath(
          new URL(
            "./fixtures/cognitive-notes-gui-abort-child.ts",
            import.meta.url,
          ),
        ),
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      forced = false;
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    const guard = setTimeout(() => {
      forced = true;
      child.kill("SIGTERM");
    }, 40_000);
    const force = setTimeout(() => child.kill("SIGKILL"), 43_000);
    try {
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(forced, false, output);
      assert.equal(result.signal, null, output);
      assert.equal(result.code, 1, output);
      assert.match(output, /test timed out after 1000ms/);
      const ready = output.match(/NOTES_GUI_ABORT_READY (\{[^\n]+\})/);
      assert.ok(ready, output);
      assert.match(output, /NOTES_GUI_ABORT_CLOSED \{"connected":false\}/);
      const origin = JSON.parse(ready[1]!).origin;
      await assert.rejects(
        fetch(origin, { signal: AbortSignal.timeout(1_000) }),
        "Owned HTTP listener must also be closed, not just detached from the test",
      );
      console.info("Controlled notes GUI abort receipt", {
        ready: true,
        testTimeoutMs: 1_000,
        exitCode: result.code,
        forced,
        browserConnected: false,
        serverClosed: true,
      });
    } finally {
      clearTimeout(guard);
      clearTimeout(force);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
  },
);

test(
  "ACTUAL packed GUI/shared Document/SDK/private port: explicit clicks and exact opaque references (controlled business, not SQL)",
  { timeout: 60_000 },
  async (t) => {
    const f = await openNotesGuiBrowser(
      readFileSync(join(packed.root, "dist/notes.html"), "utf8"),
      gui,
      { signal: t.signal },
    );
    let failed = false;
    try {
      const { page, guest } = f;
      const requests = () =>
        page.evaluate(() => Reflect.get(window, "authorHost").report.requests);
      assert.deepEqual(
        await requests(),
        [],
        "Startup has no business read/write or navigation",
      );
      assert.equal(await guest.locator("#list li").count(), 0);
      await guest.locator("#refresh").click();
      await guest.locator("#list button").first().waitFor();
      assert.deepEqual(await requests(), [
        {
          method: "invoke",
          operationId: "notes.list",
          parameters: { limit: 32 },
          resources: [],
          commandId: null,
        },
      ]);
      await guest.locator("#list button").first().click();
      assert.equal(
        (await requests()).length,
        1,
        "Selection is not an automatic original read",
      );
      await guest.locator("#next").click();
      await guest.waitForFunction(
        () => document.querySelectorAll("#list li").length === 2,
      );
      assert.deepEqual((await requests())[1].parameters, {
        limit: 32,
        afterObjectId: "cursor/second",
      });
      await guest.locator("#read").click();
      await guest.waitForFunction(
        () => document.getElementById("heading")?.textContent === "受控原文",
      );
      const original = { objectId: "原件/ 😀\n", versionRef: "v:opaque/first" };
      assert.deepEqual((await requests())[2], {
        method: "readObject",
        object: original,
        maxBytes: 128_000,
      });
      assert.equal(
        await guest.locator("#original").textContent(),
        '原文第一行\n<img src=x onerror="globalThis.authorInjected=true">',
      );
      assert.equal(await guest.locator("#original img").count(), 0);
      assert.equal(
        await guest.evaluate(() => Reflect.get(window, "authorInjected")),
        undefined,
      );
      await guest.locator("#open").click();
      await guest.waitForFunction(() =>
        document.getElementById("status")?.textContent?.includes("已确认打开"),
      );
      await guest.locator("#compose").click();
      await guest.waitForFunction(() =>
        document.getElementById("status")?.textContent?.includes("尚未发送"),
      );
      await guest.locator("#remember").click();
      await guest.waitForFunction(() =>
        document
          .getElementById("status")
          ?.textContent?.includes("正文、草稿和命令 ID"),
      );
      assert.deepEqual((await requests()).slice(3), [
        { method: "openObject", object: original },
        {
          method: "compose",
          text: "请基于这份原文整理要点。",
          object: original,
        },
        {
          method: "saveState",
          expectedRevision: 1,
          state: { object: original, view: "reading" },
        },
      ]);
      assert.deepEqual(
        (await page.evaluate(() => Reflect.get(window, "authorHost").context()))
          .view.state,
        { object: original, view: "reading" },
      );
      const report = await page.evaluate(
        () => Reflect.get(window, "authorHost").report,
      );
      assert.equal(report.connects, 1);
      assert.equal(report.accepted.length, 1);
      assert.equal(report.accepted[0].origin, new URL(page.url()).origin);
      assert.equal(report.accepted[0].source, true);
      assert.equal(report.businessWindow, 0);
      assert.equal(await guest.evaluate(() => location.origin), "null");
      assert.deepEqual(f.errors, []);
      assert.deepEqual(
        f.requests.map((url) => new URL(url).pathname).sort(),
        ["/", "/guest", "/host.js"],
        "No author HTTP/CDN/script/font/image/business request",
      );
      await page.screenshot({
        path: "/tmp/morphz-notes-gui-light-wide-oct06.png",
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.close({ preserveFailure: failed });
    }
  },
);

test(
  "ACTUAL author editor keeps dirty input across context and failed reads; explicit discard and responsive paint",
  { timeout: 60_000 },
  async (t) => {
    const f = await openNotesGuiBrowser(
      readFileSync(join(packed.root, "dist/notes.html"), "utf8"),
      gui,
      { signal: t.signal },
    );
    let failed = false;
    try {
      const { page, guest } = f;
      await guest.locator("#new").click();
      await guest.locator("#title").fill("尚未保存的标题");
      await guest.locator("#markdown").fill("私有草稿\n不进宿主 state");
      await page.evaluate(() => Reflect.get(window, "authorHost").theme());
      await guest.waitForFunction(
        () => document.documentElement.dataset.appearance === "dark",
      );
      assert.equal(
        await guest.locator("#markdown").inputValue(),
        "私有草稿\n不进宿主 state",
      );
      await guest.locator("#new").click();
      await guest.locator("#discard").waitFor({ state: "visible" });
      assert.equal(
        await guest.evaluate(() => document.activeElement?.id),
        "keep",
      );
      await guest.locator("#keep").click();
      assert.equal(
        await guest.locator("#title").inputValue(),
        "尚未保存的标题",
      );
      await guest.locator("#refresh").click();
      await guest.locator("#list button").first().waitFor();
      await guest.locator("#list button").first().click();
      await page.evaluate(() => {
        Reflect.get(window, "authorHost").report.readUnavailable = true;
      });
      await guest.locator("#read").click();
      await guest.locator("#discard-confirm").click();
      await guest.waitForFunction(() =>
        document.getElementById("status")?.textContent?.includes("未获确认"),
      );
      assert.equal(
        await guest.locator("#title").inputValue(),
        "尚未保存的标题",
        "Failed replacement read retains the draft even after discard confirmation",
      );
      assert.equal(
        await guest.locator("#markdown").inputValue(),
        "私有草稿\n不进宿主 state",
      );
      assert.equal(await guest.locator("#save").isDisabled(), false);
      await page.setViewportSize({ width: 380, height: 700 });
      assert.equal(
        await guest.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "/tmp/morphz-notes-gui-dark-narrow-oct06.png",
      });
      const requests = await page.evaluate(
        () => Reflect.get(window, "authorHost").report.requests,
      );
      assert.equal(
        requests.filter(
          (request: { method: string }) => request.method === "saveState",
        ).length,
        0,
      );
      assert.deepEqual(f.errors, []);
      await guest.locator("#new").click();
      await guest.locator("#discard-confirm").click();
      assert.equal(await guest.locator("#title").inputValue(), "");
      assert.equal(await guest.locator("#markdown").inputValue(), "");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.close({ preserveFailure: failed });
    }
  },
);

test(
  "ACTUAL author unknown write keeps the original ID/draft with no retry; explicit status/recovery settle the same command",
  { timeout: 60_000 },
  async (t) => {
    const f = await openNotesGuiBrowser(
      readFileSync(join(packed.root, "dist/notes.html"), "utf8"),
      gui,
      { signal: t.signal },
    );
    let failed = false;
    try {
      const { page, guest } = f;
      f.phase("create new draft");
      await guest.locator("#new").click();
      await guest.locator("#title").fill("新的原件");
      await guest.locator("#markdown").fill("创建正文\n精确保留");
      f.phase("first save: click");
      await guest.locator("#save").click();
      try {
        f.phase("first save: await unknown command facts");
        await guest.waitForFunction(() =>
          document
            .getElementById("status")
            ?.textContent?.includes("结果尚未确认"),
        );
      } catch (error) {
        await f.witness("Controlled author first-write witness");
        throw error;
      }
      f.phase("assert original unknown command ID and draft");
      const id = await guest.locator("#command").inputValue();
      assert.match(id, /^[a-f0-9-]{36}$/);
      assert.equal(
        await guest.locator("#command").getAttribute("readonly"),
        "",
      );
      assert.equal(
        await guest.locator("#markdown").inputValue(),
        "创建正文\n精确保留",
      );
      assert.equal(await guest.locator("#save").isDisabled(), true);
      assert.equal(await guest.locator("#new").isDisabled(), true);
      f.phase("explicit status: click and await idle");
      await guest.locator("#status-command").click();
      await guest.waitForFunction(
        () =>
          !(document.getElementById("recover") as HTMLButtonElement).disabled,
      );
      f.phase("unknown recovery: click and await idle");
      await guest.locator("#recover").click();
      await guest.waitForFunction(
        () =>
          !(document.getElementById("recover") as HTMLButtonElement).disabled,
      );
      assert.equal(await guest.locator("#command").inputValue(), id);
      const before = await page.evaluate(
        () => Reflect.get(window, "authorHost").report.requests,
      );
      assert.deepEqual(
        before.map((request: { method: string }) => request.method),
        ["invoke", "commandStatus", "recoverReceipt"],
      );
      assert.ok(
        before.every(
          (request: { commandId: string }) => request.commandId === id,
        ),
      );
      f.phase(
        "committed recovery: set controlled receipt, click and await exact original",
      );
      await page.evaluate(() => {
        Reflect.get(window, "authorHost").report.writeState = "committed";
      });
      await guest.locator("#recover").click();
      await guest.waitForFunction(
        () => document.getElementById("heading")?.textContent === "新的原件",
      );
      assert.equal(
        await guest.locator("#original").textContent(),
        "创建正文\n精确保留",
      );
      const after = await page.evaluate(
        () => Reflect.get(window, "authorHost").report.requests,
      );
      assert.equal(
        after.filter(
          (request: { method: string }) => request.method === "invoke",
        ).length,
        1,
        "Recovery does not resend or generate a second command",
      );
      assert.equal(after.at(-1).commandId, id);
      f.phase("explicit revision: edit and fill");
      await guest.locator("#edit").click();
      await guest.locator("#markdown").fill("显式修订");
      f.phase("explicit revision: click and await confirmation");
      await guest.locator("#save").click();
      await page.waitForFunction(
        (previousId) =>
          Reflect.get(window, "authorHost").report.requests.some(
            (request: {
              method: string;
              operationId?: string;
              commandId?: string;
            }) =>
              request.method === "invoke" &&
              request.operationId === "notes.revise" &&
              request.commandId !== previousId,
          ),
        id,
      );
      await guest.waitForFunction(
        () =>
          document.getElementById("original")?.textContent === "显式修订" &&
          document
            .getElementById("status")
            ?.textContent?.includes("作者已确认保存"),
      );
      f.phase("assert exact revision resources and fresh command ID");
      const revise = (
        await page.evaluate(
          () => Reflect.get(window, "authorHost").report.requests,
        )
      ).at(-1);
      assert.equal(revise.operationId, "notes.revise");
      assert.deepEqual(revise.resources, [
        { objectId: "created/原件", versionRef: "created:v1" },
      ]);
      assert.deepEqual(revise.parameters, {
        objectId: "created/原件",
        baselineVersionRef: "created:v1",
        title: "新的原件",
        markdown: "显式修订",
      });
      assert.notEqual(revise.commandId, id);
      assert.deepEqual(f.errors, []);
    } catch (error) {
      failed = true;
      await f.witness("Controlled author command/recovery witness");
      throw error;
    } finally {
      await f.close({ preserveFailure: failed });
    }
  },
);

test(
  "ACTUAL dirty editor must confirm before opening or composing elsewhere; retired Document cannot send or erase its draft",
  { timeout: 60_000 },
  async (t) => {
    const f = await openNotesGuiBrowser(
      readFileSync(join(packed.root, "dist/notes.html"), "utf8"),
      gui,
      { signal: t.signal },
    );
    let failed = false;
    try {
      const { page, guest } = f;
      await guest.locator("#refresh").click();
      await guest.locator("#list button").first().click();
      await guest.locator("#read").click();
      await guest.waitForFunction(
        () => document.getElementById("heading")?.textContent === "受控原文",
      );
      await guest.locator("#edit").click();
      await guest.locator("#markdown").fill("不能静默离开的编辑");
      await guest.locator("#open").click();
      assert.equal(
        await guest.locator("#discard").isVisible(),
        true,
        "Opening another workspace surface can retire this editor and requires explicit consent",
      );
      const requests = () =>
        page.evaluate(() => Reflect.get(window, "authorHost").report.requests);
      assert.equal(
        (await requests()).length,
        2,
        "No open request before discard consent",
      );
      await guest.locator("#keep").click();
      assert.equal(
        await guest.locator("#markdown").inputValue(),
        "不能静默离开的编辑",
      );
      await guest.locator("#compose").click();
      assert.equal(await guest.locator("#discard").isVisible(), true);
      await guest.locator("#keep").click();
      assert.equal(
        (await requests()).length,
        2,
        "No compose request before discard consent",
      );
      await guest.locator("#open").click();
      await guest.locator("#discard-confirm").click();
      await guest.waitForFunction(() =>
        document.getElementById("status")?.textContent?.includes("已确认打开"),
      );
      assert.equal((await requests()).length, 3);
      await guest.evaluate(() => {
        const root = document.documentElement,
          doctype = document.doctype!;
        root.remove();
        doctype.remove();
        document.append(doctype, root);
      });
      await guest.locator("#refresh").click();
      assert.equal(await guest.locator("#refresh").isDisabled(), true);
      assert.equal(
        await guest.locator("#markdown").inputValue(),
        "不能静默离开的编辑",
      );
      assert.equal(
        (await requests()).length,
        3,
        "A retired Document does not reclaim the facade or send a new operation",
      );
      assert.deepEqual(f.errors, []);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await f.close({ preserveFailure: failed });
    }
  },
);
