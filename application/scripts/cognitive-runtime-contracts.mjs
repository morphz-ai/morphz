// Exact contracts proved by the cognitive Runtime CI job. These are not a
// title regexp or a global skip exception; additions require an explicit review.
export const cognitiveRuntimeContracts = Object.freeze(
  [
    {
      file: "tests/cognitive-app-actual-runtime.test.ts",
      name: "actual Rust Runtime + independent packed author: Agent discovery, write, exact read and receipt recovery retain real provenance",
      flag: "MORPHZ_COGNITIVE_RUNTIME_E2E",
    },
    {
      file: "tests/cognitive-app-actual-runtime-sources.test.ts",
      name: "actual Rust scheduled task + infer: cognitive calls retain task-run source and original input provenance",
      flag: "MORPHZ_COGNITIVE_SOURCES_RUNTIME_E2E",
    },
    {
      file: "tests/cognitive-app-input-actual-runtime.test.ts",
      name: "actual Rust cognitive original locator: IO10 source, read-input and exact historical author version",
      flag: "MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E",
    },
    {
      file: "tests/cognitive-app-input-actual-runtime.test.ts",
      name: "actual old-format Runtime rejects IO10 without downgrade or model work",
      flag: "MORPHZ_COGNITIVE_INPUT_RUNTIME_E2E",
    },
    {
      file: "tests/cognitive-app-application-actual-runtime.test.ts",
      name: "ACTUAL canonical Runtime explicit headless cognitive application activates installed Harness and preserves supplemented source",
      flag: "MORPHZ_COGNITIVE_APPLICATION_RUNTIME_E2E",
    },
    {
      file: "tests/cognitive-app-application-actual-runtime.test.ts",
      name: "ACTUAL canonical Runtime without IO11/12 registrations rejects explicit application without fallback",
      flag: "MORPHZ_COGNITIVE_APPLICATION_RUNTIME_E2E",
    },
  ].map((contract) => Object.freeze(contract)),
);
