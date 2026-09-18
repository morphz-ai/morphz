// Start only the already-configured independent Runtime. No application HTTP server.
import { spawn } from "node:child_process";
import { readFileSync, lstatSync, existsSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { createServer } from "node:net";
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const root = argument("root"),
  binary = argument("binary"),
  keyFile = argument("model-key-file"),
  keyName = argument("model-key-name");
for (const path of [root, binary, keyFile])
  if (!path || !isAbsolute(path))
    throw new Error("Specify explicit absolute paths");
const privateText = (path) => {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 128 * 1024 ||
    info.mode & 0o077
  )
    throw new Error("Configuration must be a bounded private regular file");
  return readFileSync(path, "utf8");
};
if (!keyName || !/^[A-Z][A-Z0-9_]+$/.test(keyName))
  throw new Error("Specify the original credential name");
const config = JSON.parse(privateText(join(root, "center/runtime.json")));
const endpoint = new URL(config.url);
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  Number(endpoint.port) < 1024 ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== "/"
)
  throw new Error("Expected the existing local Runtime endpoint");
const key = parseEnv(privateText(keyFile))[keyName]?.trim();
if (!key)
  throw new Error(
    "The existing credential is absent; configuration was not changed",
  );
const manifest = join(root, "center/host-tools-desktop.json");
const tools = JSON.parse(privateText(manifest)).tools;
if (!tools?.length || tools.some((tool) => !tool.ipc_path || tool.endpoint))
  throw new Error("Expected the verified non-HTTP host-tool manifest");
for (const path of [
  binary,
  join(root, "runtime/runtime.sqlite"),
  join(root, "runtime/morphz.toml"),
  join(root, "runtime/models.toml"),
])
  if (!existsSync(path))
    throw new Error(
      "Existing Runtime files are missing; refusing to create a new profile",
    );
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(Number(endpoint.port), "127.0.0.1", resolve);
});
await new Promise((resolve) => probe.close(resolve));
const child = spawn(
  binary,
  [
    "serve",
    "--bind",
    endpoint.host,
    "--cwd",
    join(root, "workspace"),
    "--config-file",
    join(root, "runtime/morphz.toml"),
    "--log-level",
    "warn",
  ],
  {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      MORPHZ_HOME: join(root, "runtime"),
      MORPHZ_STORAGE_SQLITE_PATH: join(root, "runtime/runtime.sqlite"),
      MORPHZ_DASHBOARD_TOKEN: config.token,
      MORPHZ_HOST_TOOLS_FILE: manifest,
      MORPHZ_EXPERIMENTAL_FEATURES: "session-io",
      // Persisted model routes may reference the old key name. Supply both
      // without rewriting the existing configuration or credential reference.
      MORPHZWORK_DEVELOPMENT_MODEL_KEY: key,
      MORPHZ_APP_DEVELOPMENT_MODEL_KEY: key,
    },
  },
);
await new Promise((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
});
child.unref();
writeFileSync(
  join(root, "embedded-runtime.json"),
  JSON.stringify(
    {
      pid: child.pid,
      binary,
      root,
      endpoint: config.url,
      manifest,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const deadline = Date.now() + 45000;
let ready = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(
      "Runtime exited before readiness; existing databases and configuration retained",
    );
  try {
    const response = await fetch(config.url + "/api/status", {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!ready)
  throw new Error(
    "Runtime readiness timed out; inspect the recorded PID before any restart",
  );
console.log(
  JSON.stringify({
    pid: child.pid,
    endpoint: config.url,
    applicationHTTP: false,
    ready,
  }),
);
