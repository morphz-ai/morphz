import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { cognitiveRuntimeContracts } from "./cognitive-runtime-contracts.mjs";

const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
export const cognitiveRuntimeFiles = Object.freeze([
  ...new Set(cognitiveRuntimeContracts.map((contract) => contract.file)),
]);
export const cognitiveRuntimeFlags = Object.freeze([
  ...new Set(cognitiveRuntimeContracts.map((contract) => contract.flag)),
]);

// No provider/account environment, proxy, Node preload or user database URL
// reaches these fixtures. The formal manager owns a new temporary PostgreSQL.
export function cognitiveRuntimeEnvironment(environment = process.env) {
  const result = { MORPHZ_APP_ENV_FILE: "", NODE_NO_WARNINGS: "1" };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "CI",
    "GITHUB_ACTIONS",
    "npm_execpath",
    "MORPHZ_APP_RUNTIME_BINARY",
    "MORPHZ_TEST_POSTGRES_BIN_DIR",
    "MORPHZ_TEST_PG_DUMP",
    "MORPHZ_TEST_PG_RESTORE",
  ])
    if (environment[name] !== undefined) result[name] = environment[name];
  result.MORPHZ_TEST_REQUIRED_CAPABILITIES = "postgres,runtime";
  result.MORPHZ_TEST_COGNITIVE_CI = "1";
  for (const flag of cognitiveRuntimeFlags) result[flag] = "1";
  return result;
}

export function sanitizeCognitiveEvidence(value, environment = {}) {
  let result = String(value).replace(/\u001b\[[0-9;]*m/g, "");
  const secrets = new Set();
  for (const [name, candidate] of Object.entries(environment)) {
    if (typeof candidate !== "string" || candidate.length < 4) continue;
    if (/token|password|credential|secret|api.?key|postgres.*url/i.test(name))
      secrets.add(candidate);
    try {
      const url = new URL(candidate);
      for (const field of [url.username, url.password])
        if (field.length >= 4) secrets.add(decodeURIComponent(field));
    } catch {}
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    result = result.replaceAll(secret, "[REDACTED]");
  return result
    .replace(/\bBearer\s+[^\s'"<>,}\]]+/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s'"<>?]+)\?[^\s'"<>]*/gi, "$1?[REDACTED]")
    .replace(
      /((?:["']?)(?:authorization|token|password|credential|secret|api[_-]?key)(?:["']?)\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,}\]]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[0-9a-f]{48,}\b/gi, "[REDACTED-OPAQUE]")
    .replaceAll(applicationRoot, "<application>/");
}

export function cognitiveCoverageGate(output) {
  const lines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[test coverage] "));
  if (lines.length !== 1)
    throw new Error("Exactly one completed coverage report is required.");
  let record;
  try {
    record = JSON.parse(lines[0].slice("[test coverage] ".length));
  } catch {
    throw new Error("Coverage report is not valid JSON.");
  }
  if (
    !Array.isArray(record.required) ||
    record.required.length !== 2 ||
    !record.required.includes("postgres") ||
    !record.required.includes("runtime")
  )
    throw new Error("PostgreSQL and Runtime must both be required.");
  if (
    !Array.isArray(record.selectedFiles) ||
    record.selectedFiles.length !== cognitiveRuntimeFiles.length ||
    new Set(record.selectedFiles).size !== cognitiveRuntimeFiles.length ||
    !record.selectedFiles.every(
      (file) =>
        typeof file === "string" &&
        cognitiveRuntimeFiles.includes(relative(applicationRoot, file)),
    )
  )
    throw new Error(
      "Coverage must include the four exact cognitive Runtime files.",
    );
  if (
    !Array.isArray(record.optionalNotExecuted) ||
    record.optionalNotExecuted.length ||
    !Array.isArray(record.unexpectedSkips) ||
    record.unexpectedSkips.length
  )
    throw new Error("No optional omissions or unexpected skips are permitted.");
  // These four files contain six actual contracts, including their two
  // old-format rejection controls. Removing one cannot produce a green run.
  const counts = record.counts;
  if (
    counts?.tests !== 6 ||
    counts.passed !== 6 ||
    ["failed", "cancelled", "skipped", "todo"].some((key) => counts[key] !== 0)
  )
    throw new Error(
      "All six cognitive Runtime contracts must pass without skip, cancellation or todo.",
    );
  const completionLines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[cognitive contracts] "));
  if (completionLines.length !== 1)
    throw new Error("Exactly one per-contract completion report is required.");
  let completion;
  try {
    completion = JSON.parse(
      completionLines[0].slice("[cognitive contracts] ".length),
    );
  } catch {
    throw new Error("Per-contract completion report is not valid JSON.");
  }
  if (
    completion.rootSummaryObserved !== true ||
    completion.complete !== true ||
    !Array.isArray(completion.contracts) ||
    completion.contracts.length !== cognitiveRuntimeContracts.length ||
    !cognitiveRuntimeContracts.every(({ file, name }) => {
      const entries = completion.contracts.filter(
        (contract) => contract?.file === file && contract?.name === name,
      );
      return (
        entries.length === 1 &&
        entries[0].passes === 1 &&
        entries[0].failures === 0 &&
        entries[0].skips === 0
      );
    })
  )
    throw new Error(
      "Each exact cognitive Runtime file/title must complete once without failure or skip.",
    );
  return {
    required: record.required,
    files: [...cognitiveRuntimeFiles],
    counts,
    contracts: completion.contracts,
  };
}

/** Test seams replace only the owned child process and evidence directory.
 * The CLI has no custom file selection, flag opt-out or provider parameters. */
export async function runCognitiveRuntimeCI({
  env = process.env,
  signal,
  launch = spawn,
  evidenceRoot = resolve(applicationRoot, "test-results"),
  timeoutMs = 10 * 60_000,
  cancellationGraceMs = 30_000,
  maximumBytes = 4 * 1024 * 1024,
} = {}) {
  await mkdir(evidenceRoot, { recursive: true });
  const directory = await mkdtemp(
    resolve(evidenceRoot, "cognitive-runtime-ci-"),
  );
  await chmod(directory, 0o700);
  const startedAt = new Date().toISOString();
  const record = {
    format: "morphz-cognitive-runtime-ci/v1",
    startedAt,
    state: "running",
    files: [...cognitiveRuntimeFiles],
    provider: "isolated synthetic loopback",
    databases: "test-owned SQLite and temporary PostgreSQL",
  };
  // A last record left at running means completion was not observed. A runner
  // disappearance cannot be classified as a test failure or explicit cancel.
  const publish = async () =>
    writeFile(
      resolve(directory, "summary.json"),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600 },
    );
  await publish();
  let child,
    timer,
    force,
    bytes = 0,
    output = "",
    stopReason,
    forced = false;
  const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    child?.kill("SIGTERM");
    force = setTimeout(() => {
      forced = true;
      // Only this run's manager PID. Never guess or signal an ambient group.
      child?.kill("SIGKILL");
    }, cancellationGraceMs);
    force.unref();
  };
  const onAbort = () => stop("cancelled");
  let code = null,
    childSignal = null,
    failure;
  try {
    if (!env.npm_execpath)
      throw new Error(
        "Run this gate through npm exec --offline; the author fixture needs the actual npm CLI.",
      );
    if (signal?.aborted) stopReason = "cancelled";
    else {
      child = launch(
        process.execPath,
        [
          resolve(applicationRoot, "scripts/run-tests.mjs"),
          ...cognitiveRuntimeFiles,
        ],
        {
          cwd: applicationRoot,
          env: cognitiveRuntimeEnvironment(env),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      for (const [index, stream] of [child.stdout, child.stderr].entries())
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) {
            stop("output-limit");
            return;
          }
          output += decoders[index].write(chunk);
        });
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => stop("timed-out"), timeoutMs);
      const result = await new Promise((accept, reject) => {
        child.once("error", () =>
          reject(new Error("The test manager could not start.")),
        );
        child.once("close", (exitCode, exitSignal) =>
          accept([exitCode, exitSignal]),
        );
        if (signal?.aborted) onAbort();
      });
      [code, childSignal] = result;
      output += decoders.map((decoder) => decoder.end()).join("");
      if (!stopReason && code === 0)
        record.coverage = cognitiveCoverageGate(output);
      else if (!stopReason)
        throw new Error("The test manager did not exit successfully.");
    }
  } catch (error) {
    failure = error.message;
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    signal?.removeEventListener("abort", onAbort);
  }
  record.finishedAt = new Date().toISOString();
  record.state = stopReason || (failure ? "failed" : "passed");
  record.exitCode = code;
  record.exitSignal = childSignal;
  record.cleanup = forced
    ? "manager forcibly stopped; resource cleanup unconfirmed"
    : code === 0
      ? "formal manager completed owned-resource cleanup"
      : "not proven by a successful manager exit";
  if (failure) record.error = sanitizeCognitiveEvidence(failure, env);
  record.outputBytes = bytes;
  await writeFile(
    resolve(directory, "test-output.redacted.log"),
    sanitizeCognitiveEvidence(output, env),
    { mode: 0o600 },
  );
  await publish();
  const exitCode =
    record.state === "passed"
      ? 0
      : record.state === "cancelled"
        ? signal?.reason === "SIGTERM"
          ? 143
          : 130
        : 1;
  return { directory, record, exitCode };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const onInt = () => controller.abort("SIGINT"),
    onTerm = () => controller.abort("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  console.log(
    "Cognitive Runtime CI: four fixed groups, synthetic provider, isolated data; awaiting complete coverage.",
  );
  runCognitiveRuntimeCI({ signal: controller.signal })
    .then(
      ({ directory, record, exitCode }) => {
        console.log(
          `Cognitive Runtime CI: ${record.state}; redacted evidence ${relative(applicationRoot, directory)}`,
        );
        if (record.error) console.error(record.error);
        process.exitCode = exitCode;
      },
      () => {
        console.error(
          "Cognitive Runtime CI failed before evidence could be finalized; no test completion is claimed.",
        );
        process.exitCode = controller.signal.aborted ? 130 : 1;
      },
    )
    .finally(() => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    });
}
