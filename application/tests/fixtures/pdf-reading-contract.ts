// Bounded current PDF ownership/physical-phase contract. No CI Git, whole-file
// lock or peer inverse.
import assert from "node:assert/strict";
import { posix } from "node:path";
import postcss, { type Rule } from "postcss";
import {
  isImportDeclaration,
  isExportDeclaration,
  isNamedImports,
  isNamedExports,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  SyntaxKind,
  type Node,
  type SourceFile,
  type Identifier,
} from "typescript/unstable/ast";
import {
  fixedPdfReadingRole,
  fixedPdfPrimitiveRefinements,
} from "./pdf-reading-c93283db.js";

export const pdfReadingCarriers = fixedPdfReadingRole.carriers;
export type PdfSources = Readonly<{
  css: ReadonlyMap<string, string>;
  modules: ReadonlyMap<string, string>;
}>;
export type PdfModule = Readonly<{ file: string; source: SourceFile }>;
const norm = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>,])\s*/g, "$1");
const value = (text: string) => text.trim().replace(/\s+/g, " ");
const carriers = Object.values(pdfReadingCarriers) as readonly string[];
const roots = new Set([
  "pdf-reader",
  "pdf-controls",
  "pdf-page",
  "pdf-text-layer",
  "pdf-extracted",
  "pdf-paper",
  "pdf-toolbar-slot",
  "pdf-file-info",
]);
const properties = new Set<string>(
  fixedPdfReadingRole.recipes.flatMap((recipe) =>
    recipe.declarations.map((declaration) => declaration.property),
  ),
);
function guarded(check: () => void, rule: string, errors: string[]) {
  try {
    check();
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    errors.push(rule);
  }
}
function context(rule: Rule) {
  const result: string[][] = [];
  for (
    let parent = rule.parent;
    parent?.type !== "root";
    parent = parent?.parent
  ) {
    assert.ok(parent);
    if (parent.type === "atrule")
      result.unshift([parent.name, value(parent.params)]);
    else {
      assert.equal(parent.type, "rule");
      result.unshift(["nested", norm((parent as Rule).selector)]);
    }
  }
  return result;
}
function signature(rule: Rule) {
  return {
    selector: norm(rule.selector),
    context: context(rule),
    declarations: rule.nodes
      .filter((node) => node.type !== "comment")
      .map((node) =>
        node.type === "decl"
          ? {
              property: node.prop,
              value: value(node.value),
              important: !!node.important,
            }
          : { unexpected: node.type },
      ),
  };
}
const expected = (recipe: (typeof fixedPdfReadingRole.recipes)[number]) => ({
  selector: norm(recipe.selector),
  context: recipe.context,
  declarations: recipe.declarations.map((declaration) => ({
    ...declaration,
    value: value(declaration.value),
  })),
});

// Only the terminal compound is the styled subject. An OCR :has(pdf-page)
// predicate or an independent child is not a direct PDF writer.
function terminal(selector: string) {
  let depth = 0,
    bracket = 0,
    quote = "",
    at = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) {
      if (ch === quote && selector[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    else if (depth === 0 && bracket === 0 && /[\s>+~]/.test(ch)) at = i + 1;
  }
  return selector.slice(at);
}
function withoutPredicates(selector: string) {
  let result = selector;
  for (;;) {
    const match = /:(?:has|not)\(/.exec(result);
    if (!match) return result;
    let depth = 1,
      quote = "",
      end = match.index + match[0].length;
    for (; end < result.length && depth; end++) {
      const char = result[end]!;
      if (quote) {
        if (char === quote && result[end - 1] !== "\\") quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    assert.equal(depth, 0, "balanced selector predicate");
    result = result.slice(0, match.index) + result.slice(end);
  }
}
// Attribute values are data, except an actual class identity selector. Do not
// let a quoted label containing '.icon-button' create a control writer.
function classCode(selector: string) {
  let code = "";
  for (let index = 0; index < selector.length; index++) {
    if (selector[index] !== "[") {
      code += selector[index];
      continue;
    }
    let end = index + 1,
      quote = "";
    for (; end < selector.length; end++) {
      const char = selector[end]!;
      if (quote) {
        if (char === quote && selector[end - 1] !== "\\") quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "]") break;
    }
    assert.ok(end < selector.length, "balanced selector attribute");
    const attribute = selector.slice(index, end + 1);
    const match =
      /^\[\s*class\s*(?:~=|=)\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]$/.exec(
        attribute,
      );
    code += match
      ? "." + (match[1] ?? match[2] ?? match[3]!).split(/\s+/).join(".")
      : "[]";
    index = end;
  }
  return code;
}
function directClasses(compound: string) {
  const outer = classCode(withoutPredicates(compound));
  return [
    ...outer.matchAll(
      /\.([\w-]+)|\[class\s*(?:~=|=)\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]/g,
    ),
  ].flatMap((match) =>
    (match[1] ?? match[2] ?? match[3] ?? match[4]!).split(/\s+/),
  );
}
// Decode CSS identifiers before finding the terminal compound, because the
// whitespace terminator in a hexadecimal escape is not a descendant combinator.
function decoded(selector: string) {
  return selector.replace(
    /\\([\da-f]{1,6})(?:\r\n|[ \n\t\r\f])?|\\([^\n\r\f\da-f])/gi,
    (_, hex: string | undefined, character: string | undefined) => {
      if (!hex) return character!;
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(code);
    },
  );
}
function pdfSubject(selector: string) {
  if (
    fixedPdfReadingRole.recipes.some(
      (recipe) => norm(recipe.selector) === norm(selector),
    )
  )
    return true;
  return postcss.list.comma(classCode(decoded(selector))).some((branch) => {
    const subject = terminal(branch);
    if (/::(?!selection\b)/.test(subject)) return false;
    if (directClasses(subject).some((name) => roots.has(name))) return true;
    const native =
      /^(?:button|select|label|canvas|summary|p|span|br)(?=$|[.:#\[])/.test(
        subject,
      ) || /^:(?:is|where|not)\(/.test(subject);
    const selection = subject === "::selection";
    return (
      (native || selection) &&
      /\.(?:pdf-reader|pdf-controls|pdf-page|pdf-text-layer|pdf-extracted|pdf-paper|pdf-toolbar-slot|pdf-file-info)(?![\w-])/.test(
        classCode(
          withoutPredicates(branch.slice(0, branch.length - subject.length)),
        ),
      )
    );
  });
}
function genericNative(selector: string): boolean {
  return postcss.list.comma(classCode(decoded(selector))).some((branch) => {
    const fn = /:(?:is|where)\(([^()]*)\)/.exec(branch);
    if (fn)
      return postcss.list
        .comma(fn[1]!)
        .some((part) => genericNative(branch.replace(fn[0], part)));
    const subject = terminal(branch);
    if (/::/.test(subject)) return false;
    const classes = directClasses(subject),
      roles = ["icon-button", "primary", "outline"];
    if (classes.some((name) => !roles.includes(name))) return false;
    if (
      !/^(?:button|select|label|canvas|summary|p|span|br|svg|\*)(?=$|[.:#\[])/.test(
        subject,
      ) &&
      !classes.some((name) => roles.includes(name))
    )
      return false;
    const prefix = branch
      .slice(0, branch.length - subject.length)
      .replace(/(?:\.app|body|html|:root)\b/g, "")
      .replace(/[\s>+~]/g, "");
    return prefix === "";
  });
}
function affects(property: string) {
  if (property === "all" || properties.has(property)) return true;
  if (
    (property === "row-gap" || property === "column-gap") &&
    properties.has("gap")
  )
    return true;
  if (property.startsWith("border-") && properties.has("border-color"))
    return true;
  return [...properties].some(
    (owned) =>
      property.startsWith(owned + "-") || owned.startsWith(property + "-"),
  );
}
export function pdfReadingCssViolations(css: ReadonlyMap<string, string>) {
  const errors: string[] = [],
    parsed = new Map(
      [...css].map(([file, text]) => [
        file,
        postcss.parse(text, { from: file }),
      ]),
    );
  const primitiveFacts = fixedPdfPrimitiveRefinements.map((fact) => {
    let selected: Rule | undefined;
    postcss.parse(fact.raw).walkRules((rule) => {
      selected = rule;
    });
    assert.ok(selected);
    const tuple = signature(selected);
    return {
      file: fact.file,
      ...tuple,
      declarations: tuple.declarations.filter(
        (declaration) =>
          "property" in declaration && affects(declaration.property!),
      ),
    };
  });
  const usedPrimitiveFacts = new Set<number>();
  for (const [phase, file] of Object.entries(pdfReadingCarriers))
    guarded(
      () => {
        const root = parsed.get(file);
        assert.ok(root);
        const own: Rule[] = [];
        root.walkRules((rule) => {
          if (pdfSubject(rule.selector)) own.push(rule);
        });
        assert.deepEqual(
          own.map(signature),
          fixedPdfReadingRole.recipes
            .filter((recipe) => recipe.carrier === phase)
            .map(expected),
        );
        root.walkAtRules((at) => {
          assert.notEqual(at.name, "import");
          if (at.nodes?.length === 0) assert.fail("empty owner wrapper");
        });
      },
      "pdf-reading:complete-" + phase + "-recipe",
      errors,
    );
  for (const [file, root] of parsed) {
    root.walkAtRules("import", (at) =>
      guarded(
        () => {
          assert.ok(
            !carriers.some(
              (carrier) =>
                at.params.includes(carrier) ||
                at.params.includes(posix.basename(carrier)),
            ),
          );
        },
        "pdf-reading:css-import",
        errors,
      ),
    );
    root.walkRules((rule) => {
      if (carriers.includes(file)) {
        if (genericNative(rule.selector))
          guarded(
            () => {
              assert.ok(
                !rule.nodes.some(
                  (node) => node.type === "decl" && affects(node.prop),
                ),
              );
            },
            "pdf-reading:owner-boundary",
            errors,
          );
      } else if (pdfSubject(rule.selector))
        guarded(
          () => {
            assert.ok(
              !rule.nodes.some(
                (node) => node.type === "decl" && affects(node.prop),
              ),
            );
          },
          "pdf-reading:no-second-owner",
          errors,
        );
      else if (
        genericNative(rule.selector) &&
        rule.nodes.some((node) => node.type === "decl" && affects(node.prop))
      )
        guarded(
          () => {
            const tuple = signature(rule),
              relevant = tuple.declarations.filter(
                (declaration) =>
                  "property" in declaration && affects(declaration.property!),
              );
            const at = primitiveFacts.findIndex(
              (fact) =>
                fact.file === file &&
                fact.selector === tuple.selector &&
                JSON.stringify(fact.context) ===
                  JSON.stringify(tuple.context) &&
                JSON.stringify(fact.declarations) === JSON.stringify(relevant),
            );
            assert.ok(
              at >= 0,
              "not an existing finite shared native refinement",
            );
            assert.ok(
              !usedPrimitiveFacts.has(at),
              "duplicate global native refinement",
            );
            usedPrimitiveFacts.add(at);
          },
          "pdf-reading:global-native-competitor",
          errors,
        );
    });
  }
  guarded(
    () => {
      const visual = parsed.get("visual-system.css");
      assert.ok(visual);
      const matches: Rule[] = [];
      visual.walkRules((rule) => {
        if (
          (
            fixedPdfReadingRole.retainedHost.selectors as readonly string[]
          ).some((selector) => norm(selector) === norm(rule.selector))
        )
          matches.push(rule);
      });
      const fixed = postcss.parse(fixedPdfReadingRole.retainedHost.raw),
        original: Rule[] = [];
      fixed.walkRules((rule) => {
        original.push(rule);
      });
      assert.deepEqual(matches.map(signature), original.map(signature));
    },
    "pdf-reading:host-packing-remains",
    errors,
  );
  return errors;
}
function physical(file: string, specifier: string) {
  return specifier.startsWith(".")
    ? posix.normalize(
        posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]!),
      )
    : undefined;
}
function literal(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind === SyntaxKind.PlusToken
  ) {
    const left = literal(node.left),
      right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
export function pdfReadingEntryFacts(
  modules: readonly PdfModule[],
  css: ReadonlyMap<string, string>,
  unbound: (identifier: Identifier) => boolean,
) {
  const errors: string[] = [],
    names = new Set(modules.map((module) => module.file)),
    edges = new Map<string, string[]>(),
    counts = new Map<string, number>();
  let main: string[] = [];
  const resolve = (file: string, specifier: string) => {
    const path = physical(file, specifier);
    if (!path) return undefined;
    return [
      path,
      path.replace(/\.js$/, ".tsx"),
      path.replace(/\.js$/, ".ts"),
    ].find((name) => css.has(name) || names.has(name));
  };
  for (const { file, source } of modules) {
    const dependencies: string[] = [],
      direct: string[] = [];
    for (const node of source.statements) {
      if (
        (!isImportDeclaration(node) && !isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const specifier = node.moduleSpecifier.text,
        target = physical(file, specifier),
        clause = isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly = isImportDeclaration(node)
        ? clause?.phaseModifier === SyntaxKind.TypeKeyword ||
          (!!clause?.namedBindings &&
            !clause.name &&
            isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every(
              (element) => element.isTypeOnly,
            ))
        : node.isTypeOnly ||
          (!!node.exportClause &&
            isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly));
      const resolved = resolve(file, specifier);
      if (resolved && !typeOnly) dependencies.push(resolved);
      if (
        file === "main.tsx" &&
        isImportDeclaration(node) &&
        resolved &&
        css.has(resolved) &&
        !typeOnly
      )
        direct.push(resolved);
      if (target && carriers.includes(target)) {
        counts.set(target, (counts.get(target) ?? 0) + 1);
        guarded(
          () =>
            assert.ok(
              isImportDeclaration(node) &&
                file === "main.tsx" &&
                !clause &&
                !/[?#]/.test(specifier) &&
                css.has(target),
            ),
          "pdf-reading:runtime-origin:" + target,
          errors,
        );
      }
    }
    edges.set(file, dependencies);
    if (file === "main.tsx") main = direct;
    function walk(node: Node) {
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            unbound(node.expression)))
      )
        for (const argument of node.arguments) {
          const text = literal(argument),
            target = text === undefined ? undefined : physical(file, text);
          guarded(
            () => assert.ok(!target || !carriers.includes(target)),
            "pdf-reading:dynamic-entry",
            errors,
          );
        }
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
  }
  for (const file of carriers)
    guarded(
      () => assert.equal(counts.get(file), 1),
      "pdf-reading:single-entry:" + file,
      errors,
    );
  const visited = new Set<string>(),
    runtime: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (css.has(file)) {
      runtime.push(file);
      return;
    }
    for (const dependency of edges.get(file) ?? []) visit(dependency);
  }
  visit("main.tsx");
  return { errors, main, runtime };
}
export function pdfReadingPhaseViolations(
  main: readonly string[],
  runtime: readonly string[],
) {
  const errors: string[] = [];
  for (const [phase, neighbors] of Object.entries(
    fixedPdfReadingRole.mainNeighbors,
  ))
    for (const [stream, label] of [
      [main, "main"],
      [runtime, "runtime"],
    ] as const)
      guarded(
        () => {
          const at = stream.indexOf(neighbors[1]);
          assert.ok(at > 0);
          assert.deepEqual(stream.slice(at - 1, at + 2), neighbors);
        },
        "pdf-reading:" + label + "-phase:" + phase,
        errors,
      );
  return errors;
}

// Every handoff checks the full two-carrier contract, including strict actual
// main/runtime phases. A deliberately changed old neighbor may therefore hit a
// PDF phase diagnostic earlier; it needs explicit finite counterexample handoff,
// never a weaker projection path or blind carrier removal.
export function verifiedPdfCarrierPhases(
  carrier: string,
  css: ReadonlyMap<string, string>,
  modules: readonly PdfModule[],
  unbound: (identifier: Identifier) => boolean,
) {
  assert.ok(carriers.includes(carrier), "only one approved PDF carrier");
  const facts = pdfReadingEntryFacts(modules, css, unbound);
  const errors = [
    ...pdfReadingCssViolations(css),
    ...facts.errors,
    ...pdfReadingPhaseViolations(facts.main, facts.runtime),
  ];
  assert.deepEqual(
    errors,
    [],
    "pdf-reading:complete-handoff:" + errors.join(","),
  );
  return {
    main: facts.main.filter((file) => file !== carrier),
    runtime: facts.runtime.filter((file) => file !== carrier),
  };
}
