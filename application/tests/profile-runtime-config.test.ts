import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../packages/application/src/runtime.js";
import { LocalRuntimeConnection } from "../packages/application/src/runtime-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";

test("Host私有管理凭据：环境注入仍要求可信配置，重连只保留原私有文件值、不复制环境或返回UI", async () => {
  const environmentSentinel = "ENV_PRIVATE_PROFILE_SENTINEL",
    fileSentinel = "FILE_PRIVATE_PROFILE_SENTINEL";
  const prior = process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN;
  process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN = environmentSentinel;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer local-owner-token");
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/api/status"
          ? { model: "fixture-model", identity_mode: "default" }
          : { model: "fixture-model", models: ["fixture-model"] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const mode of ["first", "env", "file"] as const) {
      const existingFileToken = mode === "file" ? fileSentinel : undefined;
      const root = mkdtempSync(join(tmpdir(), "morphz-profile-config-")),
        filename = join(root, "runtime.json"),
        store = new WorkspaceStore(join(root, "workspace.sqlite"), {
          mode: "transport",
        });
      const source = {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        token: "local-owner-token",
        namespace: randomUUID(),
        ...(existingFileToken ? { operatorToken: existingFileToken } : {}),
      };
      if (mode !== "first")
        writeFileSync(filename, JSON.stringify(source), { mode: 0o600 });
      try {
        let prepared = 0;
        const connection = new LocalRuntimeConnection(
          root,
          store,
          async (configuration) => {
            prepared++;
            assert.equal(configuration.operatorToken, environmentSentinel);
            return { commit() {}, async discard() {} };
          },
        );
        const before = connection.details();
        assert.equal(
          loadRuntimeConfig(root)?.operatorToken,
          mode === "first" ? undefined : environmentSentinel,
        );
        const result = await connection.configure(
          {
            endpoint: source.url,
            token: source.token,
            expectedVersion: before.version,
          },
          () => {},
          new AbortController().signal,
        );
        assert.equal(prepared, 1);
        assert.equal(
          JSON.stringify(result).includes(environmentSentinel),
          false,
        );
        assert.equal(JSON.stringify(result).includes(fileSentinel), false);
        const actual = JSON.parse(readFileSync(filename, "utf8")) as {
          operatorToken?: string;
        };
        assert.equal(actual.operatorToken, existingFileToken);
        await assert.rejects(
          connection.configure(
            {
              endpoint: source.url,
              token: source.token,
              expectedVersion: connection.details().version,
              operatorToken: "renderer-cannot-grant",
            },
            () => {},
            new AbortController().signal,
          ),
        );
        assert.equal(prepared, 1);
        const syntaxSentinel = "RAW_JSON_PRIVATE_SENTINEL";
        writeFileSync(filename, `{"operatorToken":${syntaxSentinel}}`);
        assert.throws(
          () => loadRuntimeConfig(root),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /配置无效/);
            assert.equal(String(error.stack).includes(syntaxSentinel), false);
            assert.equal(error.cause, undefined);
            return true;
          },
        );
        // Restore the full synthetic configuration for permission checks.
        writeFileSync(
          filename,
          JSON.stringify({
            ...source,
            ...(existingFileToken ? { operatorToken: existingFileToken } : {}),
          }),
        );
        if (process.platform !== "win32") {
          chmodSync(filename, 0o644);
          assert.throws(() => loadRuntimeConfig(root), /私有配置文件/);
          chmodSync(filename, 0o600);
          const original = join(root, "real-runtime.json");
          renameSync(filename, original);
          symlinkSync(original, filename);
          assert.throws(() => loadRuntimeConfig(root), /私有配置文件/);
        }
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (prior === undefined)
      delete process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN;
    else process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN = prior;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
