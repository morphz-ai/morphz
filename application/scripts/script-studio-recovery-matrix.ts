/** Crash only isolated Runtime children; never restart the user's Desktop Runtime. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scriptFaultPoints,
  type ScriptFaultPoint,
} from "./script-studio-fault-injection.js";

const application = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), "morphz-script-recovery-"));
const results: {
  point: ScriptFaultPoint;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  evidenceDirectory?: string;
  log: string;
  durationMs: number;
}[] = [];
let next = 0;
console.log(`Recovery matrix evidence: ${directory}`);
const run = async (point: ScriptFaultPoint) => {
  const start = Date.now();
  const log = join(directory, `${point}.log`);
  let output = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/script-studio-runtime-smoke.ts",
      `--fault=${point}`,
    ],
    {
      cwd: application,
      env: { ...process.env, MORPHZ_APP_ENV_FILE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  writeFileSync(log, output, { mode: 0o600 });
  const evidenceDirectory =
    /"evidenceDirectory": "([^"]+)"/.exec(output)?.[1] ??
    /Isolated failure evidence retained: (.+)/.exec(output)?.[1];
  const passed =
    exit.exitCode === 0 &&
    output.includes(
      "PASS: script Harness/Runtime/embedded Host/SQLite workflow and teardown.",
    );
  if (passed) {
    assert.ok(
      evidenceDirectory,
      "A passing test must retain its durable proof",
    );
    const evidence = JSON.parse(
      readFileSync(join(evidenceDirectory, "result.json"), "utf8"),
    );
    assert.equal(evidence.point, point);
    assert.equal(evidence.status, "assertions-passed");
  }
  results.push({
    point,
    passed,
    ...exit,
    evidenceDirectory,
    log,
    durationMs: Date.now() - start,
  });
  writeFileSync(
    join(directory, "progress.json"),
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `${passed ? "PASS" : "FAIL"} ${point} (${Math.round((Date.now() - start) / 1000)}s): ${evidenceDirectory ?? log}`,
  );
};
// Four independent fixtures, databases, ports and Runtime children; no shared user profile.
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < scriptFaultPoints.length)
      await run(scriptFaultPoints[next++]!);
  }),
);
results.sort(
  (a, b) =>
    scriptFaultPoints.indexOf(a.point) - scriptFaultPoints.indexOf(b.point),
);
const evidence = {
  completedAt: new Date().toISOString(),
  harnessSha256: createHash("sha256")
    .update(readFileSync(join(application, "harnesses/script-studio.hns")))
    .digest("hex"),
  syntheticProviderOnly: true,
  userRuntimeUntouched: true,
  passed: results.filter((result) => result.passed).length,
  total: scriptFaultPoints.length,
  results,
};
writeFileSync(
  join(directory, "summary.json"),
  JSON.stringify(evidence, null, 2),
  { mode: 0o600 },
);
console.log(
  `Recovery matrix: ${evidence.passed}/${evidence.total}; ${join(directory, "summary.json")}`,
);
if (evidence.passed !== evidence.total) process.exitCode = 1;
