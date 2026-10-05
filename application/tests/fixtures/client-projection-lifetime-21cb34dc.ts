import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isFunctionDeclaration } from "typescript/unstable/ast";
import {
  parseReaderSources,
  readerFunction,
  readerShape,
} from "./reader-reads-contract.js";

// Fresh actual Git 21cb34dc. This is the finite clear algorithm, not a Client
// snapshot or an inverse chain. Ordinary CI neither invokes Git nor a shell.
// The prior task migration's complete-Client digest remains archival metadata;
// it is intentionally not an assertion about today's growing Client.
export const historicalTaskClientSourceSha =
  "21c02ad3c622262f768fda0a0022e6acccf811d42a43f507cfa2c4f620d8e505";
export const historicalTaskClientArchive = {
  git: "9122ad2820094bbbacf5ab1162f904d1b1c93737",
  sourceSha: historicalTaskClientSourceSha,
} as const;
export const projectionLifetimeMetadata = {
  git: "21cb34dc4d3c975247feda810d4d15f70c678737",
  path: "application/apps/web/src/client.ts",
  sourceSha: "e46367774b907c3625bf5609f31de8ab3cba00dbffada96e3cf3b8bf0ab222e0",
  clearSha: "ef7b6fa6cc40c9c56a175bf317c9c6233f3891e6763a74c3e4e85777b26983f5",
} as const;
export const originalProjectionClear =
  'function clearProtectedProjection() {\n    protectedReadGeneration.current++;\n    current.current = null;\n    platform.current = null;\n    conversationHistory.clear();\n    catalogCache.current = null;\n    scriptOverviews.current.clear();\n    pendingScriptOverviews.current.clear();\n    scriptEditorReads.clear();\n    navigationCacheKey.current = "";\n    snapshotText.current = "";\n    setBoot(null);\n    setContentCatalog([]);\n    setContentCounts([]);\n    setTaskCounts([]);\n    setContentCatalogVersion(0);\n  }';

// Finite, reviewed growth of the actual historical clear. Keep the archived
// algorithm and its digest above unchanged: cancellation and this separate
// read-only catalog must supplement every old clear, not replace its lifetime.
export const cognitiveProjectionClear = originalProjectionClear
  .replace(
    "function clearProtectedProjection()",
    "function clearProtectedProjection(keepRead?: AbortController)",
  )
  .replace(
    "catalogCache.current = null;",
    "catalogCache.current = null;\n    if (navigationReadController.current !== keepRead)\n      navigationReadController.current?.abort();",
  )
  .replace(
    "setContentCounts([]);",
    "setContentCounts([]);\n    setCognitiveAppCatalog({ versions: [], connections: [] });",
  )
  .replace(
    "setContentCatalogVersion(0);",
    "setContentCatalogVersion(0);\n    cognitiveManagement.invalidateAccess();",
  );
export const originalTaskInteractionRefs = {
  current: "current = useRef<Boot | null>(null)",
  platform: "platform = useRef<PlatformClient | null>(null)",
  taskRuntimeReads: "taskRuntimeReads = useRef(new Map<string, number>())",
  taskRuntimeReadGeneration: "taskRuntimeReadGeneration = useRef(0)",
} as const;
export const originalTaskInteractionRefHashes = {
  current: "7a4486103d3411745bc217e30586502556c941292147c30f5d9e56a403e171ba",
  platform: "47227b5536cf3f2489c19faeef74ec2f209288286551e4d47c2fd737bfec337c",
  taskRuntimeReads:
    "36a198fe3b6f8fdcde45c02654f3828929b1a143780a5595494bfa7ccb3f76e8",
  taskRuntimeReadGeneration:
    "3e8ba08d3670b45cbd349325c445b2ef6ce8b146add0496eff36d9d083b41454",
} as const;

export function verifyClientProjectionLifetime(source: string) {
  for (const name of Object.keys(
    originalTaskInteractionRefs,
  ) as (keyof typeof originalTaskInteractionRefs)[])
    assert.equal(
      createHash("sha256")
        .update(originalTaskInteractionRefs[name])
        .digest("hex"),
      originalTaskInteractionRefHashes[name],
      "fixed actual Git task ref provenance " + name,
    );
  assert.equal(
    createHash("sha256").update(originalProjectionClear).digest("hex"),
    projectionLifetimeMetadata.clearSha,
    "fixed actual Git projection-clear provenance",
  );
  const parsed = parseReaderSources({
    Client: source,
    Fixed: cognitiveProjectionClear,
  });
  const clear = readerFunction(parsed.get("Client")!, "useWorkspace")
    .body!.statements.filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === "clearProtectedProjection");
  assert.equal(
    clear.length,
    1,
    "one actual workspace projection-clear authority",
  );
  assert.deepEqual(
    readerShape(clear[0]!),
    readerShape(
      readerFunction(parsed.get("Fixed")!, "clearProtectedProjection"),
    ),
    "complete original protected projection clear and approval lifetime with finite catalog cancellation extension",
  );
}
