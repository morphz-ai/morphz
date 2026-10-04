// Finite current-source ownership gate. Original whole recipes were independently
// reviewed against the accepted post-PDF baseline 66666d53. No production source
// is synthesized by this entry, and missing actual carriers must fail.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import postcss, { type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import type { Identifier } from "typescript/unstable/ast";
import {
  topbarCarriers,
  topbarMainNeighbors,
  topbarRecipes,
  topbarMovedRecipes,
  topbarBorrowedFamilies,
  topbarCssViolations,
  topbarEntryFacts,
  topbarPhaseViolations,
  verifiedTopbarCarrierPhases,
  type TopbarSources,
  type TopbarPhase,
} from "./fixtures/workspace-topbar-contract.js";

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
  sources: TopbarSources,
  consume: (
    modules: Parameters<typeof topbarEntryFacts>[0],
    unbound: (node: Identifier) => boolean,
  ) => T,
): T {
  const base = "/workspace-topbar-current-contract",
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
    const facts = topbarEntryFacts(modules, sources.css, unbound);
    return [
      ...topbarCssViolations(sources.css),
      ...facts.errors,
      ...topbarPhaseViolations(facts.main, facts.runtime),
    ];
  });
}
const currentErrors = violations(actual);
function requireCurrent() {
  for (const file of Object.values(topbarCarriers))
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
const phases: readonly TopbarPhase[] = ["base", "composition", "packing"];
const line = (file: string) => 'import "./' + file + '";\n';
function recipe(id: string) {
  const row = topbarRecipes.find((row) => row.id === id);
  assert.ok(row, "named original recipe: " + id);
  return row;
}
function borrowed(id: string) {
  const row = topbarBorrowedFamilies.find((row) => row.id === id);
  assert.ok(row, "named retained seam: " + id);
  return row;
}
function wrap(row: { raw: string; context: readonly { open: string }[] }) {
  return row.context.reduceRight(
    (text, entry) => entry.open + "\n" + text + "}\n",
    row.raw,
  );
}
function firstValue(raw: string) {
  const css = postcss.parse(raw);
  const declaration =
    css.first?.type === "rule"
      ? css.first.nodes.find((node) => node.type === "decl")
      : undefined;
  assert.ok(declaration?.type === "decl", "original declaration exists");
  declaration.value = declaration.value === "inherit" ? "initial" : "inherit";
  return css.toString().trim();
}
function changeRecipe(sources: Sources, id: string, next: string) {
  const row = recipe(id);
  replace(sources, topbarCarriers[row.phase], row.raw.trim(), next.trim());
}
function loadIntrinsic(
  sources: Sources,
  specifier: string,
  emptyNamed = false,
) {
  sources.css.set("Future.css", ".future-owned{padding:3px}");
  sources.modules.set(
    "Future.ts",
    'import "./Future.css"; export const value=1;',
  );
  return emptyNamed
    ? 'import {} from "' + specifier + '";\n'
    : 'import "' + specifier + '";\n';
}

test("Topbar original inventory is 65/172; 64/171 move while mixed counts retain their original refinement order", () => {
  assert.equal(topbarRecipes.length, 65);
  assert.equal(new Set(topbarRecipes.map((row) => row.id)).size, 65);
  assert.equal(
    topbarRecipes.reduce((n, row) => n + row.declarations, 0),
    172,
  );
  for (const [phase, count, declarations] of [
    ["base", 16, 54],
    ["composition", 43, 112],
    ["packing", 6, 6],
  ] as const) {
    const rows = topbarRecipes.filter((row) => row.phase === phase);
    assert.equal(rows.length, count);
    assert.equal(
      rows.reduce((n, row) => n + row.declarations, 0),
      declarations,
    );
    for (const row of rows) {
      const css = postcss.parse(row.raw);
      assert.equal(css.nodes.length, 1);
      assert.equal(css.first?.type, "rule");
      let actualDeclarations = 0;
      css.walkDecls(() => {
        actualDeclarations++;
      });
      assert.equal(actualDeclarations, row.declarations, row.id);
      const wrapped = postcss.parse(wrap(row));
      const rules: Rule[] = [];
      wrapped.walkRules((rule) => {
        rules.push(rule);
      });
      assert.equal(rules.length, 1, row.id);
      const ancestors: string[] = [];
      for (
        let parent = rules[0]!.parent;
        parent?.type !== "root";
        parent = parent?.parent
      ) {
        assert.ok(parent?.type === "atrule");
        ancestors.unshift(
          "@" + parent.name + (parent.params ? " " + parent.params : "") + " {",
        );
      }
      assert.deepEqual(
        ancestors,
        row.context.map((item) => item.open),
        row.id,
      );
      assert.ok(row.raw.endsWith("}\n"));
    }
  }
  assert.deepEqual(
    topbarRecipes.filter((row) => row.phase === "packing").map((row) => row.id),
    ["L01", "L02", "L03", "L04", "L05", "L06"],
  );
  assert.ok(recipe("L03").raw.includes("min-width: 0;"));
  assert.ok(recipe("C23").raw.includes("min-width: 200px;"));
  assert.ok(recipe("C27").raw.includes("min-width: 150px;"));
  assert.ok(recipe("C34").raw.includes("min-width: 72px;"));
  assert.equal(topbarMovedRecipes.length, 64);
  assert.equal(
    topbarMovedRecipes.reduce((n, row) => n + row.declarations, 0),
    171,
  );
  assert.equal(
    topbarMovedRecipes.filter((row) => row.phase === "composition").length,
    42,
  );
  assert.equal(topbarBorrowedFamilies.length, 16);
});

test("Topbar actual full carriers reject missing/duplicate/value/important/list/context/order or extra writers without a source projection", () => {
  requireCurrent();
  for (const id of ["B01", "C19", "L06"]) {
    const row = recipe(id),
      diagnostic = "topbar:complete-" + row.phase;
    reject(id + " missing", diagnostic, (s) => changeRecipe(s, id, ""));
    reject(id + " duplicate", diagnostic, (s) =>
      changeRecipe(s, id, row.raw + row.raw),
    );
    reject(id + " changed value", diagnostic, (s) =>
      changeRecipe(s, id, firstValue(row.raw)),
    );
  }
  reject("complete native no-drag list", "topbar:complete-composition", (s) =>
    changeRecipe(s, "C03", recipe("C03").raw.replace("    textarea,\n", "")),
  );
  reject("whole important flag", "topbar:complete-base", (s) =>
    changeRecipe(
      s,
      "B01",
      recipe("B01").raw.replace("display: flex;", "display: flex !important;"),
    ),
  );
  reject("ordered declarations", "topbar:complete-composition", (s) =>
    changeRecipe(
      s,
      "C19",
      recipe("C19").raw.replace(
        "  --border: var(--line);\n  --surface: var(--paper);",
        "  --surface: var(--paper);\n  --border: var(--line);",
      ),
    ),
  );
  reject(
    "page hidden occupancy condition",
    "topbar:complete-composition",
    (s) =>
      changeRecipe(s, "C05", recipe("C05").raw.replace(":not([hidden])", "")),
  );
  reject(
    "detail empty occupancy condition",
    "topbar:complete-composition",
    (s) =>
      changeRecipe(s, "C23", recipe("C23").raw.replace(":not(:empty)", "")),
  );
  reject("PDF actual nested trigger", "topbar:complete-packing", (s) =>
    changeRecipe(
      s,
      "L01",
      recipe("L01").raw.replace(":has(.pdf-toolbar-slot)", ""),
    ),
  );
  const queryRow = recipe("C12"),
    queryAnchor = queryRow.context[0]!.open + "\n" + queryRow.raw;
  reject(
    "container is not viewport media",
    "topbar:complete-composition",
    (s) =>
      replace(
        s,
        topbarCarriers.composition,
        queryAnchor,
        queryAnchor.replace("@container", "@media"),
      ),
  );
  reject("unnamed query stays unnamed", "topbar:complete-composition", (s) =>
    replace(
      s,
      topbarCarriers.composition,
      queryAnchor,
      queryAnchor.replace("@container", "@container host"),
    ),
  );
  reject("compact counter recipe missing", "topbar:complete-composition", (s) =>
    changeRecipe(s, "C16", ""),
  );
  reject(
    "compact counter recipe moved before ordinary anchor",
    "topbar:complete-composition",
    (s) => {
      changeRecipe(s, "C16", "");
      changeRecipe(s, "C14", wrap(recipe("C16")) + recipe("C14").raw);
    },
  );
  for (const phase of phases) {
    reject(phase + " unrelated rule", "topbar:complete-" + phase, (s) =>
      append(s, topbarCarriers[phase], ".future-owned{padding:1px}"),
    );
    reject(phase + " empty wrapper", "topbar:complete-" + phase, (s) =>
      append(s, topbarCarriers[phase], "@media (min-width: 1px) {}"),
    );
  }
});

test("Topbar named subject/positive ancestor packing rejects foreign, escaped, class attribute, pseudo and nested writers", () => {
  for (const css of [
    ".topbar .future-slot{gap:1px}",
    ".page-toolbar-slot .content-actions{min-width:1px}",
    ".topbar:has(.pdf-toolbar-slot) .detail-toolbar-slot{flex-shrink:1}",
    ":is(.topbar,.browser-toolbar) .application-strip{padding:1px}",
    ":where(.topbar,.future-owned) .application-strip{margin:1px}",
    ".top\\62 ar .object-toolbar{gap:1px}",
    '[class~="topbar"] .application-strip{padding:1px}',
    '.topbar[data-note="::before"] .object-toolbar{gap:1px}',
    ".topbar{all:unset}",
    ".topbar{& .future-slot{padding:1px}}",
  ])
    reject(css, "topbar:no-second-owner:Foreign.css", (s) =>
      s.css.set("Foreign.css", css),
    );
  reject(
    "an old allowed file is not a whitelist",
    "topbar:no-second-owner:ui.css",
    (s) => append(s, "ui.css", ".topbar .future-slot{gap:1px}"),
  );
  // Named scope must not excuse an exact duplicate of an approved whole recipe.
  // C33 is the finite mixed tabs/options native recipe, not a generic ban on
  // domain toolbar CSS. This counterexample also makes its physical seam clear.
  for (const id of ["B08", "C33", "L06"]) {
    const row = recipe(id);
    reject(
      id + " original physical owner duplicate",
      "topbar:no-second-owner:" + row.file,
      (s) => append(s, row.file, wrap(row)),
    );
  }
});

test("Topbar shared mixed/native/paint/32+44/historical seams remain whole tuples at exact source and occurrence", () => {
  for (const row of topbarBorrowedFamilies)
    reject(
      row.id + " full tuple value",
      "topbar:retained-tuple:" + row.id,
      (s) => replace(s, row.file, row.raw.trim(), firstValue(row.raw)),
    );
  reject("shared theme selector branch", "topbar:retained-tuple:R01", (s) => {
    const row = borrowed("R01");
    replace(
      s,
      row.file,
      row.raw.trim(),
      row.raw.replace(".theme-wrap > button", ".theme-wrap > a").trim(),
    );
  });
  reject(
    "retained filter display refinement",
    "topbar:retained-tuple:R40",
    (s) =>
      replace(
        s,
        "ui.css",
        ".app .matter-filter-select {\n    display: block;",
        ".app .matter-filter-select {\n    display: none;",
      ),
  );
  reject(
    "mixed counts stay before display refinement",
    "topbar:retained-tuple:R40",
    (s) => {
      const family = borrowed("R40"),
        counts = recipe("C11").raw;
      const before = family.raw.trim(),
        prefix = counts.trim() + "\n";
      assert.ok(before.startsWith(prefix));
      const remainder = before.slice(prefix.length);
      const at = remainder.indexOf(
        "  .project-directory-toolbar .search-field",
      );
      assert.ok(at > 0);
      replace(
        s,
        "ui.css",
        before,
        remainder.slice(0, at) + counts + remainder.slice(at),
      );
    },
  );
  reject("shared no-drag list branch", "topbar:retained-tuple:R02", (s) => {
    const row = borrowed("R02");
    replace(
      s,
      row.file,
      row.raw.trim(),
      row.raw
        .replace('.app[data-desktop="mac"] .theme-menu', ".future-menu")
        .trim(),
    );
  });
  reject(
    "inspector physical margin is not padding",
    "topbar:retained-tuple:R23",
    (s) => {
      const row = borrowed("R23");
      replace(
        s,
        row.file,
        row.raw.trim(),
        row.raw.replace("margin-right:", "padding-left:").trim(),
      );
    },
  );
  reject(
    "borrowed mixed rule cannot widen",
    "topbar:retained-tuple:R01",
    (s) => {
      const row = borrowed("R01");
      replace(
        s,
        row.file,
        row.raw.trim(),
        row.raw
          .replace(
            ".theme-wrap > button {",
            ".theme-wrap > button,\n.topbar .new-slot {",
          )
          .trim(),
      );
    },
  );
  reject(
    "borrowed occurrence cannot duplicate",
    "topbar:retained-tuple:R26",
    (s) => append(s, borrowed("R26").file, wrap(borrowed("R26"))),
  );
  reject(
    "coarse refinement cannot precede ordinary toggle geometry",
    "topbar:retained-order:inspector.css",
    (s) => {
      const ordinary = borrowed("R25"),
        coarse = borrowed("R26");
      replace(s, coarse.file, wrap(coarse).trim(), "");
      replace(
        s,
        ordinary.file,
        ordinary.raw.trim(),
        wrap(coarse).trim() + "\n" + ordinary.raw.trim(),
      );
    },
  );
  for (const id of ["R01", "R25", "R37"])
    reject(
      id + " origin cannot be copied to foreign source",
      "topbar:borrowed-origin:" + id,
      (s) => s.css.set("Foreign.css", wrap(borrowed(id))),
    );
});

test("Topbar actual unique bare main origins reject duplicate/component/value/type/reexport/query/dynamic/CSS entries and allow independent type imports", () => {
  for (const phase of phases) {
    const carrier = topbarCarriers[phase];
    reject(phase + " missing import", "topbar:single-entry:" + carrier, (s) =>
      replace(s, "main.tsx", line(carrier), ""),
    );
    reject(phase + " duplicate import", "topbar:single-entry:" + carrier, (s) =>
      replace(s, "main.tsx", line(carrier), line(carrier) + line(carrier)),
    );
    for (const statement of [
      'import owner from "./' + carrier + '";\n',
      'import type { Owner } from "./' + carrier + '";\n',
      'export { Owner } from "./' + carrier + '";\n',
      'import "./' + carrier + '?inline";\n',
      'import "./' + carrier + '#late";\n',
    ])
      reject(
        phase + " nonbare origin",
        "topbar:runtime-origin:" + carrier,
        (s) => replace(s, "main.tsx", line(carrier), statement),
      );
    reject(
      phase + " component origin",
      "topbar:runtime-origin:" + carrier,
      (s) =>
        s.modules.set(
          "BadFeature.tsx",
          line(carrier) + "export function BadFeature(){return <span/>}",
        ),
    );
    for (const statement of [
      'void import("./' + carrier + '");',
      'void import("./shell/" + "' + carrier.slice("shell/".length) + '");',
      'require("./' + carrier + '");',
    ])
      reject(phase + " dynamic origin", "topbar:dynamic-entry", (s) =>
        s.modules.set("BadEntry.ts", statement),
      );
    for (const statement of [
      '@import "./' + carrier + '";',
      '@import url("./' + carrier + '?late");',
    ])
      reject(phase + " CSS origin", "topbar:css-import", (s) =>
        s.css.set("Foreign.css", statement),
      );
  }
  allow("locally bound require is not a dynamic origin", (s) =>
    s.modules.set(
      "Local.ts",
      'export function local(require:(id:string)=>unknown){return require("./' +
        topbarCarriers.base +
        '")}',
    ),
  );
  allow("type-only independent import does not load its intrinsic CSS", (s) => {
    loadIntrinsic(s, "./Future.js");
    s.modules.set(
      "Future.ts",
      s.modules.get("Future.ts")! + "\nexport type FutureType = number;",
    );
    const after = line("styles.css");
    replace(
      s,
      "main.tsx",
      after,
      after + 'import type { FutureType } from "./Future.js";\n',
    );
  });
});

test("Topbar all three actual main and runtime first encounter phases reject late and earlier dependencies, including empty named runtime imports", () => {
  for (const phase of phases) {
    const carrier = topbarCarriers[phase],
      before = topbarMainNeighbors[phase][0];
    reject(phase + " moved to tail", "topbar:main-phase:" + phase, (s) => {
      replace(s, "main.tsx", line(carrier), "");
      append(s, "main.tsx", line(carrier));
    });
    reject(
      phase + " early carrier dependency",
      "topbar:runtime-phase:" + phase,
      (s) => {
        s.modules.set("Early.ts", line(carrier) + "export const value=1;");
        const main = s.modules.get("main.tsx")!;
        s.modules.set("main.tsx", 'import "./Early.js";\n' + main);
      },
    );
    for (const emptyNamed of [false, true])
      reject(
        phase +
          (emptyNamed ? " empty named runtime gap" : " intrinsic runtime gap"),
        "topbar:runtime-phase:" + phase,
        (s) => {
          const statement = loadIntrinsic(s, "./Future.js", emptyNamed);
          replace(s, "main.tsx", line(before), line(before) + statement);
        },
      );
  }
});

test("Topbar legal physical aliases and an independently aliased React/data/CSS feature actually consumed in App stay extensible", () => {
  allow("actual consumed independent feature is not an App checksum", (s) => {
    for (const phase of phases)
      replace(
        s,
        "main.tsx",
        line(topbarCarriers[phase]),
        'import "./shell/../' + topbarCarriers[phase] + '";\n',
      );
    s.css.set(
      "Future.css",
      ".future-owned{padding:3px}.future-owned button{width:17px}" +
        ".task-list-wide .task-search{min-width:70px}" +
        ".object-toolbar .editor-actions{gap:3px}.browser-toolbar form{min-width:70px}",
    );
    s.modules.set("FutureData.ts", "export const futureLabel='独立功能';");
    s.modules.set(
      "Future.tsx",
      'import {useEffect as observe} from "react"; import "./Future.css"; ' +
        'import {futureLabel as label} from "./FutureData.js"; ' +
        'export function Future(){observe(()=>{},[]);return <span className="future-owned">{label}</span>}',
    );
    s.modules.set(
      "FutureBarrel.ts",
      'export { Future as Independent } from "./Future.js";',
    );
    replace(
      s,
      "App.tsx",
      "<WorkspaceApp client={client} host={host} origin={origin} />",
      "<WorkspaceApp client={client} host={host} origin={origin} /><Independent />",
    );
    s.modules.set(
      "App.tsx",
      'import {Independent} from "./FutureBarrel.js";\n' +
        s.modules.get("App.tsx")!,
    );
  });
});

test("Topbar named scope ignores label/negative/descendant identities, not positive is/where, and does not pretend universal structural CSS", () => {
  allow("bounded data/predicate/prefix false positives", (s) =>
    s.css.set(
      "Future.css",
      ".topbarish{padding:1px}.browser-topbar{padding:1px}" +
        '[data-note=".topbar"]{padding:1px}[data-note=":has(.topbar)"]{padding:1px}' +
        '.feature:lang(".topbar"){padding:1px}.feature:not(.topbar){padding:1px}' +
        '.feature:has(.topbar){padding:1px}.feature:has([class~="topbar"]){padding:1px}',
    ),
  );
  for (const pseudo of ["is", "where"])
    reject(
      pseudo + " positive named subject",
      "topbar:no-second-owner:Foreign.css",
      (s) =>
        s.css.set(
          "Foreign.css",
          ":" + pseudo + "(.topbar,.future-owned){padding:1px}",
        ),
    );
  // Broad .workspace>header, global *, sibling and indirect :has constraints
  // require explicit review + compiled crossings; no synthetic universal gate.
});

test("Topbar reusable handoff omits one approved phase entry only after complete all-three carrier/seam/origin/phase verification", () => {
  requireCurrent();
  parsed(actual, (modules, unbound) => {
    const facts = topbarEntryFacts(modules, actual.css, unbound);
    for (const phase of phases) {
      const carrier = topbarCarriers[phase];
      const projected = verifiedTopbarCarrierPhases(
        carrier,
        actual.css,
        modules,
        unbound,
      );
      assert.deepEqual(
        projected.main,
        facts.main.filter((file) => file !== carrier),
      );
      assert.deepEqual(
        projected.runtime,
        facts.runtime.filter((file) => file !== carrier),
      );
      for (const other of phases.filter((item) => item !== phase)) {
        assert.ok(projected.main.includes(topbarCarriers[other]));
        assert.ok(projected.runtime.includes(topbarCarriers[other]));
      }
      assert.deepEqual(Object.keys(projected).sort(), ["main", "runtime"]);
    }
    assert.throws(() =>
      verifiedTopbarCarrierPhases("Future.css", actual.css, modules, unbound),
    );
  });
  const invalids: Array<[string, string, (s: Sources) => void]> = [
    ...phases.map((phase): [string, string, (s: Sources) => void] => {
      const row = topbarRecipes.find((row) => row.phase === phase)!;
      return [
        phase + " invalid recipe",
        "topbar:complete-" + phase,
        (s) => changeRecipe(s, row.id, firstValue(row.raw)),
      ];
    }),
    [
      "invalid retained native seam",
      "topbar:retained-tuple:R23",
      (s) => {
        const row = borrowed("R23");
        replace(s, row.file, row.raw.trim(), firstValue(row.raw));
      },
    ],
    [
      "invalid physical origin",
      "topbar:runtime-origin:" + topbarCarriers.packing,
      (s) => s.modules.set("Bad.ts", line(topbarCarriers.packing)),
    ],
    [
      "invalid actual phase",
      "topbar:main-phase:composition",
      (s) => {
        replace(s, "main.tsx", line(topbarCarriers.composition), "");
        append(s, "main.tsx", line(topbarCarriers.composition));
      },
    ],
  ];
  for (const [name, diagnostic, mutation] of invalids) {
    const sources = clone(),
      before = JSON.stringify([[...sources.css], [...sources.modules]]);
    mutation(sources);
    assert.notEqual(
      JSON.stringify([[...sources.css], [...sources.modules]]),
      before,
      name,
    );
    // Parse/validate first so a syntax failure cannot stand in for complete-handoff.
    assert.ok(
      violations(sources).includes(diagnostic),
      name + ": designated " + diagnostic,
    );
    parsed(sources, (modules, unbound) => {
      for (const carrier of Object.values(topbarCarriers))
        assert.throws(
          () =>
            verifiedTopbarCarrierPhases(carrier, sources.css, modules, unbound),
          (error) =>
            error instanceof assert.AssertionError &&
            error.message.includes("topbar:complete-handoff:") &&
            error.message.includes(diagnostic),
        );
    });
  }
});
