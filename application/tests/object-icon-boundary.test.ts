import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import { objectIconOriginal as fixed } from "./fixtures/object-icon-f937e4b0.js";

// Finite pure primitive and seven real source consumers, not mounted execution
// or a general AST framework. Whole-page migration evidence lives outside CI.
const paths = {
  Icon: "../apps/web/src/ui/ObjectIcon.tsx",
  ArtifactEditor: "../apps/web/src/ArtifactEditor.tsx",
  ApplicationHost: "../apps/web/src/ApplicationHost.tsx",
  Conversation: "../apps/web/src/Conversation.tsx",
  ObjectCollection: "../apps/web/src/ObjectCollection.tsx",
  LibraryDialogs: "../apps/web/src/LibraryDialogs.tsx",
};
type Sources = Record<keyof typeof paths, string>;
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const shared = "./ui/ObjectIcon.js";
type Origin = { module: string; member: string; typeOnly: boolean };
type Parsed = {
  source: ts.SourceFile;
  ids: Map<ts.Node, number | undefined>;
  imports: Map<number, Origin>;
  aliases: Map<number, number>;
};
function nodes(root: ts.Node) {
  const found: ts.Node[] = [];
  const walk = (node: ts.Node) => {
    found.push(node);
    node.forEachChild(walk);
  };
  walk(root);
  return found;
}
function parse(raw: Record<string, string>): Record<string, Parsed> {
  const cwd = "/object-icon",
    config = cwd + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      cwd + "/" + key + ".tsx",
      value,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(raw).map((key) => key + ".tsx"),
  });
  const api = new API({ cwd, fs: createVirtualFileSystem(files) });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config)!;
    assert.deepEqual(
      project.program.getSyntacticDiagnostics(),
      [],
      "parse-valid-counterfactual",
    );
    return Object.fromEntries(
      Object.keys(raw).map((key) => {
        const source = project.program.getSourceFile(cwd + "/" + key + ".tsx")!;
        const identifiers = nodes(source).filter(ts.isIdentifier),
          symbols = project.checker.getSymbolAtLocation(identifiers);
        const ids = new Map<ts.Node, number | undefined>(
          identifiers.map((node, index) => [node, symbols[index]?.id]),
        );
        const imports = new Map<number, Origin>(),
          aliases = new Map<number, number>();
        for (const declaration of source.statements.filter(
          ts.isImportDeclaration,
        )) {
          const clause = declaration.importClause;
          if (
            !clause?.namedBindings ||
            !ts.isNamedImports(clause.namedBindings) ||
            !ts.isStringLiteral(declaration.moduleSpecifier)
          )
            continue;
          for (const binding of clause.namedBindings.elements) {
            const id = ids.get(binding.name);
            if (id !== undefined)
              imports.set(id, {
                module: declaration.moduleSpecifier.text,
                member: binding.propertyName?.text ?? binding.name.text,
                typeOnly:
                  clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
                  binding.isTypeOnly,
              });
          }
        }
        for (const declaration of nodes(source).filter(
          ts.isVariableDeclaration,
        )) {
          const statement = declaration.parent.parent;
          if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isIdentifier(declaration.initializer) ||
            !ts.isVariableStatement(statement) ||
            !(statement.declarationList.flags & ts.NodeFlags.Const)
          )
            continue;
          const to = ids.get(declaration.name),
            from = ids.get(declaration.initializer);
          if (to !== undefined && from !== undefined) aliases.set(to, from);
        }
        return [key, { source, ids, imports, aliases } satisfies Parsed];
      }),
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
}
function origin(node: ts.Node, parsed: Parsed): Origin | undefined {
  let id = parsed.ids.get(node);
  const seen = new Set<number>();
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const value = parsed.imports.get(id);
    if (value) return value;
    id = parsed.aliases.get(id);
  }
}
const roles = new Set([
  "ObjectIcon",
  "kindLabel",
  "Content",
  "Artifact",
  "FileText",
  "BookOpen",
  "Image",
  "CircleCheck",
  "Globe",
  "Table2",
  "Film",
  "Clapperboard",
  "FilePlus2",
]);
function recipe(node: ts.Node, parsed: Parsed, locate = false): unknown {
  if (ts.isParenthesizedExpression(node))
    return recipe(node.expression, parsed, locate);
  if (ts.isIdentifier(node)) {
    const imported = origin(node, parsed);
    return [
      node.kind,
      imported && roles.has(imported.member)
        ? locate
          ? imported.member
          : imported
        : node.text,
    ];
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  )
    return [node.kind, node.text];
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(recipe(child, parsed, locate));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function fn(parsed: Parsed, name: string) {
  const node = parsed.source.statements
    .filter(ts.isFunctionDeclaration)
    .find((value) => value.name?.text === name);
  assert.ok(node?.body, "actual-consumer-function:" + name);
  return node;
}
function plainExport(node: ts.FunctionDeclaration | ts.VariableStatement) {
  return (
    node.modifiers?.length === 1 &&
    node.modifiers[0]?.kind === ts.SyntaxKind.ExportKeyword
  );
}
function unparen(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;
}
function expression(parsed: Parsed, name: string) {
  const node = nodes(parsed.source)
    .filter(ts.isVariableDeclaration)
    .find((value) => ts.isIdentifier(value.name) && value.name.text === name);
  assert.ok(node?.initializer);
  return unparen(node.initializer);
}
const pageNames = Object.keys(fixed.icons) as (keyof typeof fixed.icons)[];
const expected = parse({
  Icon:
    'import {FileText,BookOpen,Image,CircleCheck,Globe,Table2} from "lucide-react";import type {Content} from "../../../../packages/core/src/model.js";\n' +
    fixed.declarations.kindLabel +
    "\n" +
    fixed.declarations.ObjectIcon,
  ...Object.fromEntries(
    pageNames.map((key) => [
      key,
      'import {ObjectIcon,kindLabel} from "./ui/ObjectIcon.js";import {Film,Clapperboard,FilePlus2} from "lucide-react";import type {Artifact} from "../../../packages/core/src/model.js";\n' +
        fixed.icons[key]
          .map((value, i) => `const icon${i}=(${value});`)
          .join("\n") +
        "\n" +
        fixed.contexts[key]
          .map(
            (context, i) =>
              ("branch" in context
                ? `const branch${i}=(${context.branch});`
                : "") +
              context.conditions
                .map((value, j) => `const condition${i}_${j}=(${value});`)
                .join("\n") +
              context.maps
                .map((value, j) => `const map${i}_${j}=(${value});`)
                .join("\n"),
          )
          .join("\n") +
        "\n" +
        fixed.labelRecipes[key]
          .map((value, i) => `const label${i}=(${value});`)
          .join("\n") +
        "\n" +
        fixed.labelContexts[key]
          .map(
            (context, i) =>
              context.conditions
                .map((value, j) => `const labelCondition${i}_${j}=(${value});`)
                .join("\n") +
              context.maps
                .map((value, j) => `const labelMap${i}_${j}=(${value});`)
                .join("\n"),
          )
          .join("\n") +
        "\n" +
        (key === "ObjectCollection" ? `const ${fixed.knownKind};` : ""),
    ]),
  ),
});
function context(node: ts.Node) {
  let branch: ts.Node | undefined,
    localBranch = true,
    parent = node.parent;
  const conditions: ts.Node[] = [],
    maps: ts.Node[] = [];
  while (parent && !ts.isFunctionDeclaration(parent)) {
    if (ts.isConditionalExpression(parent) && localBranch) branch = parent;
    if (ts.isJsxExpression(parent)) localBranch = false;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right.pos <= node.pos &&
      parent.right.end >= node.end
    )
      conditions.push(parent.left);
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === "map"
    )
      maps.push(parent.expression);
    parent = parent.parent;
  }
  return { branch, conditions, maps };
}
function labelRecipe(node: ts.Node) {
  let value = node;
  while (
    value.parent &&
    (ts.isConditionalExpression(value.parent) ||
      ts.isBinaryExpression(value.parent) ||
      ts.isParenthesizedExpression(value.parent))
  )
    value = value.parent;
  return value;
}
function validate(values: Sources) {
  const parsed = parse(values),
    icon = parsed.Icon!,
    oldIcon = expected.Icon!;
  const component = fn(icon, "ObjectIcon");
  assert.ok(
    plainExport(component) && !component.asteriskToken,
    "plain-exported-object-icon",
  );
  assert.deepEqual(
    recipe(component, icon),
    recipe(fn(oldIcon, "ObjectIcon"), oldIcon),
    "complete-original-object-icon",
  );
  const table = icon.source.statements
    .filter(ts.isVariableStatement)
    .find((node) =>
      node.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && d.name.text === "kindLabel",
      ),
    );
  assert.ok(
    table &&
      plainExport(table) &&
      table.declarationList.flags & ts.NodeFlags.Const &&
      table.declarationList.declarations.length === 1,
    "plain-export-const-kind-label",
  );
  const oldTable = oldIcon.source.statements.find(ts.isVariableStatement)!;
  assert.deepEqual(
    recipe(table, icon),
    recipe(oldTable, oldIcon),
    "complete-original-kind-label",
  );
  for (const key of pageNames) {
    const page = parsed[key]!,
      old = expected[key]!;
    const body = fn(page, key === "LibraryDialogs" ? "SearchDocuments" : key);
    const jsx = nodes(body).filter(ts.isJsxSelfClosingElement);
    fixed.icons[key].forEach((_, i) => {
      const original = expression(old, "icon" + i);
      assert.ok(ts.isJsxSelfClosingElement(original));
      // Nominal attributes locate the existing site only. Acceptance below
      // still requires its actual module/value symbol and complete recipe.
      const props = recipe(original.attributes, old, true);
      const candidates = jsx.filter(
        (node) =>
          JSON.stringify(recipe(node.attributes, page, true)) ===
          JSON.stringify(props),
      );
      assert.equal(
        candidates.length,
        1,
        "original-kind-prop-consumer:" + key + ":" + i,
      );
      const actual = candidates[0]!;
      assert.deepEqual(
        origin(actual.tagName, page),
        { module: shared, member: "ObjectIcon", typeOnly: false },
        "actual-object-icon-origin:" + key + ":" + i,
      );
      assert.deepEqual(
        recipe(actual, page),
        recipe(original, old),
        "complete-original-icon-consumer:" + key + ":" + i,
      );
      const actualContext = context(actual),
        archived = fixed.contexts[key][i]!;
      if ("branch" in archived) {
        assert.ok(
          actualContext.branch,
          "original-icon-branch:" + key + ":" + i,
        );
        assert.deepEqual(
          recipe(actualContext.branch, page),
          recipe(expression(old, "branch" + i), old),
          "original-icon-branch:" + key + ":" + i,
        );
      }
      assert.deepEqual(
        actualContext.conditions.map((node) => recipe(node, page)),
        archived.conditions.map((_, j) =>
          recipe(expression(old, `condition${i}_${j}`), old),
        ),
        "original-icon-presence:" + key + ":" + i,
      );
      assert.deepEqual(
        actualContext.maps.map((node) => recipe(node, page)),
        archived.maps.map((_, j) =>
          recipe(expression(old, `map${i}_${j}`), old),
        ),
        "original-icon-map-scope:" + key + ":" + i,
      );
    });
    const labels = nodes(body).filter(ts.isElementAccessExpression);
    const usedLabels = new Set<ts.ElementAccessExpression>();
    fixed.labels[key].forEach((_, i) => {
      const oldExpression = expression(old, "label" + i);
      const original = nodes(oldExpression)
        .filter(ts.isElementAccessExpression)
        .find((node) => origin(node.expression, old)?.member === "kindLabel")!;
      const index = recipe(original.argumentExpression, old);
      const candidates = labels.filter(
        (node) =>
          JSON.stringify(recipe(node.argumentExpression, page)) ===
          JSON.stringify(index),
      );
      const actual = candidates.find(
        (node) =>
          !usedLabels.has(node) &&
          (node.expression.getText().includes("kindLabel") ||
            origin(node.expression, page)?.member === "kindLabel"),
      );
      assert.ok(actual, "actual-kind-label-consumer:" + key + ":" + i);
      usedLabels.add(actual);
      assert.deepEqual(
        origin(actual.expression, page),
        { module: shared, member: "kindLabel", typeOnly: false },
        "actual-kind-label-origin:" + key + ":" + i,
      );
      assert.deepEqual(
        recipe(labelRecipe(actual), page),
        recipe(oldExpression, old),
        "original-kind-label-fallback:" + key + ":" + i,
      );
      const actualContext = context(actual),
        archivedContext = fixed.labelContexts[key][i]!;
      assert.deepEqual(
        actualContext.conditions.map((node) => recipe(node, page)),
        archivedContext.conditions.map((_, j) =>
          recipe(expression(old, `labelCondition${i}_${j}`), old),
        ),
        "original-kind-label-presence:" + key + ":" + i,
      );
      assert.deepEqual(
        actualContext.maps.map((node) => recipe(node, page)),
        archivedContext.maps.map((_, j) =>
          recipe(expression(old, `labelMap${i}_${j}`), old),
        ),
        "original-kind-label-map-scope:" + key + ":" + i,
      );
    });
  }
  const collection = parsed.ObjectCollection!;
  const known = nodes(fn(collection, "ObjectCollection"))
    .filter(ts.isVariableDeclaration)
    .find(
      (node) => ts.isIdentifier(node.name) && node.name.text === "knownKind",
    );
  assert.ok(known?.initializer, "original-known-kind");
  assert.deepEqual(
    recipe(known.initializer, collection),
    recipe(
      expression(expected.ObjectCollection!, "knownKind"),
      expected.ObjectCollection!,
    ),
    "original-known-kind",
  );
  for (const name of ["ObjectIcon", "kindLabel"]) {
    const compatibility = parsed
      .ArtifactEditor!.source.statements.filter(ts.isExportDeclaration)
      .some(
        (node) =>
          !node.isTypeOnly &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === shared &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some(
            (member) =>
              !member.isTypeOnly &&
              member.name.text === name &&
              (member.propertyName?.text ?? member.name.text) === name,
          ),
      );
    assert.ok(compatibility, "same-binding-value-compatibility:" + name);
  }
}
function changed(key: keyof Sources, before: string, after: string): Sources {
  assert.ok(sources[key].includes(before), "specific counterfactual target");
  return { ...sources, [key]: sources[key].replace(before, after) };
}
function rejected(value: Sources, rule: string) {
  assert.throws(
    () => validate(value),
    (error) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
  );
}
test("actual Git pure archive and current seven actual source consumers", () => {
  assert.equal(fixed.git, "f937e4b03aa3fb82d75570d6dffcd4f41fda4f0e");
  assert.equal(
    createHash("sha256").update(fixed.declarations.kindLabel).digest("hex"),
    "bb06582cce6fc1b07512a1cf4d975fd1c913b7e72f39527b744f841ed1c39c2c",
  );
  assert.equal(
    createHash("sha256").update(fixed.declarations.ObjectIcon).digest("hex"),
    "f584ba186a5d8295a69f2779a030805f00d93ef366bb21c8d3365da4702a6042",
  );
  validate(sources);
});
test("rejects changed complete primitive and table meanings", () => {
  rejected(
    changed("Icon", "size={16}", "size={18}"),
    "complete-original-object-icon",
  );
  rejected(
    changed("Icon", "task: CircleCheck", "task: FileText"),
    "complete-original-object-icon",
  );
  rejected(
    changed("Icon", 'task: "事项"', 'task: "任务"'),
    "complete-original-kind-label",
  );
  rejected(
    changed("Icon", "}[kind];", "}[kind] ?? FileText;"),
    "complete-original-object-icon",
  );
  rejected(
    changed("Icon", "export const kindLabel", "export let kindLabel"),
    "plain-export-const-kind-label",
  );
  rejected(
    changed("Icon", "export const kindLabel", "const kindLabel"),
    "plain-export-const-kind-label",
  );
  rejected(
    changed(
      "Icon",
      "export function ObjectIcon",
      "export async function ObjectIcon",
    ),
    "plain-exported-object-icon",
  );
  rejected(
    changed(
      "Icon",
      "export function ObjectIcon",
      "export function* ObjectIcon",
    ),
    "plain-exported-object-icon",
  );
  rejected(
    changed("Icon", 'from "lucide-react"', 'from "./foreign.js"'),
    "complete-original-object-icon",
  );
  rejected(
    changed(
      "Icon",
      'from "../../../../packages/core/src/model.js"',
      'from "./foreign.js"',
    ),
    "complete-original-object-icon",
  );
  rejected(
    changed(
      "Icon",
      'import type { Content } from "../../../../packages/core/src/model.js";',
      'import type { Content as UnusedContent } from "../../../../packages/core/src/model.js"; type Content = {kind:"document"};',
    ),
    "complete-original-object-icon",
  );
  rejected(
    changed(
      "Icon",
      "return <Icon size={16} />;",
      "return <span><Icon size={16} /></span>;",
    ),
    "complete-original-object-icon",
  );
});
test("rejects actual foreign or type-only consumers even with unused correct imports", () => {
  rejected(
    changed(
      "LibraryDialogs",
      'import { ObjectIcon } from "./ui/ObjectIcon.js";',
      'import { ObjectIcon as unusedCorrect } from "./ui/ObjectIcon.js"; import { ObjectIcon } from "./foreign.js";',
    ),
    "actual-object-icon-origin:LibraryDialogs:0",
  );
  rejected(
    changed(
      "ArtifactEditor",
      'import { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
      'import type { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
    ),
    "actual-object-icon-origin:ArtifactEditor:0",
  );
  rejected(
    changed(
      "ObjectCollection",
      'import { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
      'import { ObjectIcon, kindLabel as unusedCorrect } from "./ui/ObjectIcon.js"; import { kindLabel } from "./foreign.js";',
    ),
    "actual-kind-label-origin:ObjectCollection:0",
  );
  rejected(
    changed(
      "ArtifactEditor",
      'import { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
      'import { ObjectIcon, type kindLabel } from "./ui/ObjectIcon.js";',
    ),
    "actual-kind-label-origin:ArtifactEditor:0",
  );
  rejected(
    changed(
      "ArtifactEditor",
      'export { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
      'export type { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
    ),
    "same-binding-value-compatibility:ObjectIcon",
  );
  rejected(
    changed(
      "ArtifactEditor",
      'export { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
      'export { type ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
    ),
    "same-binding-value-compatibility:ObjectIcon",
  );
  rejected(
    changed(
      "ArtifactEditor",
      'export { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";',
      'export { ObjectIcon, kindLabel } from "./foreign.js";',
    ),
    "same-binding-value-compatibility:ObjectIcon",
  );
});
test("rejects caller presence, known-kind, script and fallback drift", () => {
  rejected(
    changed(
      "ArtifactEditor",
      'artifact.content.kind !== "task" && !isPdf && (',
      'artifact.content.kind !== "task" && (',
    ),
    "original-kind-label-presence:ArtifactEditor:0",
  );
  rejected(
    changed("Conversation", "(artifact || catalogEntry) && (", "artifact && ("),
    "original-icon-presence:Conversation:0",
  );
  rejected(
    changed("ObjectCollection", "kind in kindLabel", 'kind === "document"'),
    "original-known-kind",
  );
  rejected(
    changed(
      "ObjectCollection",
      "                      ) : (\n                        <FilePlus2 />",
      "                      ) : (\n                        <FileText />",
    ),
    "original-icon-branch:ObjectCollection:0",
  );
  rejected(
    changed("ApplicationHost", "<Film />", "<FileText />"),
    "original-icon-branch:ApplicationHost:0",
  );
  rejected(
    changed("ApplicationHost", '?? "内容"', '?? "文档"'),
    "original-kind-label-fallback:ApplicationHost:0",
  );
  rejected(
    changed(
      "ApplicationHost",
      '                                ] ?? "内容")',
      '                                ] ?? "文档")',
    ),
    "original-kind-label-fallback:ApplicationHost:1",
  );
  rejected(
    changed("LibraryDialogs", "!query.trim() &&", "query.trim() &&"),
    "original-icon-presence:LibraryDialogs:0",
  );
});
test("permits genuinely consumed import, type and constant aliases and unrelated React growth", () => {
  let icon = sources.Icon.replaceAll("FileText", "TextGlyph")
    .replace("TextGlyph,", "FileText as TextGlyph,")
    .replaceAll("Content", "ObjectContent")
    .replace("{ ObjectContent }", "{ Content as ObjectContent }");
  validate({ ...sources, Icon: icon });
  let library = sources.LibraryDialogs.replaceAll(
    "ObjectIcon",
    "ContentGlyph",
  ).replace(
    'import { ContentGlyph } from "./ui/ContentGlyph.js";',
    'import { ObjectIcon as ImportedGlyph } from "./ui/ObjectIcon.js"; const ContentGlyph = ImportedGlyph;',
  );
  validate({ ...sources, LibraryDialogs: library });
  const collection = sources.ObjectCollection.replaceAll(
    "kindLabel",
    "Labels",
  ).replace(
    'import { ObjectIcon, Labels } from "./ui/ObjectIcon.js";',
    'import { ObjectIcon, kindLabel as ImportedLabels } from "./ui/ObjectIcon.js"; const Labels = ImportedLabels;',
  );
  validate({ ...sources, ObjectCollection: collection });
  validate({
    ...sources,
    Icon:
      sources.Icon +
      "\nexport function Independent({text}:{text:string}){return <span>{text}</span>}\n",
    ArtifactEditor:
      sources.ArtifactEditor +
      "\nfunction Independent(){return <span>合法独立组件</span>} export function IndependentConsumer(){return <Independent/>}\n",
  });
});
