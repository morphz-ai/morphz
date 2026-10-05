/** Independently installed public SDK + author process, with its own actual
 * SQLite originals. This test helper never imports a .test module or exposes
 * Host/Platform code to the author. No real credentials or registry access. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const applicationRoot = fileURLToPath(new URL("../../", import.meta.url));
function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

export type PackedAuthorReady = {
  port: number;
  serviceId: string;
  dataAuthorityId: string;
};

/** The caller owns the returned temporary directory and must close it after
 * all children have stopped. The normal npm entry supplies its actual CLI. */
export function packCognitiveAuthor() {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-packed-runtime-author-"),
  );
  const sdk = join(directory, "sdk"),
    author = join(directory, "author");
  mkdirSync(join(sdk, "src"), { recursive: true });
  mkdirSync(author);
  try {
    for (const file of [
      "package.json",
      "tsconfig.build.json",
      "README.md",
      "LICENSE",
    ])
      copyFileSync(
        join(applicationRoot, "packages/cognitive-app-sdk", file),
        join(sdk, file),
      );
    for (const file of readdirSync(
      join(applicationRoot, "packages/cognitive-app-sdk/src"),
    ))
      if (file.endsWith(".ts"))
        copyFileSync(
          join(applicationRoot, "packages/cognitive-app-sdk/src", file),
          join(sdk, "src", file),
        );
    for (const file of [
      "package.json",
      "service.mjs",
      "definition.json",
      "README.md",
      "MODEL.md",
    ])
      copyFileSync(
        join(applicationRoot, "examples/cognitive-notes", file),
        join(author, file),
      );
    const cli = process.env.npm_execpath;
    assert.ok(cli, "The formal npm test entry must supply the actual npm CLI");
    const userConfig = join(directory, "npm-user.cfg");
    const globalConfig = join(directory, "npm-global.cfg");
    writeFileSync(userConfig, "", { mode: 0o600 });
    writeFileSync(globalConfig, "", { mode: 0o600 });
    const npm = (cwd: string, arguments_: string[]) =>
      execFileSync(process.execPath, [cli, ...arguments_], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...childEnvironment(),
          npm_config_cache: join(homedir(), ".npm"),
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
          npm_config_offline: "true",
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
        },
      });
    npm(sdk, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    const packed: unknown = JSON.parse(
      npm(sdk, ["pack", "--offline", "--json", "--silent"]),
    );
    assert.ok(Array.isArray(packed) && packed.length === 1);
    const filename: unknown = Reflect.get(packed[0] as object, "filename");
    assert.equal(filename, "morphz-cognitive-app-sdk-0.2.0.tgz");
    npm(author, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(sdk, String(filename)),
    ]);
    assert.doesNotMatch(
      readFileSync(join(author, "service.mjs"), "utf8"),
      /packages\/(application|platform)|\.\.\//,
    );
    return {
      directory,
      root: author,
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function startPackedAuthor(
  root: string,
  database: string,
  config: string,
) {
  const child = spawn(
    process.execPath,
    [
      join(root, "service.mjs"),
      "--db",
      database,
      "--config",
      config,
      "--port",
      "0",
    ],
    {
      cwd: root,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const ready = await new Promise<PackedAuthorReady>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () => reject(new Error("Isolated author readiness timeout")),
        10_000,
      );
      child.stdout!.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        if (!stdout.includes("\n")) return;
        try {
          const value = JSON.parse(stdout.split("\n")[0]!) as PackedAuthorReady;
          assert.ok(
            Number.isSafeInteger(value.port) &&
              value.port > 0 &&
              value.port <= 65535,
          );
          assert.equal(typeof value.serviceId, "string");
          assert.equal(typeof value.dataAuthorityId, "string");
          clearTimeout(timer);
          resolve(value);
        } catch {
          clearTimeout(timer);
          reject(new Error("Isolated author readiness invalid"));
        }
      });
      child.stderr!.on("data", () => {});
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Isolated author failed"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Isolated author exited"));
      });
    });
    return { child, ready };
  } catch (error) {
    await stopPackedAuthor(child);
    throw error;
  }
}

export async function stopPackedAuthor(child: ChildProcess) {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
