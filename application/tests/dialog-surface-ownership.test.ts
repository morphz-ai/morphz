import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import postcss, { type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
} from "typescript/unstable/ast";
import {
  mixedDialogSurvivors,
  retainedDialogRules,
  retainedDialogTokens,
  selectedDialogSurfaceRules,
  type FrozenDialogRule,
} from "./fixtures/dialog-surface-d6555b2a.js";

// Finite d6555b2a surface contract, not a general selector/cascade theorem or
// rendered-image proof. Geometry, text, child controls, motion and token policy
// retain their owners. The capturing backdrop is an explicit stronger exception.
const owner = "ui/dialog-surface.css";
const sourceDirectory = new URL("../apps/web/src/", import.meta.url).pathname;
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
const frozen = (rule: FrozenDialogRule) => [rule[2], rule[3], rule[4]];
const protectedTokens = new Set<string>(
  retainedDialogTokens.flatMap((rule) => rule[4].map((decl) => decl[0])),
);
const surfaceProperty = (property: string) =>
  /^(?:all|background(?:-.*)?|border(?:-.*)?|box-shadow|(?:-webkit-)?backdrop-filter)$/.test(
    property.toLowerCase(),
  );

function decode(selector: string) {
  return selector.replace(
    /\\([\da-f]{1,6})(?:\s)?|\\([^\n\r\f])/gi,
    (_, hex: string | undefined, character: string | undefined) =>
      hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : character!,
  );
}
// Only terminal compounds can directly paint a native surface: a dialog's
// footer/input remains independent even when an ancestor names a governed root.
function terminal(selector: string) {
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index]!;
    if (quote) {
      if (character === quote && selector[index - 1] !== "\\") quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    else if (!depth && /[\s>+~]/.test(character)) start = index + 1;
  }
  return selector.slice(start).trim();
}
const rootClasses = new Set([
  "create-dialog",
  "search-dialog",
  "attachment-preview-dialog",
  "capture-dialog",
  // Native <dialog> class variants present in the fixed source. Their child
  // controls still do not become surface writers merely by naming an ancestor.
  "settings-dialog",
  "library-dialog",
  "execution-dialog",
  "application-install",
  "connection-dialog",
  "dictation-consent",
  "voice-dialog",
  "image-preview-dialog",
  "project-dialog",
  "reader-note-dialog",
  "content-metadata-dialog",
  "notification-dialog",
  "script-dialog",
  "script-dialog-compact",
  "browser-bookmarks-dialog",
]);
function compoundPaintsSurface(compound: string): boolean {
  let plain = "";
  let restrictiveFunction = false;
  let functionalRoot = false;
  for (let index = 0; index < compound.length;) {
    const match = /^:([\w-]+)\(/.exec(compound.slice(index));
    if (!match) {
      plain += compound[index++];
      continue;
    }
    const begin = index + match[0].length;
    let end = begin;
    let depth = 1;
    let quote = "";
    for (; end < compound.length && depth; end++) {
      const character = compound[end]!;
      if (quote) {
        if (character === quote && compound[end - 1] !== "\\") quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "(") depth++;
      else if (character === ")") depth--;
    }
    if (match[1] === "is" || match[1] === "where") {
      restrictiveFunction = true;
      functionalRoot ||= paintsSurface(compound.slice(begin, end - 1));
    }
    // :has/:not/nth-* do not make their argument the painted subject.
    index = end;
  }
  const withoutAttributes = plain.replace(/\[[^\]]*\]/g, "");
  if (/::(?!backdrop\b)[\w-]+/.test(withoutAttributes)) return false;
  if (functionalRoot) return true;
  const classes = [
    ...plain.matchAll(
      /\[class\s*(?:~=|=)\s*(?:(["'])(.*?)\1|([^\s\]]+))\s*\]/gi,
    ),
  ].flatMap((match) => (match[2] ?? match[3]!).split(/\s+/));
  if (classes.some((name) => rootClasses.has(name))) return true;
  plain = withoutAttributes;
  // Attribute-only and exclusion/relational-only terminal subjects have an
  // implicit universal subject and may paint a native dialog. This deliberately
  // conservative finite restriction does not apply to typed/classed children.
  if (
    !restrictiveFunction &&
    !classes.length &&
    (plain === "" || plain === "::backdrop")
  )
    return true;
  if (/^(?:(?:[\w-]+|\*)\|)?(?:dialog|\*)(?=[.#[:]|$)/i.test(plain))
    return true;
  return [...plain.matchAll(/\.([\w-]+)/g)].some((match) =>
    rootClasses.has(match[1]!),
  );
}
function paintsSurface(selector: string): boolean {
  return postcss.list
    .comma(decode(selector))
    .some((branch) => compoundPaintsSurface(terminal(branch.trim())));
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}
function actualSources(): Sources {
  const paths = filesIn(sourceDirectory).sort();
  const read = (extension: RegExp) =>
    new Map(
      paths
        .filter((file) => extension.test(file))
        .map(
          (file) =>
            [
              relative(sourceDirectory, file),
              readFileSync(file, "utf8"),
            ] as const,
        ),
    );
  return { css: read(/\.css$/), modules: read(/\.tsx?$/) };
}
function clone(sources: Sources): Sources {
  return { css: new Map(sources.css), modules: new Map(sources.modules) };
}
function moduleProgram(
  sources: Sources,
  consume: (file: string, node: Node) => void,
) {
  const directory = "/morphz-dialog-surface";
  const config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    [...sources.modules].map(([name, text]) => [`${directory}/${name}`, text]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: [...sources.modules.keys()],
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)!.program;
      assert.equal(program.getSyntacticDiagnostics().length, 0, "module-parse");
      for (const name of sources.modules.keys())
        consume(name, program.getSourceFile(`${directory}/${name}`)!);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
const ownerSpecifier = (specifier: string) =>
  specifier.split(/[?#]/)[0]!.endsWith(`/${owner}`);
function validate(sources: Sources) {
  const parsed = new Map(
    [...sources.css].map(([name, text]) => [name, postcss.parse(text)]),
  );
  const surface = parsed.get(owner)!;
  assert.ok(surface, "surface-exact");
  assert.ok(
    surface.nodes.every(
      (node) => node.type === "comment" || node.type === "rule",
    ),
    "surface-root-tree",
  );
  const selected: unknown[] = [];
  surface.walkRules((rule) => {
    selected.push(signature(rule));
  });
  assert.deepEqual(
    selected,
    selectedDialogSurfaceRules.map(frozen),
    "surface-exact",
  );
  for (const old of [...mixedDialogSurvivors, ...retainedDialogRules]) {
    const matches: unknown[] = [];
    parsed.get(old[0])!.walkRules((rule) => {
      if (
        key(rule.selector) === old[2] &&
        JSON.stringify(context(rule)) === JSON.stringify(old[3])
      )
        matches.push(signature(rule));
    });
    assert.deepEqual(matches, [frozen(old)], `retained:${old[0]}:${old[2]}`);
  }
  const tokens: unknown[] = [];
  for (const [name, root] of parsed) {
    root.walkAtRules("import", (rule) => {
      assert.ok(
        !rule.params.includes("dialog-surface.css"),
        "css-owner-import",
      );
    });
    root.walkRules((rule) => {
      const declarations = rule.nodes.filter((node) => node.type === "decl");
      const policy = declarations.filter((decl) =>
        protectedTokens.has(decl.prop),
      );
      if (policy.length)
        tokens.push([
          name,
          key(rule.selector),
          context(rule),
          policy.map((decl) => [decl.prop, decl.value, !!decl.important]),
        ]);
      if (name === owner || !paintsSurface(rule.selector)) return;
      const paint = declarations.filter((decl) => surfaceProperty(decl.prop));
      if (!paint.length) return;
      const capture = retainedDialogRules.find(
        (old) => old[0] === "workflow.css",
      )!;
      assert.ok(
        name === capture[0] &&
          JSON.stringify(signature(rule)) === JSON.stringify(frozen(capture)),
        `foreign-surface:${name}:${key(rule.selector)}`,
      );
    });
  }
  assert.deepEqual(
    tokens,
    retainedDialogTokens.map((rule) => [rule[0], ...frozen(rule)]),
    "token-policy",
  );
  let imports = 0;
  moduleProgram(sources, (file, source) => {
    const direct: string[] = [];
    source.forEachChild((node) => {
      if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        direct.push(specifier);
        if (!ownerSpecifier(specifier)) return;
        imports++;
        assert.ok(
          file === "main.tsx" &&
            !node.importClause &&
            specifier === `./${owner}`,
          "owner-import",
        );
      }
    });
    if (file === "main.tsx") {
      const at = direct.indexOf(`./${owner}`);
      assert.ok(
        at > 0 &&
          direct[at - 1] === "./workflow.css" &&
          direct[at + 1] === "./visual-system.css",
        "entry-order",
      );
    }
    function walk(node: Node) {
      if (
        isExportDeclaration(node) &&
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier)
      )
        assert.ok(!ownerSpecifier(node.moduleSpecifier.text), "owner-reexport");
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
              ownerSpecifier(argument.text),
          ),
          "owner-dynamic",
        );
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
  });
  assert.equal(imports, 1, "single-owner-import");
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
    `mutation target:${file}:${before}`,
  );
  target.set(file, text.replace(before, after));
}
function rejected(
  name: string,
  rule: RegExp,
  mutate: (sources: Sources) => void,
) {
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

test("native dialog surface has one fixed old paint owner and preserved fallback/capture/token contracts", () => {
  assert.equal(selectedDialogSurfaceRules.length, 8);
  assert.equal(
    selectedDialogSurfaceRules.reduce((sum, rule) => sum + rule[4].length, 0),
    18,
  );
  validate(actual);
});
test("surface and finite root competitors reject legal declaration/context drift", () => {
  const variants: [string, RegExp, (sources: Sources) => void][] = [
    [
      "app radius",
      /surface-exact/,
      (s) => replace(s, owner, "border-radius: 14px", "border-radius: 12px"),
    ],
    [
      "bare create fallback",
      /surface-exact/,
      (s) => replace(s, owner, "border-radius: 15px", "border-radius: 14px"),
    ],
    [
      "background shorthand",
      /surface-exact/,
      (s) =>
        replace(
          s,
          owner,
          "background: var(--surface-dialog)",
          "background-color: var(--surface-dialog)",
        ),
    ],
    [
      "prefixed blur removed",
      /surface-exact/,
      (s) =>
        replace(
          s,
          owner,
          "  -webkit-backdrop-filter: var(--popup-blur);\n",
          "",
        ),
    ],
    [
      "important",
      /surface-exact/,
      (s) =>
        replace(
          s,
          owner,
          "border-radius: 14px;",
          "border-radius: 14px !important;",
        ),
    ],
    [
      "declaration order",
      /surface-exact/,
      (s) =>
        replace(
          s,
          owner,
          "  border-color: var(--line);\n  border-radius: 14px;",
          "  border-radius: 14px;\n  border-color: var(--line);",
        ),
    ],
    [
      "owner geometry",
      /surface-exact/,
      (s) =>
        s.css.set(
          owner,
          s.css.get(owner)! + "\n.create-dialog { width: 5px; }\n",
        ),
    ],
    [
      "owner text",
      /surface-exact/,
      (s) =>
        s.css.set(
          owner,
          s.css.get(owner)! + "\n.create-dialog { color: red; }\n",
        ),
    ],
    [
      "owner media scope",
      /surface-root-tree/,
      (s) =>
        s.css.set(owner, `@media (min-width: 1px) { ${s.css.get(owner)} }`),
    ],
    [
      "empty layer",
      /surface-root-tree/,
      (s) => s.css.set(owner, s.css.get(owner)! + "\n@layer future;\n"),
    ],
    [
      "mixed survivor padding",
      /retained:ui.css/,
      (s) =>
        replace(
          s,
          "ui.css",
          "padding: 4px 12px 12px;",
          "padding: 3px 12px 12px;",
        ),
    ],
    [
      "capture opaque",
      /retained:workflow.css/,
      (s) =>
        replace(
          s,
          "workflow.css",
          '.capture-dialog[data-capturing="true"]::backdrop {\n  visibility: hidden;\n  background: transparent;',
          '.capture-dialog[data-capturing="true"]::backdrop {\n  visibility: hidden;\n  background: black;',
        ),
    ],
    [
      "native token policy",
      /token-policy/,
      (s) =>
        replace(
          s,
          "visual-system.css",
          "--surface-dialog: light-dark(#fffffffa, #272727fa)",
          "--surface-dialog: var(--popup-solid)",
        ),
    ],
    [
      "reduced transparency context",
      /token-policy/,
      (s) =>
        replace(
          s,
          "visual-system.css",
          "@media (prefers-reduced-transparency: reduce)",
          "@media (prefers-reduced-transparency: no-preference)",
        ),
    ],
    [
      "CSS duplicate import",
      /css-owner-import/,
      (s) => s.css.set("future.css", '@import "./ui/dialog-surface.css";'),
    ],
  ];
  for (const selector of [
    "dialog",
    "dialog.create-dialog",
    ".app .capture-dialog",
    ":is(.x,.create-dialog)",
    ":where(.create-dialog)",
    ".app .\\63 reate-dialog",
    '[class~="search-dialog"]',
    '[class="x attachment-preview-dialog"]',
    ".create-dialog.search-dialog::backdrop",
  ])
    variants.push([
      `root writer ${selector}`,
      /foreign-surface/,
      (s) => s.css.set("future.css", `${selector} { background-color: red; }`),
    ]);
  for (const property of [
    "background-image",
    "border-left-width",
    "border-bottom-style",
    "border-top-color",
    "border-start-start-radius",
    "all",
    "backdrop-filter",
    "-webkit-backdrop-filter",
  ])
    variants.push([
      `shorthand/longhand ${property}`,
      /foreign-surface/,
      (s) => s.css.set("future.css", `dialog { ${property}: initial; }`),
    ]);
  variants.push([
    "capture exception cannot relocate",
    /foreign-surface/,
    (s) =>
      s.css.set(
        "future.css",
        '.capture-dialog[data-capturing="true"]::backdrop { visibility: hidden; background: transparent; backdrop-filter: none; }',
      ),
  ]);
  for (const [name, rule, mutate] of variants) rejected(name, rule, mutate);
});
test("actual composition rejects alternate imports without freezing unrelated feature imports", () => {
  const variants: [string, RegExp, (sources: Sources) => void][] = [
    [
      "owner moved after visual",
      /entry-order/,
      (s) =>
        replace(
          s,
          "main.tsx",
          `import "./${owner}";\nimport "./visual-system.css";`,
          `import "./visual-system.css";\nimport "./${owner}";`,
        ),
    ],
    [
      "duplicate component import",
      /owner-import/,
      (s) => s.modules.set("future.ts", `import "./${owner}";`),
    ],
    [
      "import clause",
      /owner-import/,
      (s) =>
        replace(
          s,
          "main.tsx",
          `import "./${owner}";`,
          `import surface from "./${owner}";`,
        ),
    ],
    [
      "owner query",
      /owner-import/,
      (s) =>
        replace(
          s,
          "main.tsx",
          `import "./${owner}";`,
          `import "./${owner}?direct";`,
        ),
    ],
    [
      "reexport",
      /owner-reexport/,
      (s) => s.modules.set("future.ts", `export * from "./${owner}";`),
    ],
    [
      "dynamic later sibling",
      /owner-dynamic/,
      (s) =>
        s.modules.set("future.ts", `const earlier = 1;\nimport("./${owner}");`),
    ],
    [
      "template literal",
      /owner-dynamic/,
      (s) => s.modules.set("future.ts", "import(`./ui/dialog-surface.css`);"),
    ],
    [
      "require hash",
      /owner-dynamic/,
      (s) => s.modules.set("future.ts", `require("./${owner}#later");`),
    ],
  ];
  for (const [name, rule, mutate] of variants) rejected(name, rule, mutate);
  const legal = clone(actual);
  legal.css.set(
    "future.css",
    `
    .create-dialog > footer, .create-dialog input { background: red; border: 0; }
    .app :is(.search-dialog,.create-dialog) .field { background-color: red; }
    .create-dialog-demo, [class~="search-dialog-demo"] { background: red; }
    .create-dialog::before, [class~="search-dialog"]::before { background: red; }
    .app :is(.create-dialog)::before, :where(.search-dialog)::after { background: red; }
    .field:not(.create-dialog), .field:has(.create-dialog) { background: red; }
  `,
  );
  legal.modules.set(
    "future.ts",
    'import "./future.css"; export const feature = true;',
  );
  validate(legal);
});

test("real native dialog variant classes and unquoted class subjects cannot add a competing surface", () => {
  for (const selector of [
    ".settings-dialog",
    ".library-dialog",
    ".execution-dialog",
    ".application-install",
    ".connection-dialog",
    ".dictation-consent",
    ".voice-dialog",
    ".image-preview-dialog",
    ".project-dialog",
    ".reader-note-dialog",
    ".content-metadata-dialog",
    ".notification-dialog",
    ".script-dialog",
    ".script-dialog-compact",
    ".browser-bookmarks-dialog",
    "[class~=search-dialog]",
    "[open]",
    ":not(.field)",
    ":has(> header)",
  ])
    rejected(
      `actual native variant ${selector}`,
      /foreign-surface/,
      (sources) =>
        sources.css.set("future.css", `${selector} { background: red; }`),
    );
});
