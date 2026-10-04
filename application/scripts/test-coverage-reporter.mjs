import {
  classifySkippedTest,
  testCapabilityPlan,
} from "./test-capabilities.mjs";

// Consume the whole stream before rejecting coverage, so sibling tests and
// their owned resources finish cleanup. Node propagates the final error as a
// failed child process; run-tests then closes only its own PostgreSQL instance.
export default async function* coverageReporter(events) {
  const files = process.env.MORPHZ_TEST_SELECTED_FILES
    ? JSON.parse(process.env.MORPHZ_TEST_SELECTED_FILES)
    : null;
  yield* reportTestCoverage(events, testCapabilityPlan({ files }));
}

export async function* reportTestCoverage(events, plan) {
  const skipped = [],
    unexpected = [];
  let summary;
  for await (const event of events) {
    if (event.type === "test:pass" && event.data.skip) {
      try {
        skipped.push(classifySkippedTest(event.data, plan));
      } catch (error) {
        unexpected.push(error.message);
      }
    }
    if (event.type === "test:summary" && !event.data.file) summary = event.data;
  }
  yield `[test coverage] ${JSON.stringify({
    required: [...plan.required],
    selectedFiles: plan.files ? [...plan.files] : null,
    counts: summary?.counts,
    optionalNotExecuted: skipped,
    unexpectedSkips: unexpected,
  })}\n`;
  if (!summary)
    throw new Error("Test process produced no final coverage summary.");
  if (unexpected.length)
    throw new Error(`Test coverage failed: ${unexpected.join("; ")}`);
}
