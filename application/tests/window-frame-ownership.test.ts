// Finite whole WindowFrame migration contract bound to accepted Stage59 9a10f743.
// Actual current sources are required before every meaningful counterfactual.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import postcss, { type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import type { Identifier } from "typescript/unstable/ast";
import {
  windowFrameBaseline,
  windowFrameCarriers,
  windowFrameRecipes,
  windowFrameRetainedFamilies,
  windowFrameCssViolations,
  windowFrameEntryFacts,
  windowFramePhaseViolations,
  windowFrameConsumerViolations,
  verifiedWindowFrameCarrierPhases,
  type WindowFrameSources,
  type WindowFramePhase,
} from "./fixtures/window-frame-contract.js";

// Locally reused actual source/TS API method, not a registered peer test, Git,
// whole-App hash, historical source projection or peer inverse.
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
  sources: WindowFrameSources,
  consume: (
    modules: Parameters<typeof windowFrameEntryFacts>[0],
    unbound: (node: Identifier) => boolean,
  ) => T,
): T {
  const base = "/window-frame-current-contract",
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
        "actual TS/JSX counterfactual must parse",
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
  // Syntax failure never counts as a designated ownership rejection.
  for (const [file, text] of sources.css) postcss.parse(text, { from: file });
  return parsed(sources, (modules, unbound) => {
    const facts = windowFrameEntryFacts(modules, sources.css, unbound);
    return [
      ...windowFrameCssViolations(sources.css),
      ...facts.errors,
      ...windowFramePhaseViolations(facts.main, facts.runtime),
      ...windowFrameConsumerViolations(modules),
    ];
  });
}
const currentErrors = violations(actual);
function requireCurrent() {
  for (const file of Object.values(windowFrameCarriers))
    assert.ok(
      actual.css.has(file),
      "actual production carrier required: " + file,
    );
  assert.deepEqual(
    currentErrors,
    [],
    "actual complete current source is the only baseline",
  );
}
function replace(
  sources: Sources,
  file: string,
  before: string,
  after: string,
) {
  const map = file.endsWith(".css") ? sources.css : sources.modules,
    raw = map.get(file);
  assert.ok(raw !== undefined, "actual source exists: " + file);
  assert.notEqual(before, after, "mutation must change its target");
  assert.equal(raw.split(before).length, 2, "unique actual mutation: " + file);
  map.set(file, raw.replace(before, after));
}
function append(sources: Sources, file: string, addition: string) {
  const map = file.endsWith(".css") ? sources.css : sources.modules;
  map.set(file, (map.get(file) ?? "") + "\n" + addition);
}
function reject(
  name: string,
  diagnostic: string,
  mutation: (sources: Sources) => void,
) {
  requireCurrent();
  const sources = clone(),
    before = JSON.stringify([[...sources.css], [...sources.modules]]);
  mutation(sources);
  assert.notEqual(
    JSON.stringify([[...sources.css], [...sources.modules]]),
    before,
    name + ": actual source bytes must change",
  );
  assert.ok(
    violations(sources).includes(diagnostic),
    name + ": designated " + diagnostic,
  );
}
function allow(name: string, mutation: (sources: Sources) => void) {
  requireCurrent();
  const sources = clone(),
    before = JSON.stringify([[...sources.css], [...sources.modules]]);
  mutation(sources);
  assert.notEqual(
    JSON.stringify([[...sources.css], [...sources.modules]]),
    before,
    name + ": actual source bytes must change",
  );
  assert.deepEqual(violations(sources), [], name);
}

const phases: readonly WindowFramePhase[] = ["base", "composition"];
const line = (file: string) => 'import "./' + file + '";\n';
function recipe(id: string) {
  const row = windowFrameRecipes.find((r) => r.id === id);
  assert.ok(row);
  return row;
}
function change(sources: Sources, id: string, next: string) {
  const row = recipe(id);
  replace(sources, windowFrameCarriers[row.phase], row.raw.trim(), next.trim());
}
function changedValue(raw: string) {
  const root = postcss.parse(raw);
  const decl = (root.first as Rule).nodes.find((n) => n.type === "decl");
  assert.ok(decl?.type === "decl");
  decl.value = decl.value === "inherit" ? "initial" : "inherit";
  return root.toString();
}
function cssReject(
  name: string,
  diagnostic: string,
  mutation: (s: Sources) => void,
) {
  requireCurrent();
  const s = clone(),
    before = JSON.stringify([...s.css]);
  mutation(s);
  assert.notEqual(JSON.stringify([...s.css]), before, name);
  for (const [file, text] of s.css) postcss.parse(text, { from: file });
  assert.ok(
    windowFrameCssViolations(s.css).includes(diagnostic),
    name + ": " + diagnostic,
  );
}
function mountFeature(
  sources: Sources,
  css = ".future-owned{display:grid;width:17px;background:red}",
  dependency = "",
) {
  sources.css.set("FutureFeature.css", css);
  sources.modules.set(
    "FutureFeature.tsx",
    'import "./FutureFeature.css";' +
      dependency +
      'export function FutureFeature(){return <section className="future-owned">future</section>}',
  );
  replace(
    sources,
    "App.tsx",
    'import { useInspectorLayout } from "./InspectorPanel.js";',
    'import { useInspectorLayout } from "./InspectorPanel.js";\nimport {FutureFeature} from "./FutureFeature.js";',
  );
  replace(
    sources,
    "App.tsx",
    '<div className="sidebar-header">',
    '<div className="sidebar-header">\n<FutureFeature />',
  );
}
test("WindowFrame accepted finite inventory has 26 whole rules/83 declarations and two actual carriers", () => {
  assert.equal(windowFrameBaseline, "9a10f743b65650ddd2fd2b09a7c4cc6cac3a6dda");
  assert.equal(windowFrameRecipes.length, 26);
  assert.equal(new Set(windowFrameRecipes.map((r) => r.id)).size, 26);
  assert.equal(
    windowFrameRecipes.reduce((n, r) => n + r.declarations, 0),
    83,
  );
  for (const [phase, count, decls] of [
    ["base", 10, 33],
    ["composition", 16, 50],
  ] as const) {
    const rows = windowFrameRecipes.filter((r) => r.phase === phase);
    assert.equal(rows.length, count);
    assert.equal(
      rows.reduce((n, r) => n + r.declarations, 0),
      decls,
    );
    for (const row of rows) {
      const root = postcss.parse(row.raw);
      assert.equal(root.nodes.length, 1);
      assert.equal(
        (root.first as Rule).nodes.filter((n) => n.type === "decl").length,
        row.declarations,
      );
    }
  }
  requireCurrent();
  for (const phase of phases) {
    reject("missing " + phase, "window-frame:complete-" + phase, (s) =>
      s.css.delete(windowFrameCarriers[phase]),
    );
    cssReject("empty wrapper " + phase, "window-frame:complete-" + phase, (s) =>
      append(s, windowFrameCarriers[phase], "@media (min-width:1px){}"),
    );
    cssReject(
      "extra independent rule in carrier " + phase,
      "window-frame:complete-" + phase,
      (s) => append(s, windowFrameCarriers[phase], ".future-owned{color:red}"),
    );
  }
});
test("Every original whole tuple rejects removed, duplicated, changed value and importance without normalization", () => {
  for (const row of windowFrameRecipes) {
    const diagnostic = "window-frame:complete-" + row.phase;
    cssReject(row.id + " omitted", diagnostic, (s) => change(s, row.id, ""));
    cssReject(row.id + " duplicated", diagnostic, (s) =>
      change(s, row.id, row.raw + row.raw),
    );
    cssReject(row.id + " value", diagnostic, (s) =>
      change(s, row.id, changedValue(row.raw)),
    );
    cssReject(row.id + " importance", diagnostic, (s) => {
      const root = postcss.parse(row.raw);
      const decl = (root.first as Rule).nodes.find((n) => n.type === "decl");
      assert.ok(decl?.type === "decl");
      decl.important = true;
      change(s, row.id, root.toString());
    });
  }
  cssReject(
    "selector list kept whole",
    "window-frame:complete-composition",
    (s) =>
      change(
        s,
        "U09",
        recipe("U09").raw.replace(
          ".app .inspector-resizer:active::after,\n",
          "",
        ),
      ),
  );
  cssReject("native pseudo kept", "window-frame:complete-base", (s) =>
    change(s, "S06", recipe("S06").raw.replace("::before", "")),
  );
  cssReject("mobile boundary", "window-frame:complete-base", (s) =>
    replace(
      s,
      windowFrameCarriers.base,
      "max-width: 560px",
      "max-width: 559px",
    ),
  );
  cssReject(
    "only original rule order changes",
    "window-frame:complete-base",
    (s) => {
      const root = postcss.parse(s.css.get(windowFrameCarriers.base)!);
      const rules = root.nodes.filter((node) => node.type === "rule");
      assert.equal(rules[0]!.selector, ".app");
      assert.equal(rules[1]!.selector, ".sidebar");
      const first = rules[0]!;
      first.remove();
      root.insertAfter(rules[1]!, first);
      s.css.set(windowFrameCarriers.base, root.toString());
    },
  );
  cssReject(
    "only original declaration order changes",
    "window-frame:complete-composition",
    (s) => {
      const root = postcss.parse(recipe("U08").raw);
      const rule = root.first as Rule;
      const first = rule.nodes[0]!;
      const second = rule.nodes[1]!;
      assert.ok(first.type === "decl" && second.type === "decl");
      first.remove();
      rule.insertAfter(second, first);
      change(s, "U08", root.toString());
    },
  );
  cssReject("wrong phase", "window-frame:complete-composition", (s) =>
    append(s, windowFrameCarriers.composition, recipe("S01").raw),
  );
});
test("All-source named frame subjects reject foreign geometry, aliases, escaped/list/pseudo/nested writers", () => {
  for (const [index, raw] of [
    ".app{grid-template-columns:1fr}",
    ".app:has(.future-owned){grid-template-columns:1fr}",
    ".app[data-accent=cyan] .sidebar{padding:0}",
    ":is(.sidebar,.future-owned){display:none}",
    '[class~="sidebar-header"]{gap:0}',
    ".side\\62 ar{width:1px}",
    ".sidebar::before{height:1px}",
    ".sidebar-resize-shield{inset:1px}",
    ".app .inspector-resizer::after{background:red}",
    "@media(min-width:1px){.sidebar{&{padding:0}}}",
  ].entries())
    cssReject(
      "foreign " + index,
      "window-frame:foreign-writer:FutureForeign.css",
      (s) => append(s, "FutureForeign.css", raw),
    );
  for (const file of ["styles.css", "ui.css", "workflow.css", "inspector.css"])
    cssReject(
      file + " second owner",
      "window-frame:foreign-writer:" + file,
      (s) => append(s, file, recipe("U13").raw),
    );
  reject(
    "actual mounted independent feature adds root writer",
    "window-frame:foreign-writer:FutureFeature.css",
    (s) => mountFeature(s, ".app{height:1px}"),
  );
});
test("Mixed root and finite retained whole tuples remain at their exact sources, values, occurrence and order", () => {
  for (const family of windowFrameRetainedFamilies) {
    const diagnostic =
      family.id === "R01"
        ? "window-frame:mixed-root"
        : "window-frame:retained-tuple:" + family.id;
    const context: readonly { open: string }[] = family.context;
    cssReject(family.id + " retained value", diagnostic, (s) => {
      const parsed = postcss.parse(family.raw);
      let changed = false;
      parsed.walkDecls((d) => {
        if (!changed) {
          d.value = d.value === "inherit" ? "initial" : "inherit";
          changed = true;
        }
      });
      assert.ok(changed);
      replace(s, family.file, family.raw.trim(), parsed.toString().trim());
    });
    cssReject(family.id + " retained duplicate", diagnostic, (s) =>
      append(
        s,
        family.file,
        context.reduceRight<string>(
          (raw, c) => c.open + "\n" + raw + "}\n",
          family.raw,
        ),
      ),
    );
  }
  cssReject("mixed root split", "window-frame:mixed-root", (s) =>
    replace(
      s,
      "ui.css",
      windowFrameRetainedFamilies[0]!.raw.trim(),
      ".app{--muted:light-dark(#686868,#a3a3a3)}\n.app{--workspace-offset:var(--sidebar-width);position:relative}",
    ),
  );
  const mixed = windowFrameRetainedFamilies[0]!;
  for (const [name, before, after] of [
    [
      "default offset",
      "--workspace-offset: var(--sidebar-width)",
      "--workspace-offset: 0px",
    ],
    ["containing block", "position: relative", "position: absolute"],
    ["importance", "position: relative", "position: relative !important"],
    ["selector list", ".app {", ".app, .future-owned {"],
  ] as const)
    cssReject("mixed root " + name, "window-frame:mixed-root", (s) =>
      replace(
        s,
        mixed.file,
        mixed.raw.trim(),
        mixed.raw.replace(before, after).trim(),
      ),
    );
  cssReject(
    "mixed root moved to a foreign physical source",
    "window-frame:retained-origin:R01",
    (s) => {
      replace(s, mixed.file, mixed.raw.trim(), "");
      append(s, "FutureMixed.css", mixed.raw);
    },
  );
  cssReject("mixed root gains a condition", "window-frame:mixed-root", (s) =>
    replace(
      s,
      mixed.file,
      mixed.raw.trim(),
      "@media(min-width:1px){" + mixed.raw + "}",
    ),
  );
  cssReject("fallback width", "window-frame:width-fallback", (s) =>
    replace(
      s,
      "styles.css",
      "--sidebar-width: 280px",
      "--sidebar-width: 281px",
    ),
  );
});
test("Carrier entry requires one actual bare normalized origin and rejects CSS/late/bound/type/reexport/require aliases", () => {
  for (const phase of phases) {
    const file = windowFrameCarriers[phase],
      importLine = line(file);
    for (const [name, next] of [
      ["missing", ""],
      ["duplicate", importLine + importLine],
      ["bound", 'import carrier from "./' + file + '";\n'],
      ["empty named", 'import {} from "./' + file + '";\n'],
      ["type", 'import type T from "./' + file + '";\n'],
      ["reexport", 'export * from "./' + file + '";\n'],
      ["query", 'import "./' + file + '?again";\n'],
    ] as const)
      reject(
        phase + " " + name,
        name === "missing"
          ? "window-frame:single-entry:" + file
          : name === "duplicate"
            ? "window-frame:single-entry:" + file
            : "window-frame:runtime-origin:" + file,
        (s) => replace(s, "main.tsx", importLine, next),
      );
    reject(
      phase + " component import",
      "window-frame:runtime-origin:" + file,
      (s) => append(s, "App.tsx", 'import "./' + file + '";'),
    );
    reject(
      phase + " constant dynamic import",
      "window-frame:dynamic-entry",
      (s) =>
        append(
          s,
          "App.tsx",
          'void import("./shell/" + "' + file.split("/").at(-1) + '");',
        ),
    );
    reject(phase + " unbound require", "window-frame:dynamic-entry", (s) =>
      append(s, "App.tsx", 'require("./' + file + '");'),
    );
    cssReject(phase + " CSS import", "window-frame:css-import", (s) =>
      append(s, "Unused.css", '@import "./' + file + '";'),
    );
  }
  allow("shadowed require and unrelated type import", (s) =>
    append(
      s,
      "App.tsx",
      'function ownRequire(require:(s:string)=>void){require("./shell/window-frame-base.css")}\nimport type {FutureType} from "./IndependentType.js";',
    ),
  );
});
test("Both actual main and runtime first encounter phases reject physical reorder and early intrinsic dependency", () => {
  for (const phase of phases) {
    const file = windowFrameCarriers[phase],
      importLine = line(file);
    reject(
      phase + " moved after original peer",
      "window-frame:main-phase:" + phase,
      (s) => {
        replace(s, "main.tsx", importLine, "");
        append(s, "main.tsx", importLine);
      },
    );
    reject(
      phase + " loaded through early actual feature",
      "window-frame:runtime-phase:" + phase,
      (s) => {
        s.modules.set(
          "EarlyWindow.ts",
          'import "./' + file + '";export const x=1;',
        );
        replace(
          s,
          "main.tsx",
          'import "./styles.css";',
          'import {} from "./EarlyWindow.js";\nimport "./styles.css";',
        );
      },
    );
  }
});
test("Actual root/sidebar/header, conditional handle, body portal and Inspector separator stay bounded native consumers", () => {
  reject("body portal destination", "window-frame:consumer-body-portal", (s) =>
    replace(
      s,
      "SidebarResizeHandle.tsx",
      "document.body,",
      "document.documentElement,",
    ),
  );
  reject("root width authority", "window-frame:consumer-app", (s) =>
    replace(
      s,
      "App.tsx",
      "`${leftSidebar.width}px`",
      "`${rightInspector.width}px`",
    ),
  );
  reject("sidebar header identity", "window-frame:consumer-app", (s) =>
    replace(
      s,
      "App.tsx",
      'className="sidebar-header"',
      'className="future-header"',
    ),
  );
  reject(
    "sidebar cannot move behind new wrapper",
    "window-frame:consumer-app",
    (s) => {
      replace(
        s,
        "App.tsx",
        '<aside\n        className="sidebar"',
        '<section className="future-wrapper"><aside\n        className="sidebar"',
      );
      replace(s, "App.tsx", "</aside>", "</aside></section>");
    },
  );
  reject("right actual separator", "window-frame:consumer-right-handle", (s) =>
    replace(
      s,
      "InspectorPanel.tsx",
      'className="inspector-resizer"',
      'className="future-resizer"',
    ),
  );
  cssReject(
    "shield cannot require App ancestor",
    "window-frame:complete-composition",
    (s) =>
      change(
        s,
        "U13",
        recipe("U13").raw.replace(
          ".sidebar-resize-shield",
          ".app .sidebar-resize-shield",
        ),
      ),
  );
  cssReject(
    "native compact rules cannot gain desktop media",
    "window-frame:complete-composition",
    (s) =>
      change(s, "U11", "@media(min-width:561px){" + recipe("U11").raw + "}"),
  );
});
test("Actually consumed independent App feature, nav/domain children and unrelated foundation token growth remain legal", () => {
  allow("real App mount and intrinsic independent CSS", (s) => mountFeature(s));
  allow("independent CSS descendants and data labels", (s) =>
    append(
      s,
      "Independent.css",
      '.app .future-owned{display:grid;width:1px}\n.sidebar nav button{padding:3px}\n.app .workspace-inspector .future-domain{width:4px}\n[data-label=".sidebar :has("]{width:7px}\n:not(.sidebar){width:7px}\n:has(.sidebar){width:7px}\n.wordmark{color:red}',
    ),
  );
  allow("foundation token only, not mixed tuple or width override", (s) =>
    replace(
      s,
      "styles.css",
      "--sidebar-width: 280px;",
      "--sidebar-width: 280px;\n  --future-feature-token: 1px;",
    ),
  );
  allow("physical aliases same unique source", (s) =>
    replace(
      s,
      "main.tsx",
      line(windowFrameCarriers.base),
      'import "./shell/../shell/window-frame-base.css";\n',
    ),
  );
  reject(
    "real mounted feature early carrier dependency",
    "window-frame:runtime-origin:" + windowFrameCarriers.composition,
    (s) =>
      mountFeature(
        s,
        undefined,
        'import "./shell/window-frame-composition.css";',
      ),
  );
});
test("Independent handoff verifies both complete carriers, named seams, origins and phases before omitting only two entries", () => {
  requireCurrent();
  const projected = parsed(actual, (modules, unbound) =>
    verifiedWindowFrameCarrierPhases(actual.css, modules, unbound),
  );
  const raw = parsed(actual, (modules, unbound) =>
    windowFrameEntryFacts(modules, actual.css, unbound),
  );
  const owners = Object.values(windowFrameCarriers) as string[];
  assert.deepEqual(
    projected.main,
    raw.main.filter((f) => !owners.includes(f)),
  );
  assert.deepEqual(
    projected.runtime,
    raw.runtime.filter((f) => !owners.includes(f)),
  );
  for (const phase of phases) {
    const s = clone();
    change(
      s,
      phase === "base" ? "S01" : "U01",
      changedValue(recipe(phase === "base" ? "S01" : "U01").raw),
    );
    assert.throws(
      () =>
        parsed(s, (modules, unbound) =>
          verifiedWindowFrameCarrierPhases(s.css, modules, unbound),
        ),
      /window-frame:complete-handoff:window-frame:complete-/,
    );
  }
  const s = clone();
  append(s, "Foreign.css", ".sidebar-resize-shield{width:1px}");
  assert.throws(
    () =>
      parsed(s, (modules, unbound) =>
        verifiedWindowFrameCarrierPhases(s.css, modules, unbound),
      ),
    /window-frame:foreign-writer:Foreign.css/,
  );
});
