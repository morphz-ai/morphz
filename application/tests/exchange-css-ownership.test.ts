import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import postcss, { type AtRule, type Rule, type Root } from "postcss";
import {
  selectedFrameRules,
  retainedFrameRules,
  type FrozenRule,
} from "./fixtures/exchange-frame-b9906e0c.js";
import {
  exchangeControlsFile,
  originalExchangeControlFrameTuple,
  exchangeControlsCssViolations,
  exchangeControlsEntryViolations,
  isExchangeControlsSpecifier,
} from "./fixtures/exchange-controls-51af4c20.js";
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

// Finite Exchange frame contract. The resizer literals retain the first-stage
// 23/9 contract; frame tuples come from fixed b9906e0c, not the new owner. Known
// primitive/focus/Dock-reveal/notice/capture competitors retain their owners.
// This is not a generic CSS matcher or whole-product cascade/visual proof.
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
function contexts(rule: Rule | AtRule) {
  const context: string[] = [];
  for (let node = rule.parent; node && node.type !== "root"; node = node.parent)
    context.unshift(
      node.type === "atrule"
        ? `@${node.name} ${node.params}`.trim()
        : `nested:${key(node.selector)}`,
    );
  return context;
}
function signature(rule: Rule): Signature {
  return {
    selector: key(rule.selector),
    context: contexts(rule),
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
const expectedResizeLayout = partition(true);
function frozenSignature(rule: FrozenRule): Signature {
  return {
    selector: rule[2],
    context: [...rule[3]],
    declarations: rule[4].map(([property, value, important]) => ({
      property,
      value,
      important,
    })),
  };
}
const expectedLayout = selectedFrameRules.map(frozenSignature);
const expectedVisual = partition(false);
function decodedSelector(selector: string) {
  return selector.replace(
    /\\([\da-f]{1,6})(?:\s)?|\\([^\n\r\f])/gi,
    (_, hex: string | undefined, character: string | undefined) => {
      if (!hex) return character!;
      const point = parseInt(hex, 16);
      return String.fromCodePoint(
        point > 0 && point <= 0x10ffff ? point : 0xfffd,
      );
    },
  );
}
function governed(
  selector: string,
  classes: readonly string[] = ["exchange-resizer", "exchange-resize-shield"],
) {
  // Bounded class/attribute aliases, not a general selector-matching engine.
  const decoded = decodedSelector(selector);
  if (classes.some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(decoded)))
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
      value.split(/\s+/).some((token) => classes.includes(token))
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
const frameSelectors = new Set([
  ...expectedLayout.map((rule) => rule.selector),
  ...retainedFrameRules.map((rule) => rule[2]),
]);
const frameClasses = [
  "exchange-resizer",
  "exchange-resize-shield",
  "exchange-surface",
  "exchange-panel",
  "exchange-panel-header",
  "exchange-controls-slot",
  "exchange-scope",
  "application-dock-slot",
];
const frameExceptions = new Set([
  ".conversation::-webkit-scrollbar",
  ".app .application-dock",
]);
function frameGoverned(selector: string) {
  // Plain terminal reading/writing roots may be qualified; their message/control
  // descendants do not acquire frame ownership just from an ancestor class.
  // PostCSS's existing comma splitter respects quoted/functional commas; this
  // terminal-compound check deliberately does not interpret arbitrary :is/has.
  return (
    governed(selector) ||
    frameSelectors.has(key(selector)) ||
    frameExceptions.has(key(selector)) ||
    postcss.list.comma(decodedSelector(selector)).some((branch) => {
      const terminal =
        /(?:^|[\s>+~])((?:[a-zA-Z][\w-]*|\*)?(?:\.[\w-]+|\[[^\]]+\])(?:\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^()]*\))?)*)$/.exec(
          branch,
        )?.[1];
      return !!(
        terminal &&
        governed(terminal.split(":", 1)[0]!, [
          ...frameClasses,
          "conversation",
          "composer-dock",
        ])
      );
    })
  );
}
const expectedRetained = new Map<string, Signature[]>();
for (const tuple of retainedFrameRules) {
  const signatures = expectedRetained.get(tuple[0]) ?? [];
  signatures.push(frozenSignature(tuple));
  expectedRetained.set(tuple[0], signatures);
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
  function contract(name: string, check: () => void) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      result.push(name);
    }
  }
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
  // This is current physical ownership, not an inverse of source or a new
  // historical tuple. The complete bounded role must pass before this one
  // immutable retained material tuple can acquire its new physical location.
  const roleErrors = exchangeControlsCssViolations(parsed);
  result.push(...roleErrors);
  const currentRetained = new Map(expectedRetained);
  if (roleErrors.length === 0) {
    const matches = retainedFrameRules.filter(
      (tuple) =>
        JSON.stringify(tuple) ===
        JSON.stringify(originalExchangeControlFrameTuple),
    );
    contract("exchange-controls-retained-handoff", () =>
      assert.equal(matches.length, 1),
    );
    if (matches.length === 1) {
      const material = frozenSignature(matches[0]!);
      const original = expectedRetained.get(visualFile) ?? [];
      const retainedMatches = original.filter(
        (rule) => JSON.stringify(rule) === JSON.stringify(material),
      );
      contract("exchange-controls-retained-handoff", () =>
        assert.equal(retainedMatches.length, 1),
      );
      if (retainedMatches.length === 1) {
        currentRetained.set(
          visualFile,
          original.filter(
            (rule) => JSON.stringify(rule) !== JSON.stringify(material),
          ),
        );
        currentRetained.set(exchangeControlsFile, [material]);
      }
    }
  }
  contract("layout-exact-geometry", () => {
    assert.deepEqual(rules(layout), expectedLayout);
    assert.ok(
      layout.nodes.every((node) =>
        ["rule", "comment", "atrule"].includes(node.type),
      ),
    );
    const allowedContexts = new Set(
      expectedLayout.flatMap((rule) =>
        rule.context.map((_, index) =>
          JSON.stringify(rule.context.slice(0, index + 1)),
        ),
      ),
    );
    layout.walkAtRules((node) => {
      const path = [...contexts(node), `@${node.name} ${node.params}`.trim()];
      assert.ok(
        allowedContexts.has(JSON.stringify(path)),
        "only fixed old media/container paths",
      );
      assert.ok(
        node.nodes?.every((child) =>
          ["rule", "comment", "atrule"].includes(child.type),
        ),
        "wrapper declarations cannot hide outside a rule",
      );
      assert.ok(
        node.nodes?.some((child) => child.type !== "comment"),
        "no empty wrapper, including empty layer",
      );
    });
  });
  if (
    JSON.stringify(rules(visual).filter((rule) => governed(rule.selector))) !==
    JSON.stringify(expectedVisual)
  )
    result.push("visual-exact-drawing");
  for (const [file, root] of parsed) {
    root.walkAtRules("import", (node) => {
      if (node.params.includes(layoutFile)) result.push(`css-import:${file}`);
    });
    if (file !== layoutFile)
      contract(`frame-retained:${file}`, () => {
        assert.deepEqual(
          rules(root).filter((rule) => frameGoverned(rule.selector)),
          currentRetained.get(file) ?? [],
        );
      });
    if (file === layoutFile || file === visualFile) continue;
    if (rules(root).some((rule) => governed(rule.selector)))
      result.push(`foreign-owner:${file}`);
    if (rules(root).some((rule) => competitorSelectors.has(rule.selector)))
      result.push(`foreign-competitor:${file}`);
  }
  contract("original-competitors", () => {
    assert.deepEqual(
      [...rules(visual), ...rules(layout)].filter((rule) =>
        competitorSelectors.has(rule.selector),
      ),
      competitorRules,
    );
  });

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
      // This mandatory phase/origin proof uses the existing parsed program;
      // the role's physical retained mapping is never sufficient on its own.
      result.push(
        ...exchangeControlsEntryViolations(
          [...sources.modules.keys()].map((file) => ({
            file,
            source: project.program.getSourceFile(`${directory}/${file}`)!,
          })),
          sources.css,
          (identifier) => !project.checker.getSymbolAtLocation([identifier])[0],
        ),
      );
      let imports = 0;
      for (const file of sources.modules.keys()) {
        const source = project.program.getSourceFile(`${directory}/${file}`)!;
        const direct = source.statements.flatMap((statement) =>
          isImportDeclaration(statement) &&
          isStringLiteral(statement.moduleSpecifier)
            ? [statement]
            : [],
        );
        if (file === "main.tsx")
          contract("known-composition-order", () => {
            // Actual old bundle placed App's compact/Dock dependencies before
            // main's UI/visual overrides. Preserve this finite import seam and
            // primitive padding precedence, not every unrelated import or CSS.
            const known = [
              "./App.js",
              "./styles.css",
              "./ui.css",
              "./workflow.css",
              `./${visualFile}`,
              `./${layoutFile}`,
              "./inspector.css",
            ];
            assert.deepEqual(
              direct.flatMap((statement) =>
                isStringLiteral(statement.moduleSpecifier) &&
                known.includes(statement.moduleSpecifier.text)
                  ? [statement.moduleSpecifier.text]
                  : [],
              ),
              known,
            );
          });
        for (const statement of direct) {
          const specifier = statement.moduleSpecifier;
          if (!isStringLiteral(specifier)) continue;
          if (!isLayoutSpecifier(specifier.text)) continue;
          imports++;
          if (file !== "main.tsx" || statement.importClause)
            result.push(`component-import:${file}`);
          const index = direct.indexOf(statement);
          const previous = direct[index - 1]?.moduleSpecifier;
          const beforeRole = direct[index - 2]?.moduleSpecifier;
          const next = direct[index + 1]?.moduleSpecifier;
          if (
            !previous ||
            !isStringLiteral(previous) ||
            !isExchangeControlsSpecifier(file, previous.text) ||
            !beforeRole ||
            !isStringLiteral(beforeRole) ||
            beforeRole.text !== `./${visualFile}` ||
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
  assert.deepEqual(
    rules(postcss.parse(production.css.get(layoutFile)!)).filter((rule) =>
      governed(rule.selector),
    ),
    expectedResizeLayout,
  );
  assert.equal(
    expectedResizeLayout.reduce(
      (sum, rule) => sum + rule.declarations.length,
      0,
    ),
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
          layoutFile,
          s.css
            .get(layoutFile)!
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
    const previous = [...source.css];
    change(source);
    assert.notDeepEqual(
      [...source.css],
      previous,
      `${name} must alter actual CSS`,
    );
    assert.ok(
      violations(source).includes(expected),
      `${name} must be rejected`,
    );
  }
});

test("入口AST拒绝顺序漂移、重复及组件或延迟加载", () => {
  const fixtures: [string, (sources: Sources) => void, string][] = [
    ...["./styles.css", "./App.js"].map(
      (specifier): [string, (sources: Sources) => void, string] => [
        `known-composition-${specifier}`,
        (sources) =>
          sources.modules.set(
            "main.tsx",
            sources.modules
              .get("main.tsx")!
              .replace(
                new RegExp(
                  `^import [^\\n]*${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n`,
                  "m",
                ),
                "",
              )
              .replace(
                'import "./inspector.css";',
                `import "./inspector.css";\n${specifier === "./App.js" ? 'import { App } from "./App.js";' : 'import "./styles.css";'}`,
              ),
          ),
        "known-composition-order",
      ],
    ),
    [
      "wrong-order",
      (s) =>
        s.modules.set(
          "main.tsx",
          s.modules
            .get("main.tsx")!
            .replace(
              'import "./visual-system.css";\nimport "./features/exchange/exchange-controls.css";\nimport "./exchange-layout.css";',
              'import "./exchange-layout.css";\nimport "./features/exchange/exchange-controls.css";\nimport "./visual-system.css";',
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
    const previous = [...source.modules];
    change(source);
    assert.notDeepEqual(
      [...source.modules],
      previous,
      `${name} must alter actual modules`,
    );
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

function changeDeclaration(
  sources: Sources,
  file: string,
  selector: string,
  property: string,
  value: string,
  context: readonly string[] = [],
) {
  const root = postcss.parse(sources.css.get(file)!);
  let matches = 0;
  root.walkRules((rule) => {
    if (
      key(rule.selector) !== selector ||
      JSON.stringify(contexts(rule)) !== JSON.stringify(context)
    )
      return;
    rule.walkDecls(property, (declaration) => {
      declaration.value = value;
      matches++;
    });
  });
  assert.equal(
    matches,
    1,
    `${file}:${selector}:${property} fixture must target one actual declaration`,
  );
  sources.css.set(file, root.toString());
}

test("完整frame owner固定旧56规则144声明，已知例外不冒领，无关后代可演进", () => {
  assert.equal(expectedLayout.length, 56);
  assert.equal(
    expectedLayout.reduce((sum, rule) => sum + rule.declarations.length, 0),
    144,
  );
  assert.deepEqual(expectedLayout.slice(-4), expectedResizeLayout);
  assert.equal(retainedFrameRules.length, 36);
  assert.deepEqual(violations(production), []);
  const allowed = cloneSources();
  allowed.css.set(
    "unrelated-feature.css",
    `.conversation .human-message { color: red; }
    .app .exchange-panel .human-message { color: red; }
    .composer-dock .new-feature { width: 123px; }
    .conversation-demo { overflow: hidden; }
    [class~="composer-dock-demo"] { position: fixed; }`,
  );
  allowed.css.set(
    layoutFile,
    postcss.parse(allowed.css.get(layoutFile)!).toString() +
      "\n/* formatting and comments are not new declarations */",
  );
  assert.deepEqual(violations(allowed), []);
});

test("frame有限反例拒绝几何重归属、条件包裹、已知paint与竞争例外漂移", () => {
  const append = (file: string, css: string) => (sources: Sources) =>
    sources.css.set(file, (sources.css.get(file) ?? "") + css);
  const declaration =
    (
      file: string,
      selector: string,
      property: string,
      value: string,
      context: readonly string[] = [],
    ) =>
    (sources: Sources) =>
      changeDeclaration(sources, file, selector, property, value, context);
  const fixtures: [string, (sources: Sources) => void, string][] = [
    [
      "frame-width",
      declaration(layoutFile, ".conversation", "width", "100%"),
      "layout-exact-geometry",
    ],
    [
      "frame-important",
      (sources) => {
        const root = postcss.parse(sources.css.get(layoutFile)!);
        const rule = root.nodes.find(
          (node) =>
            node.type === "rule" && node.selector === ".exchange-surface",
        );
        assert.ok(rule && rule.type === "rule");
        rule.walkDecls("flex", (node) => {
          node.important = true;
        });
        sources.css.set(layoutFile, root.toString());
      },
      "layout-exact-geometry",
    ],
    [
      "container-threshold",
      (sources) =>
        sources.css.set(
          layoutFile,
          sources.css
            .get(layoutFile)!
            .replace("(max-width: 360px)", "(max-width: 361px)"),
        ),
      "layout-exact-geometry",
    ],
    [
      "context-nesting",
      append(
        layoutFile,
        "@media (pointer: coarse) { @container exchange (max-width: 360px) { .application-dock-slot { left: 16px; } } }",
      ),
      "layout-exact-geometry",
    ],
    [
      "empty-layer",
      append(layoutFile, "@layer unknown {}"),
      "layout-exact-geometry",
    ],
    [
      "empty-known-media",
      append(layoutFile, "@media (max-width: 850px) { /* empty */ }"),
      "layout-exact-geometry",
    ],
    [
      "direct-media-declaration",
      append(layoutFile, "@media (max-width: 850px) { --foreign: 1; }"),
      "layout-exact-geometry",
    ],
    [
      "direct-container-declaration",
      append(
        layoutFile,
        "@container exchange (max-width: 360px) { --foreign: 1; }",
      ),
      "layout-exact-geometry",
    ],
    [
      "frame-new-paint",
      append(layoutFile, ".exchange-panel { background: red; }"),
      "layout-exact-geometry",
    ],
    [
      "ui-duplicate-reading-geometry",
      append("ui.css", ".conversation { overflow: hidden; }"),
      "frame-retained:ui.css",
    ],
    [
      "dock-duplicate-anchor",
      append(
        "application-dock.css",
        ".application-dock-slot { bottom: 101%; }",
      ),
      "frame-retained:application-dock.css",
    ],
    [
      "mixed-survivor-paint",
      declaration(visualFile, ".exchange-panel>.conversation", "border", "0"),
      `frame-retained:${visualFile}`,
    ],
    [
      "mixed-survivor-font",
      declaration(
        visualFile,
        ".exchange-scope .conversation-scope",
        "font-size",
        "13px",
      ),
      `frame-retained:${visualFile}`,
    ],
    [
      "dock-reveal",
      declaration(
        "application-dock.css",
        retainedFrameRules[1]![2],
        "pointer-events",
        "none",
      ),
      "frame-retained:application-dock.css",
    ],
    [
      "dock-hover-bridge",
      declaration(
        "application-dock.css",
        ".app .application-dock",
        "padding",
        "7px 0",
      ),
      "frame-retained:application-dock.css",
    ],
    [
      "primitive-reading-padding",
      declaration("styles.css", ".conversation", "padding", "0"),
      "frame-retained:styles.css",
    ],
    [
      "primitive-small-padding",
      declaration("styles.css", ".composer-dock", "padding", "0", [
        "@media (max-width: 560px)",
      ]),
      "frame-retained:styles.css",
    ],
    [
      "scroll-appearance",
      declaration("ui.css", ".conversation", "scrollbar-width", "auto"),
      "frame-retained:ui.css",
    ],
    [
      "capture-display",
      declaration(
        "workflow.css",
        retainedFrameRules.find((rule) => rule[0] === "workflow.css")![2],
        "display",
        "block",
      ),
      "frame-retained:workflow.css",
    ],
    ...(
      [
        ["notice-inset", [], "44px"],
        ["notice-coarse-inset", ["@media (pointer: coarse)"], "60px"],
      ] as const
    ).map(
      ([name, context, value]): [
        string,
        (sources: Sources) => void,
        string,
      ] => [
        name,
        declaration(
          "workspace-notice.css",
          retainedFrameRules.find(
            (rule) =>
              rule[0] === "workspace-notice.css" &&
              rule[4].some((decl) => decl[0] === "top" && decl[1] === value),
          )![2],
          "top",
          "0",
          context,
        ),
        "frame-retained:workspace-notice.css",
      ],
    ),
    ...[
      ".app .conversation { overflow: hidden; }",
      ".app .composer-dock { position: fixed; }",
      ".app section.conversation { overflow: hidden; }",
      ".app div.composer-dock { position: fixed; }",
      ".app .conversation, .legacy-feature { overflow: hidden; }",
      ".app .composer-dock, .legacy-feature { position: fixed; }",
      '[class~="conversation"] { overflow: hidden; }',
      ".app .exchange\\2d panel[data-open] { position: fixed; }",
      ".app .conversation:hover { overflow: hidden; }",
    ].map((css, index): [string, (sources: Sources) => void, string] => [
      `qualified-root-${index}`,
      append("foreign-frame.css", css),
      "frame-retained:foreign-frame.css",
    ]),
  ];
  for (const [name, change, expected] of fixtures) {
    const source = cloneSources();
    const previous = [...source.css];
    change(source);
    assert.notDeepEqual(
      [...source.css],
      previous,
      `${name} must alter actual CSS`,
    );
    // Each frame violation is produced only by contract's AssertionError path;
    // unexpected parser/programming exceptions are not converted into success.
    assert.ok(
      violations(source).includes(expected),
      `${name} must be rejected by ${expected}`,
    );
  }
});
