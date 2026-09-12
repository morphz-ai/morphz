import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { desktopBootstrap } = require("../scripts/desktop-bundle.mjs");

test("Dock 重开保留原服务配置文件引用，不将密钥写入应用包或覆盖显式宿主选择", () => {
  const source = desktopBootstrap({
    root: "/fixture/source",
    dataDir: "/fixture/original/center",
    profile: "/fixture/original/desktop",
    envFile: "/fixture/prior-source/.env",
    migrateOrigins: [],
    hot: false,
  });
  for (const explicit of [undefined, "", "/fixture/operator.env"]) {
    const env: Record<string, string> =
      explicit === undefined ? {} : { MORPHZWORK_ENV_FILE: explicit };
    const argv: string[] = [];
    const loaded: string[] = [];
    runInNewContext(source, {
      process: {
        env,
        argv,
        chdir: (path: string) => assert.equal(path, "/fixture/source"),
      },
      require: (path: string) =>
        path === "node:path" ? { join } : loaded.push(path),
    });
    assert.equal(
      env.MORPHZWORK_ENV_FILE,
      explicit ?? "/fixture/prior-source/.env",
    );
    assert.equal(env.MORPHZWORK_TEST_PROFILE, "/fixture/original/desktop");
    assert.deepEqual(argv, ["--data-dir=/fixture/original/center"]);
    assert.deepEqual(loaded, ["/fixture/source/apps/desktop/main.cjs"]);
    assert.ok(!source.includes("DOUBAO_API_KEY"));
  }
  assert.throws(
    () => desktopBootstrap({ envFile: "relative.env" }),
    /绝对路径/,
  );
});
