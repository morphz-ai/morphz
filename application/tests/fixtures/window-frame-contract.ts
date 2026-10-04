// Finite independent whole WindowFrame ownership contract, accepted baseline
// 9a10f743b65650ddd2fd2b09a7c4cc6cac3a6dda. Original preparation remains immutable.
// No registered test/peer fixture imports, Git reads, whole-App hashes or inverse.
import assert from "node:assert/strict";
import { posix } from "node:path";
import postcss, { type Rule, type Root, type ChildNode } from "postcss";
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

export const windowFrameBaseline = "9a10f743b65650ddd2fd2b09a7c4cc6cac3a6dda";
export const windowFrameCarriers = {
  base: "shell/window-frame-base.css",
  composition: "shell/window-frame-composition.css",
} as const;
export const windowFrameMainNeighbors = {
  base: [
    "styles.css",
    windowFrameCarriers.base,
    "shell/workspace-topbar-base.css",
  ],
  composition: [
    "ui.css",
    windowFrameCarriers.composition,
    "shell/workspace-topbar-composition.css",
  ],
} as const;
export type WindowFramePhase = keyof typeof windowFrameCarriers;
export type WindowFrameSources = Readonly<{
  css: ReadonlyMap<string, string>;
  modules: ReadonlyMap<string, string>;
}>;
export type WindowFrameModule = Readonly<{ file: string; source: SourceFile }>;
type Recipe = Readonly<{
  id: string;
  phase?: string;
  file: string;
  first: number;
  last: number;
  declarations?: number;
  context: readonly { open: string; key: string }[];
  raw: string;
}>;
export const windowFrameRecipes = [
  {
    id: "S01",
    phase: "base",
    file: "styles.css",
    first: 90,
    last: 96,
    declarations: 5,
    context: [],
    raw: ".app {\n  display: grid;\n  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);\n  height: 100dvh;\n  min-height: 420px;\n  overflow: hidden;\n}\n",
  },
  {
    id: "S02",
    phase: "base",
    file: "styles.css",
    first: 121,
    last: 130,
    declarations: 8,
    context: [],
    raw: ".sidebar {\n  background: var(--side);\n  border-right: 1px solid var(--hairline);\n  padding: 0 16px 16px;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  overflow: auto;\n  user-select: none;\n}\n",
  },
  {
    id: "S03",
    phase: "base",
    file: "styles.css",
    first: 279,
    last: 281,
    declarations: 1,
    context: [],
    raw: ".sidebar-hidden {\n  grid-template-columns: minmax(0, 1fr);\n}\n",
  },
  {
    id: "S04",
    phase: "base",
    file: "styles.css",
    first: 282,
    last: 284,
    declarations: 1,
    context: [],
    raw: ".sidebar-hidden .sidebar {\n  display: none;\n}\n",
  },
  {
    id: "S05",
    phase: "base",
    file: "styles.css",
    first: 331,
    last: 334,
    declarations: 2,
    context: [],
    raw: '.app[data-desktop="mac"] .wordmark {\n  margin-top: 47px;\n  min-height: 49px;\n}\n',
  },
  {
    id: "S06",
    phase: "base",
    file: "styles.css",
    first: 335,
    last: 343,
    declarations: 7,
    context: [],
    raw: '.app[data-desktop="mac"] .sidebar::before {\n  content: "";\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: var(--sidebar-width);\n  height: 47px;\n  -webkit-app-region: drag;\n}\n',
  },
  {
    id: "S07",
    phase: "base",
    file: "styles.css",
    first: 1766,
    last: 1768,
    declarations: 1,
    context: [
      {
        open: "@media (max-width: 1100px) {",
        key: "apps/web/src/styles.css:@media (max-width: 1100px)",
      },
    ],
    raw: "  .app.sidebar-hidden {\n    grid-template-columns: minmax(0, 1fr);\n  }\n",
  },
  {
    id: "S08",
    phase: "base",
    file: "styles.css",
    first: 1769,
    last: 1771,
    declarations: 1,
    context: [
      {
        open: "@media (max-width: 1100px) {",
        key: "apps/web/src/styles.css:@media (max-width: 1100px)",
      },
    ],
    raw: '  .app[data-desktop="mac"] .sidebar::before {\n    width: var(--sidebar-width);\n  }\n',
  },
  {
    id: "S09",
    phase: "base",
    file: "styles.css",
    first: 1843,
    last: 1847,
    declarations: 2,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/styles.css:@media (max-width: 560px)",
      },
    ],
    raw: "  .app,\n  .app.sidebar-hidden {\n    grid-template-columns: minmax(0, 1fr);\n    grid-template-rows: auto minmax(0, 1fr);\n  }\n",
  },
  {
    id: "S10",
    phase: "base",
    file: "styles.css",
    first: 1848,
    last: 1854,
    declarations: 5,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/styles.css:@media (max-width: 560px)",
      },
    ],
    raw: "  .app .sidebar {\n    display: flex;\n    padding: 0 12px 8px;\n    border-right: 0;\n    border-bottom: 1px solid var(--hairline);\n    overflow: visible;\n  }\n",
  },
  {
    id: "U01",
    phase: "composition",
    file: "ui.css",
    first: 35,
    last: 37,
    declarations: 1,
    context: [],
    raw: ".app.sidebar-hidden {\n  --workspace-offset: 0px;\n}\n",
  },
  {
    id: "U02",
    phase: "composition",
    file: "ui.css",
    first: 191,
    last: 200,
    declarations: 8,
    context: [],
    raw: ".sidebar-header {\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 56px;\n  flex-shrink: 0;\n  gap: 8px;\n  margin-top: 47px;\n}\n",
  },
  {
    id: "U03",
    phase: "composition",
    file: "ui.css",
    first: 201,
    last: 203,
    declarations: 1,
    context: [],
    raw: ".sidebar {\n  container: sidebar / inline-size;\n}\n",
  },
  {
    id: "U04",
    phase: "composition",
    file: "ui.css",
    first: 210,
    last: 213,
    declarations: 2,
    context: [],
    raw: '.app[data-desktop="mac"] .sidebar-header .wordmark {\n  margin-top: 0;\n  min-height: 48px;\n}\n',
  },
  {
    id: "U05",
    phase: "composition",
    file: "ui.css",
    first: 219,
    last: 221,
    declarations: 1,
    context: [
      {
        open: "@media (min-width: 561px) {",
        key: "apps/web/src/ui.css:@media (min-width: 561px)",
      },
    ],
    raw: "  .app.sidebar-compact .sidebar {\n    padding-inline: 12px;\n  }\n",
  },
  {
    id: "U06",
    phase: "composition",
    file: "ui.css",
    first: 222,
    last: 226,
    declarations: 3,
    context: [
      {
        open: "@media (min-width: 561px) {",
        key: "apps/web/src/ui.css:@media (min-width: 561px)",
      },
    ],
    raw: "  .app.sidebar-compact .sidebar-header {\n    flex-direction: column;\n    gap: 4px;\n    margin-bottom: 12px;\n  }\n",
  },
  {
    id: "U07",
    phase: "composition",
    file: "ui.css",
    first: 341,
    last: 352,
    declarations: 10,
    context: [],
    raw: ".sidebar-resizer {\n  position: absolute;\n  left: calc(var(--sidebar-width) - 4px);\n  top: 0;\n  bottom: 0;\n  width: 8px;\n  z-index: 30;\n  cursor: ew-resize;\n  touch-action: none;\n  user-select: none;\n  -webkit-app-region: no-drag;\n}\n",
  },
  {
    id: "U08",
    phase: "composition",
    file: "ui.css",
    first: 353,
    last: 363,
    declarations: 9,
    context: [],
    raw: '.app :is(.sidebar-resizer, .inspector-resizer)::after {\n  content: "";\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 3px;\n  width: 1px;\n  background: var(--hairline);\n  pointer-events: none;\n  transition: background-color 160ms ease;\n}\n',
  },
  {
    id: "U09",
    phase: "composition",
    file: "ui.css",
    first: 364,
    last: 369,
    declarations: 1,
    context: [],
    raw: ".app :is(.sidebar-resizer, .inspector-resizer):hover::after,\n.app :is(.sidebar-resizer, .inspector-resizer):focus-visible::after,\n.app .inspector-resizer:active::after,\n.app[data-sidebar-resizing] .sidebar-resizer::after {\n  background: var(--line-strong);\n}\n",
  },
  {
    id: "U10",
    phase: "composition",
    file: "ui.css",
    first: 370,
    last: 373,
    declarations: 2,
    context: [],
    raw: ".app :is(.sidebar-resizer, .inspector-resizer):focus-visible {\n  outline: none;\n  box-shadow: none;\n}\n",
  },
  {
    id: "U11",
    phase: "composition",
    file: "ui.css",
    first: 376,
    last: 378,
    declarations: 1,
    context: [],
    raw: '.app.sidebar-compact[data-desktop="mac"] .sidebar-resizer {\n  top: 48px;\n}\n',
  },
  {
    id: "U12",
    phase: "composition",
    file: "ui.css",
    first: 379,
    last: 381,
    declarations: 1,
    context: [],
    raw: '.app.sidebar-compact[data-desktop="mac"] .sidebar-resizer::after {\n  top: -48px;\n}\n',
  },
  {
    id: "U13",
    phase: "composition",
    file: "ui.css",
    first: 382,
    last: 390,
    declarations: 7,
    context: [],
    raw: ".sidebar-resize-shield {\n  position: fixed;\n  inset: 0;\n  z-index: 1000;\n  cursor: ew-resize;\n  touch-action: none;\n  user-select: none;\n  -webkit-app-region: no-drag;\n}\n",
  },
  {
    id: "U14",
    phase: "composition",
    file: "ui.css",
    first: 2855,
    last: 2857,
    declarations: 1,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/ui.css:@media (max-width: 560px)",
      },
    ],
    raw: "  .app {\n    --workspace-offset: 0px;\n  }\n",
  },
  {
    id: "U15",
    phase: "composition",
    file: "ui.css",
    first: 2858,
    last: 2860,
    declarations: 1,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/ui.css:@media (max-width: 560px)",
      },
    ],
    raw: "  .sidebar-header {\n    margin-top: 0;\n  }\n",
  },
  {
    id: "U16",
    phase: "composition",
    file: "ui.css",
    first: 2861,
    last: 2863,
    declarations: 1,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/ui.css:@media (max-width: 560px)",
      },
    ],
    raw: '  .app[data-desktop="mac"] .sidebar-header {\n    margin-top: 47px;\n  }\n',
  },
] as const;
export const windowFrameRetainedFamilies = [
  {
    id: "R01",
    file: "ui.css",
    first: 30,
    last: 34,
    context: [],
    raw: ".app {\n  --muted: light-dark(#686868, #a3a3a3);\n  --workspace-offset: var(--sidebar-width);\n  position: relative;\n}\n",
  },
  {
    id: "R02-material",
    file: "visual-system.css",
    first: 98,
    last: 102,
    context: [],
    raw: ".app .sidebar {\n  background: var(--sidebar-fill);\n  border-right-color: var(--sidebar-edge);\n  box-shadow: none;\n}\n",
  },
  {
    id: "R03",
    file: "styles.css",
    first: 344,
    last: 347,
    context: [],
    raw: '.app[data-desktop="mac"] .topbar button,\n.app[data-desktop="mac"] .theme-menu {\n  -webkit-app-region: no-drag;\n}\n',
  },
  {
    id: "R04-ui",
    file: "ui.css",
    first: 204,
    last: 209,
    context: [],
    raw: ".sidebar-header .wordmark {\n  padding: 0 4px;\n  min-height: 48px;\n  font-size: 18px;\n  gap: 8px;\n}\n",
  },
  {
    id: "R04-mobile",
    file: "styles.css",
    first: 1855,
    last: 1859,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/styles.css:@media (max-width: 560px)",
      },
    ],
    raw: "  .wordmark {\n    min-height: 45px;\n    font-size: 17px;\n    padding-inline: 7px;\n  }\n",
  },
  {
    id: "R05",
    file: "styles.css",
    first: 1884,
    last: 1889,
    context: [
      {
        open: "@media (max-width: 560px) {",
        key: "apps/web/src/styles.css:@media (max-width: 560px)",
      },
    ],
    raw: "  .space-label,\n  .sidebar-section,\n  .sidebar-bottom,\n  .app .sidebar-toggle {\n    display: none;\n  }\n",
  },
  {
    id: "R06",
    file: "ui.css",
    first: 325,
    last: 339,
    context: [
      {
        open: "@media (min-width: 561px) {",
        key: "apps/web/src/ui.css:@media (min-width: 561px)",
      },
    ],
    raw: '  .app.sidebar-compact .browser-sidebar-toggle {\n    left: calc(var(--sidebar-width) + 12px);\n  }\n  .app.sidebar-compact[data-desktop="mac"] .browser-sidebar-toggle {\n    left: 100px;\n  }\n  .app.sidebar-compact.application-browser-workspace .browser-toolbar {\n    margin-left: 44px;\n    padding-left: 8px;\n  }\n  .app.sidebar-compact.application-browser-workspace[data-desktop="mac"]\n    .browser-toolbar {\n    margin-left: 60px;\n    padding-left: 12px;\n  }\n',
  },
  {
    id: "R07",
    file: "workflow.css",
    first: 407,
    last: 415,
    context: [],
    raw: ".app.application-immersive {\n  grid-template-columns: minmax(0, 1fr);\n  --workspace-offset: 0px;\n}\n.application-immersive > .sidebar,\n.application-immersive > .workspace > .topbar,\n.application-browser-workspace > .workspace > .topbar {\n  display: none;\n}\n",
  },
  {
    id: "R08",
    file: "workflow.css",
    first: 416,
    last: 446,
    context: [],
    raw: '.app .browser-sidebar-toggle {\n  position: fixed;\n  left: calc(var(--sidebar-width) - 48px);\n  top: 10px;\n  z-index: 5;\n  -webkit-app-region: no-drag;\n}\n.app.sidebar-hidden .browser-sidebar-toggle {\n  left: 12px;\n}\n.app.sidebar-hidden[data-desktop="mac"] .browser-sidebar-toggle {\n  left: 100px;\n}\n.application-immersive .application-canvas,\n.application-browser-workspace .application-canvas {\n  padding: 0;\n}\n.application-immersive .application-pane {\n  position: relative;\n}\n.application-immersive .browser-toolbar,\n.application-browser-workspace .browser-toolbar {\n  position: relative;\n  -webkit-app-region: drag;\n}\n.application-immersive .browser-toolbar button,\n.application-immersive .browser-toolbar form,\n.application-browser-workspace .browser-toolbar button,\n.application-browser-workspace .browser-toolbar form {\n  -webkit-app-region: no-drag;\n}\n',
  },
  {
    id: "R09",
    file: "workflow.css",
    first: 623,
    last: 651,
    context: [],
    raw: '.application-immersive .browser-host,\n.application-browser-workspace .browser-host {\n  border: 0;\n  border-radius: 0;\n  margin: 0;\n}\n.application-immersive .browser-toolbar,\n.application-browser-workspace .browser-toolbar {\n  border: 0;\n  border-radius: 0;\n  margin: 0;\n  height: 52px;\n  min-height: 52px;\n  padding-block: 8px;\n  flex-shrink: 0;\n}\n.application-immersive[data-desktop="mac"] .browser-toolbar,\n.application-browser-workspace.sidebar-hidden[data-desktop="mac"]\n  .browser-toolbar {\n  /* The independently positioned sidebar switch must not sit inside this\n     native drag rectangle. Keep the same total space before browser actions. */\n  margin-left: 132px;\n  padding-left: 12px;\n}\n.application-browser-workspace.sidebar-hidden:not([data-desktop="mac"])\n  .browser-toolbar {\n  margin-left: 44px;\n  padding-left: 8px;\n}\n',
  },
  {
    id: "R10-gap",
    file: "inspector.css",
    first: 41,
    last: 47,
    context: [],
    raw: '.app .workspace:not([data-inspector-mode="docked"]) > .topbar,\n.app .workspace:not([data-inspector-mode="docked"]) .browser-toolbar {\n  /* Padding still belongs to Electron\'s drag rectangle. Leave the sibling\n     controls physically outside it, including while the inspector is closed. */\n  margin-right: var(--inspector-controls-space);\n  padding-right: 0;\n}\n',
  },
  {
    id: "R10-workspace",
    file: "inspector.css",
    first: 62,
    last: 70,
    context: [],
    raw: ".app:is(.application-immersive, .application-browser-workspace) .workspace {\n  --inspector-toolbar-height: 52px;\n  grid-template-rows: minmax(0, 1fr);\n}\n.app:is(.application-immersive, .application-browser-workspace)\n  .workspace\n  > .workspace-body {\n  grid-row: 1;\n}\n",
  },
  {
    id: "R10-resizer",
    file: "inspector.css",
    first: 189,
    last: 199,
    context: [],
    raw: ".inspector-resizer {\n  position: absolute;\n  left: -4px;\n  top: 0;\n  bottom: 0;\n  width: 8px;\n  cursor: col-resize;\n  touch-action: none;\n  z-index: 2;\n  -webkit-app-region: no-drag;\n}\n",
  },
  {
    id: "R11-compact",
    file: "shell/workspace-topbar-composition.css",
    first: 107,
    last: 113,
    context: [
      {
        open: "@media (min-width: 561px) {",
        key: "apps/web/src/shell/workspace-topbar-composition.css:@media (min-width: 561px)",
      },
    ],
    raw: '  .app.sidebar-compact .sidebar-toggle {\n    position: static;\n    transform: none;\n  }\n  .app.sidebar-compact[data-desktop="mac"] .topbar {\n    padding-left: calc(max(0px, 94px - var(--sidebar-width)) + 12px);\n  }\n',
  },
] as const;
const carriers: readonly string[] = Object.values(windowFrameCarriers);
const phases: readonly WindowFramePhase[] = ["base", "composition"];
function guarded(check: () => void, diagnostic: string, errors: string[]) {
  try {
    check();
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    errors.push(diagnostic);
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
    result.unshift(
      parent.type === "atrule"
        ? [parent.name, parent.params]
        : ["nested", (parent as Rule).selector],
    );
  }
  return result;
}
function signature(rule: Rule) {
  return {
    selector: rule.selector,
    context: context(rule),
    declarations: rule.nodes
      .filter((node) => node.type !== "comment")
      .map((node) =>
        node.type === "decl"
          ? {
              property: node.prop,
              value: node.value,
              important: !!node.important,
            }
          : { unexpected: node.type },
      ),
  };
}
function profiles(root: Root) {
  const result: ReturnType<typeof signature>[] = [];
  root.walkRules((rule) => {
    result.push(signature(rule));
  });
  return result;
}
function wrapped(row: Recipe) {
  return row.context.reduceRight(
    (raw, entry) => entry.open + "\n" + raw + "}\n",
    row.raw,
  );
}
// Only adjacent children of the SAME original wrapper are grouped. Distinct
// same-query wrappers separated by original rules are never globally merged.
export function windowFrameCarrierSource(phase: WindowFramePhase) {
  const rows: readonly Recipe[] = windowFrameRecipes.filter(
    (row) => row.phase === phase,
  );
  let result = "";
  for (let at = 0; at < rows.length;) {
    const row = rows[at]!;
    if (!row.context.length) {
      result += row.raw;
      at++;
      continue;
    }
    const key = JSON.stringify(row.context);
    let raw = row.raw;
    at++;
    while (at < rows.length && JSON.stringify(rows[at]!.context) === key)
      raw += rows[at++]!.raw;
    result += wrapped({ ...row, raw });
  }
  return result;
}
function shape(node: Root | ChildNode): unknown {
  if (node.type === "comment") return undefined;
  if (node.type === "rule") return { rule: signature(node) };
  if (node.type === "root" || node.type === "atrule")
    return {
      kind: node.type,
      ...(node.type === "atrule"
        ? { name: node.name, params: node.params }
        : {}),
      children: (node.nodes ?? [])
        .filter((child) => child.type !== "comment")
        .map(shape),
    };
  return { unexpected: node.type };
}
const expectedRoots = new Map(
  phases.map(
    (phase) => [phase, postcss.parse(windowFrameCarrierSource(phase))] as const,
  ),
);
const expectedProfiles = new Map(
  phases.map((phase) => [phase, profiles(expectedRoots.get(phase)!)] as const),
);
const borrowed = windowFrameRetainedFamilies.flatMap((row) =>
  profiles(postcss.parse(wrapped(row))).map((profile) => ({
    id: row.id,
    file: row.file,
    profile,
  })),
);
const key = (profile: ReturnType<typeof signature>) => JSON.stringify(profile);
const movedProfiles = new Set(
  [...expectedProfiles.values()].flatMap((rows) => rows.map(key)),
);

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
// Decode named CSS identifiers, including hexadecimal escape terminators.
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

// Only the styled subject is owned. An App/sidebar ancestor does not make an
// independent feature/nav child a frame writer. :has/:not are predicates.
function selectorParts(code: string, separators: boolean) {
  const result: string[] = [];
  let begin = 0,
    depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (separators ? /[\s>+~]/.test(c) : c === ",")) {
      if (code.slice(begin, i).trim()) result.push(code.slice(begin, i).trim());
      begin = i + 1;
    }
  }
  if (code.slice(begin).trim()) result.push(code.slice(begin).trim());
  return result;
}
const directAnchors = new Set([
  "sidebar",
  "sidebar-header",
  "sidebar-resizer",
  "inspector-resizer",
  "sidebar-resize-shield",
]);
const rootProperties = new Set([
  "all",
  "display",
  "position",
  "inset",
  "inset-inline",
  "inset-block",
  "top",
  "left",
  "right",
  "bottom",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "inline-size",
  "min-inline-size",
  "max-inline-size",
  "block-size",
  "min-block-size",
  "max-block-size",
  "overflow",
  "overflow-x",
  "overflow-y",
  "overflow-inline",
  "overflow-block",
  "--sidebar-width",
  "--workspace-offset",
]);
function subjectClasses(selector: string) {
  const identity = classCode(decoded(selector)).replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    "",
  );
  return selectorParts(withoutPredicates(identity), false).map((branch) => {
    const parts = selectorParts(branch, true),
      subject = parts.at(-1) ?? "";
    return {
      branch,
      subject,
      classes: [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!),
    };
  });
}
function frameWriter(rule: Rule): boolean {
  const props = rule.nodes.filter((n) => n.type === "decl").map((n) => n.prop);
  if (!props.length) return false;
  return subjectClasses(rule.selector).some(({ subject, classes }) => {
    if (classes.some((c) => directAnchors.has(c))) return true;
    if (
      classes.includes("wordmark") &&
      /\[data-desktop\s*=\s*["']?mac/.test(rule.selector)
    )
      return true;
    if (classes.some((c) => c === "app" || c === "sidebar-hidden"))
      return props.some((p) => rootProperties.has(p) || p.startsWith("grid"));
    if (subject.includes("&")) {
      for (let p = rule.parent; p && p.type !== "root"; p = p.parent)
        if (
          p.type === "rule" &&
          frameWriter({ ...p, nodes: rule.nodes } as Rule)
        )
          return true;
    }
    return false;
  });
}
function fallback(rule: Rule) {
  const sig = signature(rule);
  return (
    sig.selector === ".app,\n.startup,\n.connection-screen" &&
    sig.context.length === 0 &&
    sig.declarations.filter(
      (d) =>
        "property" in d &&
        typeof d.property === "string" &&
        (rootProperties.has(d.property) || d.property.startsWith("grid")),
    ).length === 1 &&
    sig.declarations.some(
      (d) =>
        "property" in d &&
        d.property === "--sidebar-width" &&
        d.value === "280px" &&
        !d.important,
    )
  );
}
export function windowFrameCssViolations(css: ReadonlyMap<string, string>) {
  const errors: string[] = [];
  for (const phase of phases)
    guarded(
      () => {
        const text = css.get(windowFrameCarriers[phase]);
        assert.ok(text !== undefined);
        assert.deepEqual(
          shape(postcss.parse(text)),
          shape(expectedRoots.get(phase)!),
        );
      },
      "window-frame:complete-" + phase,
      errors,
    );
  const parsed = new Map(
    [...css].map(([file, text]) => [file, postcss.parse(text, { from: file })]),
  );
  for (const [file, root] of parsed) {
    root.walkAtRules("import", (node) => {
      const specifier = /^\s*(?:url\(\s*)?["']?([^"'\s)]+)["']?/.exec(
        node.params,
      )?.[1];
      const target = specifier
        ? posix.normalize(
            posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]!),
          )
        : undefined;
      guarded(
        () => assert.ok(!target || !carriers.includes(target)),
        "window-frame:css-import",
        errors,
      );
    });
    if (carriers.includes(file)) continue;
    root.walkRules((rule) => {
      const tuple = key(signature(rule));
      for (const seam of borrowed.filter((r) => key(r.profile) === tuple))
        guarded(
          () => assert.equal(file, seam.file),
          "window-frame:retained-origin:" + seam.id,
          errors,
        );
      if (file === "styles.css" && fallback(rule)) return;
      if (!frameWriter(rule) && !movedProfiles.has(tuple)) return;
      guarded(
        () =>
          assert.ok(
            borrowed.some((r) => r.file === file && key(r.profile) === tuple),
          ),
        "window-frame:foreign-writer:" + file,
        errors,
      );
    });
  }
  const foundation = parsed.get("styles.css");
  guarded(
    () =>
      assert.equal(
        foundation?.nodes.filter((n) => n.type === "rule" && fallback(n))
          .length,
        1,
      ),
    "window-frame:width-fallback",
    errors,
  );
  for (const family of windowFrameRetainedFamilies)
    guarded(
      () => {
        const root = parsed.get(family.file);
        assert.ok(root);
        const wanted = borrowed
            .filter((r) => r.id === family.id)
            .map((r) => key(r.profile)),
          actual = profiles(root).map(key);
        for (const tuple of new Set(wanted))
          assert.equal(
            actual.filter((t) => t === tuple).length,
            wanted.filter((t) => t === tuple).length,
          );
        assert.deepEqual(
          actual.filter((t) => wanted.includes(t)),
          wanted,
        );
      },
      "window-frame:" +
        (family.id === "R01" ? "mixed-root" : "retained-tuple:" + family.id),
      errors,
    );
  for (const file of new Set(windowFrameRetainedFamilies.map((r) => r.file)))
    guarded(
      () => {
        const root = parsed.get(file);
        assert.ok(root);
        const wanted = windowFrameRetainedFamilies
          .filter((r) => r.file === file)
          .toSorted((a, b) => a.first - b.first)
          .flatMap((f) =>
            borrowed.filter((r) => r.id === f.id).map((r) => key(r.profile)),
          );
        assert.deepEqual(
          profiles(root)
            .map(key)
            .filter((t) => wanted.includes(t)),
          wanted,
        );
      },
      "window-frame:retained-order:" + file,
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
export function windowFrameEntryFacts(
  modules: readonly WindowFrameModule[],
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
          "window-frame:runtime-origin:" + target,
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
            "window-frame:dynamic-entry",
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
      "window-frame:single-entry:" + file,
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
export function windowFramePhaseViolations(
  main: readonly string[],
  runtime: readonly string[],
) {
  const errors: string[] = [];
  for (const [phase, neighbors] of Object.entries(windowFrameMainNeighbors))
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
        "window-frame:" + label + "-phase:" + phase,
        errors,
      );
  return errors;
}

export function windowFrameConsumerViolations(
  modules: readonly WindowFrameModule[],
) {
  const errors: string[] = [];
  const module = (file: string) => {
    const found = modules.find((m) => m.file === file);
    assert.ok(found);
    return found.source;
  };
  const descendants = (node: Node) => {
    const nodes: Node[] = [];
    function walk(n: Node) {
      nodes.push(n);
      n.forEachChild(walk);
    }
    walk(node);
    return nodes;
  };
  const openings = (node: Node) =>
    descendants(node).filter(
      (n) =>
        n.kind === SyntaxKind.JsxOpeningElement ||
        n.kind === SyntaxKind.JsxSelfClosingElement,
    );
  const className = (node: Node) => {
    const value = (
      node as unknown as { attributes: { properties: Node[] } }
    ).attributes.properties.find(
      (a) =>
        a.kind === SyntaxKind.JsxAttribute &&
        (a as unknown as { name: Node }).name.getText() === "className",
    );
    return value?.getText();
  };
  guarded(
    () => {
      const app = module("App.tsx"),
        all = openings(app);
      const roots = all.filter((n) => className(n)?.includes('"app "'));
      assert.equal(roots.length, 1);
      assert.ok(
        roots[0]!
          .getText()
          .includes('"--sidebar-width": `${leftSidebar.width}px`'),
      );
      const side = all.filter((n) => className(n) === 'className="sidebar"'),
        header = all.filter(
          (n) => className(n) === 'className="sidebar-header"',
        );
      assert.equal(side.length, 1);
      assert.equal(header.length, 1);
      const elements = descendants(app).filter(
        (n) => n.kind === SyntaxKind.JsxElement,
      );
      const root = elements.find(
        (n) =>
          (n as unknown as { openingElement: Node }).openingElement ===
          roots[0],
      );
      const sidebar = elements.find(
        (n) =>
          (n as unknown as { openingElement: Node }).openingElement === side[0],
      );
      const headerElement = elements.find(
        (n) =>
          (n as unknown as { openingElement: Node }).openingElement ===
          header[0],
      );
      assert.ok(root && sidebar && headerElement);
      assert.ok(
        (root as unknown as { children: readonly Node[] }).children.includes(
          sidebar,
        ),
      );
      assert.ok(
        (sidebar as unknown as { children: readonly Node[] }).children.includes(
          headerElement,
        ),
      );
      const handles = all.filter((n) =>
        /^<SidebarResizeHandle\b/.test(n.getText()),
      );
      assert.equal(handles.length, 1);
      for (const attr of [
        "preference={leftSidebarPreference}",
        "scope={navigationProject?.id ?? prefs.view}",
        "onCommit={prefer}",
      ])
        assert.ok(handles[0]!.getText().includes(attr));
      assert.ok(
        descendants(app).some(
          (n) =>
            n.kind === SyntaxKind.JsxExpression &&
            n
              .getText()
              .replace(/\s+/g, " ")
              .includes(
                "prefs.sidebar && !leftSidebar.mobile && !immersiveApplication",
              ),
        ),
      );
    },
    "window-frame:consumer-app",
    errors,
  );
  guarded(
    () => {
      const handle = module("SidebarResizeHandle.tsx");
      const portals = descendants(handle).filter(
        (n) =>
          isCallExpression(n) &&
          isIdentifier(n.expression) &&
          n.expression.text === "createPortal",
      );
      assert.equal(portals.length, 1);
      const portal = portals[0]!;
      assert.ok(isCallExpression(portal));
      assert.equal(portal.arguments.length, 2);
      assert.equal(portal.arguments[1]!.getText(), "document.body");
      assert.ok(
        portal.arguments[0]!.getText().includes(
          'className="sidebar-resize-shield"',
        ),
      );
      const left = openings(handle).filter(
        (n) => className(n) === 'className="sidebar-resizer"',
      );
      assert.equal(left.length, 1);
      assert.ok(left[0]!.getText().includes('role="separator"'));
      assert.ok(
        left[0]!.getText().includes('aria-controls="workspace-sidebar"'),
      );
    },
    "window-frame:consumer-body-portal",
    errors,
  );
  guarded(
    () => {
      const right = openings(module("InspectorPanel.tsx")).filter(
        (n) => className(n) === 'className="inspector-resizer"',
      );
      assert.equal(right.length, 1);
      assert.ok(right[0]!.getText().includes('role="separator"'));
      assert.ok(right[0]!.getText().includes("onKeyDown="));
    },
    "window-frame:consumer-right-handle",
    errors,
  );
  return errors;
}
// Verify BOTH exact carriers and finite retained writers/origins/phases before
// omitting ONLY the two new phase entries for older peer recipes. DAG leaf.
export function verifiedWindowFrameCarrierPhases(
  css: ReadonlyMap<string, string>,
  modules: readonly WindowFrameModule[],
  unbound: (identifier: Identifier) => boolean,
) {
  const facts = windowFrameEntryFacts(modules, css, unbound);
  const errors = [
    ...windowFrameCssViolations(css),
    ...facts.errors,
    ...windowFramePhaseViolations(facts.main, facts.runtime),
    ...windowFrameConsumerViolations(modules),
  ];
  assert.deepEqual(
    errors,
    [],
    "window-frame:complete-handoff:" + errors.join(","),
  );
  return {
    main: facts.main.filter((f) => !carriers.includes(f)),
    runtime: facts.runtime.filter((f) => !carriers.includes(f)),
  };
}
