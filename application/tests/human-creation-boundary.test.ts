import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertHumanCreationWholeApp,
  humanCreationFixed,
  inverseHumanCreationFeature,
} from "./fixtures/human-creation-consumption.js";

// Actual source/component consumption, not component execution or native
// acceptance. Fixed-old/actual-new React and compiled App regression are separate.
const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const feature = readFileSync(
  new URL(
    "../apps/web/src/features/creation/CreateDialog.tsx",
    import.meta.url,
  ),
  "utf8",
);
const client = readFileSync(
  new URL("../apps/web/src/client.ts", import.meta.url),
  "utf8",
);
const storage = readFileSync(
  new URL("../apps/web/src/local-preferences.ts", import.meta.url),
  "utf8",
);
function changed(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length - 1,
    1,
    "one specified legal counterfactual seam",
  );
  return text.replace(before, after);
}
function rejected(
  appText: string,
  featureText: string,
  rule: RegExp,
  clientText = client,
  storageText = storage,
) {
  assert.throws(
    () =>
      assertHumanCreationWholeApp(
        appText,
        featureText,
        clientText,
        storageText,
      ),
    rule,
  );
}
test("actual Human creation owner and both complete consumers inverse the whole fixed actual Git778 App", () => {
  const original = assertHumanCreationWholeApp(app, feature, client, storage);
  assert.equal(Buffer.byteLength(original), humanCreationFixed.appBytes);
  assert.equal(
    inverseHumanCreationFeature(original, feature, client, storage),
    original,
    "nested old gate lane returns every byte unchanged",
  );
});
test("Human creation consumes the sole same-name runtime import, not a copy or local shadow", () => {
  const shadow = changed(
    app,
    "  const state = client.boot?.workspace;",
    "  const CreateDialog = () => null;\n  const state = client.boot?.workspace;",
  );
  rejected(shadow, feature, /real imported creation symbol, not local shadow/);
  const type = changed(
    app,
    'import { CreateDialog } from "./features/creation/CreateDialog.js";',
    'import type { CreateDialog } from "./features/creation/CreateDialog.js";',
  );
  rejected(type, feature, /actual runtime human creation import/);
  const without = changed(
    app,
    'import { CreateDialog } from "./features/creation/CreateDialog.js";\n',
    "",
  );
  rejected(without, feature, /one actual human creation runtime import/);
});
test("Human creation keeps complete document/project props, guards, keys, portal and captured callbacks", () => {
  const noKey = changed(
    app,
    '                  key={project.id}\n                  kind="document"',
    '                  kind="document"',
  );
  rejected(
    noKey,
    feature,
    /complete original creation props keys portal and captured callbacks/,
  );
  const newKey = changed(
    app,
    "          kind={creating}\n          projectId={project.id}",
    "          key={project.id}\n          kind={creating}\n          projectId={project.id}",
  );
  rejected(
    newKey,
    feature,
    /complete original creation props keys portal and captured callbacks/,
  );
  const port = changed(
    app,
    "                  client={client}\n                  onClose={() => setCreating(null)}",
    "                  client={{ ...client }}\n                  onClose={() => setCreating(null)}",
  );
  rejected(
    port,
    feature,
    /complete original creation props keys portal and captured callbacks/,
  );
  const guard = changed(
    app,
    '{creating && creating !== "document" && (',
    '{creating === "project" && (',
  );
  rejected(guard, feature, /original document\/project creation guard/);
});
test("Human creation preserves the complete original ten registrations and submit/lifetime/portal recipes", () => {
  const alive = changed(
    feature,
    "      if (alive.current) onCreated(result.entityId, kind);",
    "      onCreated(result.entityId, kind);",
  );
  rejected(
    app,
    alive,
    /complete actual Git creation body ten hooks seven props and only approved client Pick/,
  );
  const prepare = changed(
    feature,
    "    const created = prepareCreated?.();\n    try {",
    "    try {\n      const created = prepareCreated?.();",
  );
  rejected(
    app,
    prepare,
    /complete actual Git creation body ten hooks seven props and only approved client Pick/,
  );
  const dependencies = changed(
    feature,
    "  }, [title, markdown, kind, draftId, storage]);",
    "  }, [title, markdown, kind, draftId]);",
  );
  rejected(
    app,
    dependencies,
    /complete actual Git creation body ten hooks seven props and only approved client Pick/,
  );
  const portal = changed(
    feature,
    "toolbarTarget && createPortal(heading, toolbarTarget)",
    "toolbarTarget ? createPortal(heading, toolbarTarget) : heading",
  );
  rejected(
    app,
    portal,
    /complete actual Git creation body ten hooks seven props and only approved client Pick/,
  );
});
test("Human creation keeps type-only narrow Client and original same-module storage/reexport definitions", () => {
  const runtime = changed(
    feature,
    'import type { WorkspaceClient } from "../../client.js";',
    'import { WorkspaceClient } from "../../client.js";',
  );
  rejected(
    app,
    runtime,
    /only reviewed runtime imports, type-only Client and complete creation component/,
  );
  const widened = changed(
    feature,
    'client: Pick<WorkspaceClient, "execute">;',
    "client: WorkspaceClient;",
  );
  rejected(
    app,
    widened,
    /complete actual Git creation body ten hooks seven props and only approved client Pick/,
  );
  const reexport = changed(
    client,
    humanCreationFixed.runtime.clientReexport,
    humanCreationFixed.runtime.clientReexport.replace(
      '} from "./local-preferences.js";',
      '} from "./other-preferences.js";',
    ),
  );
  rejected(
    app,
    feature,
    /original Client storage reexport to same defining module/,
    reexport,
  );
  const key = changed(
    storage,
    humanCreationFixed.runtime.draftKeyDefinition,
    'export const draftKey = (key: string) => "draft:" + key;',
  );
  rejected(
    app,
    feature,
    /same original shared draft key definition/,
    client,
    key,
  );
  const global = feature + "\nconst extraGlobalState = { busy: false };\n";
  rejected(
    app,
    global,
    /only reviewed runtime imports, type-only Client and complete creation component/,
  );
});
test("Human creation inverse cannot strip unrelated App changes or reclassify legacy specified negatives", () => {
  const unrelated = changed(
    app,
    "type View = WorkSurfaceView;",
    "type View = WorkSurfaceView;\nconst unrelatedDelta = true;",
  );
  const retained = inverseHumanCreationFeature(
    unrelated,
    feature,
    client,
    storage,
  );
  assert.ok(retained.includes("const unrelatedDelta = true;"));
  rejected(
    unrelated,
    feature,
    /whole actual Git778 App bytes after only approved creation inverse/,
  );
  const original = assertHumanCreationWholeApp(app, feature, client, storage);
  const legacy = changed(
    original,
    "      if (alive.current) onCreated(result.entityId, kind);",
    "      onCreated(result.entityId, kind);",
  );
  assert.equal(
    inverseHumanCreationFeature(legacy, feature, client, storage),
    legacy,
    "legacy old algorithm counterfactual remains byte-for-byte for its original gate",
  );
});
