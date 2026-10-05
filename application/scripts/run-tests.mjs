import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTestPostgres } from "./test-postgres.mjs";
import {
  automaticTestBrowser,
  testCapabilityPlan,
} from "./test-capabilities.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const reporter = fileURLToPath(
  new URL("./test-coverage-reporter.mjs", import.meta.url),
);

export async function testSelection(args = []) {
  const options = [],
    files = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--test-name-pattern") {
      if (!args[index + 1] || args[index + 1].startsWith("--"))
        throw new Error("Test selection: missing name pattern");
      options.push(value, args[++index]);
    } else if (value.startsWith("--test-name-pattern=")) options.push(value);
    else {
      if (value.startsWith("-") || !value.endsWith(".test.ts"))
        throw new Error(
          "Test selection: only .test.ts files and --test-name-pattern are allowed",
        );
      const path = await realpath(resolve(root, value)).catch(() => {
        throw new Error("Test selection: an existing test file is required");
      });
      const within = relative(resolve(root, "tests"), path);
      if (isAbsolute(within) || within.startsWith(".."))
        throw new Error(
          "Test selection: files must belong to application/tests",
        );
      files.push(relative(root, path));
    }
  }
  if (!files.length)
    files.push(
      ...(await readdir(resolve(root, "tests")))
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => `tests/${name}`),
    );
  return { files: [...new Set(files)], options };
}

export async function runTests({
  args = [],
  env = process.env,
  signal,
  stdio = "inherit",
} = {}) {
  const { files, options } = await testSelection(args);
  const prepared = await prepareTestPostgres({ env, signal });
  let groupStopped = true;
  try {
    const browserEnv = await automaticTestBrowser(prepared.env);
    const plan = testCapabilityPlan({ env: browserEnv, files });
    if (signal?.aborted) return 130;
    const testEnv = {
      ...plan.env,
      MORPHZ_TEST_SELECTED_FILES: JSON.stringify(files),
      MORPHZ_APP_ENV_FILE: "",
    };
    // A nested test invocation must be a manager, not an inherited Node worker.
    delete testEnv.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=4",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${reporter}`,
        "--test-reporter-destination=stdout",
        ...(testEnv.MORPHZ_TEST_COGNITIVE_CI === "1"
          ? [
              `--test-reporter=${fileURLToPath(new URL("./ci-cognitive-runtime-reporter.mjs", import.meta.url))}`,
              "--test-reporter-destination=stdout",
            ]
          : []),
        ...options,
        ...files,
      ],
      {
        cwd: root,
        env: testEnv,
        stdio,
        detached: process.platform !== "win32",
      },
    );
    let force;
    const stop = () => {
      const kill = (signalName) => {
        try {
          if (process.platform !== "win32")
            process.kill(-child.pid, signalName);
          else child.kill(signalName);
        } catch {}
      };
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 3000);
      force.unref();
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      return await new Promise((accept, reject) => {
        child.once("error", () =>
          reject(new Error("Test process could not start")),
        );
        child.once("exit", (code, childSignal) =>
          accept(
            signal?.aborted
              ? signal.reason === "SIGTERM"
                ? 143
                : 130
              : (code ?? (childSignal ? 1 : 0)),
          ),
        );
        if (signal?.aborted) stop();
      });
    } finally {
      signal?.removeEventListener("abort", stop);
      clearTimeout(force);
      // The manager may exit before a worker which ignored TERM. This process
      // group was created only for this run; finish it before closing its PG.
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        const deadline = Date.now() + 3000;
        while (true) {
          try {
            process.kill(-child.pid, 0);
          } catch {
            break;
          }
          if (Date.now() >= deadline) {
            groupStopped = false;
            throw new Error(
              "Owned test process group did not terminate; temporary PostgreSQL was retained",
            );
          }
          await new Promise((accept) => setTimeout(accept, 20));
        }
      }
    }
  } finally {
    if (groupStopped) await prepared.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const stop = (signal) => controller.abort(signal);
  const onInt = () => stop("SIGINT"),
    onTerm = () => stop("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  runTests({ args: process.argv.slice(2), signal: controller.signal })
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(error.message);
        process.exitCode = controller.signal.aborted
          ? controller.signal.reason === "SIGTERM"
            ? 143
            : 130
          : 1;
      },
    )
    .finally(() => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    });
}
