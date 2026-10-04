import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import postcss, { type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isImportDeclaration,
  isExportDeclaration,
  isNamedImports,
  isNamedExports,
  isStringLiteral,
  SyntaxKind,
} from "typescript/unstable/ast";
import { fixedControlRoles } from "./fixtures/control-role-57e7d4ce.js";

// Finite recipes and actual composition. No whole-current-file/source hash,
// Git history, generic selector theorem, or cross-owner inverse chain in CI.
const root = resolve("apps/web/src");
const phases = {
  base: "ui/controls/base.css",
  adaptive: "ui/controls/adaptive.css",
  metrics: "ui/controls/metrics.css",
  surfaces: "ui/controls/surfaces.css",
  browser: "features/browser/browser-controls.css",
} as const;
const selected = [...fixedControlRoles.common, fixedControlRoles.browser];
const normalize = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([,>+~])\s*/g, "$1");
function signature(rule: Rule) {
  const context: string[][] = [];
  for (
    let parent = rule.parent;
    parent?.type !== "root";
    parent = parent?.parent
  ) {
    assert.ok(parent);
    context.unshift(
      parent.type === "atrule"
        ? [parent.name, normalize(parent.params)]
        : ["nested", normalize(parent.selector)],
    );
  }
  return {
    selector: normalize(rule.selector),
    context,
    declarations: rule.nodes
      .filter((node) => node.type === "decl")
      .map((node) => ({
        property: node.prop,
        value: normalize(node.value),
        important: !!node.important,
      })),
    otherNodes: rule.nodes
      .filter((node) => node.type !== "decl" && node.type !== "comment")
      .map((node) => node.type),
  };
}
const fixed = (recipe: (typeof selected)[number]) => ({
  selector: normalize(recipe.selector),
  context: recipe.context.map(([name, params]) => [name, normalize(params)]),
  declarations: recipe.declarations.map(({ property, value, important }) => ({
    property,
    value: normalize(value),
    important,
  })),
  otherNodes: [],
});
function sources() {
  const result = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(css|tsx?)$/.test(file))
        result.set(relative(root, file), readFileSync(file, "utf8"));
    }
  };
  visit(root);
  return result;
}
function imports(text: string, sourceName = "main.tsx") {
  const file =
      "/control/source" + (sourceName.endsWith(".tsx") ? ".tsx" : ".ts"),
    config = "/control/tsconfig.json";
  const api = new API({
    cwd: "/control",
    fs: createVirtualFileSystem({
      [file]: text,
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
      "control-import-parse",
    );
    return program.getSourceFile(file)!.statements.flatMap((statement) => {
      if (!isImportDeclaration(statement) && !isExportDeclaration(statement))
        return [];
      if (
        isImportDeclaration(statement) &&
        (statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword ||
          (statement.importClause?.namedBindings &&
            isNamedImports(statement.importClause.namedBindings) &&
            !statement.importClause.name &&
            statement.importClause.namedBindings.elements.every(
              (item) => item.isTypeOnly,
            )))
      )
        return [];
      if (
        isExportDeclaration(statement) &&
        (statement.isTypeOnly ||
          (statement.exportClause &&
            isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.every((item) => item.isTypeOnly)))
      )
        return [];
      return statement.moduleSpecifier &&
        isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith(".")
        ? [statement.moduleSpecifier.text]
        : [];
    });
  } finally {
    snapshot?.dispose();
    api.close();
  }
}
function validate(all: Map<string, string>) {
  const rows = new Map<string, ReturnType<typeof signature>[]>();
  for (const [file, text] of all)
    if (file.endsWith(".css")) {
      const parsed = postcss.parse(text),
        result: ReturnType<typeof signature>[] = [];
      parsed.walkRules((rule) => {
        result.push(signature(rule));
      });
      rows.set(file, result);
    }
  for (const recipe of selected) {
    const expected = fixed(recipe),
      owner = phases[recipe.phase];
    const actual = rows.get(owner)!;
    assert.equal(
      actual.filter((row) => JSON.stringify(row) === JSON.stringify(expected))
        .length,
      1,
      "control-recipe: " + owner + ":" + recipe.selector,
    );
    for (const [file, values] of rows)
      for (const row of values) {
        if (
          row.selector !== expected.selector ||
          JSON.stringify(row.context) !== JSON.stringify(expected.context)
        )
          continue;
        const sameRecipe = JSON.stringify(row) === JSON.stringify(expected);
        if (file === owner && sameRecipe) continue;
        if (
          file === "workflow.css" &&
          recipe.phase === "browser" &&
          JSON.stringify(row.declarations) ===
            JSON.stringify([
              { property: "width", value: "100%", important: false },
            ])
        )
          continue;
        const collisions = row.declarations.some((declaration) =>
          expected.declarations.some(
            (original) => original.property === declaration.property,
          ),
        );
        assert.ok(
          !collisions ||
            selected.some(
              (other) =>
                other !== recipe &&
                phases[other.phase] === file &&
                JSON.stringify(fixed(other)) === JSON.stringify(row),
            ),
          "control-duplicate: " + file + ":" + row.selector,
        );
      }
  }
  for (const [phase, file] of Object.entries(phases)) {
    const expected = selected
      .filter((recipe) => recipe.phase === phase)
      .map(fixed);
    const known = new Set(expected.map((row) => JSON.stringify(row)));
    assert.deepEqual(
      rows.get(file)!.filter((row) => known.has(JSON.stringify(row))),
      expected,
      "control-phase-order: " + phase,
    );
  }
  const main = imports(all.get("main.tsx")!);
  const exact = [
    "./ui/controls/base.css",
    "./styles.css",
    "./ui/controls/adaptive.css",
    "./features/browser/browser-controls.css",
    "./ui/dialog-frame.css",
    "./ui/controls/metrics.css",
    "./ui.css",
    "./ui/popup-surface.css",
    "./workflow.css",
    "./ui/dialog-surface.css",
    "./ui/controls/surfaces.css",
    "./visual-system.css",
  ];
  const actual = main.filter((name) => exact.includes(name));
  assert.deepEqual(actual, exact, "control-composition-slots");
  const counts = new Map<string, number>(),
    visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const text = all.get(file);
    assert.ok(text !== undefined, "control-runtime-dependency: " + file);
    if (file.endsWith(".css")) {
      postcss.parse(text).walkAtRules("import", (rule) => {
        const match = /^(["'])(.*?)\1/.exec(rule.params);
        if (
          match &&
          Object.values(phases).some(
            (owner) =>
              resolve(root, dirname(file), match[2]!) === resolve(root, owner),
          )
        )
          assert.fail("control-runtime-duplicate");
      });
      return;
    }
    for (const dependency of imports(text, file)) {
      const base = relative(root, resolve(root, dirname(file), dependency));
      const target = [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        base + ".ts",
        base + ".tsx",
      ].find((name) => all.has(name));
      if (!target) continue; // Package/core dependencies are outside this CSS role boundary.
      if (
        Object.values(phases).includes(
          target as (typeof phases)[keyof typeof phases],
        )
      )
        counts.set(target, (counts.get(target) ?? 0) + 1);
      visit(target);
    }
  }
  visit("main.tsx");
  for (const owner of Object.values(phases))
    assert.equal(counts.get(owner), 1, "control-runtime-duplicate: " + owner);
  return counts;
}

test("31 common controls and the complete independent Browser recipe have one real runtime owner", () => {
  assert.equal(fixedControlRoles.common.length, 31);
  assert.equal(
    fixedControlRoles.common.reduce(
      (count, row) => count + row.declarations.length,
      0,
    ),
    85,
  );
  assert.equal(fixedControlRoles.browser.declarations.length, 6);
  validate(sources());
});

test("finite parse-valid recipe, duplicate and actual import regressions are rejected by named rules", () => {
  const original = sources();
  const variants: Array<[string, (all: Map<string, string>) => void]> = [
    [
      "control-recipe",
      (all) =>
        all.set(
          phases.base,
          all.get(phases.base)!.replace("cursor: pointer", "cursor: crosshair"),
        ),
    ],
    [
      "control-recipe",
      (all) =>
        all.set(
          phases.adaptive,
          all
            .get(phases.adaptive)!
            .replace("(pointer: coarse)", "(pointer: fine)"),
        ),
    ],
    [
      "control-recipe",
      (all) =>
        all.set(
          phases.browser,
          all
            .get(phases.browser)!
            .replace("font-size: 12px", "font-size: 16px"),
        ),
    ],
    [
      "control-duplicate",
      (all) =>
        all.set(
          "styles.css",
          all.get("styles.css")! + "\nbutton { cursor: pointer; }\n",
        ),
    ],
    [
      "control-phase-order",
      (all) => {
        const css = postcss.parse(all.get(phases.base)!);
        const rule = css.nodes.find(
          (node) => node.type === "rule" && node.selector === "button",
        )!;
        rule.remove();
        css.append(rule);
        all.set(phases.base, css.toString());
      },
    ],
    [
      "control-composition-slots",
      (all) =>
        all.set(
          "main.tsx",
          all
            .get("main.tsx")!
            .replace('import "./features/browser/browser-controls.css";\n', "")
            .replace(
              'import "./styles.css";',
              'import "./features/browser/browser-controls.css";\nimport "./styles.css";',
            ),
        ),
    ],
    [
      "control-runtime-duplicate",
      (all) =>
        all.set(
          "BrowserHost.tsx",
          'import "./ui/controls/base.css";\n' + all.get("BrowserHost.tsx")!,
        ),
    ],
  ];
  for (const [rule, change] of variants) {
    const all = new Map(original);
    change(all);
    for (const [file, text] of all)
      if (file.endsWith(".css")) assert.doesNotThrow(() => postcss.parse(text));
    assert.throws(
      () => validate(all),
      (error) =>
        error instanceof assert.AssertionError && error.message.includes(rule),
      rule,
    );
  }
});

test("legal independent growth and qualified feature refinements do not lock neighbouring components", () => {
  const all = sources();
  all.set(
    "ui.css",
    all.get("ui.css")! +
      "\n.app .feature-action { padding: 13px; }\n.app .feature-fields input { font-size: 15px; }\n.browser-toolbar.compact input { width: 90%; }\n",
  );
  all.set(
    phases.base,
    all.get(phases.base)! +
      "\n.independent-new-role { display: grid; & .future-child { color: red; } }\n",
  );
  all.set(
    "main.tsx",
    all.get("main.tsx")! + '\n// import "./ui/controls/base.css";\n',
  );
  validate(all);
});
