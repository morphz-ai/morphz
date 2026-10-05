import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeBinaryPath } from "./runtime-path.mjs";

const testsRoot = fileURLToPath(new URL("../tests/", import.meta.url));
const applicationRoot = resolve(testsRoot, "..");

// Basenames/tests-relative callers refer to this checkout's tests, never to a
// same-named file in another directory. Absolute Node event paths stay absolute.
function testFileIdentity(file) {
  if (typeof file !== "string" || !file) return null;
  const root = /^(?:\.[/\\])*tests[/\\]/.test(file)
    ? applicationRoot
    : testsRoot;
  return resolve(root, file);
}

// Explicit exceptions belong to a real test and capability, not a blanket skip
// count or title regexp. Any newly skipped test fails until its scope is reviewed.
const optionalTests = [
  [
    "cloud-artifact-host.test.ts",
    "云部署两个 Host 从同一私库和云 Store 读取阅读、图片与界面包原件",
    "s3",
  ],
  [
    "cloud-artifact-store.test.ts",
    "云 Store：两个 Host 共读原件、精确版本、备份恢复和损坏拒绝",
    "s3",
  ],
  [
    "cloud-deployment-backup.test.ts",
    "停写后的云部署关系库＋对象字节成套备份、隔离恢复、损坏及覆盖保护",
    "s3",
  ],
  [
    "nested-thread-activity-runtime.test.ts",
    "真实Rust父Thread派生两个child及孙Thread，主活动归组且子root可独立打开，四份步骤注解不串线",
    "runtime",
    "MORPHZ_NESTED_ACTIVITY_RUNTIME_E2E",
  ],
  [
    "profile-agent-update.test.ts",
    "real Rust Runtime HTTP: actual Agent tool persists Profile and next Thread Context uses name/personality; historical retry stays idempotent",
    "runtime",
    "MORPHZ_PROFILE_RUNTIME_E2E",
  ],
  [
    "cognitive-app-actual-runtime.test.ts",
    "actual Rust Runtime + independent packed author: Agent discovery, write, exact read and receipt recovery retain real provenance",
    "runtime",
    "MORPHZ_COGNITIVE_RUNTIME_E2E",
  ],
  [
    "cognitive-app-actual-runtime-sources.test.ts",
    "actual Rust scheduled task + infer: cognitive calls retain task-run source and original input provenance",
    "runtime",
    "MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E",
  ],
  [
    "cognitive-app-input-actual-runtime.test.ts",
    "actual Rust cognitive original locator: IO10 source, read-input and exact historical author version",
    "runtime",
    "MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E",
  ],
  [
    "cognitive-app-input-actual-runtime.test.ts",
    "actual old-format Runtime rejects IO10 without downgrade or model work",
    "runtime",
    "MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E",
  ],
  [
    "response-annotations-runtime.test.ts",
    "actual Runtime + Platform HTTP: two commands form one activity, three original model rounds, durable refresh and exact Job receipts",
    "runtime",
    "MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E",
  ],
  [
    "response-annotations-runtime.test.ts",
    "actual Runtime + Platform HTTP: V2 required final metadata fails once without repair requests or physical Jobs",
    "runtime",
    "MORPHZ_RESPONSE_ANNOTATIONS_RUNTIME_E2E",
  ],
  [
    "workspace-changes-actual-runtime.test.ts",
    "actual Rust Job commit wakes authorized Host SSE without the Host reconciliation ticker",
    "runtime",
    "MORPHZ_WORKSPACE_RUNTIME_E2E",
  ],
  [
    "exchange-read-receipts-mounted.test.ts",
    "native foreground/background activation preserves actual Conversation unread and both receipt event ledgers",
    "native-focus",
    "MORPHZ_TEST_NATIVE_FOCUS",
  ],
  [
    "desktop-identity.test.ts",
    "Morphz 系统身份覆盖主程序和所有 Helper，保留启动配置且重复打包不改写",
    "darwin",
  ],
  [
    "desktop-identity.test.ts",
    "运行保护拒绝修改时，主程序、Helper 与旧 plist 都不产生半次迁移",
    "darwin",
  ],
  [
    "desktop-identity.test.ts",
    "共享 Electron 包不作为修改目标，Helper 冲突在所有写入之前拒绝",
    "darwin",
  ],
  [
    "reader.test.ts",
    "macOS 旧版 DOC / RTF 在有界 Worker 内只转换文字，不改写原文件",
    "darwin",
  ],
  [
    "managed-artifact-store-upgrade.test.ts",
    "受管 Store PostgreSQL：DB已提交而根标记发布失败，不开放业务，同一重开完成升级",
    "non-windows",
  ],
].map(([file, name, capability, flag]) => ({ file, name, capability, flag }));

function existingExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(
      file,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** Resolve an already installed browser only. Never download or open a profile. */
export async function automaticTestBrowser(env = process.env) {
  if (env.MORPHZ_TEST_BROWSER_EXECUTABLE !== undefined) {
    if (
      !env.MORPHZ_TEST_BROWSER_EXECUTABLE.trim() ||
      !existingExecutable(env.MORPHZ_TEST_BROWSER_EXECUTABLE)
    )
      throw new Error("Configured test browser executable is unavailable.");
    return { ...env };
  }
  const { chromium } = await import("@playwright/test");
  const candidates = [chromium.executablePath()];
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : process.platform === "win32"
        ? join(env.LOCALAPPDATA || homedir(), "ms-playwright")
        : join(homedir(), ".cache", "ms-playwright"));
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)
      .filter((value) => value.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse())
      candidates.push(
        join(
          cache,
          entry,
          process.platform === "darwin"
            ? `chrome-headless-shell-mac-${process.arch === "arm64" ? "arm64" : "x64"}`
            : process.platform === "win32"
              ? "chrome-headless-shell-win64"
              : "chrome-headless-shell-linux64",
          process.platform === "win32"
            ? "chrome-headless-shell.exe"
            : "chrome-headless-shell",
        ),
      );
  }
  const executable = candidates.find(existingExecutable);
  return executable
    ? { ...env, MORPHZ_TEST_BROWSER_EXECUTABLE: executable }
    : { ...env };
}

/** Required capabilities cannot degrade into skip. Only selected integrations
 * require their flags; an unrelated test selection never starts a Runtime. */
export function testCapabilityPlan({
  env = process.env,
  files = null,
  platform = process.platform,
  binaryExists = existingExecutable,
} = {}) {
  const required = new Set(
    (env.MORPHZ_TEST_REQUIRED_CAPABILITIES || "postgres")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  required.add("postgres");
  for (const capability of required)
    if (!["postgres", "s3", "runtime", "native-focus"].includes(capability))
      throw new Error(`Unknown required test capability: ${capability}`);
  if (!env.MORPHZ_TEST_POSTGRES_URL?.trim())
    throw new Error(
      "PostgreSQL test preparation did not provide a connection.",
    );
  const selectedFiles =
    files === null ? null : new Set(files.map(testFileIdentity));
  const selected = optionalTests.filter(
    (test) =>
      selectedFiles === null || selectedFiles.has(join(testsRoot, test.file)),
  );
  const has = (capability) =>
    selected.some((test) => test.capability === capability);
  const browser = Boolean(
    env.MORPHZ_TEST_BROWSER_EXECUTABLE &&
    binaryExists(env.MORPHZ_TEST_BROWSER_EXECUTABLE),
  );
  const cloud = Boolean(
    env.MORPHZ_TEST_S3_ENDPOINT?.trim() &&
    env.MORPHZ_TEST_PG_DUMP &&
    binaryExists(env.MORPHZ_TEST_PG_DUMP) &&
    env.MORPHZ_TEST_PG_RESTORE &&
    binaryExists(env.MORPHZ_TEST_PG_RESTORE),
  );
  if (
    (required.has("s3") ||
      (has("s3") && env.MORPHZ_TEST_S3_ENDPOINT !== undefined)) &&
    !cloud
  )
    throw new Error(
      "S3 conformance requires its endpoint and existing pg_dump/pg_restore executables.",
    );
  const selectedRuntime = selected.filter(
    (test) => test.capability === "runtime",
  );
  if (required.has("runtime"))
    for (const test of selectedRuntime)
      if (env[test.flag] !== "1")
        throw new Error(
          `Selected Runtime integration requires ${test.flag}=1.`,
        );
  if (
    selectedRuntime.some((test) => env[test.flag] === "1") &&
    !binaryExists(runtimeBinaryPath(env))
  )
    throw new Error(
      "Selected Runtime integration requires the built test Runtime binary.",
    );
  if (
    required.has("native-focus") &&
    has("native-focus") &&
    env.MORPHZ_TEST_NATIVE_FOCUS !== "1"
  )
    throw new Error(
      "Native-focus conformance requires MORPHZ_TEST_NATIVE_FOCUS=1.",
    );
  if (has("native-focus") && env.MORPHZ_TEST_NATIVE_FOCUS === "1" && !browser)
    throw new Error(
      "Native-focus conformance requires an existing test browser executable.",
    );
  return {
    env,
    files: selectedFiles,
    platform,
    required,
    selected,
    browser,
    cloud,
  };
}

export function classifySkippedTest(data, plan) {
  const identity = testFileIdentity(data.file);
  const declaration = optionalTests.find(
    (test) =>
      join(testsRoot, test.file) === identity && test.name === data.name,
  );
  if (!declaration || (plan.files && !plan.files.has(identity)))
    throw new Error(`Unexpected skipped test: ${data.name}`);
  const { capability, flag } = declaration;
  let allowed = false;
  if (capability === "s3")
    allowed =
      !plan.required.has("s3") &&
      !plan.cloud &&
      plan.env.MORPHZ_TEST_S3_ENDPOINT === undefined;
  else if (capability === "runtime")
    allowed = !plan.required.has("runtime") && plan.env[flag] !== "1";
  else if (capability === "native-focus")
    allowed =
      !plan.required.has("native-focus") &&
      plan.env[flag] !== "1" &&
      plan.browser;
  else if (capability === "darwin") allowed = plan.platform !== "darwin";
  else if (capability === "non-windows") allowed = plan.platform === "win32";
  if (!allowed)
    throw new Error(`Required or prepared test was skipped: ${data.name}`);
  return {
    file: declaration.file,
    name: data.name,
    capability,
    reason:
      capability === "darwin" || capability === "non-windows"
        ? "platform-specific"
        : "explicit integration not enabled",
  };
}
