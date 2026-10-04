import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseReaderSources } from "./fixtures/reader-reads-contract.js";
import {
  verifyLocalInputDeliveryConsumption,
  localDeliveryOwnerText,
  verifyLocalInputDeliveryOwner,
} from "./fixtures/local-input-delivery-consumption.js";

const client = readFileSync("apps/web/src/client.ts", "utf8");
function changed(text: string, before: string, after: string) {
  assert.equal(text.split(before).length, 2, "one existing mutation target");
  const result = text.replace(before, after);
  parseReaderSources({ Mutation: result });
  return result;
}
test("unrelated Client type, export and independent React feature growth preserves delivery seams", () => {
  verifyLocalInputDeliveryConsumption(
    client +
      `\nexport type FutureDeliveryView = { label: string };\nexport function useFutureDeliveryView() { const current = useRef(0); const [value] = useState(0); function clearProtectedProjection() { return current.current; } return value + clearProtectedProjection(); }\nexport const futureDeliveryLabel = "independent";\n`,
  );
  verifyLocalInputDeliveryConsumption(
    client +
      `\nexport function futureDeliveryOwner(ports: Parameters<typeof createLocalInputDelivery>[0]) { return createLocalInputDelivery(ports); }\n`,
  );
  verifyLocalInputDeliveryConsumption(
    changed(
      changed(
        client,
        "import { createLocalInputDelivery }",
        "import { createLocalInputDelivery as makeDelivery }",
      ),
      "const localInputDelivery = createLocalInputDelivery(",
      "const localInputDelivery = makeDelivery(",
    ),
  );
});
test("complete delivery owner is inert with original synchronous and refresh Client seams", () => {
  verifyLocalInputDeliveryOwner();
  verifyLocalInputDeliveryConsumption(client);
});
test("legal Client mutations fail designated real import, capture, synchronous branch and refresh seams", () => {
  const constructor = client.slice(
    client.indexOf("  const localInputDelivery = createLocalInputDelivery({"),
    client.indexOf("  const executionInteractions ="),
  );
  assert.ok(constructor.startsWith("  const localInputDelivery"));
  const variants: [string, string, string][] = [
    [
      "    storage: () => localStorage,",
      "    storage: localStorage,",
      "exact lazy storage and original delivery captures",
    ],
    [
      "    inputSends,",
      "    inputSends: { current: new Map() },",
      "exact lazy storage and original delivery captures",
    ],
    [
      "    current,",
      "    current: { current: current.current },",
      "exact lazy storage and original delivery captures",
    ],
    [
      "    refreshAfterMutation,",
      "    refreshAfterMutation: async () => refreshAfterMutation(),",
      "exact lazy storage and original delivery captures",
    ],
    [
      "    executePlatformOperation,",
      "    executePlatformOperation: (...args) => executePlatformOperation(...args),",
      "exact lazy storage and original delivery captures",
    ],
    [
      "createLocalInputDelivery({",
      "((ports) => createLocalInputDelivery(ports))({",
      "direct delivery constructor",
    ],
  ];
  for (const [before, after, rule] of variants)
    assert.throws(
      () =>
        verifyLocalInputDeliveryConsumption(
          changed(client, constructor, changed(constructor, before, after)),
        ),
      { name: "AssertionError", message: new RegExp(rule) },
    );
  const direct: [string, string, string][] = [
    [
      "if (!navigationReadStillCurrent(navigation, finalNavigation))",
      "if (navigationReadStillCurrent(navigation, finalNavigation))",
      "one original final navigation check",
    ],
    [
      'import { createLocalInputDelivery } from "./data/local-input-delivery.js";',
      'import { type createLocalInputDelivery } from "./data/local-input-delivery.js";',
      "runtime delivery factory import",
    ],
    [
      "const localInputDelivery = createLocalInputDelivery({",
      "const createLocalInputDelivery = () => ({}); const localInputDelivery = createLocalInputDelivery({",
      "no shadow import variable",
    ],
    [
      "return localInputDelivery.recordInput(",
      "return await localInputDelivery.recordInput(",
      "synchronous captured Client record branch",
    ],
    [
      "        externalCommandId,\n        onInputStaged,",
      "        undefined,\n        onInputStaged,",
      "synchronous captured Client record branch",
    ],
    [
      "const savedInputs = localInputDelivery.readSaved(source.boot);",
      "const savedInputs = localInputDelivery.readSaved(current.current!);",
      "original early refresh read seam",
    ],
    [
      "const savedProjection = localInputDelivery.confirmAndProject(\n          workspace,\n          source,",
      "const savedProjection = localInputDelivery.confirmAndProject(\n          workspace,\n          platform.current!,",
      "original publication-time refresh seam",
    ],
  ];
  for (const [before, after, rule] of direct)
    assert.throws(
      () => verifyLocalInputDeliveryConsumption(changed(client, before, after)),
      {
        name: "AssertionError",
        message: new RegExp(rule),
      },
    );
  assert.throws(
    () =>
      verifyLocalInputDeliveryConsumption(
        changed(
          client,
          "dispatchInput: localInputDelivery.dispatchInput",
          "dispatchInput: async (...args) => localInputDelivery.dispatchInput(...args)",
        ),
      ),
    assert.AssertionError,
  );
  const duplicate = constructor.replace(
    "const localInputDelivery",
    "const duplicateDelivery",
  );
  assert.throws(
    () =>
      verifyLocalInputDeliveryConsumption(
        changed(client, constructor, constructor + duplicate),
      ),
    {
      name: "AssertionError",
      message: /one actual delivery construction/,
    },
  );
});
test("legal owner mutations fail complete algorithms, frozen retry/order and inert construction", () => {
  const variants: [string, string, string][] = [
    [
      "inputSends.current.set(key, request);",
      "inputSends.current.set(entry.commandId, request);",
      "complete original delivery algorithm submitSavedInput",
    ],
    [
      "onStaged?.(entry.commandId);",
      "await onStaged?.(entry.commandId);",
      "complete original delivery algorithm submitSavedInput",
    ],
    [
      "inputSends.current.delete(key);",
      "inputSends.current.clear();",
      "complete original delivery algorithm submitSavedInput",
    ],
    [
      "    current.current = value;\n",
      "    setBoot(value);\n    current.current = value;\n",
      "complete original delivery algorithm publishSavedInputs",
    ],
    [
      "input.author.actantId !== source.boot.actantId",
      "false",
      "complete publication-time confirmation block",
    ],
    [
      "matchSavedInputOperation(operation, existing.operation)",
      "operationSchema.parse(newInputOperation(operation))",
      "complete synchronous original record branch",
    ],
    [
      "return readSavedInputs(storage(), savedInputScope(identity));",
      "return readSavedInputs(storage(), savedInputScope(current.current!));",
      "original lazy saved-input read",
    ],
    [
      "  function recordInput(",
      "  async function recordInput(",
      "record preparation remains synchronous",
    ],
    [
      "  function readSaved(identity: Identity) {",
      "  storage();\n  function readSaved(identity: Identity) {",
      "no construction read, mirror, state or effect",
    ],
    [
      "    recordInput,\n    dispatchInput,",
      "    recordInput: async (...args) => recordInput(...args),\n    dispatchInput,",
      "direct delivery return without wrappers",
    ],
  ];
  for (const [before, after, rule] of variants) {
    const owner = changed(localDeliveryOwnerText, before, after);
    assert.throws(() => verifyLocalInputDeliveryConsumption(client, owner), {
      name: "AssertionError",
      message: new RegExp(rule),
    });
  }
});
