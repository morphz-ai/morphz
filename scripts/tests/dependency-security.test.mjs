import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

for (const workspace of ["dashboard", "website"]) {
  const require = createRequire(
    new URL(`../../${workspace}/package.json`, import.meta.url),
  );
  const braces = require("braces");
  test(`${workspace}: installed braces rejects recursion attacks and cyclic ASTs`, () => {
    assert.equal(require("braces/package.json").version, "3.0.4-morphz.1");
    const pattern = "{".repeat(4000) + "a,b" + "}".repeat(4000);
    for (const method of ["parse", "compile", "expand", "stringify"]) {
      assert.throws(() => braces[method](pattern), {
        name: "SyntaxError",
        message: /nesting depth/,
      });
    }
    assert.throws(
      () => braces.compile("(".repeat(4000) + "a" + ")".repeat(4000)),
      /nesting depth/,
    );
    const cyclic = { type: "root", nodes: [] };
    cyclic.nodes.push(cyclic);
    for (const method of ["compile", "expand", "stringify"])
      assert.throws(() => braces[method](cyclic), /nesting depth/);
    assert.deepEqual(braces.expand("src/{a,b}/{1..3}.js"), [
      "src/a/1.js",
      "src/a/2.js",
      "src/a/3.js",
      "src/b/1.js",
      "src/b/2.js",
      "src/b/3.js",
    ]);
    assert.equal(braces.compile("src/{a,b}.js"), "src/(a|b).js");
    const shallow = braces.parse("{a,b}");
    assert.equal(braces.stringify(shallow), "{a,b}");
    assert.ok(braces.compile("{".repeat(32) + "a,b" + "}".repeat(32)));
    const lock = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../${workspace}/package-lock.json`, import.meta.url),
        ),
      ),
    );
    assert.match(
      lock.packages["node_modules/braces"].resolved,
      /third_party\/npm\/braces-3\.0\.4-morphz\.1\.tgz$/,
    );
    assert.equal(lock.packages["node_modules/source-map-js"].version, "1.2.2");
  });
}

test("application no longer installs vulnerable sprintf-js through mammoth CLI", () => {
  const require = createRequire(
    new URL("../../application/package.json", import.meta.url),
  );
  const lock = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../application/package-lock.json", import.meta.url),
      ),
    ),
  );
  assert.ok(
    !Object.keys(lock.packages).some((key) =>
      /(?:^|\/)node_modules\/sprintf-js$/.test(key),
    ),
  );
  assert.equal(require("argparse/package.json").version, "2.0.1");
  assert.equal(lock.packages["node_modules/source-map-js"].version, "1.2.2");
});
