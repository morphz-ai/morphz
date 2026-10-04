import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, posix } from "node:path";
import postcss, { type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxOpeningElement,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
} from "typescript/unstable/ast";
import {
  mixedPopupSurvivors,
  popupProtectedTokens,
  retainedPopupRules,
  retainedPopupTokens,
  selectedPopupSurfaceRules,
  type FrozenPopupRule,
} from "./fixtures/popup-surface-9708abbd.js";

// A finite root-material contract, not a universal CSS solver or App snapshot.
// Actual-Git whole-source migration proof is a separate one-time verifier.
const owner = "ui/popup-surface.css";
const directory = new URL("../apps/web/src/", import.meta.url).pathname;
type Sources = { css: Map<string, string>; modules: Map<string, string> };
const key = (selector: string) =>
  selector
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>,])\s*/g, "$1");
function context(rule: Rule) {
  const result: string[] = [];
  for (let node = rule.parent; node && node.type !== "root"; node = node.parent)
    result.unshift(
      node.type === "atrule"
        ? `@${node.name} ${node.params}`.trim()
        : `nested:${key(node.selector)}`,
    );
  return result;
}
function signature(rule: Rule) {
  return [
    key(rule.selector),
    context(rule),
    rule.nodes
      .filter((node) => node.type !== "comment")
      .map((node) =>
        node.type === "decl"
          ? [node.prop, node.value, !!node.important]
          : [`unexpected:${node.type}`, "", false],
      ),
  ];
}
const frozen = (rule: FrozenPopupRule) => [rule[2], rule[3], rule[4]];
const paint = (property: string) =>
  /^(?:all|background(?:-.*)?|border(?:-.*)?|box-shadow|(?:-webkit-)?backdrop-filter)$/.test(
    property.toLowerCase(),
  );
const protectedTokens = new Set<string>(popupProtectedTokens);
// Actual 9708 ComposerOptions variants. Their descendants stay independent.
const roots = new Set([
  "composer-options",
  "theme-menu",
  "workspace-options-menu",
  "selection-actions",
  "application-dock-menu",
  "application-dock-menu-1",
  "application-dock-menu-2",
  "application-dock-menu-3",
  "application-dock-menu-4",
  "appearance-menu",
  "profile-menu",
  "composer-settings-menu",
  "composer-error-details",
  "composer-scope-menu",
]);
function decode(selector: string) {
  return selector.replace(
    /\\([\da-f]{1,6})(?:\s)?|\\([^\n\r\f])/gi,
    (_, hex: string | undefined, character: string | undefined) =>
      hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : character!,
  );
}
function terminal(selector: string) {
  let start = 0,
    depth = 0,
    quote = "";
  for (let at = 0; at < selector.length; at++) {
    const c = selector[at]!;
    if (quote) {
      if (c === quote && selector[at - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (!depth && /[\s>+~]/.test(c)) start = at + 1;
  }
  return selector.slice(start).trim();
}
function compoundPaints(compound: string): boolean {
  let plain = "",
    restrictive = false,
    functionalRoot = false;
  for (let at = 0; at < compound.length;) {
    const match = /^:([\w-]+)\(/.exec(compound.slice(at));
    if (!match) {
      plain += compound[at++];
      continue;
    }
    const start = at + match[0].length;
    let end = start,
      depth = 1,
      quote = "";
    for (; end < compound.length && depth; end++) {
      const c = compound[end]!;
      if (quote) {
        if (c === quote && compound[end - 1] !== "\\") quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    if (match[1] === "is" || match[1] === "where") {
      restrictive = true;
      functionalRoot ||= paintsSurface(compound.slice(start, end - 1));
    }
    // :has/:not do not turn an argument into the painted subject.
    at = end;
  }
  if (/::[\w-]+/.test(plain.replace(/\[[^\]]*\]/g, ""))) return false;
  if (functionalRoot) return true;
  const classes = [
    ...plain.matchAll(
      /\[class\s*(?:~=|=)\s*(?:(["'])(.*?)\1|([^\s\]]+))\s*\]/gi,
    ),
  ].flatMap((match) => (match[2] ?? match[3]!).split(/\s+/));
  if (classes.some((name) => roots.has(name))) return true;
  if (/\[popover(?:\s|[=\]])/i.test(plain)) return true;
  plain = plain.replace(/\[[^\]]*\]/g, "");
  // Implicit universal/attribute-only roots can paint the actual popover too.
  if (!restrictive && !classes.length && plain === "") return true;
  if (/^\*(?=[.#[:]|$)/.test(plain)) return true;
  return [...plain.matchAll(/\.([\w-]+)/g)].some((match) =>
    roots.has(match[1]!),
  );
}
function paintsSurface(selector: string): boolean {
  return postcss.list
    .comma(decode(selector))
    .some((branch) => compoundPaints(terminal(branch.trim())));
}
function actualSources(): Sources {
  const css = new Map<string, string>(),
    modules = new Map<string, string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const target = file.endsWith(".css")
          ? css
          : /\.tsx?$/.test(file)
            ? modules
            : undefined;
        target?.set(relative(directory, file), readFileSync(file, "utf8"));
      }
    }
  }
  visit(directory);
  return { css, modules };
}
function clone(source: Sources): Sources {
  return { css: new Map(source.css), modules: new Map(source.modules) };
}
function moduleProgram(
  sources: Sources,
  consume: (name: string, source: Node) => void,
) {
  const base = "/morphz-popup-surface",
    config = `${base}/tsconfig.json`;
  const files = Object.fromEntries(
    [...sources.modules].map(([name, text]) => [`${base}/${name}`, text]),
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
        consume(name, program.getSourceFile(`${base}/${name}`)!);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
const isOwner = (specifier: string) =>
  /(?:^|\/)popup-surface\.css$/.test(specifier.split(/[?#]/)[0]!);
const resolveModule = (file: string, specifier: string, sources: Sources) => {
  if (!specifier.startsWith(".")) return undefined;
  const candidate = posix.normalize(
    posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]!),
  );
  return [
    candidate,
    candidate.replace(/\.js$/, ".ts"),
    candidate.replace(/\.js$/, ".tsx"),
  ].find((name) => sources.modules.has(name) || sources.css.has(name));
};
function validate(sources: Sources) {
  const parsed = new Map(
    [...sources.css].map(([file, text]) => [
      file,
      postcss.parse(text, { from: file }),
    ]),
  );
  const surface = parsed.get(owner);
  assert.ok(surface, "surface-owner");
  assert.ok(
    surface.nodes.every(
      (node) => node.type === "comment" || node.type === "rule",
    ),
    "surface-root-tree",
  );
  const signatures: unknown[] = [];
  surface.walkRules((rule) => {
    signatures.push(signature(rule));
  });
  assert.deepEqual(
    signatures,
    selectedPopupSurfaceRules.map(frozen),
    "surface-exact",
  );
  for (const old of [...mixedPopupSurvivors, ...retainedPopupRules]) {
    const matches: unknown[] = [];
    parsed.get(old[0])?.walkRules((rule) => {
      if (
        key(rule.selector) === old[2] &&
        JSON.stringify(context(rule)) === JSON.stringify(old[3])
      )
        matches.push(signature(rule));
    });
    assert.deepEqual(
      matches,
      old[4].length ? [frozen(old)] : [],
      `retained:${old[0]}:${old[2]}`,
    );
  }
  const tokens: unknown[] = [];
  for (const [file, root] of parsed) {
    root.walkAtRules("import", (rule) => {
      assert.ok(!rule.params.includes("popup-surface.css"), "css-owner-import");
    });
    root.walkRules((rule) => {
      const declarations = rule.nodes.filter((node) => node.type === "decl");
      const policy = declarations.filter((decl) =>
        protectedTokens.has(decl.prop),
      );
      if (policy.length)
        tokens.push([
          file,
          key(rule.selector),
          context(rule),
          policy.map((decl) => [decl.prop, decl.value, !!decl.important]),
        ]);
      if (file !== owner && paintsSurface(rule.selector))
        assert.ok(
          !declarations.some((decl) => paint(decl.prop)),
          `foreign-surface:${file}:${key(rule.selector)}`,
        );
    });
  }
  // Compare per-file/order, without freezing unrelated stylesheet inventory.
  const tokenKey = (tuple: unknown[]) => JSON.stringify(tuple.slice(0, 3));
  assert.deepEqual(
    tokens.sort((a, b) =>
      tokenKey(a as unknown[]).localeCompare(tokenKey(b as unknown[])),
    ),
    retainedPopupTokens
      .map((rule) => [rule[0], ...frozen(rule)])
      .sort((a, b) => tokenKey(a).localeCompare(tokenKey(b))),
    "token-policy",
  );
  let imports = 0;
  const edges = new Map<string, string[]>();
  let popover = 0,
    toolbar = 0,
    portal = 0;
  moduleProgram(sources, (file, source) => {
    const direct: string[] = [],
      dependencies: string[] = [];
    source.forEachChild((node) => {
      if (
        (!isImportDeclaration(node) && !isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !isStringLiteral(node.moduleSpecifier)
      )
        return;
      const specifier = node.moduleSpecifier.text;
      const clause = isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly = isImportDeclaration(node)
        ? clause?.phaseModifier === SyntaxKind.TypeKeyword ||
          (!clause?.name &&
            clause?.namedBindings &&
            isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every(
              (element) => element.isTypeOnly,
            ))
        : node.isTypeOnly;
      const resolved = resolveModule(file, specifier, sources);
      if (resolved && !typeOnly) dependencies.push(resolved);
      if (isImportDeclaration(node)) {
        direct.push(specifier);
        if (!isOwner(specifier)) return;
        imports++;
        assert.ok(
          file === "main.tsx" &&
            !node.importClause &&
            specifier === `./${owner}`,
          "owner-import",
        );
      } else assert.ok(!isOwner(specifier), "owner-reexport");
    });
    edges.set(file, dependencies);
    if (file === "main.tsx") {
      const at = direct.indexOf(`./${owner}`);
      assert.ok(
        at > 0 &&
          direct[at - 1] === "./ui.css" &&
          direct[at + 1] === "./workflow.css" &&
          direct[at + 2] === "./ui/dialog-surface.css" &&
          direct[at + 3] === "./visual-system.css",
        "entry-order",
      );
    }
    function walk(node: Node) {
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) && node.expression.text === "require"))
      )
        assert.ok(
          !node.arguments.some(
            (argument) =>
              (isStringLiteral(argument) ||
                isNoSubstitutionTemplateLiteral(argument)) &&
              isOwner(argument.text),
          ),
          "owner-dynamic",
        );
      if (
        file === "ComposerOptions.tsx" &&
        isJsxOpeningElement(node) &&
        node.tagName.getText() === "div"
      ) {
        const attrs = node.attributes.properties.filter(isJsxAttribute);
        const native = attrs.find((attr) => attr.name.getText() === "popover");
        const className = attrs.find(
          (attr) => attr.name.getText() === "className",
        );
        if (
          native &&
          className?.initializer?.getText().includes("composer-options")
        ) {
          assert.equal(
            native.initializer?.getText(),
            '"manual"',
            "actual-popover-root",
          );
          assert.equal(
            className.initializer.getText(),
            "{`composer-options ${menuClassName}`}",
            "actual-popover-root",
          );
          popover++;
        }
      }
      if (
        file === "SelectionActions.tsx" &&
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === "createPortal"
      ) {
        const [element, host] = node.arguments;
        assert.ok(
          element &&
            isJsxElement(element) &&
            host?.getText() === "document.body",
          "actual-body-portal",
        );
        const attrs =
          element.openingElement.attributes.properties.filter(isJsxAttribute);
        assert.equal(
          attrs
            .find((attr) => attr.name.getText() === "className")
            ?.initializer?.getText(),
          '"selection-actions"',
          "actual-body-portal",
        );
        assert.equal(
          attrs
            .find((attr) => attr.name.getText() === "role")
            ?.initializer?.getText(),
          '"toolbar"',
          "actual-body-portal",
        );
        portal++;
        toolbar++;
      }
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
  });
  assert.equal(imports, 1, "single-owner-import");
  const reached = new Set<string>(),
    loaded: string[] = [];
  function visit(file: string) {
    if (reached.has(file)) return;
    reached.add(file);
    if (sources.css.has(file)) {
      loaded.push(file);
      return;
    }
    for (const dependency of edges.get(file) ?? []) visit(dependency);
  }
  visit("main.tsx");
  assert.ok(
    reached.has("ComposerOptions.tsx") &&
      reached.has("SelectionActions.tsx") &&
      reached.has("ApplicationDock.tsx"),
    "actual-consumer-closure",
  );
  assert.equal(popover, 1, "actual-popover-root");
  assert.equal(toolbar, 1, "actual-body-portal");
  assert.equal(portal, 1, "actual-body-portal");
  assert.ok(
    loaded.indexOf("application-dock.css") >= 0 &&
      loaded.indexOf("application-dock.css") < loaded.indexOf(owner),
    "actual-dock-closure-order",
  );
  const interval = [
    "ui.css",
    owner,
    "workflow.css",
    "ui/dialog-surface.css",
    "visual-system.css",
  ];
  assert.deepEqual(
    loaded.slice(
      loaded.indexOf("ui.css"),
      loaded.indexOf("ui.css") + interval.length,
    ),
    interval,
    "actual-css-closure-order",
  );
}
const actual = actualSources();
function replace(
  sources: Sources,
  file: string,
  before: string,
  after: string,
) {
  const target = file.endsWith(".css") ? sources.css : sources.modules;
  const text = target.get(file)!;
  assert.equal(
    text.split(before).length,
    2,
    `mutation-target:${file}:${before}`,
  );
  target.set(file, text.replace(before, after));
}
function reject(name: string, rule: RegExp, mutate: (source: Sources) => void) {
  const variant = clone(actual);
  mutate(variant);
  for (const text of variant.css.values()) postcss.parse(text);
  moduleProgram(variant, () => {});
  assert.throws(
    () => validate(variant),
    (error) =>
      error instanceof assert.AssertionError && rule.test(error.message),
    name,
  );
}
const append = (sources: Sources, file: string, text: string) =>
  sources.css.set(file, sources.css.get(file)! + "\n" + text);

test("popup roots consume exactly the seven original material rules / 28 declarations", () => {
  assert.equal(selectedPopupSurfaceRules.length, 7);
  assert.equal(
    selectedPopupSurfaceRules.reduce((sum, rule) => sum + rule[4].length, 0),
    28,
  );
  validate(actual);
});
test("root and actual variant foreign material writers reject parseable longhands/resets", () => {
  const selectors = [
    ".profile-menu",
    ".appearance-menu",
    ".composer-settings-menu",
    ".composer-error-details",
    ".composer-scope-menu",
    ".application-dock-menu-4",
    ".composer-options:hover",
    '[class~="composer-options"]',
    ".composer\\2d options",
    ":is(.composer-options,.unrelated)",
    "[popover]",
    ".selection-actions",
    ".theme-menu",
    ".workspace-options-menu",
  ];
  for (const selector of selectors)
    reject(selector, /foreign-surface:/, (source) =>
      append(source, "reader.css", `${selector} { background-color: red; }`),
    );
  for (const property of [
    "background",
    "background-image",
    "border",
    "border-left-color",
    "border-radius",
    "border-start-start-radius",
    "box-shadow",
    "backdrop-filter",
    "-webkit-backdrop-filter",
    "all",
  ])
    reject(property, /foreign-surface:/, (source) =>
      append(
        source,
        "reader.css",
        `.composer-options.special { ${property}: initial; }`,
      ),
    );
});
test("exact owner rejects material, importance, context and rule/declaration order drift", () => {
  reject("radius", /surface-exact/, (source) =>
    replace(source, owner, "border-radius: 20px", "border-radius: 18px"),
  );
  reject("background longhand", /surface-exact/, (source) =>
    replace(
      source,
      owner,
      "background: light-dark(#fff, #292929)",
      "background-color: light-dark(#fff, #292929)",
    ),
  );
  reject("prefixed blur", /surface-exact/, (source) => {
    const root = postcss.parse(source.css.get(owner)!);
    root.walkDecls("-webkit-backdrop-filter", (decl) => {
      decl.remove();
    });
    source.css.set(owner, root.toString());
  });
  reject("important", /surface-exact/, (source) =>
    replace(
      source,
      owner,
      "border-radius: 20px",
      "border-radius: 20px !important",
    ),
  );
  reject("layer", /surface-root-tree/, (source) =>
    source.css.set(owner, `@layer popup { ${source.css.get(owner)!} }`),
  );
  reject("media", /surface-root-tree/, (source) =>
    source.css.set(
      owner,
      `@media (min-width: 1px) { ${source.css.get(owner)!} }`,
    ),
  );
  reject("rule order", /surface-exact/, (source) => {
    const root = postcss.parse(source.css.get(owner)!);
    const first = root.nodes.find((node) => node.type === "rule")!;
    first.remove();
    root.append(first);
    source.css.set(owner, root.toString());
  });
  reject("declaration order", /surface-exact/, (source) => {
    const root = postcss.parse(source.css.get(owner)!);
    const rule = root.nodes.filter((node) => node.type === "rule")[1]!;
    const decl = rule.nodes.find((node) => node.type === "decl")!;
    decl.remove();
    rule.append(decl);
    source.css.set(owner, root.toString());
  });
});
test("body portal and Dock specificity cannot be narrowed or flattened", () => {
  reject("portal surface app-only", /surface-exact/, (source) =>
    replace(
      source,
      owner,
      ".selection-actions {\n  background: var(--surface-popover)",
      ".app .selection-actions {\n  background: var(--surface-popover)",
    ),
  );
  reject("Dock specificity lost", /surface-exact/, (source) =>
    replace(
      source,
      owner,
      ".app .composer-options.application-dock-menu",
      ".app .application-dock-menu",
    ),
  );
  reject("actual portal target", /actual-body-portal/, (source) =>
    replace(
      source,
      "SelectionActions.tsx",
      "document.body,",
      'document.getElementById("root")!,',
    ),
  );
  reject("actual native popover", /actual-popover-root/, (source) =>
    replace(
      source,
      "ComposerOptions.tsx",
      'popover="manual"',
      'popover="auto"',
    ),
  );
  // Bounded old competing selectors, not a synthetic general cascade engine.
  const radii = selectedPopupSurfaceRules.filter((rule) =>
    rule[4].some((decl) => decl[0] === "border-radius"),
  );
  const weights = new Map<string, number>([
    [".app .composer-options.application-dock-menu", 3],
    [".composer-options", 1],
    [".app :is(.composer-options,.theme-menu,.workspace-options-menu)", 2],
  ]);
  const dock = radii
    .filter((rule) => weights.has(rule[2]))
    .sort((a, b) => weights.get(a[2])! - weights.get(b[2])!)
    .at(-1)!;
  assert.equal(
    dock[4].find((decl) => decl[0] === "border-radius")?.[1],
    "20px",
  );
  assert.equal(
    selectedPopupSurfaceRules[4][4].find(
      (decl) => decl[0] === "border-radius",
    )?.[1],
    "8px",
  );
});
test("geometry/no-drag/motion and foundation/native-accessibility policy retain their owners", () => {
  reject("geometry", /retained:ui.css:.composer-options/, (source) =>
    replace(source, "ui.css", "  width: 236px;", "  width: 237px;"),
  );
  reject(
    "backdrop drag",
    /retained:ui.css:.composer-options::backdrop/,
    (source) =>
      replace(
        source,
        "ui.css",
        ".composer-options::backdrop {\n  -webkit-app-region: no-drag;",
        ".composer-options::backdrop {\n  -webkit-app-region: drag;",
      ),
  );
  reject(
    "closed hit",
    /retained:visual-system.css:.app .composer-options:not/,
    (source) =>
      replace(
        source,
        "visual-system.css",
        ".app .composer-options:not(:popover-open) {\n  pointer-events: none;",
        ".app .composer-options:not(:popover-open) {\n  pointer-events: auto;",
      ),
  );
  reject(
    "motion",
    /retained:visual-system.css:.app .composer-options:popover-open/,
    (source) =>
      replace(
        source,
        "visual-system.css",
        "animation: menu-content-reveal var(--motion-surface) var(--motion-ease);",
        "animation: none;",
      ),
  );
  reject("native policy portal narrowed", /token-policy/, (source) =>
    replace(
      source,
      "visual-system.css",
      ":root:has(.application-browser-workspace) .selection-actions",
      ":root:has(.application-browser-workspace) .app .selection-actions",
    ),
  );
  reject("extra local token owner", /token-policy/, (source) =>
    append(source, "reader.css", ".composer-options { --popup-blur: none; }"),
  );
  reject("accessibility token", /token-policy/, (source) =>
    replace(
      source,
      "visual-system.css",
      "--popup-blur: blur(20px)",
      "--popup-blur: blur(19px)",
    ),
  );
});
test("actual entry rejects extra, component, CSS, reexport and dynamic popup imports", () => {
  reject("entry moved", /entry-order/, (source) =>
    replace(
      source,
      "main.tsx",
      'import "./ui/popup-surface.css";\nimport "./workflow.css";',
      'import "./workflow.css";\nimport "./ui/popup-surface.css";',
    ),
  );
  reject("duplicate", /single-owner-import/, (source) =>
    source.modules.set(
      "main.tsx",
      source.modules.get("main.tsx")! + '\nimport "./ui/popup-surface.css";',
    ),
  );
  reject("component import", /owner-import/, (source) =>
    source.modules.set(
      "ComposerOptions.tsx",
      source.modules.get("ComposerOptions.tsx")! +
        '\nimport "./ui/popup-surface.css";',
    ),
  );
  reject("bound CSS import", /owner-import/, (source) =>
    replace(
      source,
      "main.tsx",
      'import "./ui/popup-surface.css";',
      'import surface from "./ui/popup-surface.css";',
    ),
  );
  reject("reexport", /owner-reexport/, (source) =>
    source.modules.set("extra.ts", 'export * from "./ui/popup-surface.css";'),
  );
  reject("dynamic", /owner-dynamic/, (source) =>
    source.modules.set("extra.ts", "void import(`./ui/popup-surface.css`);"),
  );
  reject("require", /owner-dynamic/, (source) =>
    source.modules.set("extra.ts", 'require("./ui/popup-surface.css");'),
  );
  reject("CSS import", /css-owner-import/, (source) =>
    append(source, "reader.css", '@import "./ui/popup-surface.css";'),
  );
});
test("actual relative closure rejects unreachable primitive consumers and component CSS reordering", () => {
  reject("menu detached", /actual-consumer-closure/, (source) => {
    for (const [name, text] of source.modules)
      if (name !== "ComposerOptions.tsx")
        source.modules.set(
          name,
          text.replace(
            /from "(?:\.\.\/)*\.\/ComposerOptions\.js"/g,
            'from "./MissingOptions.js"',
          ),
        );
  });
  reject("early owner dependency", /owner-import/, (source) =>
    source.modules.set(
      "ApplicationDock.tsx",
      source.modules.get("ApplicationDock.tsx")! +
        '\nimport "./ui/popup-surface.css";',
    ),
  );
});
test("fields, child buttons/footer, lookalikes and unrelated legitimate module/CSS changes stay legal", () => {
  const variant = clone(actual);
  append(
    variant,
    "reader.css",
    `
    .composer-options > button { background: red; border-radius: 4px; }
    .composer-options input { background-color: white; border: 1px solid red; }
    .selection-actions footer { background: pink; }
    .composer-options > .model-picker { border-top: 2px solid gray; }
    .theme-menu .mode-options button { box-shadow: none; }
    .composer-options-lookalike { background: green; }
    .unrelated:has(.composer-options) { background: white; }
    .unrelated:not(.selection-actions) { border-radius: 5px; }
    :is(.composer-options > button,.selection-actions footer) { background: transparent; }
    .reader-new-feature { --unrelated-token: blue; margin: 3px; background: blue; }
  `,
  );
  variant.modules.set(
    "unrelated-feature.ts",
    'import "./unrelated-feature.css"; export const extension = 1;',
  );
  variant.css.set(
    "unrelated-feature.css",
    ".extension-panel { background: white; border-radius: 2px; }",
  );
  variant.modules.set(
    "main.tsx",
    variant.modules.get("main.tsx")! + '\nimport "./unrelated-feature.js";',
  );
  variant.modules.set(
    "App.tsx",
    variant.modules.get("App.tsx")! +
      "\nexport const unrelatedLegalExtension = true;",
  );
  validate(variant);
});
