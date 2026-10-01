import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  pruneServerBuild,
}: {
  pruneServerBuild: (root: string) => {
    removed: string[];
    skippedSymlinks: string[];
  };
} = require("../scripts/prune-server-build.mjs");

function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "morphz-server-build-output-"),
  );
  function put(name: string, bytes = `fixture:${name}`) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  }
  return {
    root,
    put,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("server build pruning removes only deleted-source JS/map/declarations", () => {
  const f = fixture();
  try {
    const retained = new Map<string, string>();
    for (const [stem, extension] of [
      ["packages/core/src/current", ".ts"],
      ["apps/desktop/current-view", ".tsx"],
    ]) {
      f.put(`${stem}${extension}`);
      for (const suffix of [".js", ".js.map", ".d.ts"]) {
        const path = f.put(`dist/service/${stem}${suffix}`);
        retained.set(path, readFileSync(path, "utf8"));
      }
    }
    const deletedStem = "packages/core/src/deleted";
    // A same-named source elsewhere is not this output's authoritative source.
    f.put("apps/service/deleted.ts");
    const stale = [".js", ".js.map", ".d.ts"].map(
      (suffix) => `${deletedStem}${suffix}`,
    );
    for (const name of stale)
      f.put(`dist/service/${name}`, 'throw new Error("must not execute");');
    for (const name of [
      "dist/service/packages/core/src/deleted.d.ts.map",
      "dist/service/packages/core/src/deleted.js.backup",
      "dist/service/unknown.json",
      "dist/service/manual.cjs",
      "dist/web/deleted.js",
      "dist/desktop/deleted.js",
      "packages/core/src/deleted.js",
    ]) {
      const path = f.put(name);
      retained.set(path, readFileSync(path, "utf8"));
    }
    assert.deepEqual(pruneServerBuild(f.root), {
      removed: stale.sort(),
      skippedSymlinks: [],
    });
    for (const name of stale)
      assert.equal(existsSync(join(f.root, "dist/service", name)), false);
    for (const [path, bytes] of retained)
      assert.equal(readFileSync(path, "utf8"), bytes);
    assert.deepEqual(pruneServerBuild(f.root), {
      removed: [],
      skippedSymlinks: [],
    });
  } finally {
    f.close();
  }
});

test("missing server output does not create or clear any directory", () => {
  const f = fixture();
  try {
    const web = f.put("dist/web/current.js");
    assert.deepEqual(pruneServerBuild(f.root), {
      removed: [],
      skippedSymlinks: [],
    });
    assert.equal(existsSync(join(f.root, "dist/service")), false);
    assert.equal(readFileSync(web, "utf8"), "fixture:dist/web/current.js");
    assert.throws(() => pruneServerBuild("relative-root"), /absolute/);
  } finally {
    f.close();
  }
});

test("output file and nested directory symlinks are not followed or removed", () => {
  const f = fixture();
  try {
    const outside = f.put("unrelated/keep.js", "outside bytes");
    const output = join(f.root, "dist/service");
    mkdirSync(output, { recursive: true });
    symlinkSync(outside, join(output, "deleted.js"));
    symlinkSync(join(f.root, "unrelated"), join(output, "linked-directory"));
    f.put("dist/service/ordinary-deleted.js");
    assert.deepEqual(pruneServerBuild(f.root), {
      removed: ["ordinary-deleted.js"],
      skippedSymlinks: ["deleted.js", "linked-directory"],
    });
    assert.equal(readFileSync(outside, "utf8"), "outside bytes");
    assert.equal(existsSync(join(output, "deleted.js")), true);
    assert.equal(existsSync(join(output, "linked-directory")), true);
  } finally {
    f.close();
  }
});

test("root, dist and service symlinks fail closed before deleting output", () => {
  for (const boundary of ["root", "dist", "service"]) {
    const f = fixture();
    try {
      const outside = f.put("unrelated/deleted.js", "outside bytes");
      let root = f.root;
      if (boundary === "root") {
        root = join(f.root, "root-link");
        symlinkSync(join(f.root, "unrelated"), root);
      } else if (boundary === "dist") {
        symlinkSync(join(f.root, "unrelated"), join(f.root, "dist"));
      } else {
        mkdirSync(join(f.root, "dist"));
        symlinkSync(join(f.root, "unrelated"), join(f.root, "dist/service"));
      }
      assert.throws(() => pruneServerBuild(root), /unsafe build directory/);
      assert.equal(readFileSync(outside, "utf8"), "outside bytes");
    } finally {
      f.close();
    }
  }
});

test("source file and source parent symlinks preserve corresponding outputs", () => {
  const f = fixture();
  try {
    f.put("dist/service/packages/linked/deleted.js");
    f.put("dist/service/packages/linked-file.js");
    mkdirSync(join(f.root, "packages"));
    mkdirSync(join(f.root, "unrelated"));
    symlinkSync(join(f.root, "unrelated"), join(f.root, "packages/linked"));
    // Even a dangling source link cannot authorize deleting generated output.
    symlinkSync(
      join(f.root, "unrelated/missing.ts"),
      join(f.root, "packages/linked-file.ts"),
    );
    const result = pruneServerBuild(f.root);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skippedSymlinks, [
      "source:packages/linked-file.ts",
      "source:packages/linked/deleted.ts",
    ]);
    assert.equal(
      existsSync(join(f.root, "dist/service/packages/linked/deleted.js")),
      true,
    );
    assert.equal(
      existsSync(join(f.root, "dist/service/packages/linked-file.js")),
      true,
    );
  } finally {
    f.close();
  }
});

test("production build prunes only after successful TypeScript server emit", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: { build: string } };
  assert.equal(
    packageJson.scripts.build,
    "npm run typecheck && vite build && tsc -p tsconfig.server.json && node scripts/prune-server-build.mjs",
  );
});
