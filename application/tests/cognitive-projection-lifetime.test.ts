import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cognitiveProjectionClear,
  originalProjectionClear,
  verifyClientProjectionLifetime,
} from "./fixtures/client-projection-lifetime-21cb34dc.js";

const workspace = (clear: string) => `function useWorkspace() { ${clear} }`;

test("actual projection preserves every historical clear and the finite cognitive extension", () => {
  verifyClientProjectionLifetime(
    readFileSync("apps/web/src/client.ts", "utf8"),
  );
  verifyClientProjectionLifetime(workspace(cognitiveProjectionClear));
});

test("projection lifetime rejects omitted or broadened cancellation and catalog retirement", () => {
  const variants = [
    originalProjectionClear,
    cognitiveProjectionClear.replace(
      "if (navigationReadController.current !== keepRead)",
      "if (true)",
    ),
    cognitiveProjectionClear.replace(
      "navigationReadController.current?.abort();",
      "void navigationReadController.current;",
    ),
    cognitiveProjectionClear.replace(
      "setCognitiveAppCatalog({ versions: [], connections: [] });",
      "",
    ),
    cognitiveProjectionClear.replace(
      "setCognitiveAppCatalog({ versions: [], connections: [] });",
      "setCognitiveAppCatalog({ versions: [], connections: retainedConnections });",
    ),
    cognitiveProjectionClear.replace(
      "cognitiveManagement.invalidateAccess();",
      "",
    ),
    cognitiveProjectionClear.replace(
      "cognitiveManagement.invalidateAccess();",
      "cognitiveManagement.retireIdentity();",
    ),
    cognitiveProjectionClear.replace(
      "cognitiveManagement.invalidateAccess();",
      "void Promise.resolve().then(() => cognitiveManagement.invalidateAccess());",
    ),
  ];
  for (const variant of variants)
    assert.throws(() => verifyClientProjectionLifetime(workspace(variant)));
});

test("cognitive growth cannot erase or reorder the historical projection lifetime", () => {
  for (const clause of [
    "protectedReadGeneration.current++;",
    "current.current = null;",
    "platform.current = null;",
    "conversationHistory.clear();",
    "catalogCache.current = null;",
    "scriptOverviews.current.clear();",
    "pendingScriptOverviews.current.clear();",
    "scriptEditorReads.clear();",
    'navigationCacheKey.current = "";',
    'snapshotText.current = "";',
    "setBoot(null);",
    "setContentCatalog([]);",
    "setContentCounts([]);",
    "setTaskCounts([]);",
    "setContentCatalogVersion(0);",
  ])
    assert.throws(() =>
      verifyClientProjectionLifetime(
        workspace(cognitiveProjectionClear.replace(clause, "")),
      ),
    );
  assert.throws(() =>
    verifyClientProjectionLifetime(
      workspace(
        cognitiveProjectionClear.replace(
          "current.current = null;\n    platform.current = null;",
          "platform.current = null;\n    current.current = null;",
        ),
      ),
    ),
  );
});
