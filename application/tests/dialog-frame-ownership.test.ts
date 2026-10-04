import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, posix } from "node:path";
import postcss, { type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isImportDeclaration,
  isExportDeclaration,
  isStringLiteral,
  isNamedImports,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isBinaryExpression,
  SyntaxKind,
  type Node,
} from "typescript/unstable/ast";
import { fixedDialogFrame } from "./fixtures/dialog-frame-c525d217.js";

// Finite current role ownership, not a universal selector/effect solver.
// Complete historical source/inverse belongs to the separate migration proof.
const owner = "ui/dialog-frame.css";
const directory = new URL("../apps/web/src/", import.meta.url).pathname;
type Sources = { css: Map<string, string>; modules: Map<string, string> };
const key = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>,():])\s*/g, "$1");
const valueKey = (value: string) => value.trim().replace(/\s+/g, " ");
function context(rule: Rule) {
  const result: string[] = [];
  for (let p = rule.parent; p && p.type !== "root"; p = p.parent)
    result.unshift(
      p.type === "atrule"
        ? "@" + p.name + " " + valueKey(p.params)
        : "nested:" + key(p.selector),
    );
  return result;
}
function signature(rule: Rule) {
  return [
    key(rule.selector),
    context(rule),
    rule.nodes
      .filter((n) => n.type !== "comment")
      .map((n) =>
        n.type === "decl"
          ? [n.prop, valueKey(n.value), !!n.important]
          : ["unexpected:" + n.type],
      ),
  ];
}
const fixedSignature = (r: {
  selector: string;
  context: readonly string[];
  declarations: readonly { prop: string; value: string; important: boolean }[];
}) => [
  key(r.selector),
  r.context.map(valueKey),
  r.declarations.map((d) => [d.prop, valueKey(d.value), d.important]),
];
function actualSources(): Sources {
  const css = new Map<string, string>(),
    modules = new Map<string, string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        (file.endsWith(".css")
          ? css
          : /\.tsx?$/.test(file)
            ? modules
            : undefined
        )?.set(relative(directory, file), readFileSync(file, "utf8"));
    }
  }
  visit(directory);
  return { css, modules };
}
const clone = (s: Sources): Sources => ({
  css: new Map(s.css),
  modules: new Map(s.modules),
});
function parensEnd(text: string, start: number) {
  let depth = 1,
    quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && !--depth) return i;
  }
  assert.fail("selector-parentheses");
}
function expanded(selector: string): string[] {
  const match = /:(?:is|where)\(/.exec(selector);
  if (!match) return postcss.list.comma(selector);
  const start = match.index + match[0].length,
    end = parensEnd(selector, start);
  return postcss.list
    .comma(selector.slice(start, end))
    .flatMap((branch) =>
      expanded(
        selector.slice(0, match.index) + branch + selector.slice(end + 1),
      ),
    );
}
function withoutPredicates(selector: string) {
  for (;;) {
    const m = /:(?:not|has)\(/.exec(selector);
    if (!m) return selector;
    const end = parensEnd(selector, m.index + m[0].length);
    selector = selector.slice(0, m.index) + selector.slice(end + 1);
  }
}
function decode(selector: string) {
  return selector.replace(
    /\\([\da-f]{1,6})(?:\s)?|\\([^\n\r\f])/gi,
    (_, hex: string | undefined, c: string | undefined) =>
      hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : c!,
  );
}
// Qualifying the same public root with local classes or an open attribute does
// not turn its direct common header/footer into an unrelated domain descendant.
const rootTail = (tail: string) =>
  tail.replace(/^(?:\.[\w-]+|\[[^\]]*\])*/, "");
function roles(selector: string): string[] {
  const decoded = decode(selector).replace(
    /\[class\s*(?:~=|=)\s*(?:(["'])(.*?)\1|([^\s\]]+))\s*\]/gi,
    (_full, _quote, quoted: string | undefined, bare: string | undefined) =>
      "." + (quoted ?? bare!).split(/\s+/).join("."),
  );
  if (
    !/\.(?:create-dialog|document-draft|library-dialog|application-install|connection-dialog)(?![\w-])/.test(
      decoded,
    )
  )
    return [];
  return expanded(decoded).flatMap((branch) => {
    if (/::[\w-]+/.test(withoutPredicates(branch))) return [];
    const clean = key(withoutPredicates(branch));
    if (
      /\.connection-dialog(?![\w-])/.test(clean) &&
      !/[ >+~]/.test(clean.slice(clean.lastIndexOf(".connection-dialog") + 18))
    )
      return ["connection-carrier"];
    const carrier =
      /\.(?:library-dialog|application-install)(?![\w-])(.*)$/.exec(clean);
    if (carrier && /^>(?:header|footer)$/.test(rootTail(carrier[1]!)))
      return ["frame-carrier"];
    const draft = /\.document-draft(?![\w-])(.*)$/.exec(clean);
    const create = /\.create-dialog(?![\w-])(.*)$/.exec(clean);
    if (!draft && !create) return [];
    const tail = rootTail((draft?.[1] ?? create?.[1])!);
    if (!draft && !/[ >+~]/.test(tail)) return ["root"];
    const normalized = tail.replace(
      /:(?:focus-visible|focus|hover|active|disabled|enabled|open)\b/g,
      "",
    );
    if (/^(?:>| )?(?:form>)?header$/.test(normalized)) return ["header"];
    if (/^(?:>| )?(?:form>)?header>button$/.test(normalized)) return ["close"];
    if (
      /^(?:>| )?(?:form>)?header[ >]h2$/.test(normalized) ||
      normalized === " h2"
    )
      return ["title"];
    if (
      /^(?:>| )?header>(?:div|\.dialog-actions|:first-child)$/.test(normalized)
    )
      return ["header-child"];
    if (/^(?:>| )?header (?:p|small)$/.test(normalized)) return ["description"];
    if (draft) return [];
    if (/^(?:>| )?(?:form>)?footer$/.test(normalized)) return ["footer"];
    if (
      /^(?:>| )?(?:form>)?footer>button$/.test(normalized) ||
      /^ \.primary$|^ \.secondary-action$|^ \.dialog-actions>button$|^ \.bookmark-edit-actions>button$/.test(
        normalized,
      )
    )
      return ["action"];
    if (normalized === " .field") return ["field-gap"];
    if (normalized === " .dialog-input-row") return ["row"];
    if (normalized === " .dialog-input-row>input") return ["row-input"];
    if (normalized === " .dialog-input-row>button") return ["row-action"];
    if (normalized === " .dialog-input-row>footer")
      return ["row-footer", "row-action"];
    if (/^ (?:input|select|textarea)(?:\[.*\])?$/.test(normalized)) {
      if (
        /^ input\[type=(?:["'])?(?:checkbox|radio|range|file|color|hidden|button|submit|reset|image)(?:["'])?\]/.test(
          normalized,
        )
      )
        return [];
      if (branch.includes(":focus")) return ["focus"];
      if (
        normalized.startsWith(" select") &&
        /\[(?:multiple|size)(?:[=\]])/.test(normalized)
      )
        return [];
      return [normalized.startsWith(" textarea") ? "textarea" : "single-field"];
    }
    return [];
  });
}
const roleProperties = new Map<string, Set<string>>();
for (const tuple of fixedDialogFrame.selected)
  for (const role of roles(tuple.selector)) {
    const props = roleProperties.get(role) ?? new Set<string>();
    for (const d of tuple.declarations) props.add(d.prop);
    roleProperties.set(role, props);
  }
function affects(property: string, owned: Set<string>) {
  if (!owned.size) return false;
  if (property === "all") return true;
  if (owned.has(property)) return true;
  if (
    property === "inset" &&
    ["left", "right", "top", "bottom"].some((p) => owned.has(p))
  )
    return true;
  for (const base of [
    "margin",
    "padding",
    "inset",
    "border",
    "outline",
    "font",
    "overflow",
    "flex",
    "gap",
  ]) {
    if (
      (property === base &&
        [...owned].some((p) => p === base || p.startsWith(base + "-"))) ||
      (owned.has(base) &&
        (property.startsWith(base + "-") ||
          (base === "gap" && ["row-gap", "column-gap"].includes(property))))
    )
      return true;
  }
  return false;
}
function moduleProgram(
  sources: Sources,
  consume: (file: string, source: Node) => void,
) {
  const base = "/dialog-frame-contract",
    config = base + "/tsconfig.json",
    files = Object.fromEntries(
      [...sources.modules].map(([name, text]) => [base + "/" + name, text]),
    );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: [...sources.modules.keys()],
  });
  const api = new API({ cwd: base, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)!.program;
      assert.equal(program.getSyntacticDiagnostics().length, 0, "module-parse");
      for (const name of sources.modules.keys())
        consume(name, program.getSourceFile(base + "/" + name)!);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
const isOwner = (specifier: string) =>
  /(?:^|\/)dialog-frame\.css$/.test(specifier.split(/[?#]/)[0]!);
function resolve(file: string, specifier: string, sources: Sources) {
  if (!specifier.startsWith(".")) return undefined;
  const path = posix.normalize(
    posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]!),
  );
  return [
    path,
    path.replace(/\.js$/, ".ts"),
    path.replace(/\.js$/, ".tsx"),
  ].find((name) => sources.css.has(name) || sources.modules.has(name));
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
function validate(sources: Sources) {
  const parsed = new Map(
    [...sources.css].map(([file, text]) => [
      file,
      postcss.parse(text, { from: file }),
    ]),
  );
  const frame = parsed.get(owner);
  assert.ok(frame, "frame-owner");
  assert.ok(
    frame.nodes.every(
      (n) =>
        n.type === "comment" ||
        n.type === "rule" ||
        (n.type === "atrule" && n.name === "media"),
    ),
    "frame-owner-tree",
  );
  const signatures: unknown[] = [];
  frame.walkRules((r) => {
    signatures.push(signature(r));
  });
  assert.deepEqual(
    signatures,
    fixedDialogFrame.selected.map(fixedSignature),
    "frame-exact-tuples",
  );
  const seenNeighbors = new Map<string, unknown[][]>();
  for (const [file, root] of parsed) {
    root.walkAtRules("import", (r) => {
      assert.ok(!r.params.includes("dialog-frame.css"), "frame-css-import");
    });
    if (file === owner) continue;
    root.walkRules((rule) => {
      const ownedProps = new Set(
        roles(rule.selector).flatMap((role) => [
          ...(roleProperties.get(role) ?? []),
        ]),
      );
      const relevant = rule.nodes.filter(
        (n) => n.type === "decl" && affects(n.prop, ownedProps),
      );
      if (!relevant.length) return;
      const neighbor = fixedDialogFrame.neighbors.find(
        (n) =>
          n.source === file &&
          key(n.selector) === key(rule.selector) &&
          JSON.stringify(n.context.map(valueKey)) ===
            JSON.stringify(context(rule)),
      );
      assert.ok(
        neighbor,
        "foreign-frame-writer:" + file + ":" + key(rule.selector),
      );
      const projected = [
        key(rule.selector),
        context(rule),
        relevant.map((d) =>
          d.type === "decl" ? [d.prop, valueKey(d.value), !!d.important] : [],
        ),
      ];
      assert.deepEqual(
        projected,
        fixedSignature(neighbor),
        "frame-adjacent-writer:" + file,
      );
      const old = seenNeighbors.get(key(neighbor.selector)) ?? [];
      old.push(projected);
      seenNeighbors.set(key(neighbor.selector), old);
    });
  }
  for (const n of fixedDialogFrame.neighbors)
    assert.equal(
      seenNeighbors.get(key(n.selector))?.length,
      1,
      "frame-adjacent-writer-count",
    );
  let imports = 0;
  const edges = new Map<string, string[]>(),
    mainCss: string[] = [];
  moduleProgram(sources, (file, source) => {
    const dependencies: string[] = [];
    source.forEachChild((node) => {
      if (
        (!isImportDeclaration(node) && !isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !isStringLiteral(node.moduleSpecifier)
      )
        return;
      const spec = node.moduleSpecifier.text,
        clause = isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly = isImportDeclaration(node)
        ? clause?.phaseModifier === SyntaxKind.TypeKeyword ||
          (!clause?.name &&
            clause?.namedBindings &&
            isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly))
        : node.isTypeOnly;
      if (isOwner(spec)) {
        assert.ok(isImportDeclaration(node), "frame-reexport");
        imports++;
        assert.ok(
          file === "main.tsx" && !clause && spec === "./" + owner,
          "frame-runtime-import",
        );
      }
      const resolved = resolve(file, spec, sources);
      if (resolved && !typeOnly) dependencies.push(resolved);
      if (file === "main.tsx" && !typeOnly && spec.endsWith(".css"))
        mainCss.push(spec);
    });
    edges.set(file, dependencies);
    function walk(node: Node) {
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) && node.expression.text === "require"))
      )
        assert.ok(
          !node.arguments.some((a) => {
            const spec = literal(a);
            return spec !== undefined && isOwner(spec);
          }),
          "frame-dynamic-import",
        );
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
  });
  assert.equal(imports, 1, "frame-single-import");
  const at = mainCss.indexOf("./" + owner);
  assert.ok(
    at > 0 &&
      mainCss[at - 1] === "./styles.css" &&
      mainCss[at + 1] === "./ui.css",
    "frame-entry-slot",
  );
  assert.deepEqual(
    mainCss.filter((s) =>
      (fixedDialogFrame.mainCss as readonly string[]).includes(s),
    ),
    fixedDialogFrame.mainCss,
    "frame-original-entry-order",
  );
  const reached = new Set<string>(),
    loaded: string[] = [];
  function visit(file: string) {
    if (reached.has(file)) return;
    reached.add(file);
    if (sources.css.has(file)) {
      loaded.push(file);
      return;
    }
    for (const dep of edges.get(file) ?? []) visit(dep);
  }
  visit("main.tsx");
  assert.ok(
    loaded.indexOf("styles.css") >= 0 &&
      loaded.indexOf(owner) === loaded.indexOf("styles.css") + 1 &&
      loaded.indexOf("ui.css") === loaded.indexOf(owner) + 1,
    "frame-actual-runtime-slot",
  );
  assert.ok(
    loaded.indexOf("ui.css") < loaded.indexOf("visual-system.css"),
    "frame-adjacent-cascade-order",
  );
}
const actual = actualSources();
function replace(s: Sources, file: string, before: string, after: string) {
  const target = s.css.has(file) ? s.css : s.modules;
  const old = target.get(file)!;
  assert.ok(old.includes(before), "counterfactual-target");
  target.set(file, old.replace(before, after));
}
function reject(rule: string, mutate: (s: Sources) => void) {
  const s = clone(actual);
  mutate(s);
  for (const text of s.css.values()) postcss.parse(text);
  moduleProgram(s, () => {});
  assert.throws(
    () => validate(s),
    (e) => e instanceof assert.AssertionError && e.message.includes(rule),
    "specified contract: " + rule,
  );
}
test("independent finite baseline retains thirty ordered rules, 107 declarations and three real carriers", () => {
  assert.equal(
    fixedDialogFrame.baseline,
    "c525d217deafe2bc125b15186cf056edfd2e4037",
  );
  assert.equal(fixedDialogFrame.selected.length, 30);
  assert.equal(
    fixedDialogFrame.selected.reduce((n, r) => n + r.declarations.length, 0),
    107,
  );
  assert.equal(
    fixedDialogFrame.selected.filter(
      (r) => r.role === "required-same-specificity-cascade-carrier",
    ).length,
    3,
  );
});
test("actual dialog frame has its exact recipes, neighboring writer policy and one runtime owner", () =>
  validate(actual));
test("complete selectors, values, important and fallback order cannot be silently changed", () => {
  for (const [before, after] of [
    ["24px 28px", "25px 28px"],
    ["translateX(-50%)", "translateX(-49%)"],
    ["outline-offset: -2px", "outline-offset: 2px"],
    [":is(", ":where("],
    [".document-draft header > button", ".document-draft header > a"],
    ["width: min(590px", "width: min(591px"],
  ] as const)
    reject("frame-exact-tuples", (s) => replace(s, owner, before, after));
  reject("frame-exact-tuples", (s) =>
    s.css.set(
      owner,
      s.css.get(owner)! + "\n.create-dialog{width:500px!important}",
    ),
  );
  reject("frame-exact-tuples", (s) =>
    replace(s, owner, "padding: 24px 28px;", "padding: 24px 28px !important;"),
  );
});
test("three cascade carriers retain their complete values and relative original order", () => {
  for (const carrier of fixedDialogFrame.selected.filter(
    (r) => r.role === "required-same-specificity-cascade-carrier",
  ))
    reject("frame-exact-tuples", (s) => {
      const parsed = postcss.parse(s.css.get(owner)!);
      const rules: Rule[] = [];
      parsed.walkRules((r) => {
        if (key(r.selector) === key(carrier.selector)) rules.push(r);
      });
      assert.equal(rules.length, 1);
      rules[0]!.remove();
      s.css.set(owner, parsed.toString());
    });
  reject("frame-exact-tuples", (s) => {
    const root = postcss.parse(s.css.get(owner)!);
    const rules: Rule[] = [];
    root.walkRules((r) => {
      if (key(r.selector) === key(".connection-dialog")) rules.push(r);
    });
    const carrier = rules[0]!;
    carrier.remove();
    root.append(carrier);
    s.css.set(owner, root.toString());
  });
});
test("single-line, textarea, select focus and media roles remain distinct", () => {
  for (const [before, after] of [
    ['[type="checkbox"],', ""],
    ["select:not([multiple], [size])", "select"],
    ["outline-offset: -2px", "outline-offset: 0"],
    ["(pointer: coarse)", "(pointer: fine)"],
    ["(max-width: 560px)", "(max-width: 561px)"],
  ] as const)
    reject("frame-exact-tuples", (s) => replace(s, owner, before, after));
  reject("frame-owner-tree", (s) =>
    s.css.set(owner, "@layer fake{" + s.css.get(owner)! + "}"),
  );
});
test("foreign public frame/role writers including shorthand and important fail their specific ownership rule", () => {
  for (const css of [
    ".app .create-dialog{padding-inline:3px}",
    ".create-dialog{all:unset}",
    ".app .create-dialog>header{margin:0!important}",
    ".app .create-dialog.compound-local>header{padding:0}",
    ".create-dialog[open]>footer{padding:0}",
    ".create-dialog header h2{font:10px serif}",
    ".create-dialog>footer{border:0}",
    '.app [class~="create-dialog"]{width:500px}',
    ".app :is(.create-dialog,.other-dialog){max-height:90vh}",
    ".create-dialog textarea{padding:1px}",
    ".app .create-dialog .primary{border-width:4px}",
    ".document-draft header>button{height:20px}",
    ".library-dialog>footer{gap:1px}",
    ".connection-dialog{inset:0}",
  ])
    reject("foreign-frame-writer:", (s) =>
      s.css.set("reader.css", s.css.get("reader.css")! + "\n" + css),
    );
});
test("explicit adjacent shared button writers cannot gain importance or a reset shorthand", () => {
  reject("frame-adjacent-writer:", (s) =>
    replace(
      s,
      "visual-system.css",
      "min-height: 28px;",
      "min-height: 28px !important;",
    ),
  );
  reject("frame-adjacent-writer:", (s) =>
    replace(
      s,
      "visual-system.css",
      "line-height: 18px;",
      "line-height: 18px;\n  font: inherit;",
    ),
  );
});
test("entry uses a real unique side-effect import, original cascade and no role bypass", () => {
  reject("frame-single-import", (s) =>
    replace(s, "main.tsx", 'import "./' + owner + '";\n', ""),
  );
  reject("frame-runtime-import", (s) =>
    s.modules.set(
      "App.tsx",
      s.modules.get("App.tsx")! + '\nimport "./' + owner + '";',
    ),
  );
  reject("frame-single-import", (s) =>
    s.modules.set(
      "main.tsx",
      s.modules.get("main.tsx")! + '\nimport "./' + owner + '";',
    ),
  );
  reject("frame-reexport", (s) =>
    s.modules.set(
      "App.tsx",
      s.modules.get("App.tsx")! + '\nexport * from "./' + owner + '";',
    ),
  );
  reject("frame-dynamic-import", (s) =>
    s.modules.set(
      "App.tsx",
      s.modules.get("App.tsx")! + '\nvoid import("./ui/"+"dialog-frame.css");',
    ),
  );
  reject("frame-dynamic-import", (s) =>
    s.modules.set(
      "App.tsx",
      s.modules.get("App.tsx")! + '\nrequire("./ui/dialog-frame.css");',
    ),
  );
  reject("frame-css-import", (s) =>
    s.css.set(
      "reader.css",
      s.css.get("reader.css")! + '\n@import "./ui/dialog-frame.css";',
    ),
  );
  reject("frame-single-import", (s) =>
    replace(
      s,
      "main.tsx",
      'import "./' + owner + '";',
      '// import "./' + owner + '";',
    ),
  );
  reject("frame-original-entry-order", (s) =>
    replace(
      s,
      "main.tsx",
      'import "./workflow.css";\nimport "./ui/dialog-surface.css";',
      'import "./ui/dialog-surface.css";\nimport "./workflow.css";',
    ),
  );
});
test("unrelated domain, primitive, compound-local, JSX/comments/type imports and new independent feature CSS remain lawful", () => {
  const s = clone(actual);
  s.css.set(owner, "/* role documentation may evolve */\n" + s.css.get(owner)!);
  s.css.set(
    "reader.css",
    s.css.get("reader.css")! +
      '\n.reader-note-dialog .private-layout{margin:7px;padding:9px}\n.create-dialog .domain-region textarea{font:inherit}\n.create-dialog fieldset{padding:10px}\n.create-dialog input[type="checkbox"]{height:18px}\n.create-dialog-local{width:300px}\n.create-dialog-local.compound-local>header{padding:0}\n.create-dialog .local-action{height:37px}\ninput{padding-inline:4px}\n.field{gap:6px}\n.create-dialog::before{width:10px}',
  );
  s.css.set("new-independent.css", ".new-independent-feature{width:321px}");
  s.modules.set(
    "main.tsx",
    s.modules.get("main.tsx")! +
      '\nimport "./new-independent.css";\n// import("./ui/dialog-frame.css") is only documentation',
  );
  s.modules.set(
    "App.tsx",
    'import type {ReactNode} from "react";\n' +
      s.modules.get("App.tsx")! +
      '\nconst unrelatedFooter=<footer data-owner="another-domain">Allowed</footer>;',
  );
  validate(s);
});
