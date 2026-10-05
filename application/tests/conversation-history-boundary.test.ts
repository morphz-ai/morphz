import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  SyntaxKind,
  isCallExpression,
  isBindingElement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isNamedImports,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeNode,
  isTypeParameterDeclaration,
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
const publicationIdentity =
  "../../../../packages/core/src/conversation-publications.js";
const namedRuntimeDependencies = new Map([
  [scriptIdentity, "scriptOutputKey"],
  [publicationIdentity, "reconcileConversationPublications"],
]);
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

function violations(text: string, purePublications = false) {
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
    if (
      purePublications &&
      source.statements.some(
        (statement) =>
          !isTypeAliasDeclaration(statement) &&
          !isFunctionDeclaration(statement),
      )
    )
      issues.push("module-state-or-dependency");
    const visit = (node: Node) => {
      if (isIdentifier(node)) names.push(node);
      if (isVariableDeclaration(node) && isIdentifier(node.name))
        bindings.push(node.name);
      if (
        purePublications &&
        (isFunctionDeclaration(node) ||
          isParameterDeclaration(node) ||
          isBindingElement(node) ||
          isTypeAliasDeclaration(node) ||
          isTypeParameterDeclaration(node)) &&
        node.name &&
        isIdentifier(node.name)
      )
        bindings.push(node.name);
      if (isImportDeclaration(node)) {
        const from = isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "";
        const clause = node.importClause;
        if (purePublications) issues.push("pure-dependency");
        else if (clause?.phaseModifier === SyntaxKind.TypeKeyword) {
          if (from !== contractTypes) issues.push("type-dependency");
        } else if (
          !namedRuntimeDependencies.has(from) ||
          clause?.name ||
          !clause?.namedBindings ||
          !isNamedImports(clause.namedBindings) ||
          !clause.namedBindings.elements.length ||
          clause.namedBindings.elements.some(
            (item) =>
              (item.propertyName ?? item.name).text !==
              namedRuntimeDependencies.get(from),
          )
        )
          issues.push("runtime-dependency");
      }
      if (isImportTypeNode(node)) issues.push("indirect-type-dependency");
      if (node.kind === SyntaxKind.ExportDeclaration) issues.push("re-export");
      if (node.kind === SyntaxKind.AnyKeyword) issues.push("untyped-contract");
      if (
        purePublications &&
        (node.kind === SyntaxKind.AwaitExpression ||
          node.kind === SyntaxKind.AsyncKeyword)
      )
        issues.push("pure-async-effect");
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
      if (purePublications) {
        let typePosition = false;
        for (
          let parent: Node | undefined = name.parent;
          parent;
          parent = parent.parent
        )
          if (isTypeNode(parent)) {
            typePosition = true;
            break;
          }
        const propertyName =
          isPropertyAssignment(name.parent) && name.parent.name === name;
        const valueSymbol = isShorthandPropertyAssignment(name.parent)
          ? project.checker.getShorthandAssignmentValueSymbol(name.parent)
          : symbols[index];
        const localValue = valueSymbol && declared.has(valueSymbol.id);
        if (
          !localValue &&
          !property &&
          !propertyName &&
          !typePosition &&
          !["Map", "JSON", "undefined"].includes(name.text)
        )
          issues.push("pure-ambient-dependency");
      }
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

test("history permits the exact publication helper, not arbitrary core or effect imports", () => {
  const valid = `import type { PlatformHistory } from "${contractTypes}";
    import { scriptOutputKey as outputKey } from "${scriptIdentity}";
    import { reconcileConversationPublications as reconcile } from "${publicationIdentity}";
    export function page(value: PlatformHistory) {
      const key = outputKey(value.scriptOutputs[0]);
      return [key, reconcile(value.runtime.messages)];
    }`;
  assert.deepEqual(violations(valid), []);
  for (const addition of [
    `import { otherHelper } from "${publicationIdentity}";`,
    `import { reconcileConversationPublications, otherHelper } from "${publicationIdentity}";`,
    `import reconcileConversationPublications from "${publicationIdentity}";`,
    `import * as publications from "${publicationIdentity}";`,
    `import "${publicationIdentity}";`,
    `import {} from "${publicationIdentity}";`,
    `import { reconcileConversationPublications } from "../../../../packages/core/src/conversation.js";`,
    'import { applicationCall } from "../application-transport.js";',
    'import { useState } from "react";',
  ])
    assert.ok(
      violations(valid + "\n" + addition).includes("runtime-dependency"),
      addition,
    );
});

test("the actual publication helper owns only synchronous dependency-free message data", () => {
  const helper = readFileSync(
    new URL(
      "../packages/core/src/conversation-publications.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.deepEqual(violations(helper, true), []);
});

test("the pure publication gate retains local data growth but rejects environment and transport dependencies", () => {
  const helper = readFileSync(
    new URL(
      "../packages/core/src/conversation-publications.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const localGrowth = `
    function localFields(window: { rootId: string }) {
      const { rootId } = window;
      const localStorage = { rootId };
      return JSON.stringify(localStorage);
    }
    export function describe(messages: readonly PublicationMessage[]) {
      return messages.map(message => localFields({ rootId: message.rootId ?? "" }));
    }`;
  assert.deepEqual(violations(helper + localGrowth, true), []);
  const fixtures: [string, string][] = [
    [`import { useState } from "react";`, "pure-dependency"],
    [`import { readFileSync } from "node:fs";`, "pure-dependency"],
    [
      `import { applicationCall } from "../application-transport.js";`,
      "pure-dependency",
    ],
    [
      `import type { PlatformHistory } from "${contractTypes}";`,
      "pure-dependency",
    ],
    ['export { readFileSync } from "node:fs";', "re-export"],
    ['type Imported = import("node:fs").Stats;', "indirect-type-dependency"],
    ['function read() { return import("node:fs"); }', "dynamic-dependency"],
    ["const remembered = new Map();", "module-state-or-dependency"],
    [
      'function read() { return localStorage.getItem("messages"); }',
      "pure-ambient-dependency",
    ],
    [
      'function read() { return fetch("/api/platform/history"); }',
      "pure-ambient-dependency",
    ],
    ["function read() { return process.env; }", "pure-ambient-dependency"],
    [
      'function read() { return globalThis["fetch"]; }',
      "pure-ambient-dependency",
    ],
    [
      "function read() { return hostTransport.readHistory(); }",
      "pure-ambient-dependency",
    ],
    [
      'function read() { return new WebSocket("ws://localhost"); }',
      "pure-ambient-dependency",
    ],
    [
      "function read() { return setTimeout(() => {}, 1); }",
      "pure-ambient-dependency",
    ],
    ["function read() { return Date.now(); }", "pure-ambient-dependency"],
    ["function read() { return Math.random(); }", "pure-ambient-dependency"],
    ["async function read() { return []; }", "pure-async-effect"],
    ["function read(value: any) { return value; }", "untyped-contract"],
  ];
  for (const [addition, rule] of fixtures)
    assert.ok(
      violations(helper + "\n" + addition, true).includes(rule),
      addition,
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
