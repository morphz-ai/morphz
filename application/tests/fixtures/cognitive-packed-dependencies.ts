/** Lock preparation for actual independent npm installs. Only the archive
 * built from the current checkout gets a fresh digest; third-party entries
 * always come from committed exact npm lock graphs. No registry resolution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, sep, join } from "node:path";
import { fileURLToPath } from "node:url";

const applicationRoot = fileURLToPath(new URL("../../", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sdkDirectory = join(applicationRoot, "packages/cognitive-app-sdk");
const integrity = (archive: string) =>
  "sha512-" +
  createHash("sha512").update(readFileSync(archive)).digest("base64");
function write(root: string, manifest: unknown, lock: unknown) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
}

/** The notes author's frozen esbuild + SDK graph, reused after packing the
 * actual author release for its second independent consumer install. */
export function writePackedNotesAuthorLock(author: string, archive: string) {
  const sdkManifest = json(join(sdkDirectory, "package.json"));
  const authorManifest = json(join(author, "package.json"));
  const lock = json(
    join(
      applicationRoot,
      "tests/fixtures/cognitive-packed-author-package-lock.json",
    ),
  );
  const dependency = "file:" + relative(author, archive).split(sep).join("/");
  const sdkEntry = lock.packages[`node_modules/${sdkManifest.name}`];
  assert.equal(
    authorManifest.dependencies[sdkManifest.name],
    sdkManifest.version,
  );
  assert.equal(sdkEntry.version, sdkManifest.version);
  assert.deepEqual(sdkEntry.dependencies, sdkManifest.dependencies);
  assert.deepEqual(
    lock.packages[""].devDependencies,
    authorManifest.devDependencies,
  );
  assert.deepEqual(Object.keys(authorManifest.dependencies), [
    sdkManifest.name,
  ]);
  assert.equal(lock.packages[""].dependencies[sdkManifest.name], dependency);
  assert.equal(sdkEntry.resolved, dependency);
  authorManifest.dependencies[sdkManifest.name] = dependency;
  sdkEntry.integrity = integrity(archive);
  write(author, authorManifest, lock);
}

/** SDK-only consumers may include the SDK's same exact TypeScript dev graph.
 * This copies its committed transitive/optional entries without asking npm
 * for package metadata, and never borrows workspace node_modules. */
export function writePackedSdkConsumerLock(consumer: string, archive: string) {
  const sdk = json(join(sdkDirectory, "package.json"));
  const sdkLock = json(join(sdkDirectory, "package-lock.json"));
  const manifest = json(join(consumer, "package.json"));
  const includeDev = Object.keys(manifest.devDependencies ?? {}).length > 0;
  assert.deepEqual(
    manifest.devDependencies ?? {},
    includeDev ? sdk.devDependencies : {},
  );
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const dependency = "file:" + relative(consumer, archive).split(sep).join("/");
  manifest.dependencies = { [sdk.name]: dependency };
  const packages: Record<string, unknown> = {
    "": {
      name: manifest.name,
      ...(manifest.version ? { version: manifest.version } : {}),
      dependencies: manifest.dependencies,
      ...(includeDev ? { devDependencies: manifest.devDependencies } : {}),
    },
    [`node_modules/${sdk.name}`]: {
      version: sdk.version,
      resolved: dependency,
      integrity: integrity(archive),
      license: sdk.license,
      dependencies: sdk.dependencies,
    },
  };
  for (const [path, entry] of Object.entries(sdkLock.packages)) {
    if (!path || (!includeDev && Reflect.get(entry as object, "dev"))) continue;
    packages[path] = entry;
  }
  write(consumer, manifest, {
    name: manifest.name,
    ...(manifest.version ? { version: manifest.version } : {}),
    lockfileVersion: 3,
    requires: true,
    packages,
  });
}
