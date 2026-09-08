/** Explicit local development launcher, never a migration of an existing center.
 * Reuses one selected API-key model; keeps databases, tool scope and desktop profile
 * separate. Credentials stay in server processes, never command-line arguments. */
import { spawn, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../apps/service/src/runtime.js";
import { prepareHostTools } from "../apps/service/src/agent-tools.js";

function argument(name: string) {
  const value = process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
  assert.ok(value, `Missing --${name}=...`);
  return value;
}
function privateText(filename: string) {
  assert.ok(isAbsolute(filename), "Configuration paths must be absolute");
  const meta = lstatSync(filename);
  assert.ok(
    meta.isFile() &&
      !meta.isSymbolicLink() &&
      meta.size <= 128 * 1024 &&
      (meta.mode & 0o077) === 0,
    "Configuration must be a bounded private regular file",
  );
  return readFileSync(filename, "utf8");
}
const directory = argument("data-dir"),
  sourceDirectory = argument("source-center");
assert.ok(
  isAbsolute(directory) && directory !== "/" && directory !== sourceDirectory,
);
const sourceFile = join(sourceDirectory, "runtime.json");
privateText(sourceFile);
const source = loadRuntimeConfig(sourceDirectory);
assert.ok(
  source && !source.identityMode,
  "Select an existing local single-user Runtime",
);
const keyName = argument("model-key-name");
assert.match(keyName, /^[A-Z][A-Z0-9_]+$/);
const key = parseEnv(privateText(argument("model-key-file")))[keyName]?.trim();
assert.ok(key, "Selected model credential is absent; no configuration changed");
const response = await fetch(`${source.url}/api/runtime/providers`, {
  headers: { Authorization: `Bearer ${source.token}` },
  redirect: "error",
  signal: AbortSignal.timeout(10000),
});
assert.ok(response.ok, "Cannot read selected Runtime model configuration");
const catalog = await response.json();
const model = catalog.selected_model_alias;
const candidates = catalog.model_routes?.[model]?.candidates;
assert.ok(
  typeof model === "string" && candidates?.length === 1,
  "Development launcher requires one explicit model route",
);
const route = candidates[0],
  provider = catalog.provider_instances?.[route.provider],
  account = catalog.auth_accounts?.[route.account];
assert.ok(
  account?.config.auth_adapter === "credential" &&
    account.state?.status === "ready" &&
    account.effective_enabled,
  "Development launcher requires an enabled, ready API-key account",
);
assert.ok(["openai-chat", "openai-responses"].includes(provider?.protocol));
assert.ok(
  Object.keys(provider.headers ?? {}).length === 0 &&
    Object.keys(provider.env_headers ?? {}).length === 0,
  "Extra provider headers require explicit configuration, not silent omission",
);
const endpoint = new URL(provider.base_url);
assert.ok(
  (endpoint.protocol === "https:" ||
    (endpoint.protocol === "http:" &&
      process.argv.includes("--allow-http-model"))) &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash,
  "Model endpoint requires HTTPS, or explicit --allow-http-model for an existing trusted local proxy",
);
const workPort = 65424,
  runtimePort = 18089;
// Refuse occupied ports; never stop another process to make room.
for (const port of [workPort, runtimePort]) {
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  });
  await new Promise<void>((done) => probe.close(() => done()));
}
const markerPath = join(directory, "development-center.json");
const selection = {
  version: 1,
  model,
  physicalModel: route.model,
  protocol: provider.protocol,
  endpoint: endpoint.href,
  source: source.url,
  workPort,
  runtimePort,
};
if (existsSync(directory)) {
  assert.ok(
    lstatSync(directory).isDirectory() &&
      !lstatSync(directory).isSymbolicLink(),
  );
  assert.deepEqual(
    JSON.parse(privateText(markerPath)),
    selection,
    "Existing development center has different settings; not overwriting it",
  );
} else {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(markerPath, JSON.stringify(selection), {
    mode: 0o600,
    flag: "wx",
  });
}
const work = join(directory, "center"),
  runtimeHome = join(directory, "runtime"),
  workspace = join(directory, "workspace");
for (const dir of [work, runtimeHome, workspace])
  mkdirSync(dir, { recursive: true, mode: 0o700 });
const configFile = join(work, "runtime.json");
if (!existsSync(configFile))
  writeFileSync(
    configFile,
    JSON.stringify({
      url: `http://127.0.0.1:${runtimePort}`,
      token: randomBytes(32).toString("hex"),
      namespace: randomUUID(),
    }),
    { mode: 0o600, flag: "wx" },
  );
privateText(configFile);
const config = loadRuntimeConfig(work)!;
assert.equal(config.url, `http://127.0.0.1:${runtimePort}`);
assert.equal(config.identityMode, undefined);
const host = prepareHostTools(work, workPort, config.namespace);
const runtimeConfig = join(runtimeHome, "morphz.toml");
const toml = `[llm]\nprovider = "development"\nmodel = ${JSON.stringify(route.model)}\nreasoning_effort = "low"\n[providers.development]\nprotocol = ${JSON.stringify(provider.protocol)}\nbase_url = ${JSON.stringify(endpoint.href)}\ncredential = "development"\n[credentials.development]\nsource = "env"\nname = "MORPHZWORK_DEVELOPMENT_MODEL_KEY"\n[permissions]\nworkspace_root = ${JSON.stringify(workspace)}\n[background_task]\nartifact_dir = ${JSON.stringify(join(workspace, "artifacts"))}\n`;
// Runtime migrates legacy provider sections into its own models.toml on boot.
// Preserve both files, then verify the effective model over its read-only API.
if (existsSync(runtimeConfig)) privateText(runtimeConfig);
else writeFileSync(runtimeConfig, toml, { mode: 0o600, flag: "wx" });
const runtimeBinary = resolve(
  process.env.MORPHZWORK_RUNTIME_BINARY ?? "../Morphz/target/debug/morphz",
);
assert.ok(existsSync(runtimeBinary), "Build the compatible Runtime first");
const children: ChildProcess[] = [];
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
};
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse())
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
function launch(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  label: string,
) {
  const child = spawn(command, args, {
    cwd: resolve("."),
    env: environment,
    stdio: label === "Desktop" ? "ignore" : ["ignore", "pipe", "pipe"],
  });
  // The desktop is a client, not a child service: stopping the launcher must
  // not rely on Electron's platform-specific POSIX signal handling.
  if (label === "Desktop") child.unref();
  else children.push(child);
  // Do not copy provider payloads or bearer credentials into launcher output.
  child.stdout?.resume();
  child.stderr?.resume();
  child.on("error", () => {
    console.error(`${label} failed to start`);
    if (label === "Desktop") return;
    process.exitCode = 1;
    void stop();
  });
  child.on("exit", (code) => {
    if (!stopping) {
      if (label === "Desktop") {
        console.log(
          "Desktop closed; the independent center and Runtime remain running.",
        );
        return;
      }
      console.error(`${label} exited (${code})`);
      process.exitCode = 1;
      void stop();
    }
  });
  return child;
}
async function ready(url: string, token?: string) {
  const deadline = Date.now() + 45000;
  while (!stopping && Date.now() < deadline) {
    try {
      if (
        (
          await fetch(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            redirect: "error",
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Development center did not become ready");
}
try {
  launch(
    runtimeBinary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${runtimePort}`,
      "--cwd",
      workspace,
      "--config-file",
      runtimeConfig,
      "--log-level",
      "warn",
    ],
    {
      ...env,
      MORPHZ_HOME: runtimeHome,
      MORPHZ_STORAGE_SQLITE_PATH: join(runtimeHome, "runtime.sqlite"),
      MORPHZ_DASHBOARD_TOKEN: config.token,
      MORPHZ_HOST_TOOLS_FILE: host.path,
      MORPHZWORK_DEVELOPMENT_MODEL_KEY: key,
    },
    "Runtime",
  );
  await ready(`${config.url}/api/status`, config.token);
  const active = await (
    await fetch(`${config.url}/api/runtime/providers`, {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    })
  ).json();
  assert.ok(
    active.selected_model_alias === route.model &&
      active.provider_instances?.development?.base_url === endpoint.href &&
      active.provider_instances?.development?.protocol === provider.protocol,
    "Effective development model configuration changed; not starting Work against an unexpected model",
  );
  launch(
    process.execPath,
    ["dist/service/apps/service/src/main.js"],
    { ...env, MORPHZWORK_DATA_DIR: work, MORPHZWORK_PORT: String(workPort) },
    "Work center",
  );
  await ready(`http://127.0.0.1:${workPort}/api/health`);
  console.log(
    `Development center ready: http://127.0.0.1:${workPort}; model ${model}.`,
  );
  console.log(`Independent data: ${directory}. Existing centers unchanged.`);
  if (process.argv.includes("--desktop"))
    launch(
      process.execPath,
      ["scripts/desktop-dev.mjs", `--center=http://127.0.0.1:${workPort}`],
      {
        ...env,
        MORPHZWORK_TEST_PROFILE: join(directory, "desktop"),
        MORPHZWORK_ENV_FILE: "",
      },
      "Desktop",
    );
} catch (error) {
  await stop();
  throw error;
}
