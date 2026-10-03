import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isNamedImports,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Identifier,
  type Node,
} from "typescript/unstable/ast";

// This gate governs the migrated history data owner only, not every existing
// frontend module. Behavioral equivalence is checked against the fixed old
// history implementation in conversation-history.test.ts and real Host tests.
const path = "apps/web/src/data/conversation-history.ts";
const contractTypes = "../platform-client.js";
const scriptIdentity = "../../../../packages/core/src/script-delivery.js";
const forbiddenGlobals = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest",
  "EventSource",
  "WebSocket",
  "BroadcastChannel",
  "Worker",
  "setInterval",
  "setTimeout",
  "queueMicrotask",
  "globalThis",
  "process",
  "require",
  "applicationCall",
  "storageScope",
]);

function violations(text: string) {
  const directory = "/conversation-history-boundary-fixture";
  const sourcePath = `${directory}/owner.ts`,
    config = `${directory}/tsconfig.json`;
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [sourcePath]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: [sourcePath],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(project.program.getSyntacticDiagnostics(), []);
    const source = project.program.getSourceFile(sourcePath)!;
    const issues: string[] = [],
      names: Identifier[] = [],
      bindings: Identifier[] = [];
    const visit = (node: Node) => {
      if (isIdentifier(node)) names.push(node);
      if (isVariableDeclaration(node) && isIdentifier(node.name))
        bindings.push(node.name);
      if (isImportDeclaration(node)) {
        const from = isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "";
        const clause = node.importClause;
        if (clause?.phaseModifier === SyntaxKind.TypeKeyword) {
          if (from !== contractTypes) issues.push("type-dependency");
        } else if (
          from !== scriptIdentity ||
          clause?.name ||
          !clause?.namedBindings ||
          !isNamedImports(clause.namedBindings) ||
          clause.namedBindings.elements.some(
            (item) =>
              (item.propertyName ?? item.name).text !== "scriptOutputKey",
          )
        )
          issues.push("runtime-dependency");
      }
      if (isImportTypeNode(node)) issues.push("indirect-type-dependency");
      if (node.kind === SyntaxKind.ExportDeclaration) issues.push("re-export");
      if (node.kind === SyntaxKind.AnyKeyword) issues.push("untyped-contract");
      if (
        isCallExpression(node) &&
        node.expression.kind === SyntaxKind.ImportKeyword
      )
        issues.push("dynamic-dependency");
      node.forEachChild(visit);
    };
    visit(source);
    const symbols = project.checker.getSymbolAtLocation([
      ...names,
      ...bindings,
    ]);
    const declared = new Set(
      symbols
        .slice(names.length)
        .filter(Boolean)
        .map((symbol) => symbol!.id),
    );
    names.forEach((name, index) => {
      // A paging loop's local `window` is not the browser's ambient window.
      const local = symbols[index] && declared.has(symbols[index]!.id);
      const property =
        isPropertyAccessExpression(name.parent) && name.parent.name === name;
      if (!local && !property && forbiddenGlobals.has(name.text))
        issues.push("ambient-effect");
    });
    return issues;
  } finally {
    snapshot.dispose();
    api.close();
  }
}

test("conversation history owns disposable queries, not React, storage, transport or commands", () => {
  assert.deepEqual(
    violations(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")),
    [],
  );
});

test("the same gate rejects alternate imports, ambient state and direct subscriptions", () => {
  const valid = `import type { PlatformHistory } from "${contractTypes}";
    import { scriptOutputKey as outputKey } from "${scriptIdentity}";
    export function page(value: PlatformHistory) {
      for (let window = 0; window < 4; window++) { const number = window; }
      return value;
    }`;
  assert.deepEqual(violations(valid), []);
  const fixtures: [string, string][] = [
    ['import { useRef } from "react";', "runtime-dependency"],
    [
      'import { applicationCall as read } from "../application-transport.js";',
      "runtime-dependency",
    ],
    ['import type { WorkspaceClient } from "../client.js";', "type-dependency"],
    [
      `import { PlatformClient } from "${contractTypes}";`,
      "runtime-dependency",
    ],
    ['export { useWorkspace } from "../client.js";', "re-export"],
    [
      'type Client = import("../client.js").WorkspaceClient;',
      "indirect-type-dependency",
    ],
    [
      'const read = import("../application-transport.js");',
      "dynamic-dependency",
    ],
    ["const data: any = {};", "untyped-contract"],
    ['const saved = localStorage.getItem("history");', "ambient-effect"],
    [
      'const transport = fetch; transport("/api/platform/history");',
      "ambient-effect",
    ],
    [
      'const browser = window; browser.fetch("/api/history");',
      "ambient-effect",
    ],
    ['const stream = new EventSource("/api/stream");', "ambient-effect"],
    ["setInterval(() => page({}), 5000);", "ambient-effect"],
    [
      "const context = globalThis; context.localStorage.clear();",
      "ambient-effect",
    ],
  ];
  for (const [addition, rule] of fixtures)
    assert.ok(violations(valid + "\n" + addition).includes(rule), addition);
});
