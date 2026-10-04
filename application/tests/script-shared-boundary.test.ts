import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import * as ts from "typescript/unstable/ast";
import { scriptSharedOriginal as fixed } from "./fixtures/script-shared-e4fdd2ce.js";

// Finite shared primitive/value origins, not a general TS data-flow engine.
// Complete old renderer provenance is a one-time migration proof outside CI.
const paths = {
  Dialog: "../apps/web/src/features/script/StudioDialog.tsx",
  Presentation: "../packages/core/src/script-studio-presentation.ts",
  Studio: "../apps/web/src/ScriptStudio.tsx",
  Editor: "../apps/web/src/ScriptStudioEditor.tsx",
  Navigation: "../apps/web/src/ScriptStudioNavigation.tsx",
};
type Sources = Record<keyof typeof paths, string>;
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(new URL(path, import.meta.url), "utf8"),
  ]),
) as Sources;
const dialogModule = "./features/script/StudioDialog.js";
const presentationModule =
  "../../../packages/core/src/script-studio-presentation.js";
type Origin = { module: string; member: string; typeOnly: boolean };
type Parsed = {
  source: ts.SourceFile;
  ids: Map<ts.Node, number | undefined>;
  imports: Map<number, Origin>;
  aliases: Map<number, number>;
};
function nodes(root: ts.Node) {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    result.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return result;
}
function parse(contents: Record<string, string>): Record<string, Parsed> {
  const cwd = "/script-shared",
    config = cwd + "/tsconfig.json";
  const files = Object.fromEntries(
    Object.entries(contents).map(([key, raw]) => [
      cwd + "/" + key + ".tsx",
      raw,
    ]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: Object.keys(contents).map((key) => key + ".tsx"),
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
      Object.keys(contents).map((key) => {
        const source = project.program.getSourceFile(cwd + "/" + key + ".tsx")!;
        const identifiers = nodes(source).filter(ts.isIdentifier);
        const symbols = project.checker.getSymbolAtLocation(identifiers);
        const ids = new Map<ts.Node, number | undefined>(
          identifiers.map((node, i) => [node, symbols[i]?.id]),
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
          for (const member of clause.namedBindings.elements) {
            const id = ids.get(member.name);
            if (id !== undefined)
              imports.set(id, {
                module: declaration.moduleSpecifier.text,
                member: member.propertyName?.text ?? member.name.text,
                typeOnly:
                  clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
                  member.isTypeOnly,
              });
          }
        }
        for (const declaration of nodes(source).filter(
          ts.isVariableDeclaration,
        )) {
          if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isIdentifier(declaration.initializer)
          )
            continue;
          const statement = declaration.parent.parent;
          const to = ids.get(declaration.name),
            from = ids.get(declaration.initializer);
          if (
            ts.isVariableStatement(statement) &&
            statement.declarationList.flags & ts.NodeFlags.Const &&
            to !== undefined &&
            from !== undefined
          )
            aliases.set(to, from);
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
  const visited = new Set<number>();
  while (id !== undefined && !visited.has(id)) {
    visited.add(id);
    const imported = parsed.imports.get(id);
    if (imported) return imported;
    id = parsed.aliases.get(id);
  }
}
function actual(
  node: ts.Node,
  parsed: Parsed,
  module: string,
  member: string,
  rule: string,
  typeOnly = false,
) {
  assert.deepEqual(origin(node, parsed), { module, member, typeOnly }, rule);
}
function recipe(node: ts.Node, parsed: Parsed): unknown {
  if (ts.isIdentifier(node)) {
    const value = origin(node, parsed);
    return [
      node.kind,
      value
        ? `${value.typeOnly ? "type" : "value"}:${value.module}:${value.member}`
        : node.text,
    ];
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  )
    return [node.kind, node.text];
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(recipe(child, parsed));
  });
  return [node.kind, children.length ? children : node.getText()];
}
function fn(parsed: Parsed, name: string) {
  const found = parsed.source.statements
    .filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === name);
  assert.ok(found?.body, "actual-shared-declaration:" + name);
  return found;
}
function exported(parsed: Parsed, module: string, name: string) {
  return parsed.source.statements
    .filter(ts.isExportDeclaration)
    .some(
      (node) =>
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === module &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some(
          (member) =>
            !member.isTypeOnly &&
            member.name.text === name &&
            (member.propertyName?.text ?? member.name.text) === name,
        ),
    );
}
const expected = parse({
  Dialog:
    'import {useRef,type ReactNode} from "react";import {X} from "lucide-react";import {useModal} from "../../useModal.js";\n' +
    fixed.dialog.raw,
  Labels: fixed.labels.raw,
});
function validate(values: Sources) {
  const parsed = parse(values),
    dialog = parsed.Dialog!,
    presentation = parsed.Presentation!;
  const component = fn(dialog, "StudioDialog");
  assert.ok(
    !component.asteriskToken &&
      !component.modifiers?.some(
        (node) => node.kind === ts.SyntaxKind.AsyncKeyword,
      ),
    "synchronous-studio-dialog",
  );
  for (const [name, module, typeOnly] of [
    ["useRef", "react", false],
    ["useModal", "../../useModal.js", false],
    ["X", "lucide-react", false],
    ["ReactNode", "react", true],
  ] as const) {
    const uses = nodes(component)
      .filter(ts.isIdentifier)
      .filter(
        (node) => origin(node, dialog)?.member === name || node.text === name,
      );
    assert.ok(uses.length, "actual-dialog-value:" + name);
    for (const use of uses)
      actual(
        use,
        dialog,
        module,
        name,
        "actual-dialog-value:" + name,
        typeOnly,
      );
  }
  assert.deepEqual(
    recipe(component, dialog),
    recipe(fn(expected.Dialog!, "StudioDialog"), expected.Dialog!),
    "original-studio-dialog-recipe",
  );
  const labelDeclarations = nodes(presentation.source)
    .filter(ts.isVariableDeclaration)
    .filter((node) => node.name.getText() === "scriptStatusLabels");
  assert.equal(labelDeclarations.length, 1, "single-four-state-owner");
  const label = labelDeclarations[0];
  const oldLabel = nodes(expected.Labels!.source)
    .filter(ts.isVariableDeclaration)
    .find((node) => node.name.getText() === "scriptStatusLabels");
  assert.ok(
    label?.initializer && oldLabel?.initializer,
    "single-four-state-owner",
  );
  const labelStatement = label.parent.parent;
  assert.ok(
    ts.isVariableStatement(labelStatement) &&
      labelStatement.parent === presentation.source &&
      labelStatement.declarationList.flags & ts.NodeFlags.Const &&
      labelStatement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) &&
      ts.isObjectLiteralExpression(label.initializer),
    "exported-constant-four-state-owner",
  );
  assert.deepEqual(
    recipe(label.initializer, presentation),
    recipe(oldLabel.initializer, expected.Labels!),
    "original-four-script-state-values",
  );
  assert.ok(
    exported(parsed.Studio!, dialogModule, "StudioDialog"),
    "same-binding-dialog-compatibility-export",
  );
  assert.ok(
    exported(parsed.Studio!, presentationModule, "scriptStatusLabels"),
    "same-binding-label-compatibility-export",
  );
  assert.ok(
    !parsed.Studio!.source.statements.some(
      (node) =>
        ts.isFunctionDeclaration(node) && node.name?.text === "StudioDialog",
    ),
    "single-studio-dialog-owner",
  );
  for (const [key, names] of [
    ["Studio", ["scriptStatusLabels"]],
    ["Navigation", ["statuses"]],
  ] as const)
    assert.ok(
      !nodes(parsed[key]!.source).some(
        (node) =>
          ts.isVariableDeclaration(node) &&
          names.some((name) => node.name.getText() === name),
      ),
      "single-four-state-owner",
    );
  for (const declaration of parsed.Editor!.source.statements.filter(
    ts.isImportDeclaration,
  )) {
    if (
      !ts.isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== "./ScriptStudio.js"
    )
      continue;
    const clause = declaration.importClause;
    assert.ok(
      clause?.namedBindings && ts.isNamedImports(clause.namedBindings),
      "editor-parent-types-only",
    );
    assert.ok(
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        clause.namedBindings.elements.every((member) => member.isTypeOnly),
      "editor-parent-types-only",
    );
  }
  for (const consumer of fixed.consumers) {
    const current = parsed[consumer.source]!,
      body = fn(current, consumer.name).body!;
    const opening = nodes(body)
      .filter(ts.isJsxOpeningElement)
      .find((node) =>
        node.attributes.properties.some(
          (property) =>
            ts.isJsxAttribute(property) &&
            property.name.getText() === "onClose",
        ),
      );
    assert.ok(opening, "actual-original-dialog-consumer:" + consumer.name);
    actual(
      opening.tagName,
      current,
      dialogModule,
      "StudioDialog",
      "actual-dialog-consumer-origin:" + consumer.name,
    );
    const baseline = parse({
      Header:
        'import {StudioDialog} from "./features/script/StudioDialog.js";import {scriptCreateLabels} from "./ScriptStudioNavigation.js";function Header(){return (' +
        consumer.raw +
        "</StudioDialog>);}",
    }).Header!;
    const oldOpening = nodes(baseline.source).find(ts.isJsxOpeningElement)!;
    assert.deepEqual(
      recipe(opening, current),
      recipe(oldOpening, baseline),
      "original-dialog-consumer-props:" + consumer.name,
    );
  }
  for (const [key, name, value, count] of [
    ["Studio", "ScriptStudio", "value.status", 1],
    ["Editor", "ScriptItemEditorView", "item.status", 2],
    ["Navigation", "ScriptStudioNavigation", "item.status", 1],
  ] as const) {
    const current = parsed[key]!;
    const reads = nodes(fn(current, name).body!)
      .filter(ts.isElementAccessExpression)
      .filter((node) => node.argumentExpression.getText() === value);
    assert.equal(reads.length, count, "original-status-consumer-sites:" + key);
    for (const read of reads)
      actual(
        read.expression,
        current,
        presentationModule,
        "scriptStatusLabels",
        "actual-script-status-origin:" + key,
      );
  }
}
function changed(raw: string, from: string, to: string) {
  assert.ok(raw.includes(from), "exact-counterfactual-target");
  return raw.replace(from, to);
}
function reject(key: keyof Sources, from: string, to: string, rule: string) {
  assert.throws(
    () => validate({ ...sources, [key]: changed(sources[key], from, to) }),
    (error) =>
      error instanceof assert.AssertionError && error.message.includes(rule),
  );
}
test("small independent Git archive retains full dialog and both four-state declarations", () => {
  assert.equal(fixed.git, "e4fdd2cec1358b513216f05f6061d0986f1dab44");
  for (const entry of [fixed.dialog, fixed.labels, fixed.navigationLabels])
    assert.equal(
      createHash("sha256").update(entry.raw).digest("hex"),
      entry.sha256,
    );
  assert.equal(fixed.consumers.length, 7);
});
test("actual shared dialog and vocabulary retain seven direct consumers and compatibility bindings", () =>
  validate(sources));
test("wrong nominal actual origins and runtime parent back-imports are rejected", () => {
  reject(
    "Dialog",
    'from "../../useModal.js"',
    'from "./foreign.js"',
    "actual-dialog-value:useModal",
  );
  reject(
    "Dialog",
    "import { useRef, type ReactNode }",
    "import type { useRef, ReactNode }",
    "actual-dialog-value:useRef",
  );
  reject(
    "Editor",
    'from "./features/script/StudioDialog.js"',
    'from "./foreign.js"',
    "actual-dialog-consumer-origin:NoteDialog",
  );
  reject(
    "Navigation",
    'from "../../../packages/core/src/script-studio-presentation.js"',
    'from "./foreign.js"',
    "actual-script-status-origin:Navigation",
  );
  reject(
    "Editor",
    "import type { ScriptRun, ScriptComposeResult }",
    "import { ScriptRun, ScriptComposeResult }",
    "editor-parent-types-only",
  );
  reject(
    "Studio",
    'export { StudioDialog } from "./features/script/StudioDialog.js";',
    'export { StudioDialog } from "./foreign.js";',
    "same-binding-dialog-compatibility-export",
  );
  reject(
    "Studio",
    'export { scriptStatusLabels } from "../../../packages/core/src/script-studio-presentation.js";',
    'export { scriptStatusLabels } from "./foreign.js";',
    "same-binding-label-compatibility-export",
  );
  reject(
    "Studio",
    "export { StudioDialog }",
    "export type { StudioDialog }",
    "same-binding-dialog-compatibility-export",
  );
  reject(
    "Studio",
    "export { StudioDialog }",
    "export { type StudioDialog }",
    "same-binding-dialog-compatibility-export",
  );
  reject(
    "Studio",
    "export { scriptStatusLabels }",
    "export type { scriptStatusLabels }",
    "same-binding-label-compatibility-export",
  );
  reject(
    "Studio",
    "export { scriptStatusLabels }",
    "export { type scriptStatusLabels }",
    "same-binding-label-compatibility-export",
  );
  const foreign =
    sources.Editor.replace(
      "import { StudioDialog }",
      "import { StudioDialog as unusedCorrectDialog }",
    )
      .replace(/<StudioDialog\b/g, "<ForeignDialog")
      .replace(/<\/StudioDialog>/g, "</ForeignDialog>") +
    '\nimport {StudioDialog as ForeignDialog} from "./foreign.js";';
  assert.throws(
    () => validate({ ...sources, Editor: foreign }),
    /actual-dialog-consumer-origin:NoteDialog/,
  );
});
test("modal recipe, original props and exact four-state meanings cannot drift", () => {
  reject(
    "Dialog",
    "  useModal(dialog);",
    "  if (compact) useModal(dialog);",
    "original-studio-dialog-recipe",
  );
  reject(
    "Dialog",
    "      ref={dialog}",
    "      ref={{current:dialog.current}}",
    "original-studio-dialog-recipe",
  );
  reject(
    "Dialog",
    "        e.preventDefault();\n        onClose();",
    "        onClose();\n        e.preventDefault();",
    "original-studio-dialog-recipe",
  );
  reject(
    "Dialog",
    "      {children}",
    "      <section>{children}</section>",
    "original-studio-dialog-recipe",
  );
  reject(
    "Dialog",
    "export function StudioDialog",
    "export async function StudioDialog",
    "synchronous-studio-dialog",
  );
  reject(
    "Studio",
    '<StudioDialog title="导出 Word" onClose={onClose}>',
    '<StudioDialog title="导出 Word" onClose={() => onClose()}>',
    "original-dialog-consumer-props:ExportDialog",
  );
  reject(
    "Presentation",
    '  locked: "已锁稿",',
    '  locked: "已完成",',
    "original-four-script-state-values",
  );
  reject(
    "Presentation",
    "export const scriptStatusLabels =",
    "export let scriptStatusLabels =",
    "exported-constant-four-state-owner",
  );
  reject(
    "Presentation",
    "export const scriptStatusLabels =",
    "const scriptStatusLabels =",
    "exported-constant-four-state-owner",
  );
});
test("actual import and const aliases plus unrelated consumed React growth remain legal", () => {
  const dialog =
    sources.Dialog.replace(
      "import { useRef, type ReactNode }",
      "import { useRef as ref, type ReactNode as Child }",
    )
      .replace("import { useModal }", "import { useModal as modalHook }")
      .replace(/\bReactNode\b(?=;)/g, "Child")
      .replace("useRef<HTMLDialogElement>", "ref<HTMLDialogElement>")
      .replace("  useModal(dialog);", "  modal(dialog);") +
    "\nconst modal=modalHook;\nexport const version=1;\n";
  const editor =
    sources.Editor.replace(
      "import { StudioDialog }",
      "import { StudioDialog as Shared }",
    )
      .replace(/<StudioDialog\b/g, "<DialogAlias")
      .replace(/<\/StudioDialog>/g, "</DialogAlias>") +
    "\nconst DialogAlias=Shared;\n";
  const navigation =
    sources.Navigation.replace(
      "scriptStatusLabels as statuses",
      "scriptStatusLabels as statusFacts",
    ).replace("statuses[item.status]", "labels[item.status]") +
    "\nconst labels=statusFacts;\n";
  const studio =
    sources.Studio +
    "\nexport function ExtraFeature(){const [value]=useState(0);return <aside>{value}</aside>;}\nexport const extraConsumer=<ExtraFeature/>;\n";
  validate({
    ...sources,
    Dialog: dialog,
    Editor: editor,
    Navigation: navigation,
    Studio: studio,
    Presentation:
      sources.Presentation +
      "\nexport const extraPure=(value:number)=>value+1;\n",
  });
});
