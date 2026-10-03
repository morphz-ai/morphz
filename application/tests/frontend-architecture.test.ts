import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  NodeFlags,
  SyntaxKind,
  isArrowFunction,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isForOfStatement,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isNamedImports,
  isNewExpression,
  isNonNullExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeNode,
  isInterfaceDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type BindingName,
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type Identifier,
  type FunctionDeclaration,
  type FunctionExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

// Only this first migrated boundary is governed. Other App responsibilities,
// features, hooks and styles remain outside this gate until they are migrated.
const governedFiles = {
  model: "apps/web/src/host/work-surface.ts",
  consumer: "apps/web/src/App.tsx",
} as const;
const appModule = "./host/work-surface.js";
const core = "../../../../packages/core/src/";
const runtimeImports = new Map([
  [core + "model.js", new Set(["spaceKind", "applicationFor"])],
  [
    core + "applications.js",
    new Set(["objectsApplication", "readerApplication"]),
  ],
  [core + "projects.js", new Set(["projectStatus"])],
]);
const typeImports = new Set([
  ...runtimeImports.keys(),
  core + "text-quotes.js",
]);
const surfaceFields = [
  "navigationProject",
  "deliveredScript",
  "project",
  "sharedDefault",
  "defaultConversation",
  "applicationWorkspaceOpen",
  "activeId",
  "activeInstance",
  "immersiveApplication",
  "artifact",
  "selectedConversation",
  "selectedDraft",
  "conversationId",
  "conversationProjectId",
  "directoryScope",
  "contextKey",
  "exchangeKey",
  "dialogueCanvas",
] as const;
const ambientEffects = new Set([
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "Notification",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "Image",
  "Audio",
  "FileReader",
  "DOMParser",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "crypto",
  "Date",
  "performance",
  "console",
  "process",
  "globalThis",
  "require",
]);
const readMethods = new Set([
  "find",
  "findIndex",
  "filter",
  "map",
  "some",
  "every",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
  "concat",
  "join",
  "at",
  "get",
  "has",
  "startsWith",
  "endsWith",
  "trim",
  "toLowerCase",
  "toUpperCase",
]);
const mutationMethods = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);
const pureStaticMethods = new Map([
  ["Array", new Set(["isArray"])],
  ["Object", new Set(["keys", "values", "entries", "hasOwn"])],
  [
    "Math",
    new Set(["abs", "ceil", "floor", "round", "min", "max", "trunc", "sign"]),
  ],
]);
type Parsed = { source: SourceFile; symbols: Map<Node, number> };
type Violation = { rule: string; line: number; detail: string };

function walk(node: Node, visit: (node: Node) => void, runtimeOnly = false) {
  if (
    runtimeOnly &&
    (isTypeNode(node) ||
      isTypeAliasDeclaration(node) ||
      isInterfaceDeclaration(node) ||
      isImportDeclaration(node) ||
      isExportDeclaration(node))
  )
    return;
  visit(node);
  node.forEachChild((child) => walk(child, visit, runtimeOnly));
}

function identifiers(name: BindingName): Identifier[] {
  if (isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    "name" in element && element.name ? identifiers(element.name) : [],
  );
}

function unwrap(node: Expression): Expression {
  while (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

function parseSources(contents: Record<string, string>): Map<string, Parsed> {
  // TS 7's bundled native parser returns its AST through this existing API.
  // Fixtures are virtual: no invalid source is written into the real app.
  const directory = "/morphz-frontend-architecture-fixtures";
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [
      `${directory}/${name}`,
      text,
    ]),
  );
  const config = `${directory}/tsconfig.json`;
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents),
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      assert.deepEqual(
        project.program.getSyntacticDiagnostics(),
        [],
        "Architecture inputs must parse; invalid syntax cannot pass the gate",
      );
      return new Map(
        Object.keys(contents).map((name) => {
          const source = project.program.getSourceFile(`${directory}/${name}`)!;
          assert.ok(source, `Missing architecture input: ${name}`);
          const names: Identifier[] = [];
          walk(source, (node) => {
            if (isIdentifier(node)) names.push(node);
          });
          const resolved = project.checker.getSymbolAtLocation(names);
          const symbols = new Map<Node, number>();
          names.forEach((node, index) => {
            if (resolved[index]) symbols.set(node, resolved[index]!.id);
          });
          return [name, { source, symbols }];
        }),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function issue(
  source: SourceFile,
  node: Node,
  rule: string,
  detail: string,
): Violation {
  return {
    rule,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    detail,
  };
}

function pureModelViolations({ source, symbols }: Parsed): Violation[] {
  const violations: Violation[] = [];
  const report = (node: Node, rule: string, detail: string) =>
    violations.push(issue(source, node, rule, detail));
  const declared = new Set<number>();
  const borrowed = new Set<number>();
  const moduleState = new Set<number>();
  const callable = new Set<number>();
  const localFunctions = new Map<
    number,
    ArrowFunction | FunctionDeclaration | FunctionExpression
  >();
  const aliases: { name: BindingName | Expression; value: Expression }[] = [];
  const lexicalNames = new Map<Node, Set<string>>();
  const addBindings = (name: BindingName, target: Set<number>) => {
    for (const binding of identifiers(name)) {
      const symbol = symbols.get(binding);
      if (symbol !== undefined) {
        declared.add(symbol);
        target.add(symbol);
      }
      let owner: Node = binding.parent;
      while (owner !== source) {
        if (isParameterDeclaration(owner)) {
          owner = owner.parent;
          break;
        }
        if (owner.kind === SyntaxKind.Block) break;
        owner = owner.parent;
      }
      const names = lexicalNames.get(owner) ?? new Set<string>();
      names.add(binding.text);
      lexicalNames.set(owner, names);
    }
  };
  walk(source, (node) => {
    if (isImportDeclaration(node)) {
      const path = isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      const clause = node.importClause;
      const allTypes = clause?.phaseModifier === SyntaxKind.TypeKeyword;
      if (
        !clause ||
        clause.name ||
        !clause.namedBindings ||
        !isNamedImports(clause.namedBindings)
      ) {
        report(
          node,
          "dependency",
          `Only reviewed named imports are permitted: ${path}`,
        );
        return;
      }
      for (const item of clause.namedBindings.elements) {
        const typeOnly = allTypes || item.isTypeOnly;
        const imported = (item.propertyName ?? item.name).text;
        if (
          typeOnly
            ? !typeImports.has(path)
            : !runtimeImports.get(path)?.has(imported)
        )
          report(
            item,
            "dependency",
            `Unreviewed ${typeOnly ? "type" : "runtime"} import: ${path}#${imported}`,
          );
        addBindings(item.name, typeOnly ? declared : callable);
        if (!typeOnly) addBindings(item.name, moduleState);
      }
    } else if (isImportEqualsDeclaration(node)) {
      report(
        node,
        "dependency",
        "Import assignment can bypass the reviewed dependency boundary",
      );
    } else if (isExportDeclaration(node) && node.moduleSpecifier) {
      const path = isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      if (!node.isTypeOnly || !typeImports.has(path))
        report(
          node,
          "dependency",
          `Re-export bypasses the reviewed boundary: ${path}`,
        );
    } else if (isImportTypeNode(node)) {
      if (
        !typeImports.has(
          node.argument.getText(source).replace(/^['"]|['"]$/g, ""),
        )
      )
        report(node, "dependency", "Unreviewed inline type dependency");
    } else if (isParameterDeclaration(node)) {
      addBindings(node.name, borrowed);
    } else if (isVariableDeclaration(node)) {
      addBindings(node.name, declared);
      if (node.initializer)
        aliases.push({ name: node.name, value: node.initializer });
      else if (isForOfStatement(node.parent.parent))
        aliases.push({ name: node.name, value: node.parent.parent.expression });
      if (node.parent.parent.parent === source)
        addBindings(node.name, moduleState);
      if (
        node.initializer &&
        (isArrowFunction(node.initializer) ||
          isFunctionExpression(node.initializer))
      ) {
        addBindings(node.name, callable);
        for (const binding of identifiers(node.name)) {
          const id = symbols.get(binding);
          if (id !== undefined) localFunctions.set(id, node.initializer);
        }
      }
    } else if (isFunctionDeclaration(node) && node.name) {
      addBindings(node.name, callable);
      if (node.parent === source) addBindings(node.name, moduleState);
      const id = symbols.get(node.name);
      if (id !== undefined) localFunctions.set(id, node);
    } else if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken
    ) {
      aliases.push({ name: node.left, value: node.right });
    }
  });
  const resolvingReturns = new Set<number>();
  const roots = (node: Expression): number[] => {
    node = unwrap(node);
    if (isIdentifier(node))
      return symbols.has(node) ? [symbols.get(node)!] : [];
    if (isPropertyAccessExpression(node) || isElementAccessExpression(node))
      return roots(node.expression);
    // A fresh container can still hold the caller's nested objects. This is
    // intentionally conservative: copying a wrapper is not a deep clone.
    if (isObjectLiteralExpression(node))
      return node.properties.flatMap((property) =>
        isPropertyAssignment(property)
          ? roots(property.initializer)
          : isShorthandPropertyAssignment(property) &&
              isIdentifier(property.name)
            ? roots(property.name)
            : isSpreadAssignment(property)
              ? roots(property.expression)
              : [],
      );
    if (isArrayLiteralExpression(node)) return node.elements.flatMap(roots);
    if (isSpreadElement(node)) return roots(node.expression);
    if (isConditionalExpression(node))
      return [...roots(node.whenTrue), ...roots(node.whenFalse)];
    if (
      isBinaryExpression(node) &&
      [
        SyntaxKind.QuestionQuestionToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    )
      return [...roots(node.left), ...roots(node.right)];
    if (isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (isPropertyAccessExpression(callee)) {
        const receiver = unwrap(callee.expression);
        if (
          isIdentifier(receiver) &&
          receiver.text === "Object" &&
          (!symbols.has(receiver) || !declared.has(symbols.get(receiver)!)) &&
          ["values", "entries"].includes(callee.name.text)
        )
          return node.arguments.flatMap(roots);
        return roots(callee.expression);
      }
      if (isIdentifier(callee)) {
        const returned = node.arguments.flatMap(roots);
        const id = symbols.get(callee);
        const fn = id !== undefined ? localFunctions.get(id) : undefined;
        if (id !== undefined && fn?.body && !resolvingReturns.has(id)) {
          resolvingReturns.add(id);
          try {
            if (isArrowFunction(fn) && !isBlock(fn.body))
              returned.push(...roots(fn.body));
            else {
              const visitReturns = (child: Node) => {
                // A nested callback's return is not this function's return.
                if (
                  isArrowFunction(child) ||
                  isFunctionExpression(child) ||
                  isFunctionDeclaration(child)
                )
                  return;
                if (isReturnStatement(child) && child.expression)
                  returned.push(...roots(child.expression));
                child.forEachChild(visitReturns);
              };
              visitReturns(fn.body);
            }
          } finally {
            resolvingReturns.delete(id);
          }
        }
        return returned;
      }
    }
    return [];
  };
  // This bounded gate assumes the reviewed plain model data; it is not a
  // general JavaScript purity proof. Direct containers, declared function
  // returns and selected collection items conservatively retain their roots.
  // Local counters/collections are allowed; external and module state is not.
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (
        !roots(alias.value).some(
          (id) => borrowed.has(id) || moduleState.has(id),
        )
      )
        continue;
      const bindings =
        isIdentifier(alias.name) ||
        isObjectBindingPattern(alias.name) ||
        alias.name.kind === SyntaxKind.ArrayBindingPattern
          ? identifiers(alias.name as BindingName)
          : [];
      for (const binding of bindings) {
        const id = symbols.get(binding);
        if (id !== undefined && !borrowed.has(id)) {
          borrowed.add(id);
          changed = true;
        }
      }
    }
  }
  const mutation = (target: Expression, node: Node) => {
    const ids = roots(target);
    if (
      ids.some((id) => moduleState.has(id)) ||
      (!isIdentifier(unwrap(target)) && ids.some((id) => borrowed.has(id)))
    )
      report(
        node,
        "mutation",
        "Pure work-surface derivation cannot modify caller or module state",
      );
  };
  for (const statement of source.statements) {
    if (isVariableStatement(statement)) {
      if (!(statement.declarationList.flags & NodeFlags.Const))
        report(
          statement,
          "module-state",
          "Mutable state cannot live at module scope",
        );
    } else if (
      !isImportDeclaration(statement) &&
      !isExportDeclaration(statement) &&
      !isFunctionDeclaration(statement) &&
      !isTypeAliasDeclaration(statement) &&
      !isInterfaceDeclaration(statement)
    )
      report(
        statement,
        "module-effect",
        "Only declarations belong at this pure module's top level",
      );
  }
  walk(
    source,
    (node) => {
      const shorthandLocal =
        isIdentifier(node) &&
        isShorthandPropertyAssignment(node.parent) &&
        (() => {
          for (
            let scope: Node | undefined = node.parent;
            scope;
            scope = scope.parent
          )
            if (lexicalNames.get(scope)?.has(node.text)) return true;
          return false;
        })();
      if (
        isIdentifier(node) &&
        ambientEffects.has(node.text) &&
        !shorthandLocal &&
        (!symbols.has(node) || !declared.has(symbols.get(node)!)) &&
        !(
          (isPropertyAccessExpression(node.parent) ||
            isPropertyAssignment(node.parent)) &&
          node.parent.name === node
        )
      )
        report(
          node,
          "ambient-effect",
          `Ambient effect source is forbidden: ${node.text}`,
        );
      if (isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (callee.kind === SyntaxKind.ImportKeyword)
          report(
            node,
            "dependency",
            "Dynamic imports bypass the reviewed dependency boundary",
          );
        else if (isIdentifier(callee)) {
          if (!symbols.has(callee) || !callable.has(symbols.get(callee)!))
            report(
              node,
              "effect-call",
              `Unreviewed function call: ${callee.text}`,
            );
        } else if (isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          const receiver = unwrap(callee.expression);
          const pureStatic =
            isIdentifier(receiver) &&
            (!symbols.has(receiver) || !declared.has(symbols.get(receiver)!)) &&
            pureStaticMethods.get(receiver.text)?.has(method);
          if (mutationMethods.has(method)) {
            if (
              roots(callee.expression).some(
                (id) => borrowed.has(id) || moduleState.has(id),
              )
            )
              report(
                node,
                "mutation",
                `Cannot mutate borrowed state with ${method}`,
              );
          } else if (!readMethods.has(method) && !pureStatic)
            report(node, "effect-call", `Unreviewed method call: ${method}`);
        } else
          report(
            node,
            "effect-call",
            "Indirect calls need an explicit pure boundary",
          );
      }
      if (
        isNewExpression(node) &&
        !(
          isIdentifier(node.expression) &&
          ["Map", "Set"].includes(node.expression.text) &&
          (!symbols.has(node.expression) ||
            !declared.has(symbols.get(node.expression)!))
        )
      )
        report(
          node,
          "effect-call",
          "Constructors need an explicit pure boundary",
        );
      if (
        isBinaryExpression(node) &&
        node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= SyntaxKind.LastAssignment
      )
        mutation(node.left, node);
      if (
        (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
        [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(
          node.operator,
        )
      )
        mutation(node.operand, node);
      if (isDeleteExpression(node)) mutation(node.expression, node);
      if (
        [
          SyntaxKind.JsxElement,
          SyntaxKind.JsxSelfClosingElement,
          SyntaxKind.JsxFragment,
          SyntaxKind.AwaitExpression,
          SyntaxKind.YieldExpression,
        ].includes(node.kind)
      )
        report(
          node,
          "effect-call",
          "Rendering or asynchronous execution does not belong in this model",
        );
    },
    true,
  );
  return violations;
}

function appConsumerViolations({ source, symbols }: Parsed): Violation[] {
  const violations: Violation[] = [];
  const report = (node: Node, rule: string, detail: string) =>
    violations.push(issue(source, node, rule, detail));
  const imports = new Map<string, string>();
  const importBindings = new Map<string, number>();
  for (const statement of source.statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== appModule
    )
      continue;
    const clause = statement.importClause;
    if (clause?.namedBindings && isNamedImports(clause.namedBindings))
      for (const item of clause.namedBindings.elements)
        if (
          clause.phaseModifier !== SyntaxKind.TypeKeyword &&
          !item.isTypeOnly
        ) {
          imports.set((item.propertyName ?? item.name).text, item.name.text);
          const id = symbols.get(item.name);
          if (id !== undefined)
            importBindings.set((item.propertyName ?? item.name).text, id);
        }
  }
  const called = (node: Node, name: string): node is CallExpression =>
    isCallExpression(node) &&
    isIdentifier(unwrap(node.expression)) &&
    unwrap(node.expression).getText(source) === imports.get(name) &&
    importBindings.has(name) &&
    symbols.get(unwrap(node.expression)) === importBindings.get(name);
  const calls = new Map<string, Node[]>([
    ["deriveWorkSurface", []],
    ["readWorkSurfaceDraft", []],
    ["workSurfaceConversationId", []],
  ]);
  walk(
    source,
    (node) => {
      for (const [name, found] of calls)
        if (called(node, name)) found.push(node);
    },
    true,
  );
  for (const [name, found] of calls)
    if (!imports.has(name) || found.length !== 1)
      report(
        source,
        "single-entry",
        `${name} must have one imported production call; found ${found.length}`,
      );
  const workspace = source.statements.find(
    (node) => isFunctionDeclaration(node) && node.name?.text === "WorkspaceApp",
  );
  if (!workspace || !isFunctionDeclaration(workspace) || !workspace.body) {
    report(source, "consumer", "Missing WorkspaceApp boundary");
    return violations;
  }
  const connected = new Set<string>();
  const drafts = new Set<string>();
  for (const statement of workspace.body.statements) {
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const names = identifiers(declaration.name).map((node) => node.text);
      const initializer =
        declaration.initializer && unwrap(declaration.initializer);
      if (
        names.includes("workSurface") &&
        (!initializer || !called(initializer, "deriveWorkSurface"))
      )
        report(
          declaration,
          "consumer",
          "workSurface must come directly from deriveWorkSurface",
        );
      for (const name of names) {
        if ((surfaceFields as readonly string[]).includes(name)) {
          if (
            !isObjectBindingPattern(declaration.name) ||
            !initializer ||
            !isIdentifier(initializer) ||
            initializer.text !== "workSurface"
          )
            report(
              declaration,
              "derived-state",
              `${name} must be read from the single workSurface result`,
            );
          else connected.add(name);
        }
        if (["surfaceDraft", "draft"].includes(name)) {
          if (
            !isObjectBindingPattern(declaration.name) ||
            !initializer ||
            !called(initializer, "readWorkSurfaceDraft") ||
            initializer.arguments[0]?.getText(source) !== "workSurface"
          )
            report(
              declaration,
              "derived-state",
              `${name} must come from readWorkSurfaceDraft(workSurface, ...)`,
            );
          else drafts.add(name);
        }
        if (name === "legacyContextKey")
          report(
            declaration,
            "key-owner",
            "Legacy key compatibility belongs to the work-surface model",
          );
      }
    }
  }
  for (const name of surfaceFields)
    if (!connected.has(name))
      report(workspace, "consumer", `Missing workSurface projection: ${name}`);
  for (const name of ["surfaceDraft", "draft"])
    if (!drafts.has(name))
      report(workspace, "consumer", `Missing draft projection: ${name}`);
  const conversation = workspace.body.statements.find(
    (node) =>
      isFunctionDeclaration(node) && node.name?.text === "conversationKey",
  );
  const returned =
    conversation &&
    isFunctionDeclaration(conversation) &&
    conversation.body?.statements[0];
  if (
    !returned ||
    !isReturnStatement(returned) ||
    !returned.expression ||
    !called(returned.expression, "workSurfaceConversationId") ||
    returned.expression.arguments[0]?.getText(source) !== "workSurface"
  )
    report(
      workspace,
      "key-owner",
      "conversationKey must delegate to workSurfaceConversationId(workSurface, ...)",
    );
  walk(
    workspace.body,
    (node) => {
      if (!isBinaryExpression(node) && !isConditionalExpression(node)) return;
      const refs = new Set<string>();
      let separator = false;
      walk(
        node,
        (child) => {
          if (isIdentifier(child)) refs.add(child.text);
          if (isStringLiteral(child) && child.text === ":") separator = true;
        },
        true,
      );
      // Detect a copy under a new variable name as well as the old declarations.
      // Simple artifact/quote destination keys still belong to existing App callbacks.
      if (
        separator &&
        ["artifact", "activeInstance", "navigationProject", "prefs"].every(
          (name) => refs.has(name),
        )
      )
        report(
          node,
          "key-owner",
          "The context/legacy key formula belongs to the work-surface model",
        );
      if (
        isConditionalExpression(node) &&
        [
          "conversationId",
          "defaultConversation",
          "navigationProject",
          "prefs",
        ].every((name) => refs.has(name))
      )
        report(
          node,
          "key-owner",
          "The exchange key formula belongs to the work-surface model",
        );
    },
    true,
  );
  return violations;
}

const validModel = `
import { spaceKind, type Workspace } from "${core}model.js";
import type { TextQuote } from "${core}text-quotes.js";
function lookup(values: number[], wanted: number) {
  return values.find(value => value === wanted);
}
export function deriveWorkSurface(input: { values: number[]; document: string }) {
  // A string or property called document is not ambient DOM access.
  const text = "window.fetch()";
  const document = input.document;
  let count = 0;
  const selected: number[] = [];
  for (const value of input.values) { count += value; selected.push(value); }
  const cache = new Map<string, number>();
  cache.set(document, Math.round(count));
  const personalSpace = (wanted: number) => input.values.find(value => value === wanted);
  const found = personalSpace(count);
  const lookedUp = lookup(input.values, count);
  return { text, document, count, selected, found, lookedUp, cached: cache.get(document) };
}`;
const validApp = `
import { deriveWorkSurface, readWorkSurfaceDraft, workSurfaceConversationId } from "${appModule}";
function WorkspaceApp() {
  const workSurface = deriveWorkSurface(input);
  const { ${surfaceFields.join(", ")} } = workSurface;
  const { surfaceDraft, draft } = readWorkSurfaceDraft(workSurface, drafts, emptyDraft);
  function conversationKey(workspaceId: string) {
    return workSurfaceConversationId(workSurface, prefs.selectedConversations, workspaceId);
  }
  const [legacyDialogOpen, setLegacyDialogOpen] = useState(false);
  return <main onClick={() => setLegacyDialogOpen(true)}>{legacyDialogOpen}</main>;
}`;

test("first migrated work-surface boundary obeys its dependency, purity and single-entry rules", () => {
  const parsed = parseSources(
    Object.fromEntries(
      Object.values(governedFiles).map((path) => [
        path,
        readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
      ]),
    ),
  );
  assert.deepEqual(pureModelViolations(parsed.get(governedFiles.model)!), []);
  assert.deepEqual(
    appConsumerViolations(parsed.get(governedFiles.consumer)!),
    [],
  );
});

test("the boundary gate permits local computation, type-only dependencies and existing App state", () => {
  const parsed = parseSources({
    "model.ts": validModel,
    "App.tsx": validApp,
    "AliasedApp.tsx": validApp
      .replace(/deriveWorkSurface/g, "selectSurface")
      .replace(
        "import { selectSurface,",
        "import { deriveWorkSurface as selectSurface,",
      ),
  });
  assert.deepEqual(pureModelViolations(parsed.get("model.ts")!), []);
  assert.deepEqual(appConsumerViolations(parsed.get("App.tsx")!), []);
  assert.deepEqual(appConsumerViolations(parsed.get("AliasedApp.tsx")!), []);
});

test("invalid model fixtures are rejected by the same gate used on production source", () => {
  const fixtures: [string, string, string][] = [
    ["react", 'import { useState } from "react";', "dependency"],
    [
      "mixed-react",
      'import { type ReactNode, useEffect } from "react";',
      "dependency",
    ],
    [
      "transport",
      'import { request } from "../application-transport.js";',
      "dependency",
    ],
    [
      "feature-type",
      'import type { ReadingCompose } from "../Reader.js";',
      "dependency",
    ],
    [
      "unreviewed-core-symbol",
      `import { draftKey } from "${core}model.js";`,
      "dependency",
    ],
    [
      "re-export",
      'export { request } from "../application-transport.js";',
      "dependency",
    ],
    [
      "dynamic-import",
      'function load() { return import("../client.js"); }',
      "dependency",
    ],
    [
      "require",
      'function load() { return require("../client.js"); }',
      "ambient-effect",
    ],
    [
      "dom",
      'function read() { return document.querySelector("main"); }',
      "ambient-effect",
    ],
    [
      "storage-alias",
      'function save() { const store = localStorage; store.setItem("scope", "x"); }',
      "ambient-effect",
    ],
    [
      "network",
      'function read() { return fetch("/api/workspace"); }',
      "ambient-effect",
    ],
    [
      "qualified-global",
      "function read() { return globalThis.document; }",
      "ambient-effect",
    ],
    [
      "timer",
      "function schedule() { setTimeout(() => {}, 0); }",
      "ambient-effect",
    ],
    ["time", "function derive() { return Date.now(); }", "ambient-effect"],
    ["random", "function derive() { return Math.random(); }", "effect-call"],
    [
      "injected-effect",
      "function save(input: { persist(): void }) { input.persist(); }",
      "effect-call",
    ],
    [
      "input-write",
      'function change(input: { view: string }) { input.view = "content"; }',
      "mutation",
    ],
    [
      "alias-write",
      'function change(input: { prefs: { view: string } }) { const prefs = input.prefs; prefs.view = "content"; }',
      "mutation",
    ],
    [
      "nested-wrapper-write",
      'function change(input: { prefs: { view: string } }) { const wrapper = { prefs: input.prefs }; wrapper.prefs.view = "content"; }',
      "mutation",
    ],
    [
      "shallow-copy-write",
      'function change(input: { prefs: { view: string } }) { const copy = { ...input }; copy.prefs.view = "content"; }',
      "mutation",
    ],
    [
      "local-return-write",
      'function select(prefs: { view: string }) { return prefs; } function change(input: { prefs: { view: string } }) { const prefs = select(input.prefs); prefs.view = "content"; }',
      "mutation",
    ],
    [
      "object-values-write",
      'function change(input: Record<string, { view: string }>) { for (const prefs of Object.values(input)) prefs.view = "content"; }',
      "mutation",
    ],
    [
      "reassigned-alias-write",
      'function change(input: { prefs: { view: string } }) { let prefs = { view: "" }; prefs = input.prefs; prefs.view = "content"; }',
      "mutation",
    ],
    [
      "array-write",
      'function change(input: string[]) { input.push("x"); }',
      "mutation",
    ],
    [
      "iterated-item-write",
      'function change(input: { view: string }[]) { for (const item of input) item.view = "content"; }',
      "mutation",
    ],
    [
      "callback-write",
      'function change(input: { view: string }[]) { return input.map(item => { item.view = "content"; return item; }); }',
      "mutation",
    ],
    [
      "module-write",
      'const cache = { key: "" }; function change() { cache.key = "x"; }',
      "mutation",
    ],
    ["module-state", 'let selected = "";', "module-state"],
    ["module-effect", 'spaceKind({ kind: "desk" });', "module-effect"],
  ];
  const parsed = parseSources(
    Object.fromEntries(
      fixtures.map(([name, code]) => [`${name}.ts`, validModel + "\n" + code]),
    ),
  );
  for (const [name, , rule] of fixtures)
    assert.ok(
      pureModelViolations(parsed.get(`${name}.ts`)!).some(
        (item) => item.rule === rule,
      ),
      `${name}: expected ${rule} rejection`,
    );
});

test("invalid App fixtures cannot reintroduce a second derivation or copied scope formulas", () => {
  const fixtures: [string, string, string][] = [
    [
      "duplicate-entry",
      validApp.replace(
        "return <main",
        "const another = deriveWorkSurface(input); return <main",
      ),
      "single-entry",
    ],
    [
      "shadowed-import-entry",
      validApp.replace(
        "const workSurface = deriveWorkSurface(input);",
        "const deriveWorkSurface = (value: unknown) => value; const workSurface = deriveWorkSurface(input);",
      ),
      "single-entry",
    ],
    [
      "missing-entry",
      validApp.replace("deriveWorkSurface(input)", "useState(input)"),
      "single-entry",
    ],
    [
      "mirrored-context",
      validApp
        .replace("contextKey,", "contextKey: ignoredContext,")
        .replace(
          "return <main",
          'const contextKey = useState("scope"); return <main',
        ),
      "derived-state",
    ],
    [
      "copied-key",
      validApp.replace(
        "return <main",
        'const copy = conversationId + ":" + (artifact?.id ?? activeInstance?.id ?? (navigationProject?.id ?? "") + ":" + prefs.view); return <main',
      ),
      "key-owner",
    ],
    [
      "copied-exchange",
      validApp.replace(
        "return <main",
        'const copy = conversationId === defaultConversation ? prefs.view === "content" ? `${navigationProject?.id ?? conversationId}:content` : navigationProject?.id : conversationId; return <main',
      ),
      "key-owner",
    ],
    [
      "draft-mirror",
      validApp.replace(
        "readWorkSurfaceDraft(workSurface, drafts, emptyDraft)",
        "useState(emptyDraft)",
      ),
      "derived-state",
    ],
    [
      "draft-wrong-scope",
      validApp.replace(
        "readWorkSurfaceDraft(workSurface,",
        "readWorkSurfaceDraft(otherSurface,",
      ),
      "derived-state",
    ],
    [
      "conversation-key",
      validApp.replace(
        "return workSurfaceConversationId(workSurface, prefs.selectedConversations, workspaceId);",
        "return prefs.selectedConversations?.[workspaceId] ?? workspaceId;",
      ),
      "key-owner",
    ],
  ];
  const parsed = parseSources(
    Object.fromEntries(fixtures.map(([name, code]) => [`${name}.tsx`, code])),
  );
  for (const [name, , rule] of fixtures)
    assert.ok(
      appConsumerViolations(parsed.get(`${name}.tsx`)!).some(
        (item) => item.rule === rule,
      ),
      `${name}: expected ${rule} rejection`,
    );
});
