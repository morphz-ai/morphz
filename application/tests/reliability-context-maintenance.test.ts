import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMaintenanceEvidence,
  type MaintenanceEvidence,
} from "../scripts/reliability-context-maintenance.js";

function complete(): MaintenanceEvidence {
  const critical = {
    root: "original",
    pressure: {
      level: "critical",
      estimatedTokens: 70_000,
      hardLimit: 60_000,
      reserve: 7500,
      tokenSource: "openai-chat-serialized-request-estimate",
      tokenAccuracy: "heuristic-estimate",
      tokenScope: "full-work-prompt",
    },
    tools: ["context_tx", "reply", "no_reply"],
    protectedInputVisible: true,
  };
  return {
    root: "original",
    protectedInput: "keep-input",
    fact: "keep-fact",
    critical: [
      structuredClone(critical),
      structuredClone(critical),
      structuredClone(critical),
    ],
    restored: {
      ...structuredClone(critical),
      pressure: {
        level: "normal",
        estimatedTokens: 40_000,
        hardLimit: 60_000,
        reserve: 7500,
        tokenSource: "openai-chat-serialized-request-estimate",
        tokenAccuracy: "heuristic-estimate",
        tokenScope: "full-work-prompt",
      },
      tools: ["context_tx", "write", "reply"],
    },
    forbiddenWrite: {
      status: "rejected",
      executed: false,
      code: "TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE",
    },
    protectedRetirementRejected: true,
    protectedRootRetired: false,
    oldObservationsRetired: ["old"],
    expectedOldObservations: ["old"],
    frameBody: "Observed prior keep-fact",
    frameHasExactSource: true,
    originalInputUnchanged: true,
    jobCount: 1,
    jobStatus: "succeeded",
    jobRoot: "original",
    fileContent: "result",
    expectedFileContent: "result",
    terminalCount: 1,
    unresolvedSignals: 0,
    unresolvedActivations: 0,
    repeatedReceiptRoot: "original",
    callsBeforeRetry: 7,
    callsAfterRetry: 7,
  };
}

test("controlled maintenance oracle accepts the full persisted protocol proof, not a summary-quality claim", () =>
  assertMaintenanceEvidence(complete()));

for (const [name, mutate] of [
  [
    "missing actual maintenance request",
    (e: MaintenanceEvidence) => {
      e.critical = [];
    },
  ],
  [
    "scripted transaction without critical pressure",
    (e: MaintenanceEvidence) => {
      e.critical[0]!.pressure.level = "normal";
    },
  ],
  [
    "critical work schema never restricted",
    (e: MaintenanceEvidence) => {
      e.critical[0]!.tools.push("write");
    },
  ],
  [
    "other physical tool leaked during critical maintenance",
    (e: MaintenanceEvidence) => {
      e.critical[0]!.tools.push("exec");
    },
  ],
  [
    "Context-only estimate mistaken for full-work pressure",
    (e: MaintenanceEvidence) => {
      e.critical[0]!.pressure.tokenScope = "context-only";
    },
  ],
  [
    "protected input hidden",
    (e: MaintenanceEvidence) => {
      e.critical[0]!.protectedInputVisible = false;
    },
  ],
  [
    "forbidden write really executed",
    (e: MaintenanceEvidence) => {
      e.forbiddenWrite.executed = true;
    },
  ],
  [
    "retirement negative control accepted",
    (e: MaintenanceEvidence) => {
      e.protectedRetirementRejected = false;
    },
  ],
  [
    "original input retired",
    (e: MaintenanceEvidence) => {
      e.protectedRootRetired = true;
    },
  ],
  [
    "original immutable input rewritten",
    (e: MaintenanceEvidence) => {
      e.originalInputUnchanged = false;
    },
  ],
  [
    "old history not actually retired",
    (e: MaintenanceEvidence) => {
      e.oldObservationsRetired = [];
    },
  ],
  [
    "fact missing after maintenance",
    (e: MaintenanceEvidence) => {
      e.frameBody = "lost";
    },
  ],
  [
    "fact has invented source",
    (e: MaintenanceEvidence) => {
      e.frameHasExactSource = false;
    },
  ],
  [
    "pressure never falls",
    (e: MaintenanceEvidence) => {
      e.restored.pressure.level = "critical";
    },
  ],
  [
    "work tool never restored",
    (e: MaintenanceEvidence) => {
      e.restored.tools = ["context_tx"];
    },
  ],
  [
    "new root substituted for continuation",
    (e: MaintenanceEvidence) => {
      e.restored.root = "other";
    },
  ],
  [
    "physical work duplicated",
    (e: MaintenanceEvidence) => {
      e.jobCount = 2;
    },
  ],
  [
    "stranded claimed signal",
    (e: MaintenanceEvidence) => {
      e.unresolvedSignals = 1;
    },
  ],
  [
    "retry starts another evaluation",
    (e: MaintenanceEvidence) => {
      e.callsAfterRetry++;
    },
  ],
] as Array<[string, (e: MaintenanceEvidence) => void]>) {
  test(`controlled maintenance oracle rejects ${name}`, () => {
    const evidence = complete();
    mutate(evidence);
    assert.throws(() => assertMaintenanceEvidence(evidence));
  });
}
