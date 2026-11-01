import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySkippedTest,
  testCapabilityPlan,
} from "./test-capabilities.mjs";

// Emit failures when observed: a later worker/process shutdown must not erase
// the useful error while the ordinary reporter waits for its final summary.
// Read only own data properties, not arbitrary getters or attached state.
function errorDiagnostic(error, depth = 0, seen = new Set()) {
  if (error === null || error === undefined) return null;
  if (typeof error !== "object") return String(error).slice(0, 3000);
  if (depth > 3 || seen.has(error)) return "[nested error omitted]";
  seen.add(error);
  const result = {};
  for (const name of [
    "name",
    "message",
    "stack",
    "code",
    "failureType",
    "actual",
    "expected",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(error, name);
    if (!descriptor || !("value" in descriptor)) continue;
    const value = descriptor.value;
    if (typeof value === "string")
      result[name] = value.slice(0, name === "stack" ? 4000 : 3000);
    else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
      result[name] = value;
  }
  const cause = Object.getOwnPropertyDescriptor(error, "cause");
  if (cause && "value" in cause)
    result.cause = errorDiagnostic(cause.value, depth + 1, seen);
  return result;
}

// Consume the whole stream before rejecting coverage, so sibling tests and
// their owned resources finish cleanup. Node propagates the final error as a
// failed child process; run-tests then closes only its own PostgreSQL instance.
export default async function* coverageReporter(events) {
  const files = process.env.MORPHZ_TEST_SELECTED_FILES
    ? JSON.parse(process.env.MORPHZ_TEST_SELECTED_FILES)
    : null;
  const shard = process.execArgv
    .find((option) => option.startsWith("--test-shard="))
    ?.slice("--test-shard=".length);
  yield* reportTestCoverage(events, testCapabilityPlan({ files }), shard);
}

export async function* reportTestCoverage(events, plan, shard) {
  const skipped = [],
    unexpected = [];
  const unexpectedFiles = [];
  const executed = new Set();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const identity = (file) => relative(root, resolve(file)).split(sep).join("/");
  const inventory =
    shard && plan.files ? [...plan.files].map(identity).sort() : null;
  const planned = new Set(inventory ?? []);
  let summary;
  for await (const event of events) {
    if (event.type === "test:fail") {
      yield `[test failure] ${JSON.stringify({
        file: event.data.file,
        name: event.data.name,
        line: event.data.line,
        column: event.data.column,
        error: errorDiagnostic(event.data.details?.error),
      })}\n`;
    }
    if (event.type === "test:pass" && event.data.skip) {
      try {
        skipped.push(classifySkippedTest(event.data, plan));
      } catch (error) {
        unexpected.push(error.message);
      }
    }
    if (event.type === "test:summary") {
      if (!event.data.file) summary = event.data;
      else if (shard) {
        const file = identity(event.data.file);
        if (!planned.has(file) || executed.has(file))
          unexpectedFiles.push(
            `Shard produced an unexpected or duplicate file summary: ${file}`,
          );
        executed.add(file);
      }
    }
  }
  yield `[test coverage] ${JSON.stringify({
    required: [...plan.required],
    selectedFiles: plan.files ? [...plan.files] : null,
    counts: summary?.counts,
    optionalNotExecuted: skipped,
    unexpectedSkips: unexpected,
    ...(shard
      ? {
          shard: {
            coordinate: shard,
            inventory,
            executedFiles: [...executed].sort(),
            unexpectedFiles,
          },
        }
      : {}),
  })}\n`;
  if (!summary)
    throw new Error("Test process produced no final coverage summary.");
  if (unexpected.length)
    throw new Error(`Test coverage failed: ${unexpected.join("; ")}`);
  if (unexpectedFiles.length)
    throw new Error(
      `Test shard coverage failed: ${unexpectedFiles.join("; ")}`,
    );
}
