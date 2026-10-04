import assert from "node:assert/strict";
import { posix } from "node:path";
import postcss, { type AtRule, type Root, type Rule } from "postcss";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import {
  pdfReadingCarriers,
  verifiedPdfCarrierPhases,
} from "./pdf-reading-contract.js";

// Fixed pre-migration payload with bounded current-source validators.
// Complete raw sources came from actual Git; no candidate oracle or CI Git.
export const exchangeControlsFile = "features/exchange/exchange-controls.css";
export const originalExchangeControlsMetadata = {
  baseline: "51af4c208ac4e335caf9e224e412107193f1e98a",
  source: "visual-system.css",
  wholeOriginalSourceSha256:
    "ce4ecc71f0c1c512be619743340b12e6f5b4538d866221afebb907b46da87100",
  historicalFrameFixtureSha256:
    "15cc53b1cbcd42acae149092c9f30ffbd7e915755cc903f47c1138460c08d6b3",
} as const;
export const originalExchangeControlFrameTuple = [
  "visual-system.css",
  104,
  ".app .exchange-panel:has(>.conversation)>.exchange-controls-slot .exchange-view-tools",
  [],
  [
    ["background", "var(--surface-popover)", false],
    ["border-radius", "8px", false],
    ["-webkit-backdrop-filter", "var(--popup-blur)", false],
    ["backdrop-filter", "var(--popup-blur)", false],
  ],
] as const;
export const originalExchangeControlsRules = [
  {
    ordinal: 1,
    source: "visual-system.css",
    first: 486,
    last: 496,
    context: [],
    selector: ".app :is(.composer-media-tools, .exchange-view-tools)",
    declarations: [
      ["display", "flex", false],
      ["align-items", "center", false],
      ["flex-wrap", "wrap", false],
      ["gap", "4px", false],
      ["min-width", "0", false],
      ["padding", "0", false],
      ["border", "0", false],
      ["background", "none", false],
      ["box-shadow", "none", false],
    ],
    raw: ".app :is(.composer-media-tools, .exchange-view-tools) {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 4px;\n  min-width: 0;\n  padding: 0;\n  border: 0;\n  background: none;\n  box-shadow: none;\n}\n",
    rawSha256:
      "a5f348252a69a16b7e5bd89748899fff07be14ca15cc773fdd883fab782aede5",
  },
  {
    ordinal: 2,
    source: "visual-system.css",
    first: 497,
    last: 500,
    context: [],
    selector: ".app .exchange-view-tools",
    declarations: [
      ["flex", "0 0 auto", false],
      ["flex-wrap", "nowrap", false],
    ],
    raw: ".app .exchange-view-tools {\n  flex: 0 0 auto;\n  flex-wrap: nowrap;\n}\n",
    rawSha256:
      "7743dc0da632ac67c24c445e2fd51ec11703bf546a8acc4a4c59d975c42b2936",
  },
  {
    ordinal: 3,
    source: "visual-system.css",
    first: 503,
    last: 511,
    context: [],
    selector:
      ".app .exchange-panel:has(> .conversation) > .exchange-controls-slot .exchange-view-tools",
    declarations: [
      ["background", "var(--surface-popover)", false],
      ["border-radius", "8px", false],
      ["-webkit-backdrop-filter", "var(--popup-blur)", false],
      ["backdrop-filter", "var(--popup-blur)", false],
    ],
    raw: ".app\n  .exchange-panel:has(> .conversation)\n  > .exchange-controls-slot\n  .exchange-view-tools {\n  background: var(--surface-popover);\n  border-radius: 8px;\n  -webkit-backdrop-filter: var(--popup-blur);\n  backdrop-filter: var(--popup-blur);\n}\n",
    rawSha256:
      "a5f90649e71cda6aa0976cbdfc802c3e6fc8e3c4d4d6ea9dfe101941edc25c38",
  },
  {
    ordinal: 4,
    source: "visual-system.css",
    first: 512,
    last: 520,
    context: [],
    selector: ".app .composer-unread",
    declarations: [
      ["position", "absolute", false],
      ["top", "3px", false],
      ["right", "3px", false],
      ["width", "5px", false],
      ["height", "5px", false],
      ["border-radius", "50%", false],
      ["background", "var(--accent)", false],
    ],
    raw: ".app .composer-unread {\n  position: absolute;\n  top: 3px;\n  right: 3px;\n  width: 5px;\n  height: 5px;\n  border-radius: 50%;\n  background: var(--accent);\n}\n",
    rawSha256:
      "5a48be59aef6fc85ce554eaf761bd169f38166f62cecf2c3455e36d10f9e6d35",
  },
  {
    ordinal: 5,
    source: "visual-system.css",
    first: 521,
    last: 532,
    context: [],
    selector:
      ".app :is(.composer-media-tools, .exchange-view-tools) > .icon-button",
    declarations: [
      ["position", "relative", false],
      ["flex", "0 0 32px", false],
      ["width", "32px", false],
      ["height", "32px", false],
      ["padding", "8px", false],
      ["border", "0", false],
      ["color", "var(--text-secondary)", false],
      ["border-radius", "9px", false],
      ["background", "var(--surface-raised)", false],
      ["box-shadow", "inset 0 0 0 1px var(--line)", false],
    ],
    raw: ".app :is(.composer-media-tools, .exchange-view-tools) > .icon-button {\n  position: relative;\n  flex: 0 0 32px;\n  width: 32px;\n  height: 32px;\n  padding: 8px;\n  border: 0;\n  color: var(--text-secondary);\n  border-radius: 9px;\n  background: var(--surface-raised);\n  box-shadow: inset 0 0 0 1px var(--line);\n}\n",
    rawSha256:
      "4307c4b5ef67044acd93d365ecbb0af94c31765ac23694bcb0f781c9e55f60c9",
  },
  {
    ordinal: 6,
    source: "visual-system.css",
    first: 534,
    last: 544,
    context: [],
    selector: ".app .exchange-view-tools > .icon-button",
    declarations: [
      ["flex-basis", "28px", false],
      ["width", "28px", false],
      ["height", "28px", false],
      ["min-width", "28px", false],
      ["min-height", "28px", false],
      ["padding", "7px", false],
      ["border-radius", "8px", false],
      ["background", "transparent", false],
      ["box-shadow", "none", false],
    ],
    raw: ".app .exchange-view-tools > .icon-button {\n  flex-basis: 28px;\n  width: 28px;\n  height: 28px;\n  min-width: 28px;\n  min-height: 28px;\n  padding: 7px;\n  border-radius: 8px;\n  background: transparent;\n  box-shadow: none;\n}\n",
    rawSha256:
      "1a60e9a6841ba7acf57843ba4236e2d73254456a99250be9aab6ae01b13fb039",
  },
  {
    ordinal: 7,
    source: "visual-system.css",
    first: 545,
    last: 549,
    context: [],
    selector:
      ".app :is(.composer-media-tools, .exchange-view-tools) > .composer-tool-group-start",
    declarations: [["margin-left", "8px", false]],
    raw: ".app\n  :is(.composer-media-tools, .exchange-view-tools)\n  > .composer-tool-group-start {\n  margin-left: 8px;\n}\n",
    rawSha256:
      "43fa324fc124bfbe73d991b82182679bcdaec44daff672bf974765064b1478f8",
  },
  {
    ordinal: 8,
    source: "visual-system.css",
    first: 550,
    last: 555,
    context: [],
    selector:
      ".app :is(.composer-media-tools, .exchange-view-tools) > .composer-tool-reserved",
    declarations: [
      ["visibility", "hidden", false],
      ["pointer-events", "none", false],
    ],
    raw: ".app\n  :is(.composer-media-tools, .exchange-view-tools)\n  > .composer-tool-reserved {\n  visibility: hidden;\n  pointer-events: none;\n}\n",
    rawSha256:
      "26511a9016d654e9deb163af61bd76c236a34b935c4cf5fc9e6c0f1b43537fc6",
  },
  {
    ordinal: 9,
    source: "visual-system.css",
    first: 556,
    last: 560,
    context: [],
    selector:
      ".app :is(.composer-media-tools, .exchange-view-tools) > .icon-button > svg",
    declarations: [
      ["position", "relative", false],
      ["width", "16px", false],
      ["height", "16px", false],
    ],
    raw: ".app :is(.composer-media-tools, .exchange-view-tools) > .icon-button > svg {\n  position: relative;\n  width: 16px;\n  height: 16px;\n}\n",
    rawSha256:
      "3c36a7007d47075fc490ac07cddd8fecc97bec138ec3aca78ef59ec630696ad2",
  },
  {
    ordinal: 10,
    source: "visual-system.css",
    first: 561,
    last: 564,
    context: [],
    selector: ".app .exchange-view-tools > .icon-button > svg",
    declarations: [
      ["width", "13px", false],
      ["height", "13px", false],
    ],
    raw: ".app .exchange-view-tools > .icon-button > svg {\n  width: 13px;\n  height: 13px;\n}\n",
    rawSha256:
      "d1712aced4620e6bd00736d56d73e66487790b8f398f9887de2bd16cd247532a",
  },
  {
    ordinal: 11,
    source: "visual-system.css",
    first: 565,
    last: 569,
    context: [],
    selector:
      '.app :is(.composer-media-tools, .exchange-view-tools) > .icon-button:hover:not(:disabled):not([aria-pressed="true"])',
    declarations: [["background", "var(--soft)", false]],
    raw: '.app\n  :is(.composer-media-tools, .exchange-view-tools)\n  > .icon-button:hover:not(:disabled):not([aria-pressed="true"]) {\n  background: var(--soft);\n}\n',
    rawSha256:
      "0c27ba6f4b97470da51dc0ab8f552caa41c10810fc10af43fee1df209beb9e7c",
  },
  {
    ordinal: 12,
    source: "visual-system.css",
    first: 572,
    last: 577,
    context: [],
    selector:
      '.app :is(.composer-media-tools, .exchange-view-tools) > .icon-button[aria-pressed="true"]:not(:disabled)',
    declarations: [
      ["background", "var(--selection)", false],
      ["box-shadow", "inset 0 0 0 1px var(--line-strong)", false],
    ],
    raw: '.app\n  :is(.composer-media-tools, .exchange-view-tools)\n  > .icon-button[aria-pressed="true"]:not(:disabled) {\n  background: var(--selection);\n  box-shadow: inset 0 0 0 1px var(--line-strong);\n}\n',
    rawSha256:
      "21b3fa52fac6474cc3c716244617f15ff7c35e4e5a5ef5186993f928c81d34b3",
  },
  {
    ordinal: 13,
    source: "visual-system.css",
    first: 578,
    last: 581,
    context: [],
    selector:
      '.app .exchange-view-tools > .icon-button[aria-pressed="true"]:not(:disabled)',
    declarations: [
      ["color", "var(--ink)", false],
      ["box-shadow", "none", false],
    ],
    raw: '.app .exchange-view-tools > .icon-button[aria-pressed="true"]:not(:disabled) {\n  color: var(--ink);\n  box-shadow: none;\n}\n',
    rawSha256:
      "082cde00eba3ca4bceb7da13df4b79c077579b316695c2a15087ce3899b38407",
  },
  {
    ordinal: 14,
    source: "visual-system.css",
    first: 582,
    last: 587,
    context: [],
    selector:
      '.app :is(.composer-media-tools, .exchange-view-tools) > .icon-button[aria-pressed="true"]:not(:disabled) > svg',
    declarations: [["stroke-width", "2", false]],
    raw: '.app\n  :is(.composer-media-tools, .exchange-view-tools)\n  > .icon-button[aria-pressed="true"]:not(:disabled)\n  > svg {\n  stroke-width: 2;\n}\n',
    rawSha256:
      "836ef57705ba6f5d92e4420d12e985eeeac2007deafec8c980fe99a8e867b420",
  },
  {
    ordinal: 15,
    source: "visual-system.css",
    first: 664,
    last: 668,
    context: ["@media (pointer: coarse)"],
    selector: ".app :is(.composer-media-tools, .exchange-view-tools)",
    declarations: [
      ["gap", "0", false],
      ["opacity", "1", false],
      ["pointer-events", "auto", false],
    ],
    raw: "  .app :is(.composer-media-tools, .exchange-view-tools) {\n    gap: 0;\n    opacity: 1;\n    pointer-events: auto;\n  }\n",
    rawSha256:
      "1445d26d9f5e2128f366e92deda51549ad5d553f69de29f9fea7c1291a7e31f2",
  },
  {
    ordinal: 16,
    source: "visual-system.css",
    first: 669,
    last: 675,
    context: ["@media (pointer: coarse)"],
    selector:
      ".app :is(.composer-media-tools, .exchange-view-tools) > .icon-button",
    declarations: [
      ["flex-basis", "44px", false],
      ["width", "44px", false],
      ["height", "44px", false],
      ["min-width", "44px", false],
      ["min-height", "44px", false],
    ],
    raw: "  .app :is(.composer-media-tools, .exchange-view-tools) > .icon-button {\n    flex-basis: 44px;\n    width: 44px;\n    height: 44px;\n    min-width: 44px;\n    min-height: 44px;\n  }\n",
    rawSha256:
      "ff89ed176d7b088dbc4a97e02304300a0401e7d570271ccf4ba70d1390a9f18a",
  },
] as const;

// Ordinary ownership is bounded to this role, not all CSS or renderer source.
const key = (selector: string) =>
  selector
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>,])\s*/g, "$1");
const contextKey = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([():])\s*/g, "$1");
function context(node: Rule | AtRule): string[] {
  const result: string[] = [];
  for (
    let parent = node.parent;
    parent && parent.type !== "root";
    parent = parent.parent
  )
    result.unshift(
      parent.type === "atrule"
        ? contextKey(`@${parent.name} ${parent.params}`)
        : `nested:${key(parent.selector)}`,
    );
  return result;
}
function signature(rule: Rule) {
  return {
    selector: key(rule.selector),
    context: context(rule),
    declarations: rule.nodes
      .filter((node) => node.type !== "comment")
      .map((node) =>
        node.type === "decl"
          ? [node.prop, node.value, !!node.important]
          : [`unexpected:${node.type}`, "", false],
      ),
  };
}
function rules(root: Root): Rule[] {
  const result: Rule[] = [];
  root.walkRules((rule) => {
    result.push(rule);
  });
  return result;
}
function decoded(selector: string) {
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
function hasClass(selector: string, names: readonly string[]) {
  const parts = selectorLexicalParts(selector);
  const text = decoded(parts.code);
  return (
    names.some((name) => new RegExp("\\." + name + "(?![\\w-])").test(text)) ||
    parts.attributes.some((attribute) => {
      const match =
        /^\[\s*class\s*(?:~=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(?:[is]\s*)?\]$/i.exec(
          decoded(attribute),
        );
      return (
        !!match &&
        (match[1] ?? match[2] ?? match[3]!)
          .split(/\s+/)
          .some((token) => names.includes(token))
      );
    })
  );
}
const operationClasses = [
  "exchange-view-tools",
  "composer-media-tools",
  "composer-unread",
  "composer-tool-group-start",
  "composer-tool-reserved",
];
function operationWriter(selector: string) {
  const text = decoded(selectorLexicalParts(selector).code);
  return (
    hasClass(selector, operationClasses) ||
    // Only this bounded local control-slot qualification, not all descendants.
    /\.exchange-controls-slot(?![\w-])(?:\s*>?\s*)(?:button|svg|\*|\.icon-button)(?![\w-])/.test(
      text,
    )
  );
}

// The role borrows common controls without becoming their global style owner.
// These finite host/native shapes do not govern independent feature descendants.
function genericNativeControlWriter(selector: string) {
  const naked =
    /^(?:button(?:\.icon-button)?|svg|input|select|textarea|summary|a|\*|\.icon-button)(?![\w-])(?:\[[^\]]+\]|:[\w-]+(?:\([^()]*\))?)*(?:(?:\s*>\s*|\s+)svg(?:\[[^\]]+\]|:[\w-]+(?:\([^()]*\))?)*)?$/i;
  const host =
    /^(?:\.app|html|body|:root)(?:\[[^\]]+\]|:[\w-]+(?:\([^()]*\))?)*(?:\s*>\s*|\s+)/i;
  const nativeGroup =
    /^:(?:is|where)\(([^()]*)\)(?:\[[^\]]+\]|:[\w-]+(?:\([^()]*\))?)*$/i;
  const globalBranch = (text: string) => {
    let target = text.trim();
    for (
      let qualification = host.exec(target);
      qualification;
      qualification = host.exec(target)
    )
      target = target.slice(qualification[0].length).trim();
    if (naked.test(target)) return true;
    const group = nativeGroup.exec(target);
    return (
      !!group &&
      postcss.list.comma(group[1]!).some((part) => naked.test(part.trim()))
    );
  };
  return postcss.list
    .comma(decoded(selectorLexicalParts(selector).code))
    .some(globalBranch);
}

function selectorLexicalParts(selector: string) {
  const attributes: string[] = [];
  const code = selector.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\[(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|[^\]\\"'])*\]/g,
    (literal) => {
      if (literal.startsWith("[")) {
        attributes.push(literal);
        const classToken =
          /^\[\s*class\s*(?:~=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(?:[is]\s*)?\]$/i.exec(
            decoded(literal),
          );
        if (classToken) {
          const names = (classToken[1] ?? classToken[2] ?? classToken[3]!)
            .split(/\s+/)
            .filter(Boolean);
          if (names.every((name) => /^[a-zA-Z_][\w-]*$/.test(name)))
            return names.map((name) => "." + name).join("");
        }
      }
      return " ";
    },
  );
  return { code, attributes };
}

const expected = originalExchangeControlsRules.map((rule) => ({
  selector: key(rule.selector),
  context: rule.context.map(contextKey),
  declarations: rule.declarations.map((declaration) => [...declaration]),
}));
function collect() {
  const errors: string[] = [];
  const check = (name: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      errors.push(name);
    }
  };
  return { errors, check };
}
function physical(file: string, specifier: string) {
  const plain = specifier.split(/[?#]/, 1)[0]!;
  if (plain.startsWith("/src/")) return posix.normalize(plain.slice(5));
  return plain.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(file), plain))
    : undefined;
}
export function isExchangeControlsSpecifier(file: string, specifier: string) {
  return (
    !/[?#]/.test(specifier) &&
    physical(file, specifier) === exchangeControlsFile
  );
}
export function exchangeControlsCssViolations(
  roots: ReadonlyMap<string, Root>,
) {
  const { errors, check } = collect();
  const owner = roots.get(exchangeControlsFile);
  if (!owner) return ["exchange-controls:missing-owner"];
  check("exchange-controls:ordered-recipes", () =>
    assert.deepEqual(
      rules(owner)
        .filter((rule) => operationWriter(rule.selector))
        .map(signature),
      expected,
    ),
  );
  const originalSelectors = new Set(expected.map((rule) => rule.selector));
  for (const [file, root] of roots) {
    root.walkAtRules("import", (rule) => {
      const path = /^(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s;)]+))/.exec(
        rule.params,
      );
      const specifier = path?.[1] ?? path?.[2] ?? path?.[3];
      check("exchange-controls:css-import", () =>
        assert.ok(
          !specifier || physical(file, specifier) !== exchangeControlsFile,
        ),
      );
    });
    if (file !== exchangeControlsFile)
      check(`exchange-controls:foreign-writer:${file}`, () =>
        assert.ok(!rules(root).some((rule) => operationWriter(rule.selector))),
      );
  }
  check("exchange-controls:owner-boundary", () => {
    owner.walkDecls((node) => {
      assert.ok(
        !node.prop.startsWith("--"),
        "borrow variables; do not define theme/state tokens",
      );
      assert.ok(
        !/^(?:animation|transition)(?:-|$)/.test(node.prop),
        "motion stays in its original owner",
      );
      assert.equal(
        node.parent?.type,
        "rule",
        "no hidden declaration directly in a wrapper",
      );
    });
    owner.walkAtRules((node) => {
      assert.ok(
        !/(?:^|-)keyframes$/.test(node.name) &&
          node.name !== "import" &&
          node.name !== "layer",
      );
    });
    for (const rule of rules(owner)) {
      if (originalSelectors.has(key(rule.selector))) continue;
      assert.ok(
        !genericNativeControlWriter(rule.selector),
        "common native control roots stay in their original owner",
      );
      assert.ok(
        !hasClass(rule.selector, [
          "application-dock",
          "application-dock-slot",
          "application-dock-shortcut",
          "exchange-panel",
          "exchange-resizer",
          "exchange-resize-shield",
          "conversation",
          "composer-dock",
          "composer-actions",
          "composer-floating-tools",
          "composer-footer-info",
        ]),
        "no parent/frame/Dock/footer responsibility",
      );
    }
  });
  return errors;
}

type ParsedModule = Readonly<{ file: string; source: SourceFile }>;
export function exchangeControlsEntryViolations(
  modules: readonly ParsedModule[],
  css: ReadonlyMap<string, string>,
  isUnboundRequire: (identifier: Identifier) => boolean,
) {
  const { errors, check } = collect();
  const moduleNames = new Set(modules.map(({ file }) => file));
  const edges = new Map<string, string[]>();
  let imports = 0;
  let mainImports: string[] = [];
  const resolveModule = (file: string, specifier: string) => {
    const name = physical(file, specifier);
    if (!name) return undefined;
    if (css.has(name) || moduleNames.has(name)) return name;
    return [name.replace(/\.js$/, ".tsx"), name.replace(/\.js$/, ".ts")].find(
      (candidate) => moduleNames.has(candidate),
    );
  };
  for (const { file, source } of modules) {
    const direct: string[] = [],
      dependencies: string[] = [];
    for (const node of source.statements) {
      if (
        (!isImportDeclaration(node) && !isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !isStringLiteral(node.moduleSpecifier)
      )
        continue;
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
      const resolved = resolveModule(file, specifier);
      if (resolved && !typeOnly) dependencies.push(resolved);
      if (isImportDeclaration(node)) {
        direct.push(
          physical(file, specifier) === exchangeControlsFile
            ? `./${exchangeControlsFile}`
            : specifier,
        );
        if (physical(file, specifier) === exchangeControlsFile) {
          imports++;
          check("exchange-controls:runtime-entry", () =>
            assert.ok(
              file === "main.tsx" &&
                !clause &&
                !/[?#]/.test(specifier) &&
                css.has(exchangeControlsFile),
            ),
          );
        }
      } else
        check("exchange-controls:reexport", () =>
          assert.notEqual(physical(file, specifier), exchangeControlsFile),
        );
    }
    if (file === "main.tsx") mainImports = direct;
    edges.set(file, dependencies);
    function walk(node: Node) {
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            isUnboundRequire(node.expression)))
      )
        check("exchange-controls:dynamic-entry", () =>
          assert.ok(
            !node.arguments.some(
              (argument) =>
                (isStringLiteral(argument) ||
                  isNoSubstitutionTemplateLiteral(argument)) &&
                physical(file, argument.text) === exchangeControlsFile,
            ),
          ),
        );
      node.forEachChild(walk);
    }
    walk(source);
  }
  check("exchange-controls:single-entry", () => assert.equal(imports, 1));
  let pdfPhases: ReturnType<typeof verifiedPdfCarrierPhases> | undefined;
  check("exchange-controls:pdf-contract", () => {
    pdfPhases = verifiedPdfCarrierPhases(
      pdfReadingCarriers.adaptive,
      css,
      modules,
      isUnboundRequire,
    );
  });
  // Failed PDF verification never grants projection. Original role diagnostics
  // are still collected against the unprojected actual stream.
  const roleImports = pdfPhases
    ? mainImports.filter(
        (specifier) =>
          physical("main.tsx", specifier) !== pdfReadingCarriers.adaptive,
      )
    : mainImports;
  check("exchange-controls:entry-phase", () => {
    const at = roleImports.indexOf(`./${exchangeControlsFile}`);
    assert.ok(at > 0);
    assert.deepEqual(roleImports.slice(at - 1, at + 2), [
      "./visual-system.css",
      `./${exchangeControlsFile}`,
      "./exchange-layout.css",
    ]);
  });
  const visited = new Set<string>(),
    loaded: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (css.has(file)) {
      loaded.push(file);
      return;
    }
    for (const next of edges.get(file) ?? []) visit(next);
  }
  visit("main.tsx");
  const roleLoaded = pdfPhases ? pdfPhases.runtime : loaded;
  check("exchange-controls:actual-css-phase", () => {
    const at = roleLoaded.indexOf(exchangeControlsFile);
    assert.ok(at > 0);
    assert.deepEqual(roleLoaded.slice(at - 1, at + 2), [
      "visual-system.css",
      exchangeControlsFile,
      "exchange-layout.css",
    ]);
  });
  return errors;
}
