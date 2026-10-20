import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packCognitiveAuthor } from "./fixtures/cognitive-app-packed-author.js";

const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("independent cognitive locks freeze the existing declared dependency graph", () => {
  const sdk = json(
    join(applicationRoot, "packages/cognitive-app-sdk/package.json"),
  );
  const sdkLock = json(
    join(applicationRoot, "packages/cognitive-app-sdk/package-lock.json"),
  );
  const author = json(
    join(applicationRoot, "examples/cognitive-notes/package.json"),
  );
  const authorLock = json(
    join(
      applicationRoot,
      "tests/fixtures/cognitive-packed-author-package-lock.json",
    ),
  );
  const workspaceLock = json(join(applicationRoot, "package-lock.json"));
  assert.equal(sdkLock.lockfileVersion, 3);
  assert.equal(authorLock.lockfileVersion, 3);
  assert.deepEqual(sdkLock.packages[""].dependencies, sdk.dependencies);
  assert.deepEqual(sdkLock.packages[""].devDependencies, sdk.devDependencies);
  assert.deepEqual(
    authorLock.packages[""].devDependencies,
    author.devDependencies,
  );
  assert.deepEqual(Object.keys(author.dependencies), [sdk.name]);
  assert.equal(author.dependencies[sdk.name], sdk.version);
  const archive = `file:../sdk/morphz-cognitive-app-sdk-${sdk.version}.tgz`;
  assert.deepEqual(authorLock.packages[""].dependencies, {
    [sdk.name]: archive,
  });
  const sdkEntry = authorLock.packages[`node_modules/${sdk.name}`];
  assert.equal(sdkEntry.version, sdk.version);
  assert.equal(sdkEntry.resolved, archive);
  assert.deepEqual(sdkEntry.dependencies, sdk.dependencies);
  // A new independent install must not quietly select newer third-party
  // versions or change their npm provenance/integrity.
  for (const lock of [sdkLock, authorLock]) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || path === `node_modules/${sdk.name}`) continue;
      const reference = workspaceLock.packages[path];
      assert.ok(reference, `Missing workspace dependency: ${path}`);
      for (const field of ["version", "resolved", "integrity"])
        assert.equal(
          Reflect.get(entry as object, field),
          reference[field],
          `${path}.${field}`,
        );
      const optional =
        Reflect.get(entry as object, "optionalDependencies") ?? {};
      for (const [name, version] of Object.entries(optional)) {
        const platform = lock.packages[`node_modules/${name}`];
        assert.ok(platform, `${path} must retain optional platform ${name}`);
        assert.equal(platform.version, version);
        assert.equal(platform.optional, true);
        assert.ok(platform.integrity.startsWith("sha512-"));
      }
      assert.match(reference.resolved, /^https:\/\/registry\.npmjs\.org\//);
    }
  }
});

test("independent cognitive packaging rejects a cold cache without a network fallback", () => {
  const cacheDirectory = mkdtempSync(
    join(tmpdir(), "morphz-cognitive-empty-cache-"),
  );
  try {
    assert.throws(
      () => packCognitiveAuthor({ cacheDirectory }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const details = `${error.message}\n${Reflect.get(error, "stderr") ?? ""}`;
        assert.match(details, /ENOTCACHED/);
        assert.match(details, /only-if-cached/);
        return true;
      },
    );
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test("independent cognitive packaging installs and loads only its own offline SDK", () => {
  const fixture = packCognitiveAuthor();
  try {
    const sdkRoot = join(fixture.directory, "sdk");
    const sdkManifest = json(join(sdkRoot, "package.json"));
    const packagePath = join(
      fixture.root,
      "node_modules/@morphz/cognitive-app-sdk",
    );
    assert.equal(lstatSync(packagePath).isSymbolicLink(), false);
    assert.equal(
      lstatSync(join(sdkRoot, "node_modules/typescript")).isSymbolicLink(),
      false,
    );
    const installedLock = json(join(fixture.root, "package-lock.json"));
    const sdkEntry = installedLock.packages[`node_modules/${sdkManifest.name}`];
    const archive = readFileSync(
      join(sdkRoot, `morphz-cognitive-app-sdk-${sdkManifest.version}.tgz`),
    );
    assert.equal(
      sdkEntry.integrity,
      "sha512-" + createHash("sha512").update(archive).digest("base64"),
    );
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const sdk = await import('@morphz/cognitive-app-sdk'); console.log(JSON.stringify({ url: import.meta.resolve('@morphz/cognitive-app-sdk'), exports: Object.keys(sdk).length }));",
      ],
      { cwd: fixture.root, encoding: "utf8", timeout: 10_000, env: {} },
    );
    const loaded = JSON.parse(output);
    assert.equal(
      loaded.url,
      pathToFileURL(join(realpathSync(packagePath), "dist/index.js")).href,
    );
    assert.ok(loaded.exports > 0);
    assert.equal(
      loaded.url.startsWith(pathToFileURL(realpathSync(applicationRoot)).href),
      false,
    );
  } finally {
    fixture.close();
  }
});
