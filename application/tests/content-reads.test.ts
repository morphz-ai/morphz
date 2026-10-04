import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isFunctionDeclaration,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  isBinaryExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { createContentReads } from "../apps/web/src/data/content-reads.js";
import { createFixedContentReads } from "./fixtures/content-reads-84de08bb.js";
import {
  PlatformClient,
  type PlatformContent,
  type PlatformTask,
  type PlatformTaskVersion,
} from "../apps/web/src/platform-client.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import type { PlatformNavigationCache } from "../apps/web/src/platform-workspace-view.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import {
  contentSchema,
  initialWorkspace,
  type Artifact,
} from "../packages/core/src/model.js";

const fixedHashes = {
  listContentPage:
    "c869eb39a4a742a38f7b1ec3101a41c9ae887c2594751a2f1f77d671c91b5817",
  readProjectUnderstanding:
    "bd5f7b44a87d034640e3aa97a997b2afee963090d6f5df73374135540df5a1c5",
  countContent:
    "1991e2db718b4b8954a6993758e19e71e7b84230e7d744c70b5abece23b4f286",
  rememberContent:
    "134555812efeaea7086c0d365a766917ddc9b96a515195d51375421dc76bccea",
  resolveArtifact:
    "92c800cc733da54f790df91e3a687b97f11757dc29c590e266b81fc70080b522",
  resolveCatalogContent:
    "0d279cdb15a7d2d0bddd7c7ee9365f93b3faf554601a2b7db883e9baf233f97b",
};
function shape(node: Node, source: SourceFile): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child, source));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(source),
  ];
}
function fixtureHashes(text: string) {
  const root = "/content-read-fixture",
    config = root + "/tsconfig.json";
  const api = new API({
    cwd: root,
    fs: createVirtualFileSystem({
      [root + "/fixture.ts"]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["fixture.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(root + "/fixture.ts")!;
    const hashes: Record<string, string> = {};
    function walk(node: Node) {
      if (
        isFunctionDeclaration(node) &&
        node.name &&
        node.name.text in fixedHashes
      )
        hashes[node.name.text] = createHash("sha256")
          .update(JSON.stringify(shape(node, source)))
          .digest("hex");
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
    return hashes;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
test("six fixed Git 84de08bb algorithms remain independent of the new owner", () => {
  const source = readFileSync(
    new URL("./fixtures/content-reads-84de08bb.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(fixtureHashes(source), fixedHashes);
  assert.notDeepEqual(
    fixtureHashes(source.replace(".slice(-149)", ".slice(-150)")),
    fixedHashes,
  );
  assert.notDeepEqual(
    fixtureHashes(source.replace("if (!source)", "if (~source)")),
    fixedHashes,
  );
});

const now = "2026-10-04T00:00:00.000Z",
  author = { principalId: "human", actantId: "human-actant" };
const bootstrap = {
  centerId: "12345678-1234-4234-8234-123456789012",
  csrfToken: "identity-A",
  principalId: author.principalId,
  actantId: author.actantId,
  displayName: "TEST",
  capabilities: {
    runtime: false,
    teamAuthentication: true,
    directedInput: false,
    localFiles: false,
    browserBookmarks: false,
    modelSettings: false,
  },
};
function entry(
  id = "document",
  changes: Partial<PlatformContent> = {},
): PlatformContent {
  return {
    id,
    appId: "morphz.objects",
    instanceId: "objects",
    providerRevision: 1,
    appObjectId: "original-" + id,
    projectId: "first-project",
    kind: "document",
    title: "title-" + id,
    observedVersionRef: "1",
    availability: "available",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...changes,
  };
}
function artifact(id = "document", revision = 1): Artifact {
  const content = contentSchema.parse({
    kind: "document",
    markdown: "body-" + revision,
  });
  return {
    id,
    projectId: "first-project",
    title: "title-" + id,
    revision,
    catalogRevision: 1,
    providerRevision: 1,
    createdBy: author,
    createdAt: now,
    updatedAt: now,
    content,
    source: null,
    versions: [
      {
        revision,
        projectId: "first-project",
        title: "title-" + id,
        content,
        author,
        createdAt: now,
      },
    ],
  };
}
function objectVersion(id: string, revision: number) {
  const value = artifact(id, revision);
  return {
    objectId: "original-" + id,
    contentId: id,
    projectId: value.projectId,
    revision,
    headRevision: 3,
    title: value.title,
    content: value.content,
    source: null,
    author,
    createdAt: now,
  };
}
function taskVersion(revision: number): PlatformTaskVersion {
  return {
    taskId: "task",
    projectId: "first-project",
    revision,
    title: "TEST task",
    description: "actual task",
    assigneeId: author.actantId,
    modelId: null,
    reasoningEffort: null,
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    runRequested: 0,
    notBefore: null,
    everySeconds: null,
    authorPrincipalId: author.principalId,
    authorActantId: author.actantId,
    createdAt: now,
    resultIds: [],
    dependsOnIds: [],
    watchSourceIds: [],
  };
}
function task(revision = 3): PlatformTask {
  return {
    id: "task",
    projectId: "first-project",
    title: "TEST task",
    description: "actual task",
    assigneeId: author.actantId,
    execution: "planned",
    dueDate: null,
    orderRank: 0,
    revision,
    updatedAt: now,
    createdAt: now,
    createdByPrincipalId: author.principalId,
    createdByActantId: author.actantId,
    headVersion: taskVersion(revision),
  };
}
function taskArtifact(revision = 3) {
  const value = artifact("task", revision);
  value.title = "TEST task";
  value.content = contentSchema.parse({
    kind: "task",
    description: "actual task",
    assigneeId: author.actantId,
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    runRequested: 0,
    notBefore: null,
    everySeconds: null,
    dependsOnIds: [],
    watchSourceIds: [],
  });
  value.versions[0]!.content = value.content;
  value.versions[0]!.title = value.title;
  return value;
}
function catalog(
  contents: PlatformContent[] = [],
  tasks: PlatformTask[] = [],
): PlatformNavigationCache {
  return {
    version: 8,
    revisions: { access: 1, projects: 2, conversations: 3, tasks: 4 },
    value: {
      personal: { deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" },
      projects: [],
      conversations: [],
      tasks,
      tasksLoaded: true,
      taskCounts: [],
      headContents: contents.slice(0, 1),
      contents,
      contentCounts: [],
      scriptLibrary: [],
      taskOrderRevision: 1,
      uiPackages: [],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Projection = {
  csrfToken: string;
  workspace: ReturnType<typeof initialWorkspace>;
  opaque: { retained: string };
};
type Response = (params: unknown) => unknown | Promise<unknown>;
async function harness(legacy: boolean) {
  const events: unknown[] = [],
    signals: (AbortSignal | undefined)[] = [];
  const responses = new Map<ApplicationMethod, Response>();
  const source = await PlatformClient.connect({
    async call(method, params, options) {
      if (method === "platform.bootstrap") return bootstrap;
      events.push(["call", method, params, options?.identityGeneration]);
      signals.push(options?.signal);
      const response = responses.get(method);
      assert.ok(response, "unexpected read " + method);
      return response(params);
    },
  });
  const current = {
    current: {
      csrfToken: bootstrap.csrfToken,
      workspace: initialWorkspace(now),
      opaque: { retained: "extra Boot fields" },
    } as Projection | null,
  };
  const platform = { current: source as PlatformClient | null },
    protectedReadGeneration = { current: 4 },
    catalogCache = { current: catalog() as PlatformNavigationCache | null };
  const setBoot = (value: Projection) => {
    assert.equal(
      current.current,
      value,
      "current is committed synchronously before React publication",
    );
    events.push(["boot", structuredClone(value)]);
  };
  const setContentCatalog = (contents: PlatformContent[]) => {
    assert.equal(catalogCache.current?.value.contents, contents);
    events.push(["catalog", structuredClone(contents)]);
  };
  let refreshImpl = async () => false;
  const refresh = () => {
    events.push(["refresh"]);
    return refreshImpl();
  };
  const shared = {
    platform,
    current,
    protectedReadGeneration,
    catalogCache,
    refresh,
  };
  const methods = legacy
    ? createFixedContentReads({ ...shared, setBoot, setContentCatalog })
    : createContentReads({
        ...shared,
        publishCatalog: setContentCatalog,
        publishArtifact(value) {
          current.current = value;
          setBoot(value);
        },
      });
  return {
    methods,
    events,
    signals,
    responses,
    current,
    platform,
    protectedReadGeneration,
    catalogCache,
    onRefresh(value: typeof refreshImpl) {
      refreshImpl = value;
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function compare(run: (h: Harness) => unknown | Promise<unknown>) {
  const outcomes: unknown[] = [];
  for (const legacy of [true, false]) {
    const h = await harness(legacy),
      result = await run(h);
    outcomes.push({
      result,
      events: h.events,
      current: h.current.current,
      cache: h.catalogCache.current,
    });
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
}
async function failed(pending: Promise<unknown>, text: RegExp) {
  await assert.rejects(pending, text);
}

test("new and fixed factories do not read borrowed refs or call ports during construction", () => {
  const unexpected = () => {
    assert.fail("constructor read or side effect");
  };
  const shared = {
    platform: {
      get current(): PlatformClient | null {
        return unexpected();
      },
    },
    current: {
      get current(): Projection | null {
        return unexpected();
      },
      set current(_value: Projection | null) {
        unexpected();
      },
    },
    protectedReadGeneration: {
      get current(): number {
        return unexpected();
      },
    },
    catalogCache: {
      get current(): PlatformNavigationCache | null {
        return unexpected();
      },
    },
    refresh: unexpected,
  };
  assert.equal(
    Object.keys(
      createContentReads({
        ...shared,
        publishCatalog: unexpected,
        publishArtifact: unexpected,
      }),
    ).length,
    6,
  );
  assert.equal(
    Object.keys(
      createFixedContentReads({
        ...shared,
        setBoot: unexpected,
        setContentCatalog: unexpected,
      }),
    ).length,
    6,
  );
});

test("construction is inert and the three query contracts pass original parameters/signals without an invented guard", async () => {
  await compare(async (h) => {
    assert.deepEqual(h.events, []);
    h.current.current = null;
    const signal = new AbortController().signal;
    h.responses.set("content.list", () => []);
    h.responses.set("content.counts", () => []);
    h.responses.set("projects.understanding", () => null);
    await h.methods.listContentPage(
      { projectId: "project", sort: "title", limit: 7 },
      signal,
    );
    await h.methods.countContent(
      { projectId: "project", kinds: ["document"] },
      signal,
    );
    assert.equal(
      await h.methods.readProjectUnderstanding("project", 3, signal),
      null,
    );
    assert.ok(h.signals.every((value) => value === signal));
    h.platform.current = null;
    await failed(h.methods.listContentPage({}), /内容目录暂不可用/);
    await failed(h.methods.countContent({}), /内容目录暂不可用/);
    await failed(
      h.methods.readProjectUnderstanding("project"),
      /当前理解暂不可用/,
    );
  });
});
test("remember is synchronous: absent identity/cache and the original four-field match are no-ops", async () => {
  await compare((h) => {
    const original = entry();
    h.catalogCache.current = catalog([original]);
    const cache = h.catalogCache.current,
      contents = cache.value.contents;
    h.methods.rememberContent(
      entry("document", { availability: "unavailable", providerRevision: 9 }),
      bootstrap.csrfToken,
    );
    assert.equal(cache.value.contents, contents);
    h.methods.rememberContent(entry("other"), "wrong identity");
    assert.deepEqual(h.events, []);
    h.catalogCache.current = null;
    h.methods.rememberContent(entry(), bootstrap.csrfToken);
    assert.deepEqual(h.events, []);
  });
});
test("remember retains head position, last 149 references plus new non-head, and only cache scriptLibrary", async () => {
  await compare((h) => {
    const head = entry("head"),
      references = Array.from({ length: 170 }, (_, i) =>
        entry("reference-" + i),
      );
    h.catalogCache.current = catalog([head, ...references]);
    const cache = h.catalogCache.current,
      beforeBoot = h.current.current;
    const script = entry("script", {
      appId: "morphz.script-studio",
      kind: "script",
      appObjectId: "production",
      observedVersionRef: "4",
    });
    h.methods.rememberContent(script, bootstrap.csrfToken);
    assert.equal(cache.value.headContents[0], head);
    assert.equal(cache.value.contents.length, 151);
    assert.equal(cache.value.contents[1]!.id, "reference-21");
    assert.equal(cache.value.contents.at(-1), script);
    assert.equal(cache.value.scriptLibrary[0]!.id, "production");
    h.methods.rememberContent(
      entry("head", { title: "renamed", revision: 2 }),
      bootstrap.csrfToken,
    );
    assert.equal(cache.value.contents[0]!.title, "renamed");
    assert.equal(cache.version, 8);
    assert.equal(h.current.current, beforeBoot);
    return cache.value.contents.map((item) => item.id);
  });
});
test("matching original still consults live directory, returns metadata copy, and never hydrates or publishes Boot", async () => {
  await compare(async (h) => {
    const existing = artifact();
    h.current.current!.workspace.artifacts = [existing];
    h.catalogCache.current = catalog([entry()]);
    // resolveArtifact's existing policy intentionally differs from workspace hydration's provider check.
    h.responses.set("content.get", () =>
      entry("document", { providerRevision: 7 }),
    );
    const before = h.current.current,
      result = await h.methods.resolveArtifact("document");
    assert.notEqual(result, existing);
    assert.equal(result?.content, existing.content);
    assert.equal(h.current.current, before);
    assert.equal(h.events.length, 1);
    await failed(
      h.methods.resolveArtifact("document", 99),
      /指定版本尚未进入内容目录/,
    );
    return result;
  });
});
test("changed metadata preserves known versions and publishes current before Boot once, with no body reread", async () => {
  await compare(async (h) => {
    const existing = artifact();
    h.current.current!.workspace.artifacts = [artifact("other"), existing];
    h.responses.set("content.get", () =>
      entry("document", {
        revision: 2,
        title: "new title",
        projectId: "new-project",
      }),
    );
    const result = await h.methods.resolveArtifact("document", 1);
    assert.equal(result?.revision, 1);
    assert.equal(result?.title, "new title");
    assert.deepEqual(
      h.current.current!.workspace.artifacts.map((value) => value.id),
      ["other", "document"],
    );
    assert.equal(h.current.current!.opaque.retained, "extra Boot fields");
    assert.deepEqual(
      h.events.map((row) => (row as unknown[])[0]),
      ["call", "catalog", "boot"],
    );
    return result;
  });
});
test("head plus exact historical body reads preserve request order, creation metadata and version union", async () => {
  await compare(async (h) => {
    h.current.current!.workspace.artifacts = [artifact()];
    h.responses.set("content.get", () =>
      entry("document", { revision: 3, observedVersionRef: "3" }),
    );
    h.responses.set("objects.read", (params) =>
      objectVersion(
        "document",
        (params as { revision?: number }).revision ?? 3,
      ),
    );
    h.responses.set("objects.versions", () => ({
      objectId: "original-document",
      contentId: "document",
      versions: [{ revision: 1, author, createdAt: now }],
    }));
    const result = await h.methods.resolveArtifact("document", 2);
    assert.deepEqual(
      result?.versions.map((version) => version.revision),
      [1, 2, 3],
    );
    assert.equal(result?.revision, 3);
    assert.deepEqual(
      h.events
        .filter((row) => (row as unknown[])[0] === "call")
        .map((row) => (row as unknown[])[1]),
      [
        "content.get",
        "objects.read",
        "objects.versions",
        "objects.read",
        "objects.versions",
      ],
    );
    assert.ok(
      h.signals.slice(1).every((value) => value instanceof AbortSignal),
    );
    return result;
  });
});
test("unavailable original is remembered before rejection; catalog resolve itself retains unavailable entries", async () => {
  await compare(async (h) => {
    const unavailable = entry("document", {
      availability: "unavailable",
      revision: 2,
    });
    h.responses.set("content.get", () => unavailable);
    await failed(h.methods.resolveArtifact("document"), /内容原件当前不可用/);
    assert.equal(h.current.current!.workspace.artifacts.length, 0);
    assert.equal(
      h.catalogCache.current!.value.contents[0]!.availability,
      "unavailable",
    );
    assert.equal(
      (await h.methods.resolveCatalogContent("document"))?.availability,
      "unavailable",
    );
  });
});
test("complete cached task returns the same object without a request or new requested-version policy", async () => {
  await compare(async (h) => {
    const existing = taskArtifact(1);
    h.current.current!.workspace.artifacts = [existing];
    h.catalogCache.current = catalog([], [task(1)]);
    h.platform.current = null;
    assert.equal(await h.methods.resolveArtifact("task", 99), existing);
    assert.deepEqual(h.events, []);
  });
});
test("incomplete cached task reads full history and replaces in place, not filter/append", async () => {
  await compare(async (h) => {
    const existing = taskArtifact();
    h.current.current!.workspace.artifacts = [existing, artifact("other")];
    h.catalogCache.current = catalog([], [task()]);
    h.responses.set("tasks.versions", () => [
      taskVersion(3),
      taskVersion(2),
      taskVersion(1),
    ]);
    const result = await h.methods.resolveArtifact("task");
    assert.deepEqual(
      result?.versions.map((version) => version.revision),
      [1, 2, 3],
    );
    assert.deepEqual(
      h.current.current!.workspace.artifacts.map((value) => value.id),
      ["task", "other"],
    );
    return result;
  });
});
test("content 404 resolves uncached task in original order and append policy; future task revision rejects before cache/Boot write", async () => {
  await compare(async (h) => {
    h.current.current!.workspace.artifacts = [artifact("other")];
    h.responses.set("content.get", () => {
      throw new RequestError(404, "not content");
    });
    h.responses.set("tasks.get", () => task());
    h.responses.set("tasks.versions", () => [
      taskVersion(3),
      taskVersion(2),
      taskVersion(1),
    ]);
    await failed(
      h.methods.resolveArtifact("task", 99),
      /指定版本尚未进入事项目录/,
    );
    assert.equal(h.catalogCache.current!.value.tasks.length, 0);
    const result = await h.methods.resolveArtifact("task", 2);
    assert.deepEqual(
      h.current.current!.workspace.artifacts.map((value) => value.id),
      ["other", "task"],
    );
    assert.equal(h.catalogCache.current!.value.tasks[0]!.id, "task");
    return result;
  });
});
test("catalog 404 remains null even during generation change; artifact 404 checks stale before task fallback", async () => {
  await compare(async (h) => {
    h.responses.set("content.get", () => {
      h.protectedReadGeneration.current++;
      throw new RequestError(404, "hidden");
    });
    assert.equal(await h.methods.resolveCatalogContent("missing"), null);
    await failed(h.methods.resolveArtifact("missing"), /身份或访问范围已变化/);
    assert.equal(h.events.length, 2);
    h.responses.set("content.get", () => {
      throw new RequestError(403, "no access");
    });
    await failed(h.methods.resolveArtifact("missing"), /no access/);
    assert.equal(h.events.length, 3);
  });
});
test("catalog late success checks identity and protected generation before remember; no cache remains a valid no-op", async () => {
  for (const kind of ["identity", "generation", "no-cache"] as const)
    await compare(async (h) => {
      const hold = deferred<PlatformContent>(),
        started = deferred<void>();
      h.responses.set("content.get", () => {
        started.resolve();
        return hold.promise;
      });
      const pending = h.methods.resolveCatalogContent("document");
      await started.promise;
      if (kind === "identity")
        h.current.current = { ...h.current.current!, csrfToken: "identity-B" };
      if (kind === "generation") h.protectedReadGeneration.current++;
      if (kind === "no-cache") h.catalogCache.current = null;
      hold.resolve(entry());
      if (kind === "no-cache") assert.equal((await pending)?.id, "document");
      else await failed(pending, /身份已变化，内容未读取/);
      assert.equal(h.events.length, 1);
    });
});
test("late body cannot overwrite changed identity, protected generation, catalog scope/version or an intervening original", async () => {
  for (const kind of [
    "identity",
    "generation",
    "catalog-version",
    "catalog-project",
    "catalog-original",
    "artifact-version",
    "artifact-project",
  ] as const)
    await compare(async (h) => {
      h.current.current!.workspace.artifacts = [artifact()];
      h.responses.set("content.get", () =>
        entry("document", { revision: 2, observedVersionRef: "2" }),
      );
      const hold = deferred<ReturnType<typeof objectVersion>>(),
        started = deferred<void>();
      h.responses.set("objects.read", () => {
        started.resolve();
        return hold.promise;
      });
      h.responses.set("objects.versions", () => ({
        objectId: "original-document",
        contentId: "document",
        versions: [{ revision: 1, author, createdAt: now }],
      }));
      const pending = h.methods.resolveArtifact("document");
      await started.promise;
      if (kind === "identity")
        h.current.current = { ...h.current.current!, csrfToken: "identity-B" };
      if (kind === "generation") h.protectedReadGeneration.current++;
      if (kind.startsWith("catalog")) {
        const currentEntry = { ...h.catalogCache.current!.value.contents[0]! };
        if (kind === "catalog-version") currentEntry.revision++;
        if (kind === "catalog-project") currentEntry.projectId = "other";
        if (kind === "catalog-original") currentEntry.observedVersionRef = "9";
        h.catalogCache.current!.value = {
          ...h.catalogCache.current!.value,
          contents: [currentEntry],
        };
      }
      if (kind.startsWith("artifact"))
        h.current.current!.workspace.artifacts = [
          artifact("document", kind === "artifact-version" ? 4 : 1),
        ];
      if (kind === "artifact-project")
        h.current.current!.workspace.artifacts[0]!.projectId = "other";
      const before = h.current.current;
      hold.resolve(objectVersion("document", 2));
      await failed(
        pending,
        kind === "identity" || kind === "generation"
          ? /身份或访问范围已变化/
          : kind.startsWith("catalog")
            ? /内容目录已变化/
            : /内容已变化/,
      );
      assert.equal(h.current.current, before);
      assert.equal(
        h.events.some((row) => (row as unknown[])[0] === "boot"),
        false,
      );
    });
});
test("missing source uses original one/two refresh fallback and retained-cache return without an added guard", async () => {
  for (const foundOn of [1, 2, 0])
    await compare(async (h) => {
      h.platform.current = null;
      let calls = 0;
      h.onRefresh(async () => {
        calls++;
        if (calls === foundOn)
          h.current.current!.workspace.artifacts.push(artifact());
        return true;
      });
      const result = await h.methods.resolveArtifact("document");
      assert.equal(calls, foundOn === 1 ? 1 : 2);
      assert.equal(result?.id, foundOn ? "document" : undefined);
      return result;
    });
  await compare(async (h) => {
    const existing = artifact();
    h.current.current!.workspace.artifacts = [existing];
    h.platform.current = null;
    assert.equal(await h.methods.resolveArtifact("document"), existing);
    assert.deepEqual(h.events, []);
  });
});
test("query Promise continuation order is unchanged, and no successful read is silently deduplicated", async () => {
  await compare(async (h) => {
    const result = deferred<PlatformContent[]>();
    h.responses.set("content.list", () => result.promise);
    const first = h.methods.listContentPage({ limit: 2 }),
      second = h.methods.listContentPage({ limit: 2 });
    assert.notEqual(first, second);
    const order: string[] = [];
    first.then(() => {
      order.push("first");
    });
    second.then(() => {
      order.push("second");
    });
    result.promise.then(() => {
      order.push("source observer");
    });
    result.resolve([]);
    await Promise.all([first, second]);
    assert.equal(h.events.length, 2);
    return order;
  });
});

test("task hydration mismatch refreshes rather than committing its stale read, and preserves refresh result identity", async () => {
  await compare(async (h) => {
    h.current.current!.workspace.artifacts = [taskArtifact()];
    h.catalogCache.current = catalog([], [task()]);
    const hold = deferred<PlatformTaskVersion[]>(),
      started = deferred<void>();
    h.responses.set("tasks.versions", () => {
      started.resolve();
      return hold.promise;
    });
    const pending = h.methods.resolveArtifact("task");
    await started.promise;
    const newer = taskArtifact(4);
    h.current.current!.workspace.artifacts = [newer];
    h.onRefresh(async () => true);
    hold.resolve([taskVersion(3), taskVersion(2), taskVersion(1)]);
    assert.equal(await pending, newer);
    assert.deepEqual(
      h.events.map((row) => (row as unknown[])[0]),
      ["call", "refresh"],
    );
  });
});

test("two simultaneous explicit opens remain two reads; the second cannot overwrite the first committed head", async () => {
  await compare(async (h) => {
    h.current.current!.workspace.artifacts = [artifact()];
    h.responses.set("content.get", () =>
      entry("document", { revision: 2, observedVersionRef: "2" }),
    );
    const holds = [
      deferred<ReturnType<typeof objectVersion>>(),
      deferred<ReturnType<typeof objectVersion>>(),
    ];
    const started = deferred<void>();
    let index = 0;
    h.responses.set("objects.read", () => {
      const hold = holds[index++]!;
      if (index === 2) started.resolve();
      return hold.promise;
    });
    h.responses.set("objects.versions", () => ({
      objectId: "original-document",
      contentId: "document",
      versions: [{ revision: 1, author, createdAt: now }],
    }));
    const first = h.methods.resolveArtifact("document"),
      second = h.methods.resolveArtifact("document");
    await started.promise;
    holds[0]!.resolve(objectVersion("document", 2));
    const saved = await first,
      before = h.current.current;
    holds[1]!.resolve(objectVersion("document", 2));
    await failed(second, /内容已变化/);
    assert.equal(h.current.current, before);
    assert.equal(h.current.current!.workspace.artifacts.at(-1), saved);
    return saved;
  });
});
