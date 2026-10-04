import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import postcss, { type Root, type Rule } from "postcss";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  exchangeControlsFile,
  originalExchangeControlFrameTuple,
  originalExchangeControlsRules,
  exchangeControlsCssViolations,
  exchangeControlsEntryViolations,
} from "./fixtures/exchange-controls-51af4c20.js";

type Sources = { css: Map<string, string>; modules: Map<string, string> };
const readSources = (): Sources => {
  const directory = "apps/web/src",
    css = new Map<string, string>(),
    modules = new Map<string, string>();
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const name = relative(directory, file);
        if (name.endsWith(".css")) css.set(name, readFileSync(file, "utf8"));
        else if (/\.tsx?$/.test(name))
          modules.set(name, readFileSync(file, "utf8"));
      }
    }
  }
  visit(directory);
  return { css, modules };
};
const actual = readSources();
const clone = (): Sources => ({
  css: new Map(actual.css),
  modules: new Map(actual.modules),
});
function violations(sources: Sources) {
  const parsed = new Map<string, Root>(
    [...sources.css].map(([file, source]) => [
      file,
      postcss.parse(source, { from: file }),
    ]),
  );
  const result = exchangeControlsCssViolations(parsed);
  const directory = "/morphz-exchange-controls-current",
    config = `${directory}/tsconfig.json`;
  const files = Object.fromEntries(
    [...sources.modules].map(([file, text]) => [`${directory}/${file}`, text]),
  );
  files[config] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
    files: [...sources.modules.keys()],
  });
  const api = new API({ cwd: directory, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config)!;
      assert.equal(
        project.program.getSyntacticDiagnostics().length,
        0,
        "counterfactual must parse as actual TypeScript/JSX",
      );
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
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
  return result;
}
function reject(
  name: string,
  rule: string,
  mutate: (sources: Sources) => void,
) {
  const value = clone();
  mutate(value);
  assert.notDeepEqual(
    [...value.css, ...value.modules],
    [...actual.css, ...actual.modules],
    `${name}: alter actual sources`,
  );
  assert.ok(
    violations(value).includes(rule),
    `${name}: specified rejection ${rule}`,
  );
}
const key = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>,])\s*/g, "$1");
function role(sources: Sources, ordinal: number, mutate: (rule: Rule) => void) {
  const fixed = originalExchangeControlsRules.find(
    (recipe) => recipe.ordinal === ordinal,
  )!;
  const root = postcss.parse(sources.css.get(exchangeControlsFile)!);
  const selected: Rule[] = [];
  root.walkRules((rule) => {
    const context: string[] = [];
    for (
      let parent = rule.parent;
      parent && parent.type !== "root";
      parent = parent.parent
    )
      context.unshift(
        parent.type === "atrule"
          ? `@${parent.name} ${parent.params}`.trim()
          : `nested:${key(parent.selector)}`,
      );
    if (
      key(rule.selector) === key(fixed.selector) &&
      JSON.stringify(context) === JSON.stringify(fixed.context)
    )
      selected.push(rule);
  });
  assert.equal(selected.length, 1, `recipe ${ordinal}: one actual source rule`);
  mutate(selected[0]!);
  sources.css.set(exchangeControlsFile, root.toString());
}
function declaration(
  rule: Rule,
  property: string,
  value: string,
  important = false,
) {
  let count = 0;
  rule.walkDecls(property, (node) => {
    count++;
    node.value = value;
    node.important = important;
  });
  assert.equal(count, 1);
}
const line = `import "./${exchangeControlsFile}";`;
function replaceMain(sources: Sources, before: string, after: string) {
  const text = sources.modules.get("main.tsx")!;
  assert.equal(text.split(before).length, 2, "unique actual entry mutation");
  sources.modules.set("main.tsx", text.replace(before, after));
}

test("independent finite exchange-operation archive retains complete sixteen recipes and 63 declarations", () => {
  assert.equal(originalExchangeControlsRules.length, 16);
  assert.equal(
    originalExchangeControlsRules.reduce(
      (count, recipe) => count + recipe.declarations.length,
      0,
    ),
    63,
  );
  for (const recipe of originalExchangeControlsRules)
    assert.equal(
      createHash("sha256").update(recipe.raw).digest("hex"),
      recipe.rawSha256,
    );
  const material = originalExchangeControlsRules[2]!;
  assert.equal(key(material.selector), originalExchangeControlFrameTuple[2]);
  assert.deepEqual(material.context, originalExchangeControlFrameTuple[3]);
  assert.deepEqual(material.declarations, originalExchangeControlFrameTuple[4]);
});
test("current complete role has one actual bare phased source and no competing operation writer", () => {
  assert.deepEqual(violations(actual), []);
});
test("complete role rejects parse-valid value, state, context, specificity and sequence changes", () => {
  const cases: [string, number, (rule: Rule) => void][] = [
    ["local width", 6, (rule) => declaration(rule, "width", "29px")],
    ["glyph", 10, (rule) => declaration(rule, "width", "14px")],
    ["coarse hit", 16, (rule) => declaration(rule, "min-width", "43px")],
    ["unread position", 4, (rule) => declaration(rule, "right", "4px")],
    [
      "reserved pointer",
      8,
      (rule) => declaration(rule, "pointer-events", "auto"),
    ],
    ["group spacing", 7, (rule) => declaration(rule, "margin-left", "9px")],
    [
      "important",
      3,
      (rule) => declaration(rule, "background", "var(--surface-popover)", true),
    ],
    [
      "all repair",
      3,
      (rule) => {
        rule.append({ prop: "all", value: "initial" });
      },
    ],
    [
      "material longhand",
      3,
      (rule) => {
        rule.walkDecls("background", (node) => {
          node.prop = "background-color";
        });
      },
    ],
    [
      "parent-wide material",
      3,
      (rule) => {
        rule.selector = ".app .exchange-panel";
      },
    ],
    [
      "descendant instead of direct child",
      6,
      (rule) => {
        rule.selector = ".app .exchange-view-tools .icon-button";
      },
    ],
    [
      "pressed disabled",
      12,
      (rule) => {
        rule.selector = rule.selector.replace(":not(:disabled)", "");
      },
    ],
    [
      "hover pressed exclusion",
      11,
      (rule) => {
        rule.selector = rule.selector.replace(
          ':not([aria-pressed="true"])',
          "",
        );
      },
    ],
    [
      "duplicate",
      6,
      (rule) => {
        rule.cloneAfter();
      },
    ],
    [
      "missing",
      8,
      (rule) => {
        rule.remove();
      },
    ],
    [
      "order",
      1,
      (rule) => {
        const root = rule.root();
        rule.remove();
        root.append(rule);
      },
    ],
    [
      "coarse removed",
      15,
      (rule) => {
        rule.root().append(rule.clone());
        rule.remove();
      },
    ],
    [
      "legacy branch dropped",
      1,
      (rule) => {
        rule.selector = ".app .exchange-view-tools";
      },
    ],
  ];
  for (const [name, ordinal, mutate] of cases)
    reject(name, "exchange-controls:ordered-recipes", (sources) =>
      role(sources, ordinal, mutate),
    );
  reject("layer context", "exchange-controls:ordered-recipes", (sources) =>
    sources.css.set(
      exchangeControlsFile,
      `@layer displaced { ${sources.css.get(exchangeControlsFile)} }`,
    ),
  );
});
test("finite foreign writers and known frame, Dock, token and motion intrusions remain distinct", () => {
  for (const [name, css] of [
    ["exact group", ".exchange-view-tools { background: red; }"],
    ["escaped group", ".exchange\\2d view-tools { width: 1px; }"],
    ["class token", '[class~="exchange-view-tools"] { border: 0; }'],
    ["control-slot native", ".exchange-controls-slot > button { padding: 0; }"],
  ])
    reject(name!, "exchange-controls:foreign-writer:foreign.css", (sources) =>
      sources.css.set("foreign.css", css!),
    );
  for (const [name, css] of [
    ["Dock", ".application-dock { width: 1px; }"],
    ["frame", ".exchange-panel { background: red; }"],
    ["unused footer", ".composer-floating-tools { opacity: 1; }"],
    ["token", ":root { --surface-popover: red; }"],
    ["motion", ".future { animation: blink 1s; }"],
  ])
    reject(name!, "exchange-controls:owner-boundary", (sources) =>
      sources.css.set(
        exchangeControlsFile,
        sources.css.get(exchangeControlsFile)! + "\n" + css,
      ),
    );
});

test("exchange operation owner rejects generic native controls while allowing independent feature controls", () => {
  for (const [name, css] of [
    ["global button reset", ".app button { all: unset !important; }"],
    ["generic icon width", ".icon-button { width: 1px !important; }"],
    [
      "generic icon class token",
      '[class~="icon-button"] { width: 1px !important; }',
    ],
    [
      "generic compound icon button",
      "button.icon-button { width: 1px !important; }",
    ],
    [
      "generic button class token",
      'button[class~="icon-button"] { width: 1px !important; }',
    ],
    ["native glyph", ".app svg { width: 1px !important; }"],
    [
      "generic native group",
      ".app :is(button, svg, .icon-button) { padding: 0 !important; }",
    ],
    ["host direct native", ".app > button:hover { background: red; }"],
    [
      "generic glyph descendant",
      ".icon-button > svg { width: 1px !important; }",
    ],
    [
      "comma with global branch",
      ".future button, .app button { padding: 0 !important; }",
    ],
  ] as const)
    reject(name, "exchange-controls:owner-boundary", (sources) =>
      sources.css.set(
        exchangeControlsFile,
        sources.css.get(exchangeControlsFile)! + "\n" + css,
      ),
    );
  const feature = clone();
  feature.css.set(
    exchangeControlsFile,
    feature.css.get(exchangeControlsFile)! +
      [
        ".future button { color: red; }",
        ".future > .icon-button { width: 31px; }",
        ".future .icon-button > svg { width: 15px; }",
        "button.future-owned { color: red; }",
        'button[class~="future-owned"] { color: red; }',
        '.future [class~="icon-button"] { color: red; }',
        ".future :is(button, svg, .icon-button) { color: red; }",
      ].join("\n"),
  );
  assert.deepEqual(violations(feature), []);
});

test("quoted data text is not an exchange, frame or native control writer", () => {
  const dataText = [
    '[data-label=".exchange-view-tools"] { color: red; }',
    '[data-label=".exchange-panel"] { color: red; }',
    '[data-label=".app button"] { color: red; }',
    '[data-label=".icon-button"] { color: red; }',
    '[data-label="[class~=exchange-view-tools]"] { color: red; }',
    '.future[data-label=".exchange-view-tools"] button { color: red; }',
  ].join("\n");
  const value = clone();
  value.css.set("future-data-text.css", dataText);
  value.css.set(
    exchangeControlsFile,
    value.css.get(exchangeControlsFile)! + "\n" + dataText,
  );
  assert.deepEqual(violations(value), []);
  for (const [name, css] of [
    [
      "real functional selector",
      ":is(.future, .exchange-view-tools) { color: red; }",
    ],
    ["real has selector", ".future:has(.exchange-view-tools) { color: red; }"],
    ["real escaped class", ".exchange\\2d view-tools { color: red; }"],
    ["real class token", '[class~="exchange-view-tools"] { color: red; }'],
  ] as const)
    reject(
      name,
      "exchange-controls:foreign-writer:future-real-selector.css",
      (sources) => sources.css.set("future-real-selector.css", css),
    );
});

test("entry counterfactuals reject missing, foreign, bound, delayed and incorrectly phased consumption", () => {
  for (const [name, after, rule] of [
    ["missing", "", "exchange-controls:single-entry"],
    [
      "foreign actual source",
      'import "./features/foreign/exchange-controls.css";',
      "exchange-controls:single-entry",
    ],
    [
      "bound",
      `import Controls from "./${exchangeControlsFile}";`,
      "exchange-controls:runtime-entry",
    ],
    [
      "type-only",
      `import type Controls from "./${exchangeControlsFile}";`,
      "exchange-controls:runtime-entry",
    ],
    [
      "query",
      `import "./${exchangeControlsFile}?direct";`,
      "exchange-controls:runtime-entry",
    ],
    [
      "fragment",
      `import "./${exchangeControlsFile}#role";`,
      "exchange-controls:runtime-entry",
    ],
  ])
    reject(name!, rule!, (sources) => replaceMain(sources, line, after!));
  reject("duplicate", "exchange-controls:single-entry", (sources) =>
    sources.modules.set("future.ts", line),
  );
  reject("component", "exchange-controls:runtime-entry", (sources) => {
    replaceMain(sources, line, "");
    sources.modules.set("future.ts", line);
  });
  reject("reexport", "exchange-controls:reexport", (sources) =>
    sources.modules.set(
      "future.ts",
      `export * from "./${exchangeControlsFile}";`,
    ),
  );
  reject("dynamic", "exchange-controls:dynamic-entry", (sources) =>
    sources.modules.set(
      "future.ts",
      `void import("./${exchangeControlsFile}");`,
    ),
  );
  reject("template dynamic", "exchange-controls:dynamic-entry", (sources) =>
    sources.modules.set(
      "future.ts",
      `void import(\`./${exchangeControlsFile}\`);`,
    ),
  );
  reject("unbound require", "exchange-controls:dynamic-entry", (sources) =>
    sources.modules.set("future.ts", `require("./${exchangeControlsFile}");`),
  );
  reject("CSS import", "exchange-controls:css-import", (sources) =>
    sources.css.set("future.css", `@import "./${exchangeControlsFile}";`),
  );
  reject("phase", "exchange-controls:entry-phase", (sources) =>
    replaceMain(
      sources,
      `import "./visual-system.css";\n${line}`,
      `${line}\nimport "./visual-system.css";`,
    ),
  );
  reject("early dependency", "exchange-controls:actual-css-phase", (sources) =>
    sources.modules.set(
      "App.tsx",
      sources.modules.get("App.tsx")! + '\nimport "./exchange-layout.css";',
    ),
  );
});
test("the complete retained material cannot be omitted, duplicated, changed or claimed by a wrong physical source", () => {
  reject("material absent", "exchange-controls:ordered-recipes", (sources) =>
    role(sources, 3, (rule) => {
      rule.remove();
    }),
  );
  reject("material duplicate", "exchange-controls:ordered-recipes", (sources) =>
    role(sources, 3, (rule) => {
      rule.cloneAfter();
    }),
  );
  reject(
    "material wrong value",
    "exchange-controls:ordered-recipes",
    (sources) =>
      role(sources, 3, (rule) => declaration(rule, "border-radius", "9px")),
  );
  reject(
    "material wrong source",
    "exchange-controls:foreign-writer:visual-system.css",
    (sources) =>
      sources.css.set(
        "visual-system.css",
        sources.css.get("visual-system.css")! +
          originalExchangeControlsRules[2]!.raw,
      ),
  );
});
test("permits physical path aliases, lookalikes and an actually consumed independent React/CSS feature", () => {
  const alias = clone();
  replaceMain(
    alias,
    line,
    'import "./features/exchange/./exchange-controls.css";',
  );
  assert.deepEqual(violations(alias), []);
  const growth = clone();
  growth.css.set(
    "future.css",
    ".future { color: red; } .exchange-view-tools-demo { width: 7px; }",
  );
  growth.modules.set(
    "future.tsx",
    `import { useState, useEffect } from "react"; import "./future.css"; export function Future() { const [open, setOpen] = useState(false); useEffect(() => { if (open) return () => {}; }, [open]); return <section className="future"><button onClick={() => setOpen(!open)}>Future</button>{open && <span>Content</span>}</section>; }`,
  );
  replaceMain(
    growth,
    'import { App } from "./App.js";',
    'import { App } from "./App.js";\nimport { Future as FutureFeature } from "./future.js";',
  );
  replaceMain(growth, "<App />", "<><App /><FutureFeature /></>");
  growth.modules.set(
    "pure-local-loader-name.ts",
    `const require = (value: string) => value; export const name = require("./${exchangeControlsFile}");`,
  );
  growth.css.set(
    exchangeControlsFile,
    growth.css.get(exchangeControlsFile)! +
      "\n/* unrelated formatting */\n.future-owned-content { color: red; }\n",
  );
  // This is a parsed source-consumption contract, not mounted React/OS evidence.
  assert.deepEqual(violations(growth), []);
});
