import test from "node:test";
import assert from "node:assert/strict";
import {
  readArtifactVersionPage,
  type ArtifactVersionPage,
} from "../apps/web/src/data/artifact-version-reads.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import type { Workspace } from "../packages/core/src/model.js";

function fixture() {
  const calls: Array<{ operation: string; options?: unknown }> = [];
  const current = {
    current: { csrfToken: "identity-a", workspace: {} as Workspace },
  };
  const protectedReadGeneration = { current: 1 };
  const page = (revisions: number[], nextCursor: number | null) => ({
    contentId: "content",
    objectId: "object",
    projectId: "project",
    versions: revisions.map((revision) => ({
      revision,
      title: "Version " + revision,
      author: { principalId: "human", actantId: "author" },
      createdAt: "2026-10-20T00:00:00Z",
    })),
    nextCursor,
  });
  let response: ArtifactVersionPage = page([3, 2, 1], null);
  let afterRead = () => {};
  const source = {
    boot: { csrfToken: "identity-a" },
    async getContent() {
      calls.push({ operation: "directory" });
      return {
        id: "content",
        appId: "morphz.objects",
        appObjectId: "object",
        projectId: "project",
        availability: "available",
      };
    },
    async objectVersions(_contentId: string, options: unknown) {
      calls.push({ operation: "versions", options });
      afterRead();
      return response;
    },
  };
  return {
    ports: {
      platform: { current: source as unknown as PlatformClient },
      current,
      protectedReadGeneration,
    },
    calls,
    page,
    source,
    reply(value: ArtifactVersionPage) {
      response = value;
    },
    afterRead(value: () => void) {
      afterRead = value;
    },
  };
}

test("history pages are bounded metadata only, with explicit cursor continuation", async () => {
  const f = fixture();
  const first = f.page(
    Array.from({ length: 50 }, (_, index) => 53 - index),
    4,
  );
  f.reply(first);
  assert.deepEqual(await readArtifactVersionPage(f.ports, "content"), first);
  f.reply(f.page([3, 2, 1], null));
  const next = await readArtifactVersionPage(f.ports, "content", 4);
  assert.deepEqual(
    next.versions.map((version) => version.revision),
    [3, 2, 1],
  );
  assert.deepEqual(f.calls, [
    { operation: "directory" },
    {
      operation: "versions",
      options: { limit: 50, beforeRevision: undefined },
    },
    { operation: "directory" },
    { operation: "versions", options: { limit: 50, beforeRevision: 4 } },
  ]);
  assert.equal(next.nextCursor, null);
  assert.ok(next.versions.every((version) => !("content" in version)));
});

test("history metadata never crosses an identity or access-generation change", async () => {
  for (const changed of ["identity", "access", "abort"]) {
    const f = fixture();
    const controller = new AbortController();
    f.afterRead(() => {
      if (changed === "identity")
        f.ports.current.current.csrfToken = "identity-b";
      else if (changed === "access") f.ports.protectedReadGeneration.current++;
      else controller.abort();
    });
    await assert.rejects(
      readArtifactVersionPage(f.ports, "content", undefined, controller.signal),
      /身份或访问范围已变化/,
    );
  }
});

test("history rejects a revoked directory before reading version metadata", async () => {
  const f = fixture();
  f.source.getContent = async () => {
    throw new Error("forbidden");
  };
  await assert.rejects(
    readArtifactVersionPage(f.ports, "content"),
    /forbidden/,
  );
  assert.deepEqual(f.calls, []);
});

test("history rejects wrong original, unordered pages and non-progressing cursors", async () => {
  for (const response of [
    { ...fixture().page([3, 2, 1], null), objectId: "another-object" },
    { ...fixture().page([3, 2, 1], null), projectId: "another-project" },
    fixture().page([3, 3, 2], null),
    fixture().page([3, 2, 1], 3),
    fixture().page([], 1),
    fixture().page([4, 3], null),
    fixture().page(
      Array.from({ length: 51 }, (_, index) => 53 - index),
      null,
    ),
  ]) {
    const f = fixture();
    f.reply(response);
    await assert.rejects(readArtifactVersionPage(f.ports, "content", 4));
  }
});

test("invalid cursors and mismatched initial identity perform no network reads", async () => {
  const f = fixture();
  for (const cursor of [0, -1, 1.5, NaN, Infinity])
    await assert.rejects(readArtifactVersionPage(f.ports, "content", cursor));
  f.ports.current.current.csrfToken = "identity-b";
  await assert.rejects(
    readArtifactVersionPage(f.ports, "content"),
    /身份已变化/,
  );
  assert.deepEqual(f.calls, []);
});
