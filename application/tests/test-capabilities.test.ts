import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
type Plan = {
  env: NodeJS.ProcessEnv;
  files: Set<string> | null;
  platform: NodeJS.Platform;
  required: Set<string>;
  selected: { file: string; name: string; capability: string; flag?: string }[];
  browser: boolean;
  cloud: boolean;
};
type SkipData = { file?: string; name: string; skip?: boolean };
// Native URL import preserves the real .mjs module without a shadow algorithm.
const { automaticTestBrowser, classifySkippedTest, testCapabilityPlan } =
  (await import(
    new URL("../scripts/test-capabilities.mjs", import.meta.url).href
  )) as {
    automaticTestBrowser(env?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
    testCapabilityPlan(options?: {
      env?: NodeJS.ProcessEnv;
      files?: string[] | null;
      platform?: NodeJS.Platform;
      binaryExists?: (path: unknown) => boolean;
    }): Plan;
    classifySkippedTest(
      data: SkipData,
      plan: Plan,
    ): {
      file: string;
      name: string;
      capability: string;
      reason: string;
    };
  };

// Controlled capability facts only: no database/browser/Runtime is started.
const existing = new Set([
  "/fixture/browser",
  "/fixture/runtime",
  "/fixture/pg_dump",
  "/fixture/pg_restore",
]);
const base: NodeJS.ProcessEnv = Object.freeze({
  MORPHZ_TEST_POSTGRES_URL:
    "postgres://fixture:dummy-secret@127.0.0.1:59999/isolated_test",
  MORPHZ_TEST_BROWSER_EXECUTABLE: "/fixture/browser",
});
const binaryExists = (path: unknown) =>
  typeof path === "string" && existing.has(path);
const declarations = [
  {
    file: "cloud-artifact-host.test.ts",
    name: "云部署两个 Host 从同一私库和云 Store 读取阅读、图片与界面包原件",
    capability: "s3",
  },
  {
    file: "cloud-artifact-store.test.ts",
    name: "云 Store：两个 Host 共读原件、精确版本、备份恢复和损坏拒绝",
    capability: "s3",
  },
  {
    file: "cloud-deployment-backup.test.ts",
    name: "停写后的云部署关系库＋对象字节成套备份、隔离恢复、损坏及覆盖保护",
    capability: "s3",
  },
  {
    file: "nested-thread-activity-runtime.test.ts",
    name: "真实Rust父Thread派生两个child及孙Thread，主活动归组且子root可独立打开，四份步骤注解不串线",
    capability: "runtime",
    flag: "MORPHZ_NESTED_ACTIVITY_RUNTIME_E2E",
  },
  {
    file: "profile-agent-update.test.ts",
    name: "real Rust Runtime HTTP: actual Agent tool persists Profile and next Thread Context uses name/personality; historical retry stays idempotent",
    capability: "runtime",
    flag: "MORPHZ_PROFILE_RUNTIME_E2E",
  },
  {
    file: "response-annotations-runtime.test.ts",
    name: "actual Runtime + Platform HTTP: two commands form one activity, three original model rounds, durable refresh and exact Job receipts",
    capability: "runtime",
    flag: "MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E",
  },
  {
    file: "response-annotations-runtime.test.ts",
    name: "actual Runtime + Platform HTTP: V2 required final metadata fails once without repair requests or physical Jobs",
    capability: "runtime",
    flag: "MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E",
  },
  {
    file: "workspace-changes-actual-runtime.test.ts",
    name: "actual Rust Job commit wakes authorized Host SSE without the Host reconciliation ticker",
    capability: "runtime",
    flag: "MORPHZ_WORKSPACE_RUNTIME_E2E",
  },
  {
    file: "exchange-read-receipts-mounted.test.ts",
    name: "native foreground/background activation preserves actual Conversation unread and both receipt event ledgers",
    capability: "native-focus",
    flag: "MORPHZ_TEST_NATIVE_FOCUS",
  },
  {
    file: "cognitive-app-actual-runtime.test.ts",
    name: "actual Rust Runtime + independent packed author: Agent discovery, write, exact read and receipt recovery retain real provenance",
    capability: "runtime",
    flag: "MORPHZ_COGNITIVE_RUNTIME_E2E",
  },
  {
    file: "cognitive-app-actual-runtime-sources.test.ts",
    name: "actual Rust scheduled task + infer: cognitive calls retain task-run source and original input provenance",
    capability: "runtime",
    flag: "MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E",
  },
  {
    file: "cognitive-app-input-actual-runtime.test.ts",
    name: "actual Rust cognitive original locator: IO10 source, read-input and exact historical author version",
    capability: "runtime",
    flag: "MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E",
  },
  {
    file: "cognitive-app-input-actual-runtime.test.ts",
    name: "actual old-format Runtime rejects IO10 without downgrade or model work",
    capability: "runtime",
    flag: "MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E",
  },
] as const;
const darwin = [
  {
    file: "desktop-identity.test.ts",
    name: "Morphz 系统身份覆盖主程序和所有 Helper，保留启动配置且重复打包不改写",
  },
  {
    file: "desktop-identity.test.ts",
    name: "运行保护拒绝修改时，主程序、Helper 与旧 plist 都不产生半次迁移",
  },
  {
    file: "desktop-identity.test.ts",
    name: "共享 Electron 包不作为修改目标，Helper 冲突在所有写入之前拒绝",
  },
  {
    file: "reader.test.ts",
    name: "macOS 旧版 DOC / RTF 在有界 Worker 内只转换文字，不改写原文件",
  },
] as const;
const windows = {
  file: "managed-artifact-store-upgrade.test.ts",
  name: "受管 Store PostgreSQL：DB已提交而根标记发布失败，不开放业务，同一重开完成升级",
};
const testsRoot = fileURLToPath(new URL("./", import.meta.url));
const data = ({ file, name }: { file: string; name: string }) => ({
  file: join(testsRoot, file),
  name,
  skip: true,
});
function plan(
  env: NodeJS.ProcessEnv = {},
  options: { files?: string[] | null; platform?: NodeJS.Platform } = {},
) {
  return testCapabilityPlan({
    env: { ...base, ...env },
    binaryExists,
    ...options,
  });
}

test("default test planning requires a prepared PostgreSQL connection, never a skip fallback", () => {
  for (const value of [undefined, "", " "]) {
    assert.throws(
      () =>
        testCapabilityPlan({
          env: { MORPHZ_TEST_POSTGRES_URL: value },
          binaryExists,
        }),
      /PostgreSQL test preparation did not provide a connection/,
    );
  }
  const env = { ...base, UNRELATED_FIXTURE_VALUE: "unchanged" };
  const before = { ...env };
  const actual = testCapabilityPlan({ env, binaryExists });
  assert.equal(actual.env, env);
  assert.deepEqual(env, before);
  assert.deepEqual([...actual.required], ["postgres"]);
  assert.equal(actual.browser, true);
});

test("required capability CSV is finite and cannot remove PostgreSQL", () => {
  for (const csv of ["unknown", "postgres,browser", "runtime,typo"]) {
    assert.throws(
      () => plan({ MORPHZ_TEST_REQUIRED_CAPABILITIES: csv }),
      /Unknown required test capability/,
    );
  }
  const actual = plan(
    { MORPHZ_TEST_REQUIRED_CAPABILITIES: " runtime, postgres, runtime " },
    { files: ["test-capabilities.test.ts"] },
  );
  assert.deepEqual(new Set(actual.required), new Set(["postgres", "runtime"]));
  assert.deepEqual(actual.selected, []);
});

test("exact thirteen optional integrations are declared opt-outs, not environment-unavailable successes", () => {
  const actual = plan({}, { platform: "darwin" });
  for (const item of declarations) {
    assert.deepEqual(classifySkippedTest(data(item), actual), {
      file: item.file,
      name: item.name,
      capability: item.capability,
      reason: "explicit integration not enabled",
    });
  }
});

test("unknown, copied-name, misspelled and unselected skips cannot use an allow-regexp", () => {
  const actual = plan();
  for (const value of [
    {
      file: "platform-storage.test.ts",
      name: "Platform PostgreSQL：身份、成员和会话与 SQLite 同事务语义",
    },
    { file: "unrelated.test.ts", name: declarations[0].name },
    { file: declarations[0].file, name: declarations[0].name + " changed" },
    { name: declarations[0].name },
  ]) {
    assert.throws(
      () => classifySkippedTest(value, actual),
      /Unexpected skipped test/,
    );
  }
  assert.throws(
    () =>
      classifySkippedTest(
        data(declarations[0]),
        plan({}, { files: ["test-capabilities.test.ts"] }),
      ),
    /Unexpected skipped test/,
  );
});

test("optional identities preserve actual absolute and supported relative paths without basename collisions", () => {
  const item = declarations[0];
  const absolute = join(testsRoot, item.file);
  const aliases = [
    item.file,
    `tests/${item.file}`,
    `./tests/./${item.file}`,
    `tests/nested/../${item.file}`,
    absolute,
  ];
  const actual = plan({}, { files: aliases });
  assert.deepEqual([...actual.files!], [absolute]);
  assert.equal(actual.selected.length, 1);
  for (const file of aliases)
    assert.deepEqual(classifySkippedTest({ file, name: item.name }, actual), {
      file: item.file,
      name: item.name,
      capability: item.capability,
      reason: "explicit integration not enabled",
    });
});

test("nested, wrong-workspace and dot-segment escaping files cannot borrow the same optional title", () => {
  const item = declarations[0];
  const unrelated = [
    join(testsRoot, "copied", item.file),
    `copied/${item.file}`,
    `tests/copied/${item.file}`,
    resolve(testsRoot, "../../../other-workspace/application/tests", item.file),
    resolve(testsRoot, "..", item.file),
    `../${item.file}`,
    `tests/../${item.file}`,
    `tests/../../${item.file}`,
  ];
  for (const file of unrelated) {
    assert.throws(
      () => classifySkippedTest({ file, name: item.name }, plan()),
      /Unexpected skipped test/,
    );
    const selected = plan({}, { files: [file] });
    assert.deepEqual(selected.selected, [], file);
    assert.throws(
      () => classifySkippedTest(data(item), selected),
      /Unexpected skipped test/,
    );
  }
});

test("four Darwin-specific cases and the single Windows exclusion are platform-exact", () => {
  for (const item of darwin) {
    assert.equal(
      classifySkippedTest(data(item), plan({}, { platform: "linux" })).reason,
      "platform-specific",
    );
    assert.equal(
      classifySkippedTest(data(item), plan({}, { platform: "win32" }))
        .capability,
      "darwin",
    );
    assert.throws(
      () => classifySkippedTest(data(item), plan({}, { platform: "darwin" })),
      /Required or prepared test was skipped/,
    );
  }
  assert.equal(
    classifySkippedTest(data(windows), plan({}, { platform: "win32" }))
      .capability,
    "non-windows",
  );
  for (const platform of ["darwin", "linux"] as const)
    assert.throws(
      () => classifySkippedTest(data(windows), plan({}, { platform })),
      /Required or prepared test was skipped/,
    );
});

test("selected S3 configuration or requirement must be complete before test execution", () => {
  const selected = { files: [declarations[0].file] };
  const cloud = {
    MORPHZ_TEST_S3_ENDPOINT: "http://fixture.invalid:4566",
    MORPHZ_TEST_PG_DUMP: "/fixture/pg_dump",
    MORPHZ_TEST_PG_RESTORE: "/fixture/pg_restore",
  };
  for (const env of [
    { MORPHZ_TEST_REQUIRED_CAPABILITIES: "s3" },
    { MORPHZ_TEST_S3_ENDPOINT: "" },
    { MORPHZ_TEST_S3_ENDPOINT: cloud.MORPHZ_TEST_S3_ENDPOINT },
    { ...cloud, MORPHZ_TEST_PG_DUMP: "/missing/dump" },
    { ...cloud, MORPHZ_TEST_PG_RESTORE: "/missing/restore" },
  ])
    assert.throws(() => plan(env, selected), /S3 conformance requires/);
  const ready = plan(cloud, selected);
  assert.equal(ready.cloud, true);
  assert.throws(
    () => classifySkippedTest(data(declarations[0]), ready),
    /Required or prepared test was skipped/,
  );
  assert.throws(
    () => classifySkippedTest(data(declarations[2]), plan(cloud)),
    /Required or prepared test was skipped/,
  );
  // An unselected cloud family must not acquire capabilities or start services.
  assert.doesNotThrow(() =>
    plan(
      { MORPHZ_TEST_S3_ENDPOINT: "" },
      { files: ["test-capabilities.test.ts"] },
    ),
  );
});

test("required Runtime checks only selected files and all corresponding exact flags", () => {
  const runtime = {
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "runtime",
    MORPHZ_APP_RUNTIME_BINARY: "/fixture/runtime",
  };
  assert.throws(
    () => plan(runtime, { files: ["profile-agent-update.test.ts"] }),
    /Selected Runtime integration requires MORPHZ_PROFILE_RUNTIME_E2E=1/,
  );
  const actual = plan(
    { ...runtime, MORPHZ_PROFILE_RUNTIME_E2E: "1" },
    { files: [join(testsRoot, "profile-agent-update.test.ts")] },
  );
  assert.equal(actual.selected.length, 1);
  assert.throws(
    () => classifySkippedTest(data(declarations[4]), actual),
    /Required or prepared test was skipped/,
  );
  assert.throws(
    () => plan({ ...runtime, MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E: "1" }),
    /Selected Runtime integration requires MORPHZ_NESTED_ACTIVITY_RUNTIME_E2E=1/,
  );
  assert.doesNotThrow(() =>
    plan(runtime, { files: ["test-capabilities.test.ts"] }),
  );
});

test("actual cognitive Runtime opt-in is exact, cannot borrow Profile's flag, and never excuses a prepared skip", () => {
  const runtime = {
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "runtime",
    MORPHZ_APP_RUNTIME_BINARY: "/fixture/runtime",
    MORPHZ_PROFILE_RUNTIME_E2E: "1",
  };
  const item = declarations[9];
  const selection = { files: [item.file] };
  assert.throws(
    () => plan(runtime, selection),
    /Selected Runtime integration requires MORPHZ_COGNITIVE_RUNTIME_E2E=1/,
  );
  const actual = plan(
    { ...runtime, MORPHZ_COGNITIVE_RUNTIME_E2E: "1" },
    selection,
  );
  assert.equal(actual.selected.length, 1);
  assert.throws(
    () => classifySkippedTest(data(item), actual),
    /Required or prepared test was skipped/,
  );
});

test("scheduled cognitive infer opt-in cannot borrow the input-only flag or excuse a prepared skip", () => {
  const item = declarations[10];
  const selection = { files: [item.file] };
  const runtime = {
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "runtime",
    MORPHZ_APP_RUNTIME_BINARY: "/fixture/runtime",
    MORPHZ_COGNITIVE_RUNTIME_E2E: "1",
  };
  assert.throws(
    () => plan(runtime, selection),
    /Selected Runtime integration requires MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E=1/,
  );
  const actual = plan(
    { ...runtime, MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E: "1" },
    selection,
  );
  assert.equal(actual.selected.length, 1);
  assert.throws(
    () => classifySkippedTest(data(item), actual),
    /Required or prepared test was skipped/,
  );
});

test("exact-original IO10 Runtime cases cannot borrow other cognitive flags or excuse either prepared skip", () => {
  const items = declarations.slice(11);
  assert.equal(items.length, 2);
  const selection = { files: [items[0]!.file] };
  const runtime = {
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "runtime",
    MORPHZ_APP_RUNTIME_BINARY: "/fixture/runtime",
    MORPHZ_PROFILE_RUNTIME_E2E: "1",
    MORPHZ_COGNITIVE_RUNTIME_E2E: "1",
    MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E: "1",
  };
  assert.throws(
    () => plan(runtime, selection),
    /Selected Runtime integration requires MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E=1/,
  );
  const actual = plan(
    { ...runtime, MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E: "1" },
    selection,
  );
  assert.equal(actual.selected.length, 2);
  for (const item of items) {
    assert.throws(
      () => classifySkippedTest(data(item), actual),
      /Required or prepared test was skipped/,
    );
    assert.throws(
      () =>
        classifySkippedTest(
          { file: "copied.test.ts", name: item.name },
          actual,
        ),
      /Unexpected skipped test/,
    );
  }
});

test("enabled Runtime cases require the canonical existing binary even without a required mode", () => {
  for (const item of declarations.filter(
    (value) => value.capability === "runtime",
  )) {
    const flag = "flag" in item ? item.flag : "";
    assert.throws(
      () =>
        plan(
          { [flag]: "1", MORPHZ_APP_RUNTIME_BINARY: "/missing/runtime" },
          { files: [item.file] },
        ),
      /Selected Runtime integration requires the built test Runtime binary/,
    );
    const actual = plan(
      { [flag]: "1", MORPHZ_APP_RUNTIME_BINARY: "/fixture/runtime" },
      { files: [item.file] },
    );
    assert.throws(
      () => classifySkippedTest(data(item), actual),
      /Required or prepared test was skipped/,
    );
  }
  assert.throws(
    () =>
      plan(
        { MORPHZ_PROFILE_RUNTIME_E2E: "1", MORPHZ_APP_RUNTIME_BINARY: " " },
        { files: ["profile-agent-update.test.ts"] },
      ),
    /must name an executable path/,
  );
});

test("native-focus opt-out never excuses missing Chromium, and enabled focus cannot skip", () => {
  const item = declarations[8],
    selected = { files: [item.file] };
  assert.throws(
    () =>
      classifySkippedTest(
        data(item),
        plan({ MORPHZ_TEST_BROWSER_EXECUTABLE: "/missing/browser" }, selected),
      ),
    /Required or prepared test was skipped/,
  );
  assert.throws(
    () => plan({ MORPHZ_TEST_REQUIRED_CAPABILITIES: "native-focus" }, selected),
    /Native-focus conformance requires MORPHZ_TEST_NATIVE_FOCUS=1/,
  );
  assert.throws(
    () =>
      plan(
        {
          MORPHZ_TEST_NATIVE_FOCUS: "1",
          MORPHZ_TEST_BROWSER_EXECUTABLE: "/missing/browser",
        },
        selected,
      ),
    /Native-focus conformance requires an existing test browser/,
  );
  const actual = plan({ MORPHZ_TEST_NATIVE_FOCUS: "1" }, selected);
  assert.throws(
    () => classifySkippedTest(data(item), actual),
    /Required or prepared test was skipped/,
  );
});

test("explicit browser discovery preserves input without launch/download and rejects bad overrides", async () => {
  const env = Object.freeze({
    ...base,
    MORPHZ_TEST_BROWSER_EXECUTABLE: process.execPath,
  });
  assert.deepEqual(await automaticTestBrowser(env), env);
  for (const executable of ["", " ", "/missing/fixture/browser", tmpdir()])
    await assert.rejects(
      automaticTestBrowser({
        ...base,
        MORPHZ_TEST_BROWSER_EXECUTABLE: executable,
      }),
      /Configured test browser executable is unavailable/,
    );
});

test("the default executable probe rejects directories before configured cloud, Runtime or native tests", () => {
  const directory = tmpdir();
  const common = { ...base, MORPHZ_TEST_BROWSER_EXECUTABLE: process.execPath };
  assert.throws(
    () =>
      testCapabilityPlan({
        env: {
          ...common,
          MORPHZ_TEST_S3_ENDPOINT: "http://fixture.invalid",
          MORPHZ_TEST_PG_DUMP: directory,
          MORPHZ_TEST_PG_RESTORE: directory,
        },
        files: ["cloud-deployment-backup.test.ts"],
      }),
    /S3 conformance requires/,
  );
  assert.throws(
    () =>
      testCapabilityPlan({
        env: {
          ...common,
          MORPHZ_PROFILE_RUNTIME_E2E: "1",
          MORPHZ_APP_RUNTIME_BINARY: directory,
        },
        files: ["profile-agent-update.test.ts"],
      }),
    /Selected Runtime integration requires the built test Runtime binary/,
  );
  assert.throws(
    () =>
      testCapabilityPlan({
        env: {
          ...common,
          MORPHZ_TEST_NATIVE_FOCUS: "1",
          MORPHZ_TEST_BROWSER_EXECUTABLE: directory,
        },
        files: ["exchange-read-receipts-mounted.test.ts"],
      }),
    /Native-focus conformance requires an existing test browser/,
  );
});
