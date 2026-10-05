import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  executionOwnerText,
  executionRegistration,
  verifyExecutionInteractionConsumption,
  verifyExecutionInteractionOwner,
} from "./fixtures/execution-interactions-consumption.js";
import { parseReaderSources } from "./fixtures/reader-reads-contract.js";
import { verifyClientProjectionLifetime } from "./fixtures/client-projection-lifetime-21cb34dc.js";

const client = readFileSync("apps/web/src/client.ts", "utf8");
function changed(text: string, before: string, after: string) {
  assert.equal(text.split(before).length, 2, "one existing mutation target");
  const result = text.replace(before, after);
  parseReaderSources({ Mutation: result });
  return result;
}
function validate(text = client, owner = executionOwnerText) {
  verifyExecutionInteractionConsumption(text, owner);
  verifyClientProjectionLifetime(text);
}
test("complete five-method execution owner, actual Client consumers and protected projection lifetime", () => {
  verifyExecutionInteractionOwner();
  validate();
});
test("legal Client counterfactuals fail real import, captures, placement, hooks, aliases and finite clear lifetime", () => {
  const captures: [string, string, string][] = [
    [
      "    current,",
      "    current: { current: current.current },",
      "exact original execution captures",
    ],
    [
      "    approvalSubmissions,",
      "    approvalSubmissions: { current: new Set() },",
      "exact original execution captures",
    ],
    [
      "    updateApprovalSubmissions,",
      "    updateApprovalSubmissions: () => {},",
      "exact original execution captures",
    ],
    [
      "    call: applicationCall,",
      "    call: (...args) => applicationCall(...args),",
      "exact original execution captures",
    ],
    [
      "    refreshAfterMutation,",
      "    refreshAfterMutation: async () => refreshAfterMutation(),",
      "exact original execution captures",
    ],
    [
      "createExecutionInteractions({",
      "((ports) => createExecutionInteractions(ports))({",
      "direct execution constructor",
    ],
  ];
  for (const [before, after, rule] of captures)
    assert.throws(
      () =>
        validate(
          changed(
            client,
            executionRegistration,
            changed(executionRegistration, before, after),
          ),
        ),
      { name: "AssertionError", message: new RegExp(rule) },
    );
  const direct: [string, string, string][] = [
    [
      'import { createExecutionInteractions } from "./data/execution-interactions.js";',
      'import { type createExecutionInteractions } from "./data/execution-interactions.js";',
      "runtime execution factory import",
    ],
    [
      "const executionInteractions = createExecutionInteractions({",
      "const createExecutionInteractions = () => ({}); const executionInteractions = createExecutionInteractions({",
      "no shadow import variable",
    ],
    [
      executionRegistration,
      executionRegistration +
        executionRegistration.replace(
          "const executionInteractions",
          "const duplicateInteractions",
        ),
      "one actual execution construction",
    ],
    [
      "executionResult: executionInteractions.executionResult",
      "executionResult: async (...args) => executionInteractions.executionResult(...args)",
      "direct public execution alias executionResult",
    ],
    [
      "executionResult: executionInteractions.executionResult",
      "executionResult: executionInteractions.executionSnapshot",
      "only five actual Client execution consumers",
    ],
    [
      "const approvalSubmissions = useRef(new Set<string>());",
      'const approvalSubmissions = useRef(new Set<string>(["prior"]));',
      "original execution Client ref approvalSubmissions",
    ],
    [
      "const [, updateApprovalSubmissions] = useState(0);",
      "const [, updateApprovalSubmissions] = useState(1);",
      "original approval state registration",
    ],
    [
      "function clearProtectedProjection(keepRead?: AbortController) {",
      "function clearProtectedProjection(keepRead?: AbortController) { approvalSubmissions.current.clear();",
      "complete original protected projection clear and approval lifetime",
    ],
    [
      "function clearProtectedProjection(keepRead?: AbortController) {\n    protectedReadGeneration.current++;",
      "function clearProtectedProjection(keepRead?: AbortController) {\n    protectedReadGeneration.current += 0;",
      "complete original protected projection clear and approval lifetime",
    ],
  ];
  for (const [before, after, rule] of direct)
    assert.throws(() => validate(changed(client, before, after)), {
      name: "AssertionError",
      message: new RegExp(rule),
    });
  const removed = changed(client, executionRegistration, "");
  const moved = changed(
    removed,
    "  function refresh() {",
    executionRegistration + "  function refresh() {",
  );
  assert.throws(() => validate(moved), {
    name: "AssertionError",
    message: /original execution registration location/,
  });
});
test("unrelated Client type, export and independent React feature growth does not change execution ownership", () => {
  validate(
    client +
      `\nexport type FutureExecutionView = { label: string };\nexport function useFutureExecutionView() { const current = useRef(0); const [value] = useState(0); function clearProtectedProjection() { return current.current; } return value + clearProtectedProjection(); }\nexport const futureExecutionLabel = "independent";\n`,
  );
  validate(
    client +
      `\nexport function futureExecutionOwner(ports: Parameters<typeof createExecutionInteractions>[0]) { return createExecutionInteractions(ports); }\n`,
  );
  validate(
    changed(
      changed(
        client,
        "import { createExecutionInteractions }",
        "import { createExecutionInteractions as makeExecution }",
      ),
      "const executionInteractions = createExecutionInteractions(",
      "const executionInteractions = makeExecution(",
    ),
  );
});
test("legal owner counterfactuals fail complete original timeout, signal, parse, approval ordering and inert construction rules", () => {
  const variants: [string, string, string][] = [
    [
      "AbortSignal.timeout(8000)",
      "AbortSignal.timeout(12000)",
      "complete original execution algorithm cancelInput",
    ],
    [
      "    await refreshAfterMutation();",
      "    refreshAfterMutation();",
      "complete original execution algorithm cancelInput",
    ],
    [
      "AbortSignal.any([signal, AbortSignal.timeout(12000)])",
      "signal",
      "complete original execution algorithm executionSnapshot",
    ],
    [
      "executionSnapshotSchema.parse(",
      "Promise.resolve(",
      "complete original execution algorithm executionSnapshot",
    ],
    [
      "{ scope, jobId }",
      "{ scope, jobId: scope.sessionId }",
      "complete original execution algorithm executionResult",
    ],
    [
      "truncated: z.boolean(),",
      "truncated: z.boolean().optional(),",
      "complete original execution algorithm executionResult",
    ],
    [
      "      approvalSubmissions.current.add(key);\n      updateApprovalSubmissions((version) => version + 1);",
      "      updateApprovalSubmissions((version) => version + 1);\n      approvalSubmissions.current.add(key);",
      "complete original execution algorithm controlExecution",
    ],
    [
      "command.action.fingerprint,",
      "command.action.approvalId,",
      "complete original execution algorithm controlExecution",
    ],
    [
      "JSON.stringify([current.current?.csrfToken, approvalId, fingerprint])",
      "JSON.stringify([approvalId, fingerprint])",
      "complete original execution algorithm approvalSubmitted",
    ],
    [
      "  function approvalSubmitted(",
      "  async function approvalSubmitted(",
      "complete original execution algorithm approvalSubmitted",
    ],
    [
      "    approvalSubmitted,\n",
      "    approvalSubmitted: async (...args) => approvalSubmitted(...args),\n",
      "direct execution return without wrappers",
    ],
    [
      "  async function cancelInput(",
      "  current.current;\n  async function cancelInput(",
      "only five commands and direct return, no construction work",
    ],
    [
      "refreshAfterMutation(): Promise<boolean>;",
      "refreshAfterMutation(): Promise<boolean>; subscribe(): void;",
      "exact original execution port contract",
    ],
    [
      "export type ExecutionInteractionPorts",
      "const mirror = new Set<string>();\nexport type ExecutionInteractionPorts",
      "finite inert execution module",
    ],
  ];
  for (const [before, after, rule] of variants)
    assert.throws(
      () => validate(client, changed(executionOwnerText, before, after)),
      {
        name: "AssertionError",
        message: new RegExp(rule),
      },
    );
});
