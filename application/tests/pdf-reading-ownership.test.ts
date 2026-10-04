import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import postcss from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import type { Identifier } from "typescript/unstable/ast";
import {
  fixedPdfReadingRole,
  fixedPdfPrimitiveRefinements,
} from "./fixtures/pdf-reading-c93283db.js";
import {
  pdfReadingCssViolations,
  pdfReadingEntryFacts,
  pdfReadingPhaseViolations,
  verifiedPdfCarrierPhases,
  pdfReadingCarriers,
  type PdfSources,
} from "./fixtures/pdf-reading-contract.js";

// Current, bounded recipes and actual runtime imports. No CI Git or whole-file
// hashes/inverse. Full source/compiled historical provenance stays in /tmp.
type Sources = { css: Map<string, string>; modules: Map<string, string> };
const root = resolve("apps/web/src");
function actualSources(): Sources {
  const result: Sources = { css: new Map(), modules: new Map() };
  function visit(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile())
        (file.endsWith(".css")
          ? result.css
          : /\.tsx?$/.test(file)
            ? result.modules
            : undefined
        )?.set(
          relative(root, file).replaceAll("\\", "/"),
          readFileSync(file, "utf8"),
        );
    }
  }
  visit(root);
  return result;
}
const actual = actualSources();
const clone = (): Sources => ({
  css: new Map(actual.css),
  modules: new Map(actual.modules),
});
function parsed<T>(
  sources: PdfSources,
  consume: (
    modules: Parameters<typeof pdfReadingEntryFacts>[0],
    unbound: (node: Identifier) => boolean,
  ) => T,
): T {
  const base = "/pdf-reading-current-contract",
    config = base + "/tsconfig.json";
  const files = Object.fromEntries(
    [...sources.modules].map(([file, text]) => [base + "/" + file, text]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: [...sources.modules.keys()],
  });
  const api = new API({ cwd: base, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!,
        program = project.program;
      assert.equal(
        program.getSyntacticDiagnostics().length,
        0,
        "counterfactual must parse as actual TS/JSX",
      );
      return consume(
        [...sources.modules.keys()].map((file) => ({
          file,
          source: program.getSourceFile(base + "/" + file)!,
        })),
        (node) => !project.checker.getSymbolAtLocation([node])[0],
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
function violations(sources: Sources) {
  // Parse all actual CSS first, never count a syntax/missing-target error as a
  // designated contract rejection. TS parser diagnostics also remain hard errors.
  for (const [file, text] of sources.css) postcss.parse(text, { from: file });
  return parsed(sources, (modules, unbound) => {
    const facts = pdfReadingEntryFacts(modules, sources.css, unbound);
    return [
      ...pdfReadingCssViolations(sources.css),
      ...facts.errors,
      ...pdfReadingPhaseViolations(facts.main, facts.runtime),
    ];
  });
}
function replace(
  sources: Sources,
  file: string,
  before: string,
  after: string,
) {
  const map = file.endsWith(".css") ? sources.css : sources.modules;
  const raw = map.get(file);
  assert.ok(raw);
  assert.equal(raw.split(before).length, 2, "unique actual mutation: " + file);
  map.set(file, raw.replace(before, after));
}
function reject(
  name: string,
  rule: string,
  mutation: (sources: Sources) => void,
) {
  const sources = clone(),
    before = JSON.stringify([[...sources.css], [...sources.modules]]);
  mutation(sources);
  assert.notEqual(
    JSON.stringify([[...sources.css], [...sources.modules]]),
    before,
    name + ": actual source must change",
  );
  assert.ok(violations(sources).includes(rule), name + ": designated " + rule);
}
const base = pdfReadingCarriers.base,
  adaptive = pdfReadingCarriers.adaptive;
const line = (file: string) => 'import "./' + file + '";\n';

test("PDF archive contains complete independent 23 root recipes and 76 ordered declarations", () => {
  assert.equal(fixedPdfReadingRole.recipes.length, 23);
  assert.equal(
    fixedPdfReadingRole.recipes.reduce(
      (n, row) => n + row.declarations.length,
      0,
    ),
    76,
  );
  for (const row of fixedPdfReadingRole.recipes) {
    assert.equal(
      createHash("sha256").update(row.raw).digest("hex"),
      row.rawSha256,
    );
    assert.ok(row.raw.endsWith("}\n"));
    const css = postcss.parse(row.raw);
    assert.equal(css.nodes.length, 1);
    assert.equal(css.first?.type, "rule");
    assert.deepEqual(row.context, []);
  }
  assert.equal(
    fixedPdfReadingRole.recipes.find(
      (row) => row.selector === ".pdf-extracted p",
    )!.last,
    2485,
  );
  assert.equal(fixedPdfPrimitiveRefinements.length, 21);
  for (const row of fixedPdfPrimitiveRefinements) {
    for (const [raw, sha] of [
      [row.raw, row.rawSha256],
      [row.sourceRaw, row.sourceRawSha256],
    ] as const)
      assert.equal(createHash("sha256").update(raw).digest("hex"), sha);
    assert.ok(row.sourceRaw.trimEnd().endsWith("}"));
    const rawRule = postcss.parse(row.sourceRaw);
    assert.equal(rawRule.nodes.length, 1);
    assert.equal(rawRule.first?.type, "rule");
    const rules: import("postcss").Rule[] = [];
    postcss.parse(row.raw).walkRules((rule) => {
      rules.push(rule);
    });
    assert.equal(rules.length, 1);
    assert.equal(
      rules[0]!.selector,
      (rawRule.first as import("postcss").Rule).selector,
    );
    const context: string[][] = [];
    for (
      let parent = rules[0]!.parent;
      parent && parent.type !== "root";
      parent = parent.parent
    ) {
      assert.equal(parent.type, "atrule");
      context.unshift([
        (parent as import("postcss").AtRule).name,
        (parent as import("postcss").AtRule).params,
      ]);
    }
    assert.deepEqual(context, row.context);
  }
});
test("PDF current complete recipes, both actual bare origins, main and runtime phases pass", () =>
  assert.deepEqual(violations(actual), []));
test("PDF complete value/state/tree contracts reject parse-valid designated changes", () => {
  reject("base value", "pdf-reading:complete-base-recipe", (sources) =>
    replace(sources, base, "margin-top: 24px;", "margin-top: 25px;"),
  );
  reject(
    "adaptive control value",
    "pdf-reading:complete-adaptive-recipe",
    (sources) =>
      replace(
        sources,
        adaptive,
        ".app .pdf-toolbar-slot .pdf-controls button {\n  width: 28px;",
        ".app .pdf-toolbar-slot .pdf-controls button {\n  width: 29px;",
      ),
  );
  reject(
    "native selection important",
    "pdf-reading:complete-base-recipe",
    (sources) =>
      replace(
        sources,
        base,
        "background: #098cb755;",
        "background: #098cb755 !important;",
      ),
  );
  reject("new media scope", "pdf-reading:complete-base-recipe", (sources) =>
    sources.css.set(
      base,
      "@media (pointer: coarse) {\n" + sources.css.get(base)! + "\n}",
    ),
  );
  reject("empty wrapper", "pdf-reading:complete-adaptive-recipe", (sources) =>
    sources.css.set(
      adaptive,
      sources.css.get(adaptive)! + "\n@layer unknown {}",
    ),
  );
  reject(
    "canvas text layer selector",
    "pdf-reading:complete-base-recipe",
    (sources) =>
      replace(
        sources,
        base,
        ".pdf-text-layer :is(span, br)",
        ".pdf-text-layer :is(span)",
      ),
  );
});
test("PDF direct competing writers, finite native refinements and retained Host packing are guarded", () => {
  for (const [name, css] of [
    ["foreign page", ".pdf-page{margin:1px}"],
    ["compound", ".app div.pdf-reader{padding:1px}"],
    ["class attribute", "[class~=pdf-controls]{gap:1px}"],
    ["quoted class", '[class~="pdf-page"]{display:none}'],
    ["escaped class", ".\\70 df-page{display:none}"],
    ["escaped attribute", '[class~="\\70 df-page"]{display:none}'],
    ["ancestor class attribute", '[class~="pdf-controls"] button{width:1px}'],
    ["multiple real classes", '[class="pdf-page future"]{display:none}'],
    ["pseudo text is data", '.pdf-page[data-label="::before"]{display:none}'],
    [
      "real class with pseudo data",
      '[class~="pdf-page"][data-label="::before"]{display:none}',
    ],
    ["PDF ancestor condition", ".pdf-controls:has(.future) button{width:1px}"],
  ] as const)
    reject(name, "pdf-reading:no-second-owner", (sources) =>
      sources.css.set("future.css", css),
    );
  for (const css of [
    ".app button{all:unset!important}",
    ".app :is(button,select,svg){width:1px!important}",
    ".icon-button{width:1px!important}",
  ])
    reject(css, "pdf-reading:owner-boundary", (sources) =>
      sources.css.set(base, sources.css.get(base)! + "\n" + css),
    );
  for (const css of [
    "canvas{display:none}",
    "button{all:unset}",
    ".app :is(button,select){height:1px!important}",
    ".icon-button{width:1px!important}",
  ])
    reject(
      "foreign native " + css,
      "pdf-reading:global-native-competitor",
      (sources) => sources.css.set("future.css", css),
    );
  reject(
    "Host packing must stay",
    "pdf-reading:host-packing-remains",
    (sources) =>
      replace(
        sources,
        "visual-system.css",
        ".app .topbar:has(.pdf-toolbar-slot) .breadcrumb {\n  min-width: 40px;",
        ".app .topbar:has(.pdf-toolbar-slot) .breadcrumb {\n  min-width: 41px;",
      ),
  );
});
test("PDF actual carrier origin rejects duplicates, value/type/reexport and dynamic imports", () => {
  reject("duplicate base", "pdf-reading:single-entry:" + base, (sources) =>
    sources.modules.set(
      "main.tsx",
      sources.modules.get("main.tsx")! + "\n" + line(base),
    ),
  );
  reject(
    "component adaptive",
    "pdf-reading:runtime-origin:" + adaptive,
    (sources) => {
      replace(sources, "main.tsx", line(adaptive), "");
      sources.modules.set(
        "App.tsx",
        sources.modules.get("App.tsx")! + "\n" + line(adaptive),
      );
    },
  );
  reject("value base", "pdf-reading:runtime-origin:" + base, (sources) =>
    replace(
      sources,
      "main.tsx",
      line(base),
      'import value from "./' + base + '";\n',
    ),
  );
  reject("type base", "pdf-reading:runtime-origin:" + base, (sources) =>
    replace(
      sources,
      "main.tsx",
      line(base),
      'import type { Value } from "./' + base + '";\n',
    ),
  );
  reject("reexport base", "pdf-reading:runtime-origin:" + base, (sources) =>
    replace(
      sources,
      "main.tsx",
      line(base),
      'export * from "./' + base + '";\n',
    ),
  );
  reject("dynamic concatenation", "pdf-reading:dynamic-entry", (sources) =>
    sources.modules.set(
      "App.tsx",
      sources.modules.get("App.tsx")! +
        '\nvoid import("./features/pdf/" + "pdf-reading-adaptive.css");',
    ),
  );
  reject("CSS import", "pdf-reading:css-import", (sources) =>
    sources.css.set("future.css", '@import "./' + base + '";'),
  );
});
test("PDF actual main and runtime phase reject physical movement and earlier dependency", () => {
  reject("base moved", "pdf-reading:main-phase:base", (sources) => {
    replace(sources, "main.tsx", line(base), "");
    replace(
      sources,
      "main.tsx",
      line("ui/controls/adaptive.css"),
      line("ui/controls/adaptive.css") + line(base),
    );
  });
  reject("adaptive moved", "pdf-reading:main-phase:adaptive", (sources) => {
    replace(sources, "main.tsx", line(adaptive), "");
    replace(
      sources,
      "main.tsx",
      line("inspector.css"),
      line("inspector.css") + line(adaptive),
    );
  });
  reject("early indirect CSS", "pdf-reading:runtime-phase:base", (sources) => {
    sources.css.set("future.css", ".future-only{color:inherit}");
    sources.modules.set(
      "future.ts",
      'import "./future.css"; export const value=1;',
    );
    replace(
      sources,
      "main.tsx",
      line("styles.css"),
      line("styles.css") + 'import "./future.js";\n',
    );
  });
  reject(
    "empty named import is runtime",
    "pdf-reading:runtime-phase:base",
    (sources) => {
      sources.css.set("future.css", ".future-only{color:inherit}");
      sources.modules.set(
        "future.ts",
        'import "./future.css"; export const value=1;',
      );
      replace(
        sources,
        "main.tsx",
        line("styles.css"),
        line("styles.css") + 'import {} from "./future.js";\n',
      );
    },
  );
});
test("PDF legal physical aliases/actually consumed React feature and strict single-carrier projection", () => {
  const allowed = clone();
  replace(
    allowed,
    "main.tsx",
    line(base),
    'import "./features/pdf/../pdf/pdf-reading-base.css";\n',
  );
  allowed.css.set(
    "future.css",
    '.future-owned button{width:17px}.pdf-page-demo{color:red}.reader-ocr-box{visibility:hidden}.reader-ocr-box:has(.pdf-page) {display:flex}.pdf-reader .future-owned{padding:4px}.app button.future-owned{height:17px}[data-label=".pdf-page"]{color:red}[data-label="[class~=pdf-page]"]{color:red}.future[data-label=".pdf-page"] button{width:17px}.future:has(.pdf-page) button{height:17px}',
  );
  allowed.modules.set(
    "Future.tsx",
    'import {useEffect as observe} from "react"; import "./future.css"; export function Future(){observe(()=>{},[]);return <span className="future-owned">独立功能</span>;}',
  );
  allowed.modules.set(
    "App.tsx",
    'import {Future as Independent} from "./Future.js";\n' +
      allowed.modules
        .get("App.tsx")!
        .replace(
          "<WorkspaceApp client={client} host={host} origin={origin} />",
          "<WorkspaceApp client={client} host={host} origin={origin} /><Independent />",
        ),
  );
  assert.deepEqual(violations(allowed), []);
  allowed.css.set(
    "future-decoration.css",
    '.pdf-page::before{content:"future"}',
  );
  assert.deepEqual(violations(allowed), []);
  parsed(actual, (modules, unbound) => {
    const projected = verifiedPdfCarrierPhases(
      base,
      actual.css,
      modules,
      unbound,
    );
    assert.ok(!projected.main.includes(base));
    assert.ok(projected.main.includes(adaptive));
  });
  const invalid = clone();
  replace(
    invalid,
    adaptive,
    ".app .pdf-toolbar-slot .pdf-controls button {\n  width: 28px;",
    ".app .pdf-toolbar-slot .pdf-controls button {\n  width: 29px;",
  );
  parsed(invalid, (modules, unbound) =>
    assert.throws(
      () => verifiedPdfCarrierPhases(base, invalid.css, modules, unbound),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes("pdf-reading:complete-adaptive-recipe"),
    ),
  );
});
