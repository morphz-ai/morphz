import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { currentAppCSSImports } from "./fixtures/current-app-css.js";

test("current CSS fixture entry preserves complete main bare-import declaration order", () => {
  const source = readFileSync("apps/web/src/main.tsx", "utf8");
  const expected = [...source.matchAll(/^import "(\.\/[^"\n]+\.css)";$/gm)]
    .map((match) => `import ${JSON.stringify("/src/" + match[1]!.slice(2))};`)
    .join("\n");
  const actual = currentAppCSSImports();
  assert.notEqual(expected, "");
  assert.equal(actual, expected);
  assert.ok(!actual.includes("App.js"));
});

test("AST entry handles multiline bare imports without interpreting comments, strings or bound imports", () => {
  assert.equal(
    currentAppCSSImports(`
// import './comment.css';
/* import './block-comment.css'; */
const text = "import './string.css';";
import React from 'react';
import sheet from './bound.css';
import type { Sheet } from './typed.css';
import
  './first.css'
;
import './shell/window-frame-base.css';
import './last.css';
const view = <div>{text}</div>;
`),
    [
      'import "/src/first.css";',
      'import "/src/shell/window-frame-base.css";',
      'import "/src/last.css";',
    ].join("\n"),
  );
});

test("entry neither sorts nor deduplicates real declarations", () => {
  assert.equal(
    currentAppCSSImports(
      "import './z.css'; import './a.css'; import './z.css';",
    ),
    'import "/src/z.css";\nimport "/src/a.css";\nimport "/src/z.css";',
  );
});

test("malformed source and non-local CSS fail rather than guessing an entry", () => {
  assert.throws(() => currentAppCSSImports("import './a.css'; const = ;"));
  for (const specifier of ["../a.css", "./../a.css", "package/theme.css"])
    assert.throws(
      () => currentAppCSSImports(`import ${JSON.stringify(specifier)};`),
      /current bare CSS entry must remain relative to \/src/,
    );
});
