import { after } from "node:test";
import { API, type Snapshot } from "typescript/unstable/sync";
import {
  createVirtualFileSystem,
  type FileSystem,
} from "typescript/unstable/fs";

// TS 7's synchronous close sends SIGTERM, but Node cannot reap that child
// until its event loop runs. Hundreds of synchronous counterfactuals used to
// accumulate hundreds of zombies even though every parse called api.close().
// Own one compiler per fixed virtual project layout in this test worker.
// Keep different file/config layouts separate (including case-only renames),
// while source mutations use fresh, independently disposed AST snapshots.
type Compiler = {
  api: API;
  fs: FileSystem;
  opened: boolean;
};
const compilers = new Map<string, Compiler>();
const active = new Map<string, Snapshot>();
let starts = 0;

export function virtualTypeScriptSnapshot(
  cwd: string,
  files: Record<string, string>,
  project: string,
): Snapshot {
  const previous = active.get(cwd);
  if (previous && !previous.isDisposed()) {
    throw new Error(
      "Dispose the previous virtual TypeScript snapshot before replacing its sources",
    );
  }
  const key = JSON.stringify([
    cwd,
    project,
    files[project],
    Object.keys(files).sort(),
  ]);
  let compiler = compilers.get(key);
  const fs = createVirtualFileSystem(files);
  if (!compiler) {
    const state = { fs, opened: false } as Compiler;
    state.api = new API({
      cwd,
      fs: {
        readFile: (path) => state.fs.readFile!(path),
        fileExists: (path) => state.fs.fileExists!(path),
        directoryExists: (path) => state.fs.directoryExists!(path),
        getAccessibleEntries: (path) => state.fs.getAccessibleEntries!(path),
        realpath: (path) => state.fs.realpath!(path),
      },
    });
    starts++;
    compiler = state;
    compilers.set(key, state);
  } else {
    compiler.fs = fs;
  }
  // Counterfactual audits require fresh ASTs, not the client's retained nodes
  // from the preceding snapshot. Keep the public server and client invalidation
  // explicit; no counterfactual is satisfied by a preceding source/AST cache.
  compiler.api.clearSourceFileCache();
  const snapshot = compiler.api.updateSnapshot({
    openProjects: compiler.opened ? [] : [project],
    fileChanges: { changed: Object.keys(files) },
  });
  compiler.opened = true;
  active.set(cwd, snapshot);
  return snapshot;
}

export function virtualTypeScriptResources() {
  return { starts, owned: compilers.size };
}

after(() => {
  const errors: unknown[] = [];
  for (const compiler of compilers.values()) {
    try {
      compiler.api.close();
    } catch (error) {
      errors.push(error);
    }
  }
  compilers.clear();
  active.clear();
  if (errors.length)
    throw new AggregateError(errors, "Virtual compilers did not close cleanly");
});
