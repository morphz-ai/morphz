import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cognitiveRuntimeContracts } from "./cognitive-runtime-contracts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Drain all events before rejection so sibling fixtures finish their cleanup.
// The fixed formal manager also runs its original capability/skip reporter.
export default async function* reportCognitiveContracts(events) {
  const contracts = cognitiveRuntimeContracts.map(({ file, name }) => ({
    file,
    name,
    passes: 0,
    failures: 0,
    skips: 0,
  }));
  let rootSummaryObserved = false;
  for await (const event of events) {
    if (event.type === "test:summary" && !event.data.file)
      rootSummaryObserved = true;
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const contract = contracts.find(
      (candidate) =>
        event.data.file === resolve(root, candidate.file) &&
        event.data.name === candidate.name,
    );
    if (!contract) continue;
    if (event.data.skip) contract.skips++;
    else if (event.type === "test:pass") contract.passes++;
    else contract.failures++;
  }
  const complete =
    rootSummaryObserved &&
    contracts.every(
      (contract) =>
        contract.passes === 1 &&
        contract.failures === 0 &&
        contract.skips === 0,
    );
  yield `[cognitive contracts] ${JSON.stringify({ rootSummaryObserved, complete, contracts })}\n`;
  if (!complete)
    throw new Error(
      "The six exact cognitive Runtime contracts did not all complete once successfully.",
    );
}
