import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableStatement,
  SyntaxKind,
  type Node,
} from "typescript/unstable/ast";

export const referenceMethods = [
  "openTextQuote",
  "composeContent",
  "composeReading",
  "composeIntent",
] as const;
// Independently calculated from the complete actual Git 39cf13cf declarations,
// before writing the new owner. CI does not need Git or a generated baseline.
export const fixedReferenceHashes = {
  openTextQuote:
    "f61329c9c1b1e74c8cc1bfb6d53174c8b5f60a90d1e4d736916b0e608be2d15c",
  composeContent:
    "c773919ac64df8a32955b623d78031907d7e72bb10d13f7a70d224f2d2484623",
  composeReading:
    "2e85a489ac0229dd77b6dc5cbf388382b8080f43d0b8f4c83cc9c97d7da2c572",
  composeIntent:
    "85b135a8844909a5305f4eef7f20cb5374d7ca0b550d39b488d43b3c6a5f273f",
};
export function walkReference(node: Node, visit: (node: Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    walkReference(child, visit);
  });
}
export function parseReference(source: string) {
  const root = "/exchange-reference-contract",
    config = root + "/tsconfig.json",
    file = root + "/source.ts";
  const api = new API({
    cwd: root,
    fs: createVirtualFileSystem({
      [file]: source,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["source.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(
      program.getSyntacticDiagnostics(),
      [],
      "legal parsed source is required before applying finite rules",
    );
    const sourceFile = program.getSourceFile(file)!;
    const nodes: Node[] = [];
    walkReference(sourceFile, (node) => {
      nodes.push(node);
    });
    return { source: sourceFile, nodes };
  } finally {
    snapshot.dispose();
    api.close();
  }
}
export function referenceDeclarations(
  parsed: ReturnType<typeof parseReference>,
) {
  return Object.fromEntries(
    referenceMethods.map((name) => {
      const found = parsed.nodes.filter(
        (node) =>
          (isFunctionDeclaration(node) || isVariableDeclaration(node)) &&
          node.name &&
          isIdentifier(node.name) &&
          node.name.text === name,
      );
      assert.equal(found.length, 1, "one complete algorithm " + name);
      return [name, found[0]!.getText()];
    }),
  ) as Record<(typeof referenceMethods)[number], string>;
}
export function verifyFixedReference(source: string) {
  const declarations = referenceDeclarations(parseReference(source));
  for (const name of referenceMethods)
    assert.equal(
      createHash("sha256").update(declarations[name]).digest("hex"),
      fixedReferenceHashes[name],
      "fixed Git 39cf13cf declaration " + name,
    );
  return declarations;
}

// A deliberately finite structural contract, not a general purity proof or
// authority/UI/mounted-consumption gate. The fixed oracle supplies the algorithms.
export function verifyReferenceOwner(owner: string, fixed: string) {
  const parsed = parseReference(owner);
  for (const statement of parsed.source.statements.filter(isImportDeclaration))
    assert.equal(
      statement.importClause?.phaseModifier,
      SyntaxKind.TypeKeyword,
      "type-only imports",
    );
  const factory = parsed.nodes.filter(
    (node) =>
      isFunctionDeclaration(node) &&
      node.name?.text === "createExchangeReferenceCommands",
  );
  assert.equal(factory.length, 1, "one render-local reference factory");
  assert.ok(isFunctionDeclaration(factory[0]!) && factory[0].body);
  const body = factory[0].body;
  for (const statement of body.statements) {
    assert.ok(
      isVariableStatement(statement) ||
        isFunctionDeclaration(statement) ||
        isReturnStatement(statement),
      "reference construction only captures and returns commands",
    );
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || isArrowFunction(declaration.initializer))
        continue;
      walkReference(declaration.initializer, (node) => {
        assert.ok(!isCallExpression(node), "no constructor port call");
        assert.ok(
          !isPropertyAccessExpression(node) || node.name.text !== "current",
          "no constructor live ref read",
        );
      });
    }
  }
  const old = verifyFixedReference(fixed);
  const actual = referenceDeclarations(parsed);
  // Only these two explicit, finite source adapters are authorized. DOM work is
  // still performed by the original App port; the reading type has no runtime.
  actual.openTextQuote = actual.openTextQuote.replace(
    "quotes.clearSelection();",
    "window.getSelection()?.removeAllRanges();",
  );
  actual.composeReading = actual.composeReading.replace(
    "composeReading: ReadingComposeCommand",
    "composeReading: ReadingCompose",
  );
  for (const name of referenceMethods)
    assert.equal(
      actual[name],
      old[name],
      "original reference algorithm " + name,
    );
}
