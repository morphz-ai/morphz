import { readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";

// The offline Harness checker consumes the same business schemas as the
// registered Host. Never maintain a narrower handwritten second contract.
const path = new URL("../harnesses/script-studio.tools.json", import.meta.url);
const expected = await format(
  JSON.stringify(
    Object.fromEntries(
      workToolDefinitions.map(({ name, parameters }) => [name, parameters]),
    ),
  ),
  { parser: "json" },
);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== expected)
    throw new Error(
      "Harness tool schema is stale. Run node --import tsx scripts/generate-harness-tool-schema.ts",
    );
} else {
  writeFileSync(path, expected);
}
