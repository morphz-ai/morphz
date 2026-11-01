import test from "node:test";
import assert from "node:assert/strict";
import { terminalCatalogPage } from "../packages/application/src/terminal-catalog-page.js";

test("terminal source pages have one physical owner, bounded roots and explicit native/source continuation", async () => {
  const calls: {
    key: string;
    roots: readonly string[];
    cursor: string | null;
  }[] = [];
  const sources = Array.from({ length: 1200 }, (_, i) => ({
    key: `source-${String(i).padStart(5, "0")}`,
    sessionId: `session-${i}`,
    contextId: `ctx-${i}`,
    roots: Array.from(
      { length: 90 },
      (_, r) => `root-${String(r).padStart(5, "0")}`,
    ),
  }));
  const options = {
    owner: ["principal-a", "conversation-a"],
    sources,
    read: async (
      source: (typeof sources)[number],
      roots: readonly string[],
      cursor: string | null,
    ) => {
      calls.push({ key: source.key, roots, cursor });
      return {
        terminals: [],
        has_more: cursor === null,
        next_cursor: cursor === null ? "native-exact-1" : null,
        limit: 50,
      };
    },
  };
  const first = await terminalCatalogPage(options);
  assert.equal(calls.length, 1, "a large registry is not physical page demand");
  assert.equal(calls[0]!.roots.length, 32);
  assert.equal(first.has_more, true);
  const second = await terminalCatalogPage({
    ...options,
    cursor: first.next_cursor!,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.cursor, "native-exact-1");
  assert.deepEqual(
    calls[1]!.roots,
    calls[0]!.roots,
    "native continuation keeps its exact root page",
  );
  const third = await terminalCatalogPage({
    ...options,
    cursor: second.next_cursor!,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.cursor, null);
  assert.equal(calls[2]!.roots[0], "root-00032");
  assert.equal(
    calls[2]!.roots.filter((root) => calls[0]!.roots.includes(root)).length,
    0,
  );
  await assert.rejects(
    terminalCatalogPage({
      ...options,
      owner: ["other-principal"],
      cursor: third.next_cursor!,
    }),
    /范围/,
  );
  assert.equal(
    calls.length,
    3,
    "foreign continuation is rejected before physical reads",
  );
  await assert.rejects(
    terminalCatalogPage({
      ...options,
      sources: sources.slice(1),
      cursor: first.next_cursor!,
    }),
    /来源/,
  );
  assert.equal(calls.length, 3);
  await assert.rejects(
    terminalCatalogPage({
      ...options,
      sources: [{ ...sources[0]!, roots: sources[0]!.roots.slice(1) }],
      cursor: first.next_cursor!,
    }),
    /变化/,
  );
  assert.equal(calls.length, 3, "a source change cannot mix native pages");
});

test("terminal continuation never loops or drains an empty source automatically", async () => {
  let reads = 0;
  const options = {
    owner: ["principal"],
    sources: ["a", "b"].map((key) => ({
      key,
      sessionId: key,
      contextId: key,
      roots: [],
    })),
    read: async () => {
      reads++;
      return { terminals: [], limit: 50, has_more: false, next_cursor: null };
    },
  };
  const first = await terminalCatalogPage(options);
  assert.equal(reads, 1);
  assert.equal(first.has_more, true);
  const second = await terminalCatalogPage({
    ...options,
    cursor: first.next_cursor!,
  });
  assert.equal(reads, 2);
  assert.equal(second.has_more, false);
  await assert.rejects(
    terminalCatalogPage({
      ...options,
      read: async () => ({ terminals: [], limit: 50, has_more: true }),
    }),
    /游标/,
  );
});

test("terminal source pages enforce a URL byte budget as well as a row budget", async () => {
  const roots = Array.from(
    { length: 40 },
    (_, i) => `${String(i).padStart(3, "0")}${"根".repeat(100)}`,
  );
  let selected: readonly string[] = [];
  const page = await terminalCatalogPage({
    owner: ["principal"],
    sources: [{ key: "source", sessionId: "session", contextId: "ctx", roots }],
    read: async (_source, ids) => {
      selected = ids;
      return { terminals: [], limit: 50, has_more: false };
    },
  });
  assert.ok(selected.length > 0 && selected.length < 32);
  assert.ok(
    new URLSearchParams({ root_ids: JSON.stringify(selected) }).toString()
      .length <= 6000,
  );
  assert.equal(page.has_more, true);
  assert.ok(page.next_cursor);
});
