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
  for (const legacy of [false, true])
    for (const explicit of [undefined, "", "/fixture/operator.env"]) {
      const env: Record<string, string> =
        explicit === undefined
          ? {}
          : {
              [legacy ? "MORPHZWORK_ENV_FILE" : "MORPHZ_APP_ENV_FILE"]:
                explicit,
            };
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
        env.MORPHZ_APP_ENV_FILE,
        explicit ?? "/fixture/prior-source/.env",
      );
      assert.equal(env.MORPHZ_APP_PROFILE, "/fixture/original/desktop");
      assert.deepEqual(argv, ["--data-dir=/fixture/original/center"]);
      assert.deepEqual(loaded, ["/fixture/source/apps/desktop/main.cjs"]);
      assert.ok(!source.includes("DOUBAO_API_KEY"));
    }
  assert.throws(
    () => desktopBootstrap({ envFile: "relative.env" }),
    /绝对路径/,
  );
});

test("迁移源码根目录只改变加载位置，保留原数据、草稿 profile 和配置文件引用", () => {
  const retained = {
    dataDir: "/fixture/original/center",
    profile: "/fixture/original/desktop",
    envFile: "/fixture/MorphzWork/.env",
    migrateOrigins: ["http://127.0.0.1:65419", "http://127.0.0.1:65424"],
    hot: false,
  };
  const launches = ["/fixture/MorphzWork/", "/fixture/Morphz/application/"].map(
    (root) => {
      const env: Record<string, string> = {};
      const argv: string[] = [];
      const loaded: string[] = [];
      runInNewContext(desktopBootstrap({ root, ...retained }), {
        process: {
          env,
          argv,
          chdir: (path: string) => assert.equal(path, root),
        },
        require: (path: string) =>
          path === "node:path" ? { join } : loaded.push(path),
      });
      assert.deepEqual(loaded, [join(root, "apps/desktop/main.cjs")]);
      return { env, argv };
    },
  );
  assert.deepEqual(launches[0], launches[1]);
  assert.deepEqual(launches[1], {
    env: {
      MORPHZ_APP_ENV_FILE: retained.envFile,
      MORPHZ_APP_PROFILE: retained.profile,
    },
    argv: [
      `--data-dir=${retained.dataDir}`,
      ...retained.migrateOrigins.map((origin) => `--migrate-origin=${origin}`),
    ],
  });
});
