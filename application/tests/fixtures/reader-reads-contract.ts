import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isBinaryExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

export const readerMethods = [
  "readReading",
  "readingContents",
  "readingState",
  "readingMarks",
] as const;
// Independently calculated from the four actual Git 39cf13cf Client functions.
// Ordinary CI reads the embedded oracle; it needs neither shell nor Git history.
export const fixedReaderHashes = {
  readReading:
    "ec19e646b30e1898030aae19f5908a3b688b407f1db7452738ab19a0dc465d00",
  readingContents:
    "5f760d66dd3710a4712ead552b4bbb89da0995385b5b1c57d1478a8d0ffb6ce5",
  readingState:
    "c348122efacd96de7102b6d32afcc17a03b596ccb01742f9551c8b7b0dded4a1",
  readingMarks:
    "4efe9d1ee3b25462de30e360c89dc573c07019cc5e1b9a728a2d0575343bcebc",
};
export type ParsedReaderSource = {
  source: SourceFile;
  nodes: Node[];
  symbols: Map<Node, number | undefined>;
};
export function walkReader(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walkReader(child, visit);
  });
}
export function parseReaderSources(contents: Record<string, string>) {
  const root = "/reader-reads-contract",
    config = root + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(contents).map(([name, text]) => [
      root + "/" + name + ".ts",
      text,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true },
    files: Object.keys(contents).map((name) => name + ".ts"),
  });
  const api = new API({ cwd: root, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "parse legal sources before applying finite rules",
    );
    return new Map(
      Object.keys(contents).map((name): [string, ParsedReaderSource] => {
        const source = project.program.getSourceFile(
          root + "/" + name + ".ts",
        )!;
        const nodes: Node[] = [],
          names: Identifier[] = [];
        walkReader(source, (node) => {
          nodes.push(node);
          if (isIdentifier(node)) names.push(node);
        });
        const resolved = project.checker.getSymbolAtLocation(names);
        const symbols = new Map<Node, number | undefined>(
          names.map((node, index) => [node, resolved[index]?.id]),
        );
        for (const node of nodes.filter(isShorthandPropertyAssignment))
          symbols.set(
            node.name,
            project.checker.getShorthandAssignmentValueSymbol(node)?.id,
          );
        return [name, { source, nodes, symbols }];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
export function readerShape(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(readerShape(child));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(),
  ];
}
export function readerFunction(parsed: ParsedReaderSource, name: string) {
  const found = parsed.nodes
    .filter(isFunctionDeclaration)
    .filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, "exactly one function " + name);
  assert.ok(found[0]!.body);
  return found[0]!;
}
export function readerVariable(parsed: ParsedReaderSource, name: string) {
  const found = parsed.nodes
    .filter(isVariableDeclaration)
    .filter((node) => isIdentifier(node.name) && node.name.text === name);
  assert.equal(found.length, 1, "exactly one binding " + name);
  return found[0]!;
}
export function readerFunctionHashes(parsed: ParsedReaderSource) {
  return Object.fromEntries(
    readerMethods.map((name) => [
      name,
      createHash("sha256")
        .update(JSON.stringify(readerShape(readerFunction(parsed, name))))
        .digest("hex"),
    ]),
  );
}
export function readerImport(
  parsed: ParsedReaderSource,
  path: string,
  name: string,
) {
  const found: Identifier[] = [];
  for (const declaration of parsed.source.statements.filter(
    isImportDeclaration,
  )) {
    if (
      !isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== path
    )
      continue;
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !isNamedImports(bindings)) continue;
    for (const binding of bindings.elements)
      if ((binding.propertyName ?? binding.name).text === name)
        found.push(binding.name);
  }
  assert.equal(found.length, 1, "exactly one actual import " + name);
  const local = found[0]!;
  assert.equal(
    parsed.nodes
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === local.text).length,
    0,
    "no shadow import function",
  );
  assert.equal(
    parsed.nodes
      .filter(isVariableDeclaration)
      .filter(
        (node) => isIdentifier(node.name) && node.name.text === local.text,
      ).length,
    0,
    "no shadow import variable",
  );
  const symbol = parsed.symbols.get(local);
  assert.notEqual(symbol, undefined, "resolved import symbol");
  return { local, symbol };
}
