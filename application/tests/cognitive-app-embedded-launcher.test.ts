import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import {
  parseCognitiveAppCatalog,
  parseCognitiveAppInstalled,
} from "../packages/core/src/cognitive-app-api.js";
import { cognitiveAppLaunchConfig } from "../packages/application/src/cognitive-app-launch-config.js";
import { CognitiveAppServiceError } from "../packages/application/src/cognitive-app-service.js";

test("trusted launch config imports only an explicit absolute binding path, without reading or creating files or exposing a private error", () => {
  assert.equal(cognitiveAppLaunchConfig({}), undefined);
  assert.equal(
    cognitiveAppLaunchConfig({ MORPHZ_APP_COGNITIVE_BINDINGS_FILE: "" }),
    undefined,
  );
  const filename = join(
    tmpdir(),
    "morphz-cognitive-nonexistent-operator-config.json",
  );
  assert.deepEqual(
    cognitiveAppLaunchConfig({
      MORPHZ_APP_COGNITIVE_BINDINGS_FILE: filename,
      MORPHZ_APP_COGNITIVE_CREDENTIAL_SAMPLE: "private",
    }),
    { bindingsFile: filename },
  );
  assert.throws(
    () =>
      cognitiveAppLaunchConfig({
        MORPHZ_APP_COGNITIVE_BINDINGS_FILE: "private/path/secret.json",
      }),
    (error) =>
      error instanceof CognitiveAppServiceError &&
      error.reason === "unavailable" &&
      !error.message.includes("private") &&
      !Reflect.has(error, "cause"),
  );
});

// Actual embedded application, shared domains, HPA and durable SQLite. This
// isolated automated fixture is not native acceptance of the user's original App.
test("actual embedded launcher wires the one shared cognitive Service before Runtime and retains exact installation on reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-embedded-"));
  const profile = join(directory, "profile");
  const previousEnv = process.env.MORPHZ_APP_ENV_FILE;
  const previousBinding = process.env.MORPHZ_APP_COGNITIVE_BINDINGS_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  delete process.env.MORPHZ_APP_COGNITIVE_BINDINGS_FILE;
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  const definition = JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  );
  try {
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      centerId: string;
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const before = parseCognitiveAppCatalog(
      await host.connection.call("cognitive-apps.list", { limit: 10 }, options),
    );
    assert.equal(before.versions.length, 0);
    const installed = parseCognitiveAppInstalled(
      await host.connection.call(
        "cognitive-apps.install",
        { definition },
        options,
      ),
    );
    assert.equal(installed.appId, definition.id);
    assert.equal(installed.version, definition.version);
    await host.connection.call(
      "cognitive-apps.grant",
      {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
      },
      options,
    );
    const catalog = parseCognitiveAppCatalog(
      await host.connection.call("cognitive-apps.list", { limit: 10 }, options),
    );
    assert.equal(catalog.versions.length, 1);
    assert.equal(catalog.versions[0]!.definitionHash, installed.definitionHash);
    assert.equal(catalog.connections.length, 0);
    assert.equal(
      host.manifestPath,
      undefined,
      "No Runtime tools or HTTP app service are required for management.",
    );
    await host.close();
    host = await openEmbeddedApplication(directory, profile);
    const reopened = (await host.connection.call("platform.bootstrap")) as {
      centerId: string;
      csrfToken: string;
    };
    assert.equal(reopened.centerId, boot.centerId);
    const actual = parseCognitiveAppCatalog(
      await host.connection.call(
        "cognitive-apps.list",
        { limit: 10 },
        { identityGeneration: reopened.csrfToken },
      ),
    );
    assert.deepEqual(actual, catalog);
    assert.equal(
      readdirSync(directory).some((name) =>
        /cognitive.*binding|credential/.test(name),
      ),
      false,
    );
  } finally {
    await host?.close();
    if (previousEnv === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = previousEnv;
    if (previousBinding === undefined)
      delete process.env.MORPHZ_APP_COGNITIVE_BINDINGS_FILE;
    else process.env.MORPHZ_APP_COGNITIVE_BINDINGS_FILE = previousBinding;
    rmSync(directory, { recursive: true, force: true });
  }
});
