import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { transformSync } from "esbuild";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";

// Execute the production hydration/save lifecycles with controlled transport
// promises. No timer, database, browser focus or rewritten queue implementation.
const source = readFileSync(
  new URL("../apps/web/src/Reader.tsx", import.meta.url),
  "utf8",
);
const effectStart = source.indexOf(
  "  useEffect(() => {\n    if (!active) return;\n    const abort = new AbortController();\n",
);
const effectEnd = source.indexOf("  }, [", effectStart);
const saveStart = source.indexOf("  function savePosition(");
const saveEnd = source.indexOf("  function flushPosition()", saveStart);
assert.ok(
  effectStart >= 0 &&
    effectEnd > effectStart &&
    saveStart >= 0 &&
    saveEnd > saveStart,
);
const code = transformSync(
  `
function hydrate() { ${source.slice(effectStart + "  useEffect(() => {".length, effectEnd)} }
${source.slice(saveStart, saveEnd)}
globalThis.api = { hydrate, savePosition };
`,
  { loader: "ts", target: "es2023" },
).code;
const location = (sectionId: string) => ({
  sourceId: "source",
  sectionId,
  start: 0,
  end: 0,
});
const preferences = { fontSize: 20, font: "serif", theme: "system" };
type Position = {
  revision: number;
  location: ReturnType<typeof location>;
  preferences: typeof preferences;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function turns() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fixture(initialRevision = 7) {
  let release!: (value: { position: Position }) => void;
  const held = new Promise<{ position: Position }>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let server: Position = {
    revision: 7,
    location: location("page-1"),
    preferences,
  };
  const initial = clone(server);
  const writes: Array<{
    location: Position["location"];
    preferences: typeof preferences;
    expectedRevision: number;
  }> = [];
  const notices: string[] = [];
  const progressQueue = { current: Promise.resolve() };
  const positionRevision = { current: initialRevision };
  const savedPosition = { current: initialRevision ? clone(initial) : null };
  const context = createContext({
    Promise,
    AbortController,
    Error,
    RequestError: ApplicationRequestError,
    active: true,
    artifact: { id: "book" },
    version: { revision: 1 },
    owner: "human",
    centerId: "center",
    target: undefined,
    progressQueue,
    positionRevision,
    savedPosition,
    hydrated: { current: initialRevision > 0 },
    latest: { current: { preferences } },
    progress: { current: null },
    jump: { current: null },
    setPreferences() {},
    setSectionId() {},
    setReaderReady() {},
    setError: (message: string) => notices.push(message),
    onNotice: (message: string) => notices.push(message),
    client: {
      getSnapshot: () => ({ principalId: "human", centerId: "center" }),
      readingState: async () =>
        ++reads === 1 ? held : { position: clone(server) },
      readerCommand: async (
        _id: string,
        _revision: number,
        command: (typeof writes)[number],
      ) => {
        writes.push(clone(command));
        if (command.expectedRevision !== server.revision)
          throw new ApplicationRequestError(
            409,
            "阅读进度已被其他操作更新。",
            "conflict",
          );
        server = {
          revision: server.revision + 1,
          location: clone(command.location),
          preferences: clone(command.preferences),
        };
        return { id: "position", revision: server.revision };
      },
    },
  });
  runInContext(code, context);
  return {
    api: context.api as {
      hydrate(): () => void;
      savePosition(
        location: Position["location"],
        prefs?: typeof preferences,
      ): void;
    },
    progressQueue,
    positionRevision,
    savedPosition,
    writes,
    notices,
    reads: () => reads,
    server: () => clone(server),
    external: (value: Position) => {
      server = clone(value);
    },
    release: () => release({ position: initial }),
  };
}

for (const initial of [0, 7])
  test(`Reader ${initial ? "foreground reconciliation" : "initial hydration"}: a pending authorized position read precedes the next save`, async () => {
    const f = fixture(initial);
    const cleanup = f.api.hydrate();
    try {
      await turns();
      assert.equal(f.reads(), 1);
      f.api.savePosition(location("page-2"));
      await turns();
      assert.equal(
        f.writes.length,
        0,
        "a pending state read must not race a save using the previous revision",
      );
    } finally {
      f.release();
    }
    await f.progressQueue.current;
    cleanup();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]!.expectedRevision, 7);
    assert.equal(f.positionRevision.current, 8);
    assert.equal(f.server().location.sectionId, "page-2");
    assert.deepEqual(f.notices, []);
  });

for (const identical of [false, true])
  test(`Reader concurrent external save: ${identical ? "confirm an identical receipt" : "retain a genuine different-position conflict without retry"}`, async () => {
    const f = fixture();
    const cleanup = f.api.hydrate();
    try {
      await turns();
      f.api.savePosition(location("page-2"));
      await turns();
      f.external({
        revision: 8,
        location: location(identical ? "page-2" : "page-3"),
        preferences,
      });
    } finally {
      f.release();
    }
    await f.progressQueue.current;
    cleanup();
    assert.equal(f.writes.length, 1, "never reissue a conflicting save");
    assert.equal(f.reads(), 2, "one exact verification read, no polling");
    assert.equal(f.server().revision, 8);
    assert.equal(
      f.server().location.sectionId,
      identical ? "page-2" : "page-3",
    );
    if (identical) {
      assert.equal(f.positionRevision.current, 8);
      assert.deepEqual(f.notices, []);
    } else {
      assert.deepEqual(f.notices, [
        "阅读进度未保存：阅读进度已被其他操作更新。",
      ]);
    }
  });
