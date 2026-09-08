import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEnvironmentFile,
  loadServiceEnvironment,
} from "../apps/service/src/environment.js";

test("服务端 .env 仅加载允许的密钥，不覆盖宿主环境或修改其他进程选项", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphzwork-env-"));
  try {
    const filename = join(directory, ".env");
    writeFileSync(
      filename,
      'DOUBAO_API_KEY=" fixture-private-key "\nPATH=untrusted\nNODE_OPTIONS=untrusted\nVITE_DOUBAO_API_KEY=untrusted\n',
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = {};
    loadServiceEnvironment(env, filename);
    assert.deepEqual(env, { DOUBAO_API_KEY: "fixture-private-key" });
    const existing = { DOUBAO_API_KEY: "host-key" };
    loadServiceEnvironment(existing, filename);
    assert.equal(existing.DOUBAO_API_KEY, "host-key");
    const disabled = { DOUBAO_API_KEY: "" };
    loadServiceEnvironment(disabled, filename);
    assert.equal(disabled.DOUBAO_API_KEY, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("默认配置位置跟随工程，不跟随进程启动目录；源码和构建版一致", () => {
  const source = defaultEnvironmentFile(
    "file:///tmp/fixture%20project/apps/service/src/environment.ts",
  );
  const compiled = defaultEnvironmentFile(
    "file:///tmp/fixture%20project/dist/service/apps/service/src/environment.js",
  );
  assert.equal(source, "/tmp/fixture project/.env");
  assert.equal(compiled, source);
});

test("配置缺省可启动，显式路径错误不静默忽略，测试可禁用项目 .env", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphzwork-env-"));
  try {
    const missing = join(directory, "missing.env");
    assert.doesNotThrow(() => loadServiceEnvironment({}, missing));
    assert.throws(
      () => loadServiceEnvironment({ MORPHZWORK_ENV_FILE: missing }),
      /无法读取服务端环境配置/,
    );
    assert.throws(
      () => loadServiceEnvironment({ MORPHZWORK_ENV_FILE: "relative.env" }),
      /必须是绝对路径/,
    );
    const env = { MORPHZWORK_ENV_FILE: "" };
    loadServiceEnvironment(env, missing);
    assert.deepEqual(env, { MORPHZWORK_ENV_FILE: "" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("错误报告不包含配置内容", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphzwork-env-"));
  try {
    const filename = join(directory, ".env");
    writeFileSync(filename, "DOUBAO_API_KEY=" + "fixture-secret".repeat(12000));
    assert.throws(
      () => loadServiceEnvironment({}, filename),
      (error: Error) => {
        assert.match(error.message, /超过大小限制/);
        assert.ok(!error.message.includes("fixture-secret"));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
