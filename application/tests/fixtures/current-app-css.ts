import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isImportDeclaration, isStringLiteral } from "typescript/unstable/ast";

// Current component/algorithm fixtures share today's main CSS declarations.
// This does not execute main/App or replace any explicitly frozen CSS oracle.
export function currentAppCSSImports(
  source = readFileSync(resolve("apps/web/src/main.tsx"), "utf8"),
) {
  const file = "/current-css/main.tsx";
  const config = "/current-css/tsconfig.json";
  const api = new API({
    cwd: "/current-css",
    fs: createVirtualFileSystem({
      [file]: source,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: [file],
      }),
    }),
  });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(
      program.getSyntacticDiagnostics(),
      [],
      "current main CSS entry must parse",
    );
    const imports: string[] = [];
    for (const statement of program.getSourceFile(file)!.statements) {
      if (
        !isImportDeclaration(statement) ||
        statement.importClause ||
        !isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.endsWith(".css")
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      assert.ok(
        specifier.startsWith("./") &&
          !specifier
            .slice(2)
            .split("/")
            .some((part) => part === ".."),
        "current bare CSS entry must remain relative to /src: " + specifier,
      );
      // Do not sort or deduplicate: retain the real declaration order.
      imports.push(`import ${JSON.stringify("/src/" + specifier.slice(2))};`);
    }
    return imports.join("\n");
  } finally {
    snapshot?.dispose();
    api.close();
  }
}
