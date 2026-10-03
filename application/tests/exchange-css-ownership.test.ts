import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import postcss, { type Rule, type Root } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
} from "typescript/unstable/ast";

// This first CSS boundary governs only the existing resize edge and its shield.
// The literals below are the pre-extraction production rules, not a new visual
// standard. Other exchange geometry and other features remain with their owners.
const layoutFile = "exchange-layout.css";
const visualFile = "visual-system.css";
const legacyResize = `
.exchange-resizer {
  position: absolute;
  z-index: 5;
  top: 0;
  left: 20px;
  right: 20px;
  height: 12px;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
  -webkit-app-region: no-drag;
  border-radius: 4px;
}
.exchange-resizer::after {
  content: "";
  position: absolute;
  top: 3px;
  left: calc(50% - 18px);
  width: 36px;
  height: 3px;
  border-radius: 2px;
  background: var(--line-strong);
}
.exchange-resizer:hover::after,
.exchange-resizer:focus-visible::after,
.exchange-panel[data-resizing] > .exchange-resizer::after {
  background: var(--text-secondary);
}
.exchange-resizer:focus-visible {
  outline: 2px solid var(--accent-strong);
  outline-offset: -2px;
}
.exchange-panel:has(> .exchange-resizer) > .exchange-panel-header {
  padding-top: 14px;
}
.exchange-panel[data-resizing] {
  transition: none;
  animation: none;
}
.exchange-resize-shield {
  position: fixed;
  inset: 0;
  z-index: 1000;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
  -webkit-app-region: no-drag;
}
`;

const key = (selector: string) =>
  selector
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>,])\s*/g, "$1");
const geometry = new Map(
  [
    [
      ".exchange-resizer",
      [
        "position",
        "z-index",
        "top",
        "left",
        "right",
        "height",
        "cursor",
        "touch-action",
        "user-select",
        "-webkit-app-region",
      ],
    ],
    [
      ".exchange-resizer::after",
      ["position", "top", "left", "width", "height"],
    ],
    [
      ".exchange-panel:has(> .exchange-resizer) > .exchange-panel-header",
      ["padding-top"],
    ],
    [
      ".exchange-resize-shield",
      [
        "position",
        "inset",
        "z-index",
        "cursor",
        "touch-action",
        "user-select",
        "-webkit-app-region",
      ],
    ],
  ].map(([selector, properties]) => [
    key(selector as string),
    new Set(properties as string[]),
  ]),
);
type Declaration = { property: string; value: string; important: boolean };
type Signature = {
  selector: string;
  context: string[];
  declarations: Declaration[];
};
function signature(rule: Rule): Signature {
  const context: string[] = [];
  for (let node = rule.parent; node && node.type !== "root"; node = node.parent)
    context.unshift(
      node.type === "atrule"
        ? `@${node.name} ${node.params}`.trim()
        : `nested:${key(node.selector)}`,
    );
  return {
    selector: key(rule.selector),
    context,
    declarations: rule.nodes
      .filter((node) => node.type !== "comment")
      .map((node) =>
        node.type === "decl"
          ? {
              property: node.prop,
              value: node.value,
              important: !!node.important,
            }
          : {
              property: `unexpected:${node.type}`,
              value: "",
              important: false,
            },
      ),
  };
}
function rules(root: Root) {
  const result: Signature[] = [];
  root.walkRules((rule) => {
    result.push(signature(rule));
  });
  return result;
}
const legacyRules = rules(postcss.parse(legacyResize));
function partition(layout: boolean) {
  return legacyRules.flatMap((rule) => {
    const properties = geometry.get(rule.selector);
    const declarations = rule.declarations.filter(
      (declaration) => !!properties?.has(declaration.property) === layout,
    );
    return declarations.length ? [{ ...rule, declarations }] : [];
  });
}
const expectedLayout = partition(true);
const expectedVisual = partition(false);
function governed(selector: string) {
  // Recognize the same named boundary when CSS spells it as an attribute or
  // escaped identifier; do not mistake an unrelated -demo class for this owner.
  // This is deliberately bounded, not a general selector-matching engine.
  const decoded = selector.replace(
    /\\([\da-f]{1,6})(?:\s)?|\\([^\n\r\f])/gi,
    (_, hex: string | undefined, character: string | undefined) => {
      if (!hex) return character!;
      const point = parseInt(hex, 16);
      return String.fromCodePoint(
        point > 0 && point <= 0x10ffff ? point : 0xfffd,
      );
    },
  );
  if (/\.(?:exchange-resizer|exchange-resize-shield)(?![\w-])/.test(decoded))
    return true;
  const attributes = new Map<string, string>();
  for (const match of decoded.matchAll(
    /\[\s*([\w-]+)\s*(?:~=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g,
  )) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4]!;
    attributes.set(name, value);
    if (
      name === "class" &&
      value
        .split(/\s+/)
        .some(
          (token) =>
            token === "exchange-resizer" || token === "exchange-resize-shield",
        )
    )
      return true;
  }
  return (
    (/\.exchange-panel(?![\w-])/.test(decoded) &&
      /\[\s*data-resizing\s*\]/.test(decoded)) ||
    (attributes.get("role") === "separator" &&
      attributes.get("aria-label") === "调整消息区高度")
  );
}

// Preserve the actual competing rules, including the higher-specificity shared
// focus rule. Its +2px offset wins over the local -2px; this migration must not
// accidentally "fix" that existing appearance or move header padding wholesale.
const legacyCompetitors = `
.app :is(button, a, summary, [tabindex]):focus-visible { outline-offset: 2px; }
.exchange-panel-header {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  min-width: 0;
  padding: 8px 12px 0;
}
.exchange-panel-header:not(:has(.conversation-scope)) { display: none; }
.exchange-panel:has(> .exchange-controls-slot) > .exchange-panel-header {
  padding-right: calc(var(--exchange-controls-width) + 24px);
}
@container exchange (max-width: 540px) {
  .exchange-panel-header { flex-wrap: wrap; }
}
`;
const competitorRules = rules(postcss.parse(legacyCompetitors));
const competitorSelectors = new Set(
  competitorRules.map((rule) => rule.selector),
);
function isLayoutSpecifier(specifier: string) {
  return specifier.split(/[?#]/, 1)[0]!.endsWith(`/${layoutFile}`);
}
type Sources = { css: Map<string, string>; modules: Map<string, string> };
function violations(sources: Sources) {
  const result: string[] = [];
  const parsed = new Map<string, Root>();
  for (const [file, source] of sources.css) {
    try {
      parsed.set(file, postcss.parse(source, { from: file }));
    } catch {
      result.push(`parse:${file}`);
    }
  }
  const layout = parsed.get(layoutFile);
  const visual = parsed.get(visualFile);
  if (!layout || !visual) return [...result, "missing-owner"];
  if (
    layout.nodes.some(
      (node) => node.type !== "rule" && node.type !== "comment",
    ) ||
    JSON.stringify(rules(layout)) !== JSON.stringify(expectedLayout)
  )
    result.push("layout-exact-geometry");
  if (
    JSON.stringify(rules(visual).filter((rule) => governed(rule.selector))) !==
    JSON.stringify(expectedVisual)
  )
    result.push("visual-exact-drawing");
  for (const [file, root] of parsed) {
    root.walkAtRules("import", (node) => {
      if (node.params.includes(layoutFile)) result.push(`css-import:${file}`);
    });
    if (file === layoutFile || file === visualFile) continue;
    if (rules(root).some((rule) => governed(rule.selector)))
      result.push(`foreign-owner:${file}`);
    if (rules(root).some((rule) => competitorSelectors.has(rule.selector)))
      result.push(`foreign-competitor:${file}`);
  }
  if (
    JSON.stringify(
      rules(visual).filter((rule) => competitorSelectors.has(rule.selector)),
    ) !== JSON.stringify(competitorRules)
  )
    result.push("original-competitors");

  // A single direct side-effect import fixes composition independently of which
  // feature happens to be visited. Additional literal static/dynamic imports
  // of this owner cannot silently change development or bundled loading order.
  const directory = "/morphz-exchange-css-fixtures";
  const files = Object.fromEntries(
    [...sources.modules].map(([file, text]) => [`${directory}/${file}`, text]),
  );
  const config = `${directory}/tsconfig.json`;
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: [...sources.modules.keys()],
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      if (project.program.getSyntacticDiagnostics().length)
        result.push("module-parse");
      let imports = 0;
      for (const file of sources.modules.keys()) {
        const source = project.program.getSourceFile(`${directory}/${file}`)!;
        const direct = source.statements.flatMap((statement) =>
          isImportDeclaration(statement) &&
          isStringLiteral(statement.moduleSpecifier)
            ? [statement]
            : [],
        );
        for (const statement of direct) {
          const specifier = statement.moduleSpecifier;
          if (!isStringLiteral(specifier)) continue;
          if (!isLayoutSpecifier(specifier.text)) continue;
          imports++;
          if (file !== "main.tsx" || statement.importClause)
            result.push(`component-import:${file}`);
          const index = direct.indexOf(statement);
          const previous = direct[index - 1]?.moduleSpecifier;
          const next = direct[index + 1]?.moduleSpecifier;
          if (
            !previous ||
            !isStringLiteral(previous) ||
            previous.text !== `./${visualFile}` ||
            !next ||
            !isStringLiteral(next) ||
            next.text !== "./inspector.css" ||
            specifier.text !== `./${layoutFile}`
          )
            result.push("entry-order");
        }
        function walk(node: Node) {
          if (
            isExportDeclaration(node) &&
            node.moduleSpecifier &&
            isStringLiteral(node.moduleSpecifier) &&
            isLayoutSpecifier(node.moduleSpecifier.text)
          )
            result.push(`reexport:${file}`);
          if (
            isCallExpression(node) &&
            node.expression.kind === SyntaxKind.ImportKeyword &&
            node.arguments.some(
              (argument) =>
                (isStringLiteral(argument) ||
                  isNoSubstitutionTemplateLiteral(argument)) &&
                isLayoutSpecifier(argument.text),
            )
          )
            result.push(`dynamic-import:${file}`);
          node.forEachChild(walk);
        }
        walk(source);
      }
      if (imports !== 1) result.push("single-entry-import");
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
  return result;
}

function readSources(): Sources {
  const directory = "apps/web/src";
  const css = new Map<string, string>();
  const modules = new Map<string, string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const name = relative(directory, file);
        if (file.endsWith(".css")) css.set(name, readFileSync(file, "utf8"));
        else if (/\.tsx?$/.test(file))
          modules.set(name, readFileSync(file, "utf8"));
      }
    }
  }
  visit(directory);
  return { css, modules };
}
const production = readSources();
function cloneSources(): Sources {
  return {
    css: new Map(production.css),
    modules: new Map(production.modules),
  };
}

test("交流伸缩的首个 CSS owner 精确保存原23项几何与9项绘制声明", () => {
  assert.deepEqual(violations(production), []);
  assert.equal(
    expectedLayout.reduce((sum, rule) => sum + rule.declarations.length, 0),
    23,
  );
  assert.equal(
    expectedVisual.reduce((sum, rule) => sum + rule.declarations.length, 0),
    9,
  );
  const extracted = [
    ...rules(postcss.parse(production.css.get(layoutFile)!)),
    ...rules(postcss.parse(production.css.get(visualFile)!)).filter((rule) =>
      governed(rule.selector),
    ),
  ];
  // Recompose each original rule in its original declaration order. Only
  // disjoint longhands were split; no shorthand/important/context was invented.
  const recomposed = legacyRules.map((old) => {
    const declarations = extracted
      .filter((rule) => rule.selector === old.selector)
      .flatMap((rule) => rule.declarations);
    return {
      ...old,
      declarations: old.declarations.map((declaration) => {
        const matches = declarations.filter(
          (candidate) => candidate.property === declaration.property,
        );
        assert.equal(matches.length, 1);
        return matches[0]!;
      }),
    };
  });
  assert.deepEqual(recomposed, legacyRules);
});

type Weight = [number, number, number];
function winner(
  source: Signature[],
  target: "header" | "focus",
  property: "padding-top" | "padding-right" | "outline-offset",
) {
  // These exact selectors are already AST-checked above. Their old specificity
  // is known; this is a bounded competing-rule model, not a general CSS engine.
  const matches = new Map<string, { target: typeof target; weight: Weight }>([
    [key(".exchange-panel-header"), { target: "header", weight: [0, 1, 0] }],
    [
      key(".exchange-panel:has(> .exchange-resizer) > .exchange-panel-header"),
      { target: "header", weight: [0, 3, 0] },
    ],
    [
      key(
        ".exchange-panel:has(> .exchange-controls-slot) > .exchange-panel-header",
      ),
      { target: "header", weight: [0, 3, 0] },
    ],
    [
      key(".exchange-resizer:focus-visible"),
      { target: "focus", weight: [0, 2, 0] },
    ],
    [
      key(".app :is(button, a, summary, [tabindex]):focus-visible"),
      { target: "focus", weight: [0, 3, 0] },
    ],
  ]);
  let chosen: { value: string; rank: number[] } | undefined;
  source.forEach((rule, order) => {
    const match = matches.get(rule.selector);
    if (!match || match.target !== target) return;
    rule.declarations.forEach((declaration) => {
      let value: string | undefined;
      if (declaration.property === property) value = declaration.value;
      else if (declaration.property === "padding") {
        const [top, right = top] = declaration.value.split(/\s+/);
        if (property === "padding-top") value = top;
        if (property === "padding-right") value = right;
      }
      if (value === undefined) return;
      const rank = [Number(declaration.important), ...match.weight, order];
      const comparison = chosen
        ? rank.map((part, index) => part - chosen!.rank[index]!).find(Boolean)
        : 1;
      if ((comparison ?? 0) > 0) chosen = { value, rank };
    });
  });
  return chosen?.value;
}
test("拆分前后保持标题longhand及共享焦点的原竞争结果", () => {
  const before = [...competitorRules, ...legacyRules];
  const after = [
    ...rules(postcss.parse(production.css.get(visualFile)!)),
    ...rules(postcss.parse(production.css.get(layoutFile)!)),
  ];
  for (const [target, property, value] of [
    ["header", "padding-top", "14px"],
    ["header", "padding-right", "calc(var(--exchange-controls-width) + 24px)"],
    ["focus", "outline-offset", "2px"],
  ] as const) {
    assert.equal(winner(before, target, property), value);
    assert.equal(
      winner(after, target, property),
      winner(before, target, property),
    );
  }
});

test("AST所有权门禁拒绝几何、绘制、上下文与第二owner的真实反例", () => {
  const fixtures: [string, (sources: Sources) => void, string][] = [
    [
      "changed-value",
      (s) =>
        s.css.set(
          layoutFile,
          s.css.get(layoutFile)!.replace("left: 20px", "left: 19px"),
        ),
      "layout-exact-geometry",
    ],
    [
      "important",
      (s) =>
        s.css.set(
          layoutFile,
          s.css
            .get(layoutFile)!
            .replace("height: 12px", "height: 12px !important"),
        ),
      "layout-exact-geometry",
    ],
    [
      "specificity",
      (s) =>
        s.css.set(
          layoutFile,
          s.css
            .get(layoutFile)!
            .replace(".exchange-resizer {", ".app .exchange-resizer {"),
        ),
      "layout-exact-geometry",
    ],
    [
      "selector-list",
      (s) =>
        s.css.set(
          layoutFile,
          s.css
            .get(layoutFile)!
            .replace(
              ".exchange-resizer {",
              ".exchange-resizer, .another-handle {",
            ),
        ),
      "layout-exact-geometry",
    ],
    [
      "inset-shorthand",
      (s) =>
        s.css.set(
          layoutFile,
          s.css.get(layoutFile)! + ".exchange-resizer { inset: 0 20px auto; }",
        ),
      "layout-exact-geometry",
    ],
    [
      "padding-shorthand",
      (s) =>
        s.css.set(
          layoutFile,
          s.css.get(layoutFile)!.replace("padding-top: 14px", "padding: 14px"),
        ),
      "layout-exact-geometry",
    ],
    [
      "material-in-layout",
      (s) =>
        s.css.set(
          layoutFile,
          s.css.get(layoutFile)! + ".exchange-resizer { background: red; }",
        ),
      "layout-exact-geometry",
    ],
    [
      "duplicate-layout",
      (s) =>
        s.css.set(
          layoutFile,
          s.css.get(layoutFile)! + ".exchange-resizer { left: 20px; }",
        ),
      "layout-exact-geometry",
    ],
    [
      "duplicate-visual",
      (s) =>
        s.css.set(
          visualFile,
          s.css.get(visualFile)! + ".exchange-resizer { left: 20px; }",
        ),
      "visual-exact-drawing",
    ],
    [
      "foreign-owner",
      (s) => s.css.set("other.css", ":is(.exchange-resizer) { left: 20px; }"),
      "foreign-owner:other.css",
    ],
    [
      "class-attribute-alias",
      (s) =>
        s.css.set(
          "other.css",
          '[class~="exchange-resizer"] { left: 99px !important; }',
        ),
      "foreign-owner:other.css",
    ],
    [
      "role-label-alias",
      (s) =>
        s.css.set(
          "other.css",
          '[role="separator"][aria-label="调整消息区高度"] { left: 99px !important; }',
        ),
      "foreign-owner:other.css",
    ],
    [
      "escaped-class-alias",
      (s) =>
        s.css.set(
          "other.css",
          ".exchange\\2d resizer { left: 99px !important; }",
        ),
      "foreign-owner:other.css",
    ],
    [
      "css-import-alias",
      (s) => s.css.set("other.css", '@import "./exchange-layout.css?direct";'),
      "css-import:other.css",
    ],
    [
      "foreign-header-competitor",
      (s) =>
        s.css.set(
          "other.css",
          ".exchange-panel-header { padding: 99px !important; }",
        ),
      "foreign-competitor:other.css",
    ],
    [
      "foreign-focus-competitor",
      (s) =>
        s.css.set(
          "other.css",
          ".app :is(button, a, summary, [tabindex]):focus-visible { outline-offset: -2px !important; }",
        ),
      "foreign-competitor:other.css",
    ],
    [
      "foreign-qualified-resize-motion",
      (s) =>
        s.css.set(
          "other.css",
          ".app .exchange-panel[data-resizing] { transition: all 3s; }",
        ),
      "foreign-owner:other.css",
    ],
    [
      "changed-focus",
      (s) =>
        s.css.set(
          visualFile,
          s.css
            .get(visualFile)!
            .replace(
              "outline-offset: -2px;\n}\n.exchange-panel[data-resizing]",
              "outline-offset: 0;\n}\n.exchange-panel[data-resizing]",
            ),
        ),
      "visual-exact-drawing",
    ],
    [
      "changed-shared-focus",
      (s) =>
        s.css.set(
          visualFile,
          s.css
            .get(visualFile)!
            .replace("outline-offset: 2px", "outline-offset: -2px"),
        ),
      "original-competitors",
    ],
    [
      "changed-header-base",
      (s) =>
        s.css.set(
          visualFile,
          s.css
            .get(visualFile)!
            .replace("padding: 8px 12px 0", "padding: 8px 20px 0"),
        ),
      "original-competitors",
    ],
    ...[
      "media (min-width: 600px)",
      "supports (display: grid)",
      "container exchange (min-width: 600px)",
      "layer exchange",
    ].map((context): [string, (sources: Sources) => void, string] => [
      context,
      (s) => s.css.set(layoutFile, `@${context} { ${s.css.get(layoutFile)} }`),
      "layout-exact-geometry",
    ]),
    [
      "css-nesting",
      (s) => s.css.set(layoutFile, `.app { ${s.css.get(layoutFile)} }`),
      "layout-exact-geometry",
    ],
  ];
  for (const [name, change, expected] of fixtures) {
    const source = cloneSources();
    change(source);
    assert.ok(
      violations(source).includes(expected),
      `${name} must be rejected`,
    );
  }
});

test("入口AST拒绝顺序漂移、重复及组件或延迟加载", () => {
  const fixtures: [string, (sources: Sources) => void, string][] = [
    [
      "wrong-order",
      (s) =>
        s.modules.set(
          "main.tsx",
          s.modules
            .get("main.tsx")!
            .replace(
              'import "./visual-system.css";\nimport "./exchange-layout.css";',
              'import "./exchange-layout.css";\nimport "./visual-system.css";',
            ),
        ),
      "entry-order",
    ],
    [
      "duplicate-import",
      (s) =>
        s.modules.set(
          "main.tsx",
          s.modules.get("main.tsx")! + '\nimport "./exchange-layout.css";',
        ),
      "single-entry-import",
    ],
    [
      "component-import",
      (s) =>
        s.modules.set(
          "Another.tsx",
          'import "./exchange-layout.css"; export const Component = () => null;',
        ),
      "component-import:Another.tsx",
    ],
    [
      "dynamic-import",
      (s) =>
        s.modules.set(
          "Another.tsx",
          'export async function load() { await import("./exchange-layout.css"); }',
        ),
      "dynamic-import:Another.tsx",
    ],
    [
      "template-import",
      (s) =>
        s.modules.set(
          "Another.tsx",
          "export async function load() { await import(`./exchange-layout.css`); }",
        ),
      "dynamic-import:Another.tsx",
    ],
    [
      "reexport",
      (s) =>
        s.modules.set("Another.tsx", 'export * from "./exchange-layout.css";'),
      "reexport:Another.tsx",
    ],
    [
      "query-import",
      (s) =>
        s.modules.set("Another.tsx", 'import "./exchange-layout.css?direct";'),
      "component-import:Another.tsx",
    ],
    [
      "fragment-import",
      (s) =>
        s.modules.set("Another.tsx", 'import "./exchange-layout.css#owner";'),
      "component-import:Another.tsx",
    ],
  ];
  for (const [name, change, expected] of fixtures) {
    const source = cloneSources();
    change(source);
    assert.ok(
      violations(source).includes(expected),
      `${name} must be rejected`,
    );
  }
  const allowed = cloneSources();
  allowed.css.set(
    "unmigrated-feature.css",
    '.legacy-feature { width: 123px; background: red; } .exchange-resizer-demo { width: 123px; } [class~="exchange-resizer-demo"] { height: 30px; } /* .exchange-resizer is only a comment */',
  );
  allowed.css.set(
    layoutFile,
    `/* unrelated whitespace is not a declaration */\n${allowed.css.get(layoutFile)}`,
  );
  assert.deepEqual(violations(allowed), []);
});
