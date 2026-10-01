import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Remove only TypeScript outputs whose same-position source was deleted.
 * Skip unknown extensions and observed symlinks. The build tree must not be
 * concurrently rewritten; pathname checks are not an atomic filesystem lock. */
export function pruneServerBuild(root = projectRoot) {
  if (!isAbsolute(root)) throw new Error("Build root must be absolute.");
  root = resolve(root);
  const output = join(root, "dist", "service");
  const directories = new Map();
  const removed = [];
  const skippedSymlinks = new Set();

  function directory(path) {
    const value = stat(path);
    if (!value) return false;
    if (value.isSymbolicLink() || !value.isDirectory())
      throw new Error(`Refusing unsafe build directory: ${path}`);
    directories.set(path, { dev: value.dev, ino: value.ino });
    return true;
  }
  if (!directory(root)) throw new Error("Build root does not exist.");
  if (!directory(join(root, "dist")) || !directory(output))
    return { removed, skippedSymlinks: [] };

  function insideOutput(path) {
    const name = relative(output, path);
    if (
      !name ||
      name === ".." ||
      name.startsWith(`..${sep}`) ||
      isAbsolute(name)
    )
      throw new Error("Build output escaped dist/service.");
    return name;
  }
  function sourceState(name) {
    const parts = name.split(sep);
    let path = root;
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]);
      const value = stat(path);
      if (!value) return "missing";
      if (value.isSymbolicLink()) {
        skippedSymlinks.add(`source:${name}`);
        return "blocked";
      }
      if (index < parts.length - 1) {
        if (!value.isDirectory()) return "blocked";
      } else {
        return value.isFile() ? "present" : "blocked";
      }
    }
    return "blocked";
  }
  const candidates = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      const name = insideOutput(file);
      const value = stat(file);
      if (!value) throw new Error(`Build output changed during scan: ${name}`);
      if (value.isSymbolicLink()) {
        skippedSymlinks.add(name);
        continue;
      }
      if (value.isDirectory()) {
        directory(file);
        walk(file);
        continue;
      }
      if (!value.isFile()) continue;
      const suffix = [".js.map", ".d.ts", ".js"].find((suffix) =>
        name.endsWith(suffix),
      );
      if (!suffix) continue;
      const stem = name.slice(0, -suffix.length);
      if (
        sourceState(`${stem}.ts`) === "missing" &&
        sourceState(`${stem}.tsx`) === "missing"
      )
        candidates.push({ file, name, dev: value.dev, ino: value.ino });
    }
  }
  walk(output);

  for (const candidate of candidates) {
    // Recheck observed parents/inodes before unlink in this trusted build tree;
    // this is not atomic protection against hostile pathname races.
    for (let path = dirname(candidate.file); ; path = dirname(path)) {
      const expected = directories.get(path);
      const current = stat(path);
      if (
        !expected ||
        !current?.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      )
        throw new Error(`Build directory changed before prune: ${path}`);
      if (path === root) break;
    }
    const current = stat(candidate.file);
    if (
      !current?.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== candidate.dev ||
      current.ino !== candidate.ino
    )
      throw new Error(`Build output changed before prune: ${candidate.name}`);
    const stem = candidate.name.replace(/(?:\.js\.map|\.d\.ts|\.js)$/, "");
    if (
      sourceState(`${stem}.ts`) !== "missing" ||
      sourceState(`${stem}.tsx`) !== "missing"
    )
      continue;
    unlinkSync(candidate.file);
    removed.push(candidate.name);
  }
  return {
    removed: removed.sort(),
    skippedSymlinks: [...skippedSymlinks].sort(),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2)
    throw new Error("No build-root override accepted.");
  const result = pruneServerBuild();
  console.log(
    JSON.stringify({
      type: "server_build_pruned",
      removedCount: result.removed.length,
      ...result,
    }),
  );
}
