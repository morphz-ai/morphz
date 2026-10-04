import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  assertObjectAnnotationsWholeApp,
  inverseObjectAnnotationsFeature,
  objectAnnotationsFixed,
} from "./fixtures/object-annotations-consumption.js";

// Finite actual source/consumer proof. Fixed-old/actual-new React lifecycle,
// actual Client authority and compiled full-App/native acceptance are separate.
const app = readFileSync(
  new URL("../apps/web/src/App.tsx", import.meta.url),
  "utf8",
);
const feature = readFileSync(
  new URL(
    "../apps/web/src/features/content/ObjectAnnotations.tsx",
    import.meta.url,
  ),
  "utf8",
);
const client = readFileSync(
  new URL("../apps/web/src/client.ts", import.meta.url),
  "utf8",
);
function changed(text: string, before: string, after: string) {
  assert.equal(
    text.split(before).length - 1,
    1,
    "one specified legal annotation counterfactual seam",
  );
  return text.replace(before, after);
}
function legal(appText: string, featureText: string, clientText: string) {
  const directory = "/annotation-counterfactual",
    config = directory + "/tsconfig.json";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [directory + "/App.tsx"]: appText,
      [directory + "/Feature.tsx"]: featureText,
      [directory + "/Client.ts"]: clientText,
      [config]: JSON.stringify({
        compilerOptions: { jsx: "preserve", noLib: true, noResolve: true },
        files: ["App.tsx", "Feature.tsx", "Client.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    assert.deepEqual(
      snapshot.getProject(config)!.program.getSyntacticDiagnostics(),
      [],
      "specified counterfactual parses before the designated rejection",
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function rejected(
  appText: string,
  featureText: string,
  rule: RegExp,
  clientText = client,
) {
  legal(appText, featureText, clientText);
  assert.throws(
    () => assertObjectAnnotationsWholeApp(appText, featureText, clientText),
    rule,
  );
}
const registration = `const { annotationResult, setAnnotationRefresh } = useObjectAnnotations({
    artifact,
    collaborationVisible,
    client,
  });`;
test("actual object annotations complete recipes and real consumers inverse the whole fixed actual Git9c6 App", () => {
  const original = assertObjectAnnotationsWholeApp(app, feature, client);
  assert.equal(Buffer.byteLength(original), objectAnnotationsFixed.appBytes);
  assert.equal(
    inverseObjectAnnotationsFeature(original, feature, client),
    original,
    "nested old lane is byte-idempotent",
  );
  assert.equal(
    inverseObjectAnnotationsFeature(
      inverseObjectAnnotationsFeature(app, feature, client),
      feature,
      client,
    ),
    original,
  );
});
test("object annotations use the sole three same-name runtime bindings, not type imports, shadows or alias consumers", () => {
  rejected(
    changed(
      app,
      '} from "./features/content/ObjectAnnotations.js";',
      '} from "./features/content/ObjectAnnotations.js";\nconst annotationAlias = ObjectAnnotationsPanel;',
    ),
    feature,
    /only one direct annotation use, no alias or second consumer/,
  );
  const type = changed(
    app,
    "import {\n  useObjectAnnotations,\n  objectAnnotationItems,\n  ObjectAnnotationsPanel,",
    "import type {\n  useObjectAnnotations,\n  objectAnnotationItems,\n  ObjectAnnotationsPanel,",
  );
  rejected(type, feature, /actual runtime object annotation import/);
  const shadow = changed(
    app,
    "  const state = client.boot?.workspace;",
    "  const useObjectAnnotations = () => ({ annotationResult: null, setAnnotationRefresh: () => {} });\n  const state = client.boot?.workspace;",
  );
  rejected(
    shadow,
    feature,
    /real imported annotation symbol, not local shadow/,
  );
  const without = changed(
    app,
    'import {\n  useObjectAnnotations,\n  objectAnnotationItems,\n  ObjectAnnotationsPanel,\n} from "./features/content/ObjectAnnotations.js";\n',
    "",
  );
  rejected(without, feature, /one actual object annotation runtime import/);
});
test("object annotations retain the original unconditional hook slot, exact render Client and stable submission writer", () => {
  const conditional = changed(
    app,
    registration,
    "if (collaborationVisible) {\n  " + registration + "\n  }",
  );
  rejected(conditional, feature, /unconditional original annotation hook slot/);
  const relocated = changed(
    app,
    registration + "\n  " + objectAnnotationsFixed.afterHook,
    objectAnnotationsFixed.afterHook + "\n  " + registration,
  );
  rejected(
    relocated,
    feature,
    /original annotation hook preceding collaboration witness/,
  );
  const copiedClient = changed(
    app,
    registration,
    registration.replace("    client,", "    client: { ...client },"),
  );
  rejected(
    copiedClient,
    feature,
    /exact original annotation Client and stable writer aliases/,
  );
  const wrappedWriter = changed(
    feature,
    "return { annotationResult, setAnnotationRefresh };",
    "return { annotationResult, setAnnotationRefresh: (value: number) => setAnnotationRefresh(value) };",
  );
  rejected(
    app,
    wrappedWriter,
    /complete original annotation two states effect five dependencies abort and stable writer/,
  );
  const earlierProjection = changed(
    app,
    "  const annotations = objectAnnotationItems(artifact, annotationResult);\n",
    "",
  );
  const movedProjection = changed(
    earlierProjection,
    "  if (!state || !project)",
    "  const annotations = objectAnnotationItems(artifact, annotationResult);\n  if (!state || !project)",
  );
  rejected(
    movedProjection,
    feature,
    /original annotation projection after startup and before context/,
  );
});
test("object annotations preserve complete read, abort and five-dependency recipes plus unchanged authorized Client reconciliation", () => {
  for (const [before, after] of [
    [
      "    artifact?.id,\n    collaborationVisible,\n    annotationRefresh,",
      "    artifact?.id,\n    annotationRefresh,\n    collaborationVisible,",
    ],
    ["    client.workspaceChangeRevision,\n  ]);", "  ]);"],
    ["return () => controller.abort();", "return () => {};"],
    [
      'if (!controller.signal.aborted)\n          setAnnotationResult({ artifactId, items, error: "", loading: false });',
      'setAnnotationResult({ artifactId, items, error: "", loading: false });',
    ],
  ])
    rejected(
      app,
      changed(feature, before!, after!),
      /complete original annotation two states effect five dependencies abort and stable writer/,
    );
  const reader = objectAnnotationsFixed.reader.raw;
  const changedReader = changed(
    reader,
    "for (let page = 0; page < 100; page++)",
    "for (let page = 0; page < 101; page++)",
  );
  rejected(
    app,
    feature,
    /complete original authorized annotation Client reader identity pagination and bounds/,
    changed(client, reader, changedReader),
  );
  const wake = objectAnnotationsFixed.invalidation[0]!.raw;
  const changedWake = changed(
    wake,
    "setWorkspaceChangeRevision((value) => value + 1);",
    "setWorkspaceChangeRevision((value) => value + 2);",
  );
  rejected(
    app,
    feature,
    /original annotation cross-domain refresh and access invalidation effects/,
    changed(client, wake, changedWake),
  );
});
test("object annotations retain the complete original panel tree, focus, keys and narrow captured author/type ports", () => {
  rejected(
    app,
    changed(feature, "key={a.id}", "key={a.artifactRevision}"),
    /complete original annotation panel DOM keys focus and only two expressions/,
  );
  rejected(
    app,
    changed(feature, "focusOnMount={focusOnMount}", "focusOnMount={true}"),
    /complete original annotation panel DOM keys focus and only two expressions/,
  );
  rejected(
    changed(
      app,
      "authorName={(actantId) => actorName(state, actantId)}",
      "authorName={(actantId) => actorName(client.getSnapshot()!.workspace, actantId)}",
    ),
    feature,
    /complete original annotation props and captured render authorName/,
  );
  rejected(
    changed(
      app,
      "  const state = client.boot?.workspace;",
      "  const actorName = (_state: unknown, _id: string) => 'fake';\n  const state = client.boot?.workspace;",
    ),
    feature,
    /real captured render actorName binding/,
  );
  rejected(
    app,
    changed(
      feature,
      'import type { WorkspaceClient } from "../../client.js";',
      'import { WorkspaceClient } from "../../client.js";',
    ),
    /only reviewed annotation module imports type-only narrow Client props and complete original recipes/,
  );
  rejected(
    app,
    changed(
      feature,
      'client: Pick<\n    WorkspaceClient,\n    "boot" | "workspaceChangeRevision" | "listObjectAnnotations"\n  >;',
      "client: WorkspaceClient;",
    ),
    /only reviewed annotation module imports type-only narrow Client props and complete original recipes/,
  );
});
test("object annotation inverse preserves unrelated deltas and all bytes of no-import legacy counterfactuals", () => {
  const original = assertObjectAnnotationsWholeApp(app, feature, client);
  const unrelated = changed(
    app,
    "type View = WorkSurfaceView;",
    "type View = WorkSurfaceView;\nconst unrelatedAnnotationDelta = true;",
  );
  const retained = inverseObjectAnnotationsFeature(unrelated, feature, client);
  assert.equal(
    retained,
    changed(
      original,
      "type View = WorkSurfaceView;",
      "type View = WorkSurfaceView;\nconst unrelatedAnnotationDelta = true;",
    ),
    "no surrounding delta stripped",
  );
  rejected(
    unrelated,
    feature,
    /whole actual Git9c6 App bytes after only approved annotation inverse/,
  );
  const legacy = changed(
    original,
    "return () => controller.abort();",
    "return () => {};",
  );
  assert.equal(
    inverseObjectAnnotationsFeature(legacy, feature, client),
    legacy,
    "old specified mutation remains exactly raw",
  );
  const legacyOther = changed(
    original,
    "type View = WorkSurfaceView;",
    "type View = WorkSurfaceView;\nconst originalLaneDelta = true;",
  );
  assert.equal(
    inverseObjectAnnotationsFeature(legacyOther, feature, client),
    legacyOther,
  );
});
