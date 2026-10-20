// Explicit operator-invoked live gate. Never imported by normal tests.
// One process per case; no automatic retry and no original-app operation.
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [binary, config, model, output, credentialAlias, selectedCase] = process.argv.slice(2);
if (![binary, config, model, output, credentialAlias].every(Boolean)) {
  throw new Error("Expected BINARY CONFIG MODEL NEW_OUTPUT_DIRECTORY KEYCHAIN_ENV_ALIAS");
}
if (!/^[A-Z][A-Z0-9_]+$/.test(credentialAlias)) {
  throw new Error("Expected an explicit environment credential alias");
}
const executable = fs.realpathSync(binary);
const configuration = fs.realpathSync(config);
// Refuse to overwrite any previous live evidence.
fs.mkdirSync(output);
let key;
try {
  key = cp.execFileSync("/usr/bin/security", [
    "find-generic-password", "-s", "ai.morphz.runtime.secrets.v1",
    "-a", `env:${credentialAlias}`, "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  throw new Error("The explicitly selected test credential is unavailable");
}
if (!key) throw new Error("The explicitly selected test credential is empty");

const matrix = [
  ["plain", "on"], ["plain", "off"],
  ["review", "on"], ["review", "off"],
  ["annotated-review", "on"], ["progress", "on"],
  ["discuss-script", "on"], ["injected-invalid-arguments", "on"],
];
const cases = selectedCase ? matrix.filter(([testCase]) => testCase === selectedCase) : matrix;
if (!cases.length) throw new Error("Unknown diagnostic case; no model request was made");
const results = [];
for (const [testCase, mode] of cases) {
  console.log(`START ${testCase}/${mode}; real provider, no retry`);
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = cp.spawn(executable, [configuration, model, testCase, mode], {
      env: { ...process.env, [credentialAlias]: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { stderr += `Probe process failed: ${error.message}\n`; });
    child.on("close", (code, signal) => resolve({
      code, signal,
      stdout: stdout.replaceAll(key, "[REDACTED]"),
      stderr: stderr.replaceAll(key, "[REDACTED]"),
    }));
  });
  const prefix = path.join(output, `${testCase}-${mode}`);
  fs.writeFileSync(`${prefix}.stdout.log`, result.stdout, { flag: "wx" });
  fs.writeFileSync(`${prefix}.stderr.log`, result.stderr, { flag: "wx" });
  let report = null;
  for (const line of result.stdout.split("\n").filter((line) => line.startsWith("{"))) {
    try { report = JSON.parse(line); } catch { /* Preserve unparsed stdout as evidence. */ }
  }
  const passed = result.code === 0 && report?.passed === true;
  const record = {
    case: testCase, mode, passed, exit_code: result.code, signal: result.signal,
    elapsed_ms: Date.now() - started, report,
    evidence_kind: testCase === "injected-invalid-arguments"
      ? "real_provider_with_explicit_once_only_argument_fault_injection"
      : "unmodified_real_provider",
  };
  fs.writeFileSync(`${prefix}.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  results.push(record);
  console.log(`END ${testCase}/${mode}: ${passed ? "PASS" : "FAIL"} (${record.elapsed_ms} ms)`);
}
const reviewOn = results.find((result) => result.case === "review" && result.mode === "on")?.report;
const reviewOff = results.find((result) => result.case === "review" && result.mode === "off")?.report;
const directoryStableAcrossModes = reviewOn && reviewOff
  ? reviewOn.tool_directory_sha256[0] === reviewOff.tool_directory_sha256[0]
  : null;
const summary = {
  model, credential_alias: credentialAlias, automatic_retries: 0,
  scope: selectedCase ? "selected_case_diagnostic" : "acceptance_matrix",
  passed: results.every((result) => result.passed) &&
    (selectedCase ? directoryStableAcrossModes !== false : directoryStableAcrossModes === true),
  directory_stable_across_modes: directoryStableAcrossModes,
  cases: results,
};
fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  passed: summary.passed, completed_cases: results.length,
  passing_cases: results.filter((result) => result.passed).length,
  directory_stable_across_modes: directoryStableAcrossModes,
  summary: path.join(output, "summary.json"),
}));
process.exitCode = summary.passed ? 0 : 1;
