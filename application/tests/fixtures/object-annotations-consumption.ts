import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inverseExchangeReferencePreparationApp } from "./exchange-reference-preparation-consumption.js";
import {
  readObjectInteractionOwner,
  verifyObjectInteractionConsumption,
} from "./object-interactions-consumption.js";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
} from "typescript/unstable/ast";

// Complete actual Git9c6 recipes, independently captured before this migration.
// Ordinary CI needs no Git. Source inverse is not React scheduling, real Client
// authorization/HTTP, compiled App geometry or native-window acceptance.
export const objectAnnotationsFixed = {
  commit: "9c6b8dd143d7220ede11a25a5996eef6da047762",
  appSHA256: "d516aa14d079d4adddc06545e0616a3c45399dc6c2d62056753f95d99e78af30",
  appBytes: 115483,
  states: [
    {
      raw: "const [annotationRefresh, setAnnotationRefresh] = useState(0);",
      sha256:
        "7250ae22eea9c792bdbdfcd77c901645edb3d920862a5e96aaa84bcbaf47e181",
    },
    {
      raw: 'const [annotationResult, setAnnotationResult] = useState<{\n    artifactId: string;\n    items: Workspace["annotations"];\n    error: string;\n    loading: boolean;\n  } | null>(null);',
      sha256:
        "98f53565747fefa27823ea350fab707b450824503ccf5d10c5aec1a902a5d8cf",
    },
  ],
  effect: {
    raw: 'useEffect(() => {\n    if (!collaborationVisible || !artifact) return;\n    const controller = new AbortController();\n    const artifactId = artifact.id;\n    setAnnotationResult({ artifactId, items: [], error: "", loading: true });\n    void client\n      .listObjectAnnotations(artifactId, controller.signal)\n      .then((items) => {\n        if (!controller.signal.aborted)\n          setAnnotationResult({ artifactId, items, error: "", loading: false });\n      })\n      .catch((error: unknown) => {\n        if (!controller.signal.aborted)\n          setAnnotationResult({\n            artifactId,\n            items: [],\n            error:\n              error instanceof Error ? error.message : "批注暂时无法读取。",\n            loading: false,\n          });\n      });\n    return () => controller.abort();\n  }, [\n    artifact?.id,\n    collaborationVisible,\n    annotationRefresh,\n    client.boot?.csrfToken,\n    client.workspaceChangeRevision,\n  ]);',
    sha256: "b7f841ba27a1d4b2ae149501c2bb35ef815289bab29917103aa4eb549b5f7830",
  },
  projection: {
    raw: "const annotations =\n    artifact && annotationResult?.artifactId === artifact.id\n      ? annotationResult.items\n      : [];",
    sha256: "d2d5b414a0afdf92df6a21ca5c7c744db15e1e54a05558983381bb240a97dbf4",
  },
  panel: {
    raw: '<InspectorPanel\n            className="collaboration"\n            label="对象批注"\n            title="批注"\n            viewOptions={inspectorViewOptions}\n            context={contextTitle}\n            resizeLabel="调整批注栏宽度"\n            // Showing a saved annotation must not steal focus from continued input.\n            focusOnMount={!sentInputFocusPending}\n            layout={rightInspector}\n            onResize={resizeInspector}\n            onClose={closeInspector}\n          >\n            <div className="collaboration-scroll">\n              {annotationResult?.artifactId === artifact?.id &&\n              annotationResult.error ? (\n                <p role="alert">批注读取失败：{annotationResult.error}</p>\n              ) : annotationResult?.artifactId !== artifact?.id ||\n                annotationResult.loading ? (\n                <p>正在读取批注…</p>\n              ) : !annotations.length ? (\n                <div className="discussion-empty">\n                  <MessageSquarePlus />\n                  <p>暂无批注</p>\n                </div>\n              ) : (\n                <>\n                  {annotations.map((a) => (\n                    <section className="message annotation" key={a.id}>\n                      <div className="message-author">\n                        <MessageSquarePlus />\n                        {actorName(state, a.author.actantId)}\n                        <small>\n                          批注 · v{a.artifactRevision}\n                          {a.page ? ` · 第 ${a.page} 页` : ""}\n                        </small>\n                      </div>\n                      <blockquote>{a.quote}</blockquote>\n                      <p>{a.body}</p>\n                    </section>\n                  ))}\n                </>\n              )}\n            </div>\n          </InspectorPanel>',
    sha256: "9fee22f8e8eb8c58757e95cc8bc73a68a753e1d28b0318248583b6c00c600e57",
  },
  guard: {
    raw: '{collaborationVisible && (\n          <InspectorPanel\n            className="collaboration"\n            label="对象批注"\n            title="批注"\n            viewOptions={inspectorViewOptions}\n            context={contextTitle}\n            resizeLabel="调整批注栏宽度"\n            // Showing a saved annotation must not steal focus from continued input.\n            focusOnMount={!sentInputFocusPending}\n            layout={rightInspector}\n            onResize={resizeInspector}\n            onClose={closeInspector}\n          >\n            <div className="collaboration-scroll">\n              {annotationResult?.artifactId === artifact?.id &&\n              annotationResult.error ? (\n                <p role="alert">批注读取失败：{annotationResult.error}</p>\n              ) : annotationResult?.artifactId !== artifact?.id ||\n                annotationResult.loading ? (\n                <p>正在读取批注…</p>\n              ) : !annotations.length ? (\n                <div className="discussion-empty">\n                  <MessageSquarePlus />\n                  <p>暂无批注</p>\n                </div>\n              ) : (\n                <>\n                  {annotations.map((a) => (\n                    <section className="message annotation" key={a.id}>\n                      <div className="message-author">\n                        <MessageSquarePlus />\n                        {actorName(state, a.author.actantId)}\n                        <small>\n                          批注 · v{a.artifactRevision}\n                          {a.page ? ` · 第 ${a.page} 页` : ""}\n                        </small>\n                      </div>\n                      <blockquote>{a.quote}</blockquote>\n                      <p>{a.body}</p>\n                    </section>\n                  ))}\n                </>\n              )}\n            </div>\n          </InspectorPanel>\n        )}',
    sha256: "d8e87574a48bd7578ccb2cbbf6122d839cf187884e534ff8e5064e252d99cd18",
  },
  beforeHook:
    "const collaborationVisible =\n    !!artifact &&\n    subjectCollaborationVisible({\n      executions,\n      subjectView,\n      understandingOpen,\n      artifact,\n      compact,\n      mobileCollaboration,\n      preferences: prefs,\n    });",
  afterHook:
    "const { ref: inspectorWorkspace, layout: rightInspector } =\n    useInspectorLayout(prefs.inspectorWidth ?? prefs.executionWidth ?? 340);",
  startup:
    'if (!state || !project)\n    return (\n      <div className="startup">\n        <h1>Morphz</h1>\n        <p>\n          {client.error\n            ? "暂时无法打开工作空间，请重试。"\n            : "正在打开工作空间…"}\n        </p>\n        {client.error && (\n          <>\n            <button onClick={() => void client.refresh()}>\n              <RefreshCw />\n              重新连接\n            </button>\n          </>\n        )}\n      </div>\n    );',
  reader: {
    raw: 'async function listObjectAnnotations(\n    contentId: string,\n    signal?: AbortSignal,\n  ) {\n    const identity = current.current;\n    const source = platform.current;\n    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)\n      throw new Error("身份已变化，批注未读取。");\n    const annotations: Workspace["annotations"] = [];\n    let afterOrdinal: number | undefined;\n    for (let page = 0; page < 100; page++) {\n      const rows = z\n        .array(\n          z.object({\n            ordinal: z.number().int().nonnegative(),\n            annotation: stateSchema.shape.annotations.element,\n          }),\n        )\n        .parse(\n          await source.listObjectAnnotations(\n            contentId,\n            {\n              limit: 100,\n              ...(afterOrdinal === undefined ? {} : { afterOrdinal }),\n            },\n            signal,\n          ),\n        );\n      annotations.push(...rows.map((row) => row.annotation));\n      if (rows.length < 100) return annotations;\n      const last = rows.at(-1)!.ordinal;\n      if (afterOrdinal !== undefined && last <= afterOrdinal)\n        throw new Error("批注分页游标未推进。");\n      afterOrdinal = last;\n    }\n    throw new Error("批注数量超过当前可读取范围。");\n  }',
    sha256: "3f5c2f3c730e74d7399e04df637781574109769cea6b5aa7514a1b5fab1dc65b",
  },
  invalidation: [
    {
      raw: 'useEffect(() => {\n    void refresh();\n    // Startup and foregrounding reconcile authoritative state after sleep or\n    // best-effort filesystem hints. Healthy idle windows do no periodic reads.\n    const wake = () => {\n      if (document.visibilityState === "visible") {\n        // Independent domains (Profile, reading marks, bookmarks, annotations)\n        // also reconcile after best-effort SQLite hints were lost during sleep.\n        setWorkspaceChangeRevision((value) => value + 1);\n        void refresh();\n      }\n    };\n    window.addEventListener("focus", wake);\n    document.addEventListener("visibilitychange", wake);\n    return () => {\n      window.removeEventListener("focus", wake);\n      document.removeEventListener("visibilitychange", wake);\n    };\n  }, [])',
      sha256:
        "d6f9f39b13efdae8dd882adf5055a23694896ebd5fd290e05f0059d5c1552fd1",
    },
    {
      raw: 'useEffect(() => {\n    const expected = boot?.csrfToken;\n    if (!expected || authenticationRequired) return;\n    setWorkspaceConnection("connecting");\n    return subscribeWorkspaceChanges(\n      (change) => {\n        if (current.current?.csrfToken !== expected) return;\n        if (change.accessChanged) {\n          // Invalidate in-flight publication as well as mounted private data.\n          // Drafts and unsent input are deliberately not part of this clear.\n          epoch.current++;\n          clearProtectedProjection();\n        }\n        // This is only a local invalidation token, never a database revision\n        // or authority. Profile/Reader projections have their own read APIs.\n        setWorkspaceChangeRevision((value) => value + 1);\n        void refresh();\n      },\n      {\n        onConnected: () => {\n          if (current.current?.csrfToken !== expected) return;\n          setWorkspaceConnection("connected");\n        },\n        onClosed: () => {\n          if (current.current?.csrfToken !== expected) return;\n          // Losing change hints does not mean the authoritative RPC channel\n          // is unavailable. Keep drafts and usable commands available while\n          // the transport reconnects and requests its resync snapshot.\n          setWorkspaceConnection("reconnecting");\n        },\n      },\n    );\n  }, [\n    boot?.centerId,\n    boot?.principalId,\n    boot?.csrfToken,\n    authenticationRequired,\n  ])',
      sha256:
        "a7893d30871d74176f445a83c7be47c165fed1020795086ea5d2dda007871f80",
    },
  ],
  originalImports: {
    workspace:
      'import type { Workspace } from "../../../packages/core/src/model.js";',
    inspector:
      'import { InspectorPanel, useInspectorLayout } from "./InspectorPanel.js";',
  },
} as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
for (const span of [
  ...objectAnnotationsFixed.states,
  objectAnnotationsFixed.effect,
  objectAnnotationsFixed.projection,
  objectAnnotationsFixed.panel,
  objectAnnotationsFixed.guard,
  objectAnnotationsFixed.reader,
  ...objectAnnotationsFixed.invalidation,
])
  assert.equal(
    hash(span.raw),
    span.sha256,
    "fixed complete actual Git annotation span",
  );
// The archived raw/hash recipes remain immutable. This separately reviewed,
// finite lifecycle extension keeps their original annotation invalidation
// algorithm, while a validated session owns hints independently of private Boot.
// It is a source-contract check, not mounted authorization or SQL evidence.
const currentStartupInvalidation = uniqueReplace(
  uniqueReplace(
    objectAnnotationsFixed.invalidation[0].raw,
    "useEffect(() => {\n    void refresh();",
    "useEffect(() => {\n    projectionMounted.current = true;\n    void refresh();",
    "one approved mounted startup extension",
  ),
  "return () => {\n      window.removeEventListener",
  "return () => {\n      projectionMounted.current = false;\n      changeOwner.current = null;\n      cognitiveManagement.retireIdentity();\n      epoch.current++;\n      navigationReadController.current?.abort();\n      window.removeEventListener",
  "one approved synchronous session retirement cleanup",
);
let currentSessionInvalidation = uniqueReplace(
  objectAnnotationsFixed.invalidation[1].raw,
  "const expected = boot?.csrfToken;",
  "const expected = changeIdentity;",
  "one approved metadata-only hint identity",
);
currentSessionInvalidation = uniqueReplace(
  currentSessionInvalidation,
  '    setWorkspaceConnection("connecting");',
  '    const owned = () => {\n      const latest = changeOwner.current;\n      return (\n        latest?.centerId === expected.centerId &&\n        latest.principalId === expected.principalId &&\n        latest.csrfToken === expected.csrfToken\n      );\n    };\n    setWorkspaceConnection("connecting");',
  "one approved exact three-field synchronous ownership guard",
);
const previousHintGuard =
  "if (current.current?.csrfToken !== expected) return;";
assert.equal(
  currentSessionInvalidation.split(previousHintGuard).length - 1,
  3,
  "all and only update / connected / closed hint ownership guards migrate",
);
currentSessionInvalidation = currentSessionInvalidation.replaceAll(
  previousHintGuard,
  "if (!owned()) return;",
);
currentSessionInvalidation = uniqueReplace(
  currentSessionInvalidation,
  "}, [\n    boot?.centerId,\n    boot?.principalId,\n    boot?.csrfToken,\n    authenticationRequired,\n  ])",
  "}, [changeIdentity, authenticationRequired])",
  "one approved stable lifecycle dependency, including same-session reinstatement",
);
export const currentWorkspaceInvalidations = [
  currentStartupInvalidation,
  currentSessionInvalidation,
];
const featureModule = "./features/content/ObjectAnnotations.js";
const exports = [
  "useObjectAnnotations",
  "objectAnnotationItems",
  "ObjectAnnotationsPanel",
] as const;
const originalRegistration = [
  ...objectAnnotationsFixed.states.map((span) => span.raw),
  objectAnnotationsFixed.effect.raw,
].join("\n  ");
const mappedPanel = objectAnnotationsFixed.panel.raw
  .replace(
    "actorName(state, a.author.actantId)",
    "authorName(a.author.actantId)",
  )
  .replace(
    "focusOnMount={!sentInputFocusPending}",
    "focusOnMount={focusOnMount}",
  )
  .split("\n")
  .map((line, index) => (index ? line.slice(6) : line))
  .join("\n");
const expectedConsumer = `<ObjectAnnotationsPanel
            artifact={artifact}
            annotationResult={annotationResult}
            annotations={annotations}
            authorName={(actantId) => actorName(state, actantId)}
            viewOptions={inspectorViewOptions}
            context={contextTitle}
            focusOnMount={!sentInputFocusPending}
            layout={rightInspector}
            onResize={resizeInspector}
            onClose={closeInspector}
          />`;
const expectedRegistration = `const { annotationResult, setAnnotationRefresh } = useObjectAnnotations({
    artifact,
    collaborationVisible,
    client,
  });`;
const expectedProjection =
  "const annotations = objectAnnotationItems(artifact, annotationResult);";
// A finite reviewed port/module skeleton, composed from original Git bodies;
// it is neither the candidate's output nor a general AST architecture engine.
const expectedFeature = `
import { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { Artifact, Workspace } from "../../../../../packages/core/src/model.js";
import type { WorkspaceClient } from "../../client.js";
import type { ComposerOption } from "../../ComposerOptions.js";
import { InspectorPanel } from "../../InspectorPanel.js";
import type { InspectorLayout } from "../../inspector-layout.js";
export type ObjectAnnotationResult = {
  artifactId: string; items: Workspace["annotations"]; error: string; loading: boolean;
};
export function useObjectAnnotations({artifact, collaborationVisible, client}: {
  artifact: Pick<Artifact, "id"> | undefined;
  collaborationVisible: boolean;
  client: Pick<WorkspaceClient, "boot" | "workspaceChangeRevision" | "listObjectAnnotations">;
}) {
  ${originalRegistration}
  return { annotationResult, setAnnotationRefresh };
}
export function objectAnnotationItems(
  artifact: Pick<Artifact, "id"> | undefined,
  annotationResult: ObjectAnnotationResult | null,
) {
  ${objectAnnotationsFixed.projection.raw}
  return annotations;
}
export function ObjectAnnotationsPanel({
  artifact, annotationResult, annotations, authorName,
  viewOptions: inspectorViewOptions, context: contextTitle, focusOnMount,
  layout: rightInspector, onResize: resizeInspector, onClose: closeInspector,
}: {
  artifact: Pick<Artifact, "id">;
  annotationResult: ObjectAnnotationResult | null;
  annotations: Workspace["annotations"];
  authorName: (actantId: string) => string;
  viewOptions: ComposerOption[];
  context: string;
  focusOnMount: boolean;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  onClose: () => void;
}) {
  return (
    ${mappedPanel}
  );
}
`;
function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}
function parse(contents: Record<string, string>) {
  const directory = "/object-annotations-consumption";
  const config = directory + "/tsconfig.json";
  const filename = (name: string) =>
    directory + "/" + name + (name === "Client" ? ".ts" : ".tsx");
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [filename(name), text]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map(filename),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "legal annotation contract syntax",
    );
    return new Map(
      Object.keys(contents).map((name) => {
        const source = project.program.getSourceFile(filename(name))!;
        const nodes: Node[] = [],
          identifiers: Identifier[] = [];
        walk(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) identifiers.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(identifiers);
        const symbols = new Map<Node, number | undefined>(
          identifiers.map((node, index) => [node, resolved[index]?.id]),
        );
        for (const node of nodes.filter(isShorthandPropertyAssignment))
          symbols.set(
            node.name,
            project.checker.getShorthandAssignmentValueSymbol(node)?.id,
          );
        return [name, { source, nodes, symbols }] as const;
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
type Parsed = ReturnType<typeof parse> extends Map<string, infer P> ? P : never;
function shape(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child));
  });
  return [
    node.kind,
    node.flags &
      (NodeFlags.Const |
        NodeFlags.Let |
        NodeFlags.Using |
        NodeFlags.OptionalChain),
    ...(isImportDeclaration(node) ? [node.importClause?.phaseModifier] : []),
    ...(isImportSpecifier(node) ||
    isExportSpecifier(node) ||
    isExportDeclaration(node)
      ? [node.isTypeOnly]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    children.length ? children : node.getText(),
  ];
}
function imports(parsed: Parsed, module: string) {
  return parsed.source.statements
    .filter(isImportDeclaration)
    .filter(
      (node) =>
        isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === module,
    );
}
function oneFunction(parsed: Parsed, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "one complete annotation function " + name);
  return found[0]!;
}
function runtimeMember(parsed: Parsed, module: string, name: string) {
  const declarations = imports(parsed, module);
  assert.equal(
    declarations.length,
    1,
    "one real annotation dependency " + module,
  );
  const clause = declarations[0]!.importClause;
  assert.equal(
    clause?.phaseModifier,
    undefined,
    "real runtime annotation dependency " + name,
  );
  assert.ok(clause?.namedBindings && isNamedImports(clause.namedBindings));
  const matches = clause.namedBindings.elements.filter(
    (value) => value.name.text === name,
  );
  assert.equal(matches.length, 1, "same-name annotation dependency " + name);
  const member = matches[0]!;
  assert.ok(
    !member.propertyName && !member.isTypeOnly,
    "same-name runtime annotation dependency " + name,
  );
  assert.notEqual(
    parsed.symbols.get(member.name),
    undefined,
    "resolved annotation dependency " + name,
  );
  return member.name;
}
function uniqueReplace(
  text: string,
  before: string,
  after: string,
  rule: string,
) {
  assert.equal(text.split(before).length - 1, 1, rule);
  return text.replace(before, after);
}
function verifyCurrentWorkspaceChangeOwner(client: Parsed) {
  const workspace = oneFunction(client, "useWorkspace");
  const direct = workspace.body!.statements;
  assert.equal(
    direct
      .filter(
        (node) =>
          node.kind === SyntaxKind.TypeAliasDeclaration &&
          node.getText().startsWith("type ChangeIdentity ="),
      )
      .map((node) => node.getText())
      .join("\n"),
    'type ChangeIdentity = Pick<Boot, "centerId" | "principalId" | "csrfToken">;',
    "hint owner contains only validated authentication metadata, not private content",
  );
  const states = direct
    .filter(isVariableStatement)
    .filter((node) =>
      node.declarationList.declarations.some((declaration) =>
        ["[changeIdentity, setChangeIdentity]", "changeOwner"].includes(
          declaration.name.getText(),
        ),
      ),
    );
  assert.deepEqual(
    states.map((node) => node.getText()),
    [
      "const [changeIdentity, setChangeIdentity] = useState<ChangeIdentity | null>(\n    null,\n  );",
      "const changeOwner = useRef<ChangeIdentity | null>(null);",
    ],
    "session state starts unauthenticated, never from local storage or private Boot",
  );
  const refresh = oneFunction(client, "refreshOnce");
  const installation = client.nodes
    .filter(isVariableDeclaration)
    .filter((node) => node.name.getText() === "nextIdentity");
  assert.equal(installation.length, 1, "one validated session installation");
  const statement = installation[0]!.parent.parent;
  assert.ok(isVariableStatement(statement));
  const scope = statement.parent;
  assert.ok(scope.kind === SyntaxKind.Block);
  assert.ok(
    statement.pos > refresh.pos && statement.end < refresh.end,
    "metadata installation belongs only to the real refresh read",
  );
  const statements: Node[] = [];
  scope.forEachChild((node) => {
    statements.push(node);
  });
  const index = statements.indexOf(statement);
  assert.deepEqual(
    statements.slice(index - 2, index + 3).map((node) => node.getText()),
    [
      "const source = await PlatformClient.connect(\n          { call: applicationCall },\n          signal,\n        );",
      "if (version !== epoch.current) return false;",
      "const nextIdentity: ChangeIdentity = {\n          centerId: source.boot.centerId,\n          principalId: source.boot.principalId,\n          csrfToken: source.boot.csrfToken,\n        };",
      "changeOwner.current = nextIdentity;",
      "setChangeIdentity((previous) =>\n          previous?.centerId === nextIdentity.centerId &&\n          previous.principalId === nextIdentity.principalId &&\n          previous.csrfToken === nextIdentity.csrfToken\n            ? previous\n            : nextIdentity,\n        );",
    ],
    "only validated source.boot three-field identity installs after the refresh epoch gate",
  );
  const platform = annotationImported(
    client,
    "./platform-client.js",
    "PlatformClient",
  );
  const connectIdentifier = client.nodes
    .filter(isIdentifier)
    .filter(
      (node) =>
        node.text === "PlatformClient" &&
        node.pos > statements[index - 2]!.pos &&
        node.end < statement.pos,
    );
  assert.equal(connectIdentifier.length, 1);
  assert.equal(
    client.symbols.get(connectIdentifier[0]!),
    client.symbols.get(platform),
    "real validated PlatformClient bootstrap, not a locally shadowed authority",
  );
  assert.deepEqual(
    client.nodes
      .filter(isBinaryExpression)
      .filter((node) => node.left.getText() === "changeOwner.current")
      .map((node) => node.getText()),
    [
      "changeOwner.current = null",
      "changeOwner.current = nextIdentity",
      "changeOwner.current = null",
    ],
    "all metadata owner writes are explicit retire, validated bootstrap, or unmount",
  );
  assert.equal(
    oneFunction(client, "retireChangeOwner").getText(),
    "function retireChangeOwner() {\n    changeOwner.current = null;\n    setChangeIdentity(null);\n  }",
    "session retirement synchronously closes the live guard before React effect cleanup",
  );
}
function expand(
  appText: string,
  featureText: string,
  clientText: string,
  requireActual: boolean,
  ownerText: string,
) {
  appText = inverseExchangeReferencePreparationApp(appText);
  // Nested old/no-import lanes preserve every byte, including specified old
  // counterfactuals; only the separate actual-new assertion requires migration.
  if (!requireActual && !appText.includes(featureModule)) return appText;
  const parsed = parse({
    App: appText,
    Feature: featureText,
    Client: clientText,
    Expected: expectedFeature,
  });
  const app = parsed.get("App")!,
    feature = parsed.get("Feature")!,
    client = parsed.get("Client")!,
    expected = parsed.get("Expected")!;
  const actualImports = imports(app, featureModule);
  if (!requireActual && actualImports.length === 0) return appText;
  assert.equal(
    actualImports.length,
    1,
    "one actual object annotation runtime import",
  );
  const declaration = actualImports[0]!,
    clause = declaration.importClause;
  assert.equal(
    clause?.phaseModifier,
    undefined,
    "actual runtime object annotation import",
  );
  assert.ok(
    clause &&
      !clause.name &&
      clause.namedBindings &&
      isNamedImports(clause.namedBindings),
    "same-name annotation import shape",
  );
  assert.deepEqual(
    clause.namedBindings.elements.map((binding) => ({
      name: binding.name.text,
      alias: binding.propertyName?.text,
      type: binding.isTypeOnly,
    })),
    exports.map((name) => ({ name, alias: undefined, type: false })),
    "three same-name annotation runtime exports",
  );
  const members = clause.namedBindings.elements;
  const calls = exports.slice(0, 2).map((name) => {
    const found = app.nodes
      .filter(isCallExpression)
      .filter(
        (node) =>
          isIdentifier(node.expression) && node.expression.text === name,
      );
    assert.equal(found.length, 1, "one actual annotation call " + name);
    return found[0]!;
  });
  const panels = app.nodes
    .filter(isJsxSelfClosingElement)
    .filter((node) => node.tagName.getText() === "ObjectAnnotationsPanel");
  assert.equal(panels.length, 1, "one actual object annotation panel consumer");
  const panel = panels[0]!;
  for (const [index, member] of members.entries()) {
    const use = index === 2 ? panel.tagName : calls[index]!.expression;
    const symbol = app.symbols.get(member.name);
    assert.notEqual(
      symbol,
      undefined,
      "resolved actual annotation import " + member.name.text,
    );
    assert.equal(
      app.symbols.get(use),
      symbol,
      "real imported annotation symbol, not local shadow",
    );
    assert.deepEqual(
      app.nodes
        .filter(isIdentifier)
        .filter((node) => app.symbols.get(node) === symbol),
      [member.name, use],
      "only one direct annotation use, no alias or second consumer",
    );
  }
  const hook = oneFunction(feature, "useObjectAnnotations");
  assert.deepEqual(
    hook.body!.statements.map((node) => node.getText()),
    [
      ...objectAnnotationsFixed.states.map((span) => span.raw),
      objectAnnotationsFixed.effect.raw,
      "return { annotationResult, setAnnotationRefresh };",
    ],
    "complete original annotation two states effect five dependencies abort and stable writer",
  );
  const projector = oneFunction(feature, "objectAnnotationItems");
  assert.deepEqual(
    projector.body!.statements.map((node) => node.getText()),
    [objectAnnotationsFixed.projection.raw, "return annotations;"],
    "complete original annotation ID projection",
  );
  const rendering = oneFunction(feature, "ObjectAnnotationsPanel");
  assert.equal(
    rendering.body!.statements.length,
    1,
    "annotation panel has no new lifecycle or state",
  );
  const innerPanels = feature.nodes
    .filter(isJsxElement)
    .filter(
      (node) => node.openingElement.tagName.getText() === "InspectorPanel",
    );
  assert.equal(
    innerPanels.length,
    1,
    "one complete annotation InspectorPanel tree",
  );
  const inner = innerPanels[0]!;
  assert.equal(
    inner.getText(),
    mappedPanel,
    "complete original annotation panel DOM keys focus and only two expressions",
  );
  const inspector = runtimeMember(
    feature,
    "../../InspectorPanel.js",
    "InspectorPanel",
  );
  assert.equal(
    feature.symbols.get(inner.openingElement.tagName),
    feature.symbols.get(inspector),
    "actual annotation InspectorPanel symbol",
  );
  assert.equal(
    feature.symbols.get(inner.closingElement.tagName),
    feature.symbols.get(inspector),
    "actual annotation InspectorPanel closing symbol",
  );
  const authorBindings = rendering.parameters.flatMap((node) =>
    isObjectBindingPattern(node.name)
      ? node.name.elements
          .filter(isBindingElement)
          .filter((binding) => binding.name?.getText() === "authorName")
      : [],
  );
  assert.equal(
    authorBindings.length,
    1,
    "one original narrow annotation author port",
  );
  const authorBinding = authorBindings[0]!;
  assert.ok(authorBinding.name, "one named annotation author port binding");
  const authorCalls = feature.nodes
    .filter(isCallExpression)
    .filter((node) => node.expression.getText() === "authorName");
  assert.equal(authorCalls.length, 1, "one narrow annotation author call");
  assert.equal(
    feature.symbols.get(authorCalls[0]!.expression),
    feature.symbols.get(authorBinding.name),
    "real supplied annotation author port, not local fake",
  );
  assert.deepEqual(
    shape(feature.source),
    shape(expected.source),
    "only reviewed annotation module imports type-only narrow Client props and complete original recipes",
  );
  const importedReact = ["useState", "useEffect"].map((name) =>
    runtimeMember(feature, "react", name),
  );
  for (const [index, name] of ["useState", "useEffect"].entries()) {
    const registrations = feature.nodes
      .filter(isCallExpression)
      .filter((node) => node.expression.getText() === name);
    assert.equal(
      registrations.length,
      index === 0 ? 2 : 1,
      "original annotation React registration inventory",
    );
    for (const node of registrations)
      assert.equal(
        feature.symbols.get(node.expression),
        feature.symbols.get(importedReact[index]!),
        "actual annotation React registration binding",
      );
  }
  const workspace = oneFunction(app, "WorkspaceApp");
  const registration = calls[0]!.parent;
  assert.ok(
    isVariableDeclaration(registration) &&
      registration.initializer === calls[0] &&
      isObjectBindingPattern(registration.name),
    "direct stable annotation aliases",
  );
  const registrationStatement = registration.parent.parent;
  assert.ok(
    isVariableStatement(registrationStatement) &&
      registrationStatement.parent === workspace.body,
    "unconditional original annotation hook slot",
  );
  assert.equal(
    registrationStatement.getText(),
    expectedRegistration,
    "exact original annotation Client and stable writer aliases",
  );
  const index = workspace.body!.statements.indexOf(registrationStatement);
  assert.equal(
    workspace.body!.statements[index - 1]?.getText(),
    objectAnnotationsFixed.beforeHook,
    "original annotation hook preceding collaboration witness",
  );
  assert.equal(
    workspace.body!.statements[index + 1]?.getText(),
    objectAnnotationsFixed.afterHook,
    "original annotation hook before inspector layout and memory commit",
  );
  const writer = registration.name.elements
    .filter(isBindingElement)
    .find((node) => node.name?.getText() === "setAnnotationRefresh");
  assert.ok(writer?.name, "one direct annotation stable writer alias");
  const feedback = app.nodes
    .filter(isShorthandPropertyAssignment)
    .filter((node) => node.name.getText() === "setAnnotationRefresh");
  assert.equal(
    feedback.length,
    1,
    "one unchanged annotation submission refresh writer",
  );
  assert.equal(
    app.symbols.get(feedback[0]!.name),
    app.symbols.get(writer.name),
    "submission borrows original annotation stable writer",
  );
  const projection = calls[1]!.parent;
  assert.ok(
    isVariableDeclaration(projection) &&
      projection.initializer === calls[1] &&
      isIdentifier(projection.name) &&
      projection.name.text === "annotations",
    "direct original annotation ID projection",
  );
  const projectionStatement = projection.parent.parent;
  assert.ok(
    isVariableStatement(projectionStatement) &&
      projectionStatement.parent === workspace.body,
    "original annotation projection direct post-startup slot",
  );
  assert.equal(
    projectionStatement.getText(),
    expectedProjection,
    "original annotation projection inputs",
  );
  const start = workspace.body!.statements.findIndex(
    (node) => node.getText() === objectAnnotationsFixed.startup,
  );
  const projectionIndex =
    workspace.body!.statements.indexOf(projectionStatement);
  assert.ok(
    start >= 0 &&
      projectionIndex === start + 2 &&
      workspace
        .body!.statements[projectionIndex - 1]?.getText()
        .startsWith("const inboxCount =") &&
      workspace
        .body!.statements[projectionIndex + 1]?.getText()
        .startsWith("const contextTitle ="),
    "original annotation projection after startup and before context",
  );
  assert.equal(
    panel.getText(),
    expectedConsumer,
    "complete original annotation props and captured render authorName",
  );
  const paren = panel.parent;
  assert.ok(
    isParenthesizedExpression(paren) && isBinaryExpression(paren.parent),
    "original direct annotation conditional placement",
  );
  const guard = paren.parent;
  assert.equal(
    guard.operatorToken.kind,
    SyntaxKind.AmpersandAmpersandToken,
    "original annotation conditional operator",
  );
  assert.equal(
    guard.left.getText(),
    "collaborationVisible",
    "original annotation visibility guard",
  );
  assert.equal(guard.right, paren, "original annotation direct guarded panel");
  assert.ok(
    isJsxExpression(guard.parent) && isJsxElement(guard.parent.parent),
    "original annotation native parent",
  );
  assert.equal(
    guard.parent.parent.openingElement.tagName.getText(),
    "div",
    "original annotation native parent",
  );
  const author = panel.attributes.properties.find(
    (node) => isJsxAttribute(node) && node.name.getText() === "authorName",
  );
  assert.ok(
    author &&
      isJsxAttribute(author) &&
      author.initializer &&
      isJsxExpression(author.initializer) &&
      author.initializer.expression &&
      isArrowFunction(author.initializer.expression),
    "original render annotation author closure",
  );
  const actor = runtimeMember(app, "./client.js", "actorName");
  const actorCall = author.initializer.expression.body;
  assert.ok(
    isCallExpression(actorCall),
    "original render annotation author call",
  );
  assert.equal(
    app.symbols.get(actorCall.expression),
    app.symbols.get(actor),
    "real captured render actorName binding",
  );
  const state = app.nodes
    .filter(isVariableDeclaration)
    .filter((node) => node.name.getText() === "state");
  assert.equal(state.length, 1, "one original render workspace state");
  assert.equal(
    state[0]!.initializer?.getText(),
    "client.boot?.workspace",
    "original render annotation author workspace capture",
  );
  assert.equal(
    app.symbols.get(actorCall.arguments[0]!),
    app.symbols.get(state[0]!.name),
    "author reads original render workspace, not latest projection",
  );
  const importIndex = app.source.statements.indexOf(declaration);
  const predecessor = app.source.statements[importIndex - 1];
  if (requireActual)
    assert.equal(
      predecessor?.getText(),
      'import { CreateDialog } from "./features/creation/CreateDialog.js";',
      "annotation feature keeps approved creation successor slot",
    );
  else {
    // This inverse must preserve the old creation gate's specified type-import
    // and missing-import negatives, not validate or repair that other owner.
    // Both finite lanes keep the annotation import directly before ArtifactEditor.
    const creation = imports(app, "./features/creation/CreateDialog.js");
    assert.ok(
      (creation.length === 1 && predecessor === creation[0]) ||
        (creation.length === 0 &&
          predecessor &&
          isImportDeclaration(predecessor) &&
          isStringLiteral(predecessor.moduleSpecifier) &&
          predecessor.moduleSpecifier.text === "./client.js"),
      "annotation inverse keeps its slot without absorbing old creation negatives",
    );
  }
  assert.equal(
    app.source.statements[importIndex + 1]?.getText(),
    'import { ArtifactEditor } from "./ArtifactEditor.js";',
    "annotation feature keeps approved artifact predecessor slot",
  );
  const layout = imports(app, "./InspectorPanel.js");
  assert.equal(layout.length, 1, "one remaining inspector layout App import");
  assert.equal(
    layout[0]!.getText(),
    'import { useInspectorLayout } from "./InspectorPanel.js";',
    "only moved annotation InspectorPanel binding removed",
  );
  assert.equal(
    app.source.statements.filter(
      (node) =>
        node.getText() === objectAnnotationsFixed.originalImports.workspace,
    ).length,
    0,
    "only moved annotation Workspace type import removed",
  );
  // R4 moves only the complete Client reader and its real public consumption.
  // Preserve the original raw/hash above; verify its current owner instead of
  // repairing Client with another historical inverse chain.
  verifyObjectInteractionConsumption(clientText, ownerText);
  verifyCurrentWorkspaceChangeOwner(client);
  const invalidation = client.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        node.expression.getText() === "useEffect" &&
        node.getText().includes("setWorkspaceChangeRevision"),
    );
  assert.deepEqual(
    invalidation.map((node) => node.getText()),
    currentWorkspaceInvalidations,
    "original annotation cross-domain refresh and access invalidation effects with approved mounted session lifecycle",
  );
  // Replace only the approved exact spans. Unknown surrounding bytes, extra
  // hooks, old counterfactuals or unrelated App changes are never stripped.
  let result = uniqueReplace(
    appText,
    declaration.getText() + "\n",
    "",
    "remove only approved annotation runtime import",
  );
  result = uniqueReplace(
    result,
    registrationStatement.getText(),
    originalRegistration,
    "restore only approved annotation registrations",
  );
  result = uniqueReplace(
    result,
    projectionStatement.getText(),
    objectAnnotationsFixed.projection.raw,
    "restore only approved annotation projection",
  );
  result = uniqueReplace(
    result,
    panel.getText(),
    objectAnnotationsFixed.panel.raw,
    "restore only approved complete annotation JSX",
  );
  result = uniqueReplace(
    result,
    layout[0]!.getText(),
    objectAnnotationsFixed.originalImports.inspector,
    "restore only original annotation InspectorPanel import",
  );
  result = uniqueReplace(
    result,
    'import type { BrowserView } from "./desktop.js";\n',
    objectAnnotationsFixed.originalImports.workspace +
      '\nimport type { BrowserView } from "./desktop.js";\n',
    "restore only original annotation Workspace import position",
  );
  return result;
}
const readFeature = () =>
  readFileSync(
    new URL(
      "../../apps/web/src/features/content/ObjectAnnotations.tsx",
      import.meta.url,
    ),
    "utf8",
  );
const readClient = () =>
  readFileSync(
    new URL("../../apps/web/src/client.ts", import.meta.url),
    "utf8",
  );
export function inverseObjectAnnotationsFeature(
  appText: string,
  featureText = readFeature(),
  clientText = readClient(),
  ownerText = readObjectInteractionOwner(),
) {
  return expand(appText, featureText, clientText, false, ownerText);
}
export function assertObjectAnnotationsWholeApp(
  appText: string,
  featureText = readFeature(),
  clientText = readClient(),
  ownerText = readObjectInteractionOwner(),
) {
  const result = expand(appText, featureText, clientText, true, ownerText);
  assert.equal(
    Buffer.byteLength(result),
    objectAnnotationsFixed.appBytes,
    "whole actual Git9c6 App bytes after only approved annotation inverse",
  );
  assert.equal(
    hash(result),
    objectAnnotationsFixed.appSHA256,
    "whole actual Git9c6 App SHA after only approved annotation inverse",
  );
  return result;
}

// Current finite contract: only owned recipes and their actual consumers.
// No historical App inverse, whole-file digest or peer default sampling here.
function annotationLocal(parsed: Parsed, value: Node): Node {
  for (let depth = 0; depth < 8 && isIdentifier(value); depth++) {
    const symbol = parsed.symbols.get(value);
    const declaration = parsed.nodes
      .filter(isVariableDeclaration)
      .find(
        (node) =>
          isIdentifier(node.name) && parsed.symbols.get(node.name) === symbol,
      );
    if (!declaration?.initializer || !isIdentifier(declaration.initializer))
      break;
    value = declaration.initializer;
  }
  return value;
}
function annotationImported(parsed: Parsed, module: string, name: string) {
  const declarations = imports(parsed, module);
  assert.ok(declarations.length, "one actual object annotation runtime import");
  assert.ok(
    declarations.some((node) => node.importClause?.phaseModifier === undefined),
    "actual runtime object annotation import",
  );
  const members = declarations.flatMap((declaration) => {
    const clause = declaration.importClause;
    if (
      !clause ||
      clause.phaseModifier !== undefined ||
      !clause.namedBindings ||
      !isNamedImports(clause.namedBindings)
    )
      return [];
    return clause.namedBindings.elements.filter(
      (node) =>
        !node.isTypeOnly && (node.propertyName ?? node.name).text === name,
    );
  });
  assert.equal(
    members.length,
    1,
    "actual runtime object annotation import " + name,
  );
  return members[0]!.name;
}
const annotationOrigins: Record<string, string> = {
  useState: "react",
  useEffect: "react",
  MessageSquarePlus: "lucide-react",
  InspectorPanel: "../../InspectorPanel.js",
  Artifact: "../../../../../packages/core/src/model.js",
  Workspace: "../../../../../packages/core/src/model.js",
  WorkspaceClient: "../../client.js",
  ComposerOption: "../../ComposerOptions.js",
  InspectorLayout: "../../inspector-layout.js",
  useObjectAnnotations: featureModule,
  objectAnnotationItems: featureModule,
  ObjectAnnotationsPanel: featureModule,
  actorName: "./client.js",
  subjectCollaborationVisible: "./host/use-subject-inspector.js",
  useInspectorLayout: "./InspectorPanel.js",
};
function annotationNames(parsed: Parsed) {
  const names = new Map<number, string>();
  for (const declaration of parsed.source.statements.filter(
    isImportDeclaration,
  )) {
    const clause = declaration.importClause;
    if (
      !isStringLiteral(declaration.moduleSpecifier) ||
      !clause?.namedBindings ||
      !isNamedImports(clause.namedBindings)
    )
      continue;
    for (const member of clause.namedBindings.elements) {
      const name = (member.propertyName ?? member.name).text;
      if (!Object.hasOwn(annotationOrigins, name)) continue;
      const symbol = parsed.symbols.get(member.name);
      if (symbol === undefined) continue;
      const type = [
        "Artifact",
        "Workspace",
        "WorkspaceClient",
        "ComposerOption",
        "InspectorLayout",
      ].includes(name);
      const valid =
        declaration.moduleSpecifier.text === annotationOrigins[name] &&
        (type
          ? clause.phaseModifier === SyntaxKind.TypeKeyword || member.isTypeOnly
          : clause.phaseModifier === undefined && !member.isTypeOnly);
      names.set(symbol, valid ? name : "wrong-origin:" + name);
    }
  }
  return names;
}
function annotationShape(parsed: Parsed, node: Node): unknown {
  const names = annotationNames(parsed);
  function tree(value: Node): unknown {
    if (isIdentifier(value)) {
      const local = annotationLocal(parsed, value);
      const symbol = parsed.symbols.get(local);
      return [
        value.kind,
        symbol === undefined ? value.text : (names.get(symbol) ?? value.text),
      ];
    }
    const children: unknown[] = [];
    value.forEachChild((child) => {
      children.push(tree(child));
    });
    return [
      value.kind,
      value.flags &
        (NodeFlags.Const |
          NodeFlags.Let |
          NodeFlags.Using |
          NodeFlags.OptionalChain),
      ...(isImportDeclaration(value)
        ? [value.importClause?.phaseModifier]
        : []),
      ...(isImportSpecifier(value) ||
      isExportSpecifier(value) ||
      isExportDeclaration(value)
        ? [value.isTypeOnly]
        : []),
      ...(isBinaryExpression(value) ? [value.operatorToken.kind] : []),
      ...(isPrefixUnaryExpression(value) || isPostfixUnaryExpression(value)
        ? [value.operator]
        : []),
      children.length ? children : value.getText(),
    ];
  }
  return tree(node);
}
function annotationSame(
  actual: Parsed,
  node: Node,
  expected: Parsed,
  old: Node,
  rule: string,
) {
  assert.deepEqual(
    annotationShape(actual, node),
    annotationShape(expected, old),
    rule,
  );
}
function annotationCalls(parsed: Parsed, module: string, name: string) {
  const symbol = parsed.symbols.get(annotationImported(parsed, module, name));
  assert.notEqual(
    symbol,
    undefined,
    "real imported annotation symbol, not local shadow",
  );
  return parsed.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        parsed.symbols.get(annotationLocal(parsed, node.expression)) === symbol,
    );
}
/** Current UI/read contract. The separately named legacy APIs above remain
 * unchanged for fixed history/peers; this function never calls their inverse. */
export function verifyCurrentObjectAnnotationsConsumption(
  appText: string,
  featureText: string,
  clientText: string,
  ownerText: string,
) {
  const parsed = parse({
    App: appText,
    Feature: featureText,
    Client: clientText,
    Expected: expectedFeature,
    Caller: `${expectedRegistration}\n${expectedProjection}\nconst panel = (${expectedConsumer});\n${objectAnnotationsFixed.beforeHook}\n${objectAnnotationsFixed.afterHook}`,
    Invalidations: currentWorkspaceInvalidations.join("\n"),
  });
  const app = parsed.get("App")!,
    feature = parsed.get("Feature")!,
    expected = parsed.get("Expected")!,
    caller = parsed.get("Caller")!,
    client = parsed.get("Client")!;
  const workspace = oneFunction(app, "WorkspaceApp");
  for (const [name, rule] of [
    [
      "useObjectAnnotations",
      "complete original annotation two states effect five dependencies abort and stable writer",
    ],
    ["objectAnnotationItems", "complete original annotation ID projection"],
    [
      "ObjectAnnotationsPanel",
      "complete original annotation panel DOM keys focus and only two expressions",
    ],
  ] as const)
    annotationSame(
      feature,
      oneFunction(feature, name),
      expected,
      oneFunction(expected, name),
      rule,
    );
  const hook = annotationCalls(app, featureModule, "useObjectAnnotations");
  const items = annotationCalls(app, featureModule, "objectAnnotationItems");
  for (const found of [hook, items])
    assert.equal(
      found.length,
      1,
      "real imported annotation symbol, not local shadow",
    );
  const panelImport = annotationImported(
    app,
    featureModule,
    "ObjectAnnotationsPanel",
  );
  const panels = app.nodes
    .filter(isJsxSelfClosingElement)
    .filter(
      (node) =>
        app.symbols.get(annotationLocal(app, node.tagName)) ===
        app.symbols.get(panelImport),
    );
  assert.equal(
    panels.length,
    1,
    "real imported annotation symbol, not local shadow",
  );
  const registration = hook[0]!.parent;
  assert.ok(
    isVariableDeclaration(registration) &&
      isObjectBindingPattern(registration.name),
    "direct stable annotation aliases",
  );
  const statement = registration.parent.parent;
  assert.ok(
    isVariableStatement(statement) && statement.parent === workspace.body,
    "unconditional original annotation hook slot",
  );
  const oldRegistration = caller.source.statements[0]!;
  annotationSame(
    app,
    statement,
    caller,
    oldRegistration,
    "exact original annotation Client and stable writer aliases",
  );
  const collaboration = workspace.body!.statements.find((node) =>
    node.getText().startsWith("const collaborationVisible ="),
  );
  const layout = annotationCalls(
    app,
    "./InspectorPanel.js",
    "useInspectorLayout",
  );
  assert.ok(
    collaboration && collaboration.end <= statement.pos,
    "original annotation hook preceding collaboration witness",
  );
  assert.equal(
    layout.length,
    1,
    "original annotation hook before inspector layout and memory commit",
  );
  assert.ok(
    statement.end < layout[0]!.pos,
    "original annotation hook preceding collaboration witness",
  );
  const feedback = app.nodes
    .filter(isShorthandPropertyAssignment)
    .filter((node) => node.name.getText() === "setAnnotationRefresh");
  const writer = registration.name.elements.find(
    (node) => node.name?.getText() === "setAnnotationRefresh",
  );
  assert.ok(writer?.name, "direct stable annotation aliases");
  assert.equal(
    feedback.length,
    1,
    "submission borrows original annotation stable writer",
  );
  assert.equal(
    app.symbols.get(feedback[0]!.name),
    app.symbols.get(writer.name),
    "submission borrows original annotation stable writer",
  );
  const projection = items[0]!.parent;
  assert.ok(
    isVariableDeclaration(projection) &&
      isVariableStatement(projection.parent.parent) &&
      projection.parent.parent.parent === workspace.body,
    "original annotation projection direct post-startup slot",
  );
  annotationSame(
    app,
    projection.parent.parent,
    caller,
    caller.source.statements[1]!,
    "original annotation projection inputs",
  );
  const startup = workspace.body!.statements.find((node) =>
    node.getText().startsWith("if (!state || !project)"),
  );
  const context = workspace.body!.statements.find((node) =>
    node.getText().startsWith("const contextTitle ="),
  );
  assert.ok(
    startup &&
      context &&
      startup.end < projection.pos &&
      projection.end < context.pos,
    "original annotation projection after startup and before context",
  );
  const panel = panels[0]!;
  const oldPanel = caller.nodes.filter(isJsxSelfClosingElement)[0]!;
  annotationSame(
    app,
    panel,
    caller,
    oldPanel,
    "complete original annotation props and captured render authorName",
  );
  const paren = panel.parent;
  assert.ok(
    isParenthesizedExpression(paren) &&
      isBinaryExpression(paren.parent) &&
      paren.parent.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken &&
      paren.parent.left.getText() === "collaborationVisible",
    "original annotation visibility guard",
  );
  const actor = annotationImported(app, "./client.js", "actorName");
  const author = panel.attributes.properties.find(
    (node) => isJsxAttribute(node) && node.name.getText() === "authorName",
  );
  assert.ok(
    author &&
      isJsxAttribute(author) &&
      author.initializer &&
      isJsxExpression(author.initializer) &&
      author.initializer.expression &&
      isArrowFunction(author.initializer.expression) &&
      isCallExpression(author.initializer.expression.body),
    "original render annotation author closure",
  );
  assert.equal(
    app.symbols.get(
      annotationLocal(app, author.initializer.expression.body.expression),
    ),
    app.symbols.get(actor),
    "real captured render actorName binding",
  );
  const state = workspace
    .body!.statements.filter(isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .filter((node) => node.name.getText() === "state");
  assert.equal(state.length, 1, "one original render workspace state");
  assert.equal(
    state[0]!.initializer?.getText(),
    "client.boot?.workspace",
    "original render annotation author workspace capture",
  );
  assert.equal(
    app.symbols.get(author.initializer.expression.body.arguments[0]!),
    app.symbols.get(state[0]!.name),
    "author reads original render workspace, not latest projection",
  );
  verifyObjectInteractionConsumption(clientText, ownerText);
  verifyCurrentWorkspaceChangeOwner(client);
  const effectSymbol = client.symbols.get(
    annotationImported(client, "react", "useEffect"),
  );
  const invalidation = client.nodes
    .filter(isCallExpression)
    .filter(
      (node) =>
        client.symbols.get(annotationLocal(client, node.expression)) ===
          effectSymbol && node.getText().includes("setWorkspaceChangeRevision"),
    );
  const old = parsed
    .get("Invalidations")!
    .nodes.filter(isCallExpression)
    .filter((node) => node.expression.getText() === "useEffect");
  assert.deepEqual(
    invalidation.map((node) => annotationShape(client, node)),
    old.map((node) => annotationShape(parsed.get("Invalidations")!, node)),
    "original annotation cross-domain refresh and access invalidation effects with approved mounted session lifecycle",
  );
}
