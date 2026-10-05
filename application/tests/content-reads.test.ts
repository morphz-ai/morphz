import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isFunctionDeclaration,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  isBinaryExpression,
  isIdentifier,
  isPropertyAssignment,
  isArrowFunction,
  isIfStatement,
  isVariableDeclaration,
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
  type ScriptLibraryEntry,
} from "../apps/web/src/platform-client.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import { createRefreshDrain } from "../apps/web/src/refresh-drain.js";
import {
  scriptLibraryEntryFromContent,
  type PlatformNavigationCache,
} from "../apps/web/src/platform-workspace-view.js";
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
      cognitiveApps: { versions: [], connections: [] },
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
    scriptPublications: ScriptLibraryEntry[][] = [],
    publicationOrder: string[] = [],
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
    publicationOrder.push("catalog");
    events.push(["catalog", structuredClone(contents)]);
  };
  let onScripts = (_entries: ScriptLibraryEntry[]) => {};
  const publishScriptLibrary = (entries: ScriptLibraryEntry[]) => {
    assert.equal(catalogCache.current?.value.scriptLibrary, entries);
    scriptPublications.push(entries);
    publicationOrder.push("scripts");
    onScripts(entries);
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
        publishScriptLibrary,
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
    scriptPublications,
    publicationOrder,
    onScriptPublication(value: typeof onScripts) {
      onScripts = value;
    },
    onRefresh(value: typeof refreshImpl) {
      refreshImpl = value;
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
// Execute only the actual Client's finite synchronous ports/commit preflight.
// This is not a mounted Client or an HTTP publication test.
function clientPublicationContracts() {
  const root = "/content-client-publication",
    config = root + "/tsconfig.json";
  const api = new API({
    cwd: root,
    fs: createVirtualFileSystem({
      [root + "/client.ts"]: readFileSync("apps/web/src/client.ts", "utf8"),
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["client.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(root + "/client.ts")!,
      nodes: Node[] = [];
    function walk(node: Node) {
      nodes.push(node);
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
    const publishers = nodes
      .filter(isPropertyAssignment)
      .filter(
        (node) =>
          isIdentifier(node.name) && node.name.text === "publishScriptLibrary",
      );
    assert.equal(publishers.length, 1);
    const publisher = publishers[0]!.initializer;
    assert.ok(isArrowFunction(publisher));
    const confirmations = nodes
      .filter(isVariableDeclaration)
      .filter(
        (node) =>
          isIdentifier(node.name) && node.name.text === "savedProjection",
      );
    assert.equal(confirmations.length, 1);
    const block = confirmations[0]!.parent.parent.parent,
      statements: Node[] = [];
    block.forEachChild((node) => {
      statements.push(node);
    });
    const index = statements.indexOf(confirmations[0]!.parent.parent);
    assert.ok(index >= 2);
    assert.ok(isIfStatement(statements[index - 2]!));
    assert.ok(isIfStatement(statements[index - 1]!));
    const commit = statements
      .slice(index - 2, index)
      .map((node) => node.getText())
      .join("\n");
    return {
      publisher: new Function(
        "current",
        "setBoot",
        "return (" + stripTypeScriptTypes(publisher.getText()) + ");",
      ) as (
        current: {
          current: {
            scriptLibrary: ScriptLibraryEntry[];
            opaque: string;
          } | null;
        },
        setBoot: (value: unknown) => void,
      ) => (entries: ScriptLibraryEntry[]) => void,
      commit: new Function(
        "version",
        "epoch",
        "conversationHistory",
        "requestedScope",
        "readCatalogCache",
        "catalogCache",
        "readCatalogValue",
        "refresh",
        commit + "\nreturn true;",
      ) as (
        version: number,
        epoch: { current: number },
        history: { isSelectionCurrent: (scope: unknown) => boolean },
        scope: unknown,
        cache: PlatformNavigationCache | null,
        cacheRef: { current: PlatformNavigationCache | null },
        value: PlatformNavigationCache["value"] | undefined,
        refresh: () => Promise<boolean>,
      ) => boolean,
    };
  } finally {
    snapshot.dispose();
    api.close();
  }
}
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
        publishScriptLibrary: unexpected,
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
test("equal remembered content synchronously publishes the cached script array, not ignored incoming fields", async () => {
  const h = await harness(false);
  const script = entry("script", {
    appId: "morphz.script-studio",
    kind: "script",
    appObjectId: "production",
    observedVersionRef: "2",
  });
  h.catalogCache.current = catalog([script]);
  const scripts: ScriptLibraryEntry[] = [
    {
      id: "production",
      contentId: "script",
      projectId: script.projectId,
      title: script.title,
      updatedAt: script.updatedAt,
      catalogRevision: 1,
      activityRevision: 2,
    },
  ];
  h.catalogCache.current.value.scriptLibrary = scripts;
  let projected: ScriptLibraryEntry[] = [];
  h.onScriptPublication((entries) => {
    projected = entries;
  });
  const cache = h.catalogCache.current.value;
  h.methods.rememberContent(
    { ...script, availability: "unavailable", updatedAt: "ignored" },
    bootstrap.csrfToken,
  );
  assert.equal(
    projected,
    scripts,
    "missing presentation entry is repaired synchronously",
  );
  assert.equal(h.catalogCache.current.value, cache);
  assert.deepEqual(h.scriptPublications, [scripts]);
  assert.deepEqual(h.publicationOrder, ["scripts"]);
  assert.deepEqual(
    h.events,
    [],
    "the original cache/catalog ledger is unchanged",
  );
});
test("equal confirmed cold script moves the cached original to the bounded reference tail and invalidates an older snapshot", async () => {
  const h = await harness(false),
    head = entry("head");
  const scripts = Array.from({ length: 150 }, (_, index) =>
    entry("script-" + index, {
      appId: "morphz.script-studio",
      kind: "script",
      appObjectId: "production-" + index,
      observedVersionRef: "2",
    }),
  );
  h.catalogCache.current = catalog([head, ...scripts]);
  const cache = h.catalogCache.current,
    before = cache.value,
    target = scripts[0]!;
  cache.value.scriptLibrary = scripts.map(scriptLibraryEntryFromContent);
  h.methods.rememberContent(
    {
      ...target,
      appId: "ignored-app",
      kind: "document",
      appObjectId: "ignored-production",
      availability: "unavailable",
      updatedAt: "ignored",
      providerRevision: 99,
    },
    bootstrap.csrfToken,
  );
  assert.notEqual(
    cache.value,
    before,
    "equal point-read confirmation must retire an older snapshot",
  );
  assert.equal(cache.value.headContents[0], head);
  assert.equal(cache.value.contents.length, 151);
  assert.equal(
    cache.value.contents.at(-1),
    target,
    "cached source fields, not ignored incoming metadata",
  );
  assert.deepEqual(
    cache.value.contents.slice(1).map((item) => item.id),
    [...scripts.slice(1).map((item) => item.id), target.id],
  );
  assert.deepEqual(
    cache.value.scriptLibrary.at(-1),
    scriptLibraryEntryFromContent(target),
  );
  assert.equal(cache.version, 8);
  assert.deepEqual(h.publicationOrder, ["scripts", "catalog"]);
  let retired = 0;
  assert.equal(
    clientPublicationContracts().commit(
      4,
      { current: 4 },
      { isSelectionCurrent: () => true },
      {},
      cache,
      h.catalogCache,
      before,
      async () => {
        retired++;
        return true;
      },
    ),
    false,
  );
  assert.equal(retired, 1);
  const after = cache.value;
  h.methods.rememberContent(
    { ...target, availability: "unavailable", providerRevision: 99 },
    bootstrap.csrfToken,
  );
  assert.equal(
    cache.value,
    after,
    "already-latest confirmation does not repeatedly invalidate snapshots",
  );
  assert.deepEqual(h.publicationOrder, ["scripts", "catalog", "scripts"]);
});
test("equal tail script confirmation rebuilds an over-budget catalog before the client selects its first 150 references", async () => {
  for (const mixed of [false, true]) {
    const h = await harness(false),
      head = entry("head");
    const references = Array.from({ length: 151 }, (_, index) =>
      entry("reference-" + index, {
        appId: "morphz.script-studio",
        kind: "script",
        appObjectId: "production-" + index,
        observedVersionRef: "2",
      }),
    );
    if (mixed) references[0] = entry("ordinary-document");
    h.catalogCache.current = catalog([head, ...references]);
    const cache = h.catalogCache.current,
      before = cache.value,
      target = references.at(-1)!;
    cache.value.scriptLibrary = references
      .filter((item) => item.kind === "script")
      .map(scriptLibraryEntryFromContent);
    h.methods.rememberContent(
      { ...target, availability: "unavailable", updatedAt: "ignored" },
      bootstrap.csrfToken,
    );
    assert.notEqual(
      cache.value,
      before,
      "a tail confirmation must retire a cache containing more than 150 non-head references",
    );
    assert.equal(cache.value.headContents[0], head);
    assert.equal(cache.value.contents.length, 151);
    assert.deepEqual(cache.value.contents.slice(1), references.slice(1));
    assert.equal(cache.value.contents.at(-1), target);
    assert.deepEqual(
      cache.value.scriptLibrary.at(-1),
      scriptLibraryEntryFromContent(target),
    );
    assert.ok(
      cache.value.contents
        .filter((item) => item.kind === "script")
        .map((item) => item.id)
        .slice(0, 150)
        .includes(target.id),
      "the current point-read target remains in the client's bounded selection",
    );
    assert.deepEqual(h.publicationOrder, ["scripts", "catalog"]);
    let retired = 0;
    assert.equal(
      clientPublicationContracts().commit(
        4,
        { current: 4 },
        { isSelectionCurrent: () => true },
        {},
        cache,
        h.catalogCache,
        before,
        async () => {
          retired++;
          return true;
        },
      ),
      false,
    );
    assert.equal(retired, 1);
    const bounded = cache.value;
    h.methods.rememberContent(target, bootstrap.csrfToken);
    assert.equal(cache.value, bounded, "bounded tail confirmation is a no-op");
    assert.deepEqual(h.publicationOrder, ["scripts", "catalog", "scripts"]);
  }
});
test("equal head and non-available-script references keep the original no-op and cached fields", async () => {
  for (const changes of [
    { appId: "morphz.objects", kind: "document", availability: "available" },
    {
      appId: "morphz.script-studio",
      kind: "script",
      availability: "unavailable",
    },
    {
      appId: "morphz.script-studio",
      kind: "document",
      availability: "available",
    },
  ] as const) {
    const h = await harness(false),
      head = entry("head"),
      target = entry("reference", changes),
      other = entry("other");
    h.catalogCache.current = catalog([head, target, other]);
    const before = h.catalogCache.current.value;
    h.methods.rememberContent(
      {
        ...target,
        appId: "morphz.script-studio",
        kind: "script",
        availability: "available",
        updatedAt: "ignored",
      },
      bootstrap.csrfToken,
    );
    assert.equal(h.catalogCache.current.value, before);
    assert.equal(h.catalogCache.current.value.contents[1], target);
    assert.deepEqual(h.publicationOrder, ["scripts"]);
    assert.deepEqual(h.events, []);
  }
});
test("changed remembered scripts publish the newly assigned array before catalog, including removal and non-script entries", async () => {
  const h = await harness(false);
  const script = entry("script", {
    appId: "morphz.script-studio",
    kind: "script",
    appObjectId: "production",
    observedVersionRef: "2",
  });
  const before = h.catalogCache.current!.value;
  h.onScriptPublication((entries) => {
    assert.notEqual(h.catalogCache.current!.value, before);
    assert.equal(entries, h.catalogCache.current!.value.scriptLibrary);
    assert.equal(
      h.events.length,
      h.scriptPublications.length - 1,
      "each synchronous script publication precedes its catalog publication",
    );
  });
  h.methods.rememberContent(script, bootstrap.csrfToken);
  assert.equal(h.scriptPublications[0]![0]!.activityRevision, 2);
  h.methods.rememberContent(
    { ...script, revision: 2, observedVersionRef: "3", title: "changed" },
    bootstrap.csrfToken,
  );
  assert.equal(h.scriptPublications[1]![0]!.activityRevision, 3);
  assert.equal(h.scriptPublications[1]![0]!.catalogRevision, 2);
  assert.equal(h.scriptPublications[1]![0]!.title, "changed");
  h.methods.rememberContent(
    { ...script, revision: 3, availability: "unavailable" },
    bootstrap.csrfToken,
  );
  assert.deepEqual(h.scriptPublications[2], []);
  h.methods.rememberContent(entry("document"), bootstrap.csrfToken);
  assert.deepEqual(h.scriptPublications[3], []);
  assert.deepEqual(h.publicationOrder, [
    "scripts",
    "catalog",
    "scripts",
    "catalog",
    "scripts",
    "catalog",
    "scripts",
    "catalog",
  ]);
});
test("remembered script publication retains the original identity and cache preflight", async () => {
  const h = await harness(false);
  h.methods.rememberContent(entry(), "different-CSRF");
  const boot = h.current.current;
  h.current.current = null;
  h.methods.rememberContent(entry(), bootstrap.csrfToken);
  h.current.current = boot;
  h.catalogCache.current = null;
  h.methods.rememberContent(entry(), bootstrap.csrfToken);
  assert.deepEqual(h.scriptPublications, []);
  assert.deepEqual(h.events, []);
});
test("actual Client script publisher uses all seven metadata fields and array order, preserving unchanged references and current-before-React", () => {
  const { publisher } = clientPublicationContracts();
  const script: ScriptLibraryEntry = {
    id: "production",
    contentId: "script",
    projectId: "first-project",
    title: "script",
    updatedAt: now,
    catalogRevision: 1,
    activityRevision: 2,
  };
  const current: {
      current: { scriptLibrary: ScriptLibraryEntry[]; opaque: string } | null;
    } = { current: { scriptLibrary: [], opaque: "preserved" } },
    ledger: unknown[] = [];
  const publish = publisher(current, (updated) => {
    assert.equal(current.current, updated);
    ledger.push(updated);
  });
  const entries = [script];
  publish(entries);
  assert.equal(current.current!.scriptLibrary, entries);
  assert.equal(current.current!.opaque, "preserved");
  const unchanged = current.current;
  publish([{ ...script }]);
  assert.equal(current.current, unchanged);
  assert.equal(ledger.length, 1);
  for (const field of [
    "id",
    "contentId",
    "projectId",
    "title",
    "updatedAt",
    "catalogRevision",
    "activityRevision",
  ] as const) {
    current.current = { scriptLibrary: [script], opaque: "preserved" };
    const changed = [
      {
        ...script,
        [field]: typeof script[field] === "number" ? 3 : "different",
      },
    ];
    const before: number = ledger.length;
    publish(changed);
    assert.equal(ledger.length, before + 1, field + " must publish");
    assert.equal(current.current!.scriptLibrary, changed);
  }
  const second = { ...script, id: "second" };
  current.current = { scriptLibrary: [script, second], opaque: "preserved" };
  publish([second, script]);
  assert.equal(current.current!.scriptLibrary[0], second);
  publish([]);
  assert.deepEqual(current.current!.scriptLibrary, []);
  current.current = null;
  const before = ledger.length;
  publish(entries);
  assert.equal(ledger.length, before);
});
test("actual Client catalog commit preflight retires a changed borrowed value through the original drain without writing the stale snapshot", async () => {
  const { commit } = clientPublicationContracts(),
    h = await harness(false);
  const hold = deferred<void>(),
    started = deferred<void>(),
    ledger: string[] = [],
    epoch = { current: 4 };
  let reads = 0;
  const drain = createRefreshDrain(async () => {
    reads++;
    const cache = h.catalogCache.current,
      value = cache?.value;
    if (reads === 1) {
      started.resolve();
      await hold.promise;
    }
    if (
      !commit(
        4,
        epoch,
        { isSelectionCurrent: () => true },
        {},
        cache,
        h.catalogCache,
        value,
        () => drain.request(),
      )
    ) {
      ledger.push("retired");
      return false;
    }
    ledger.push("confirmed", "history", "catalog", "Boot");
    return true;
  });
  const pending = drain.request();
  await started.promise;
  h.methods.rememberContent(
    entry("script", {
      appId: "morphz.script-studio",
      kind: "script",
      appObjectId: "production",
      observedVersionRef: "2",
    }),
    bootstrap.csrfToken,
  );
  hold.resolve();
  assert.equal(await pending, true);
  assert.equal(reads, 2);
  assert.deepEqual(ledger, [
    "retired",
    "confirmed",
    "history",
    "catalog",
    "Boot",
  ]);
  const cache = h.catalogCache.current!,
    oldValue = cache.value;
  cache.value = { ...cache.value };
  for (const [version, selected] of [
    [3, true],
    [4, false],
  ] as const) {
    let requests = 0;
    assert.equal(
      commit(
        version,
        epoch,
        { isSelectionCurrent: () => selected },
        {},
        cache,
        h.catalogCache,
        oldValue,
        async () => {
          requests++;
          return true;
        },
      ),
      false,
    );
    assert.equal(requests, 0, "original epoch/selection checks precede retry");
  }
  h.catalogCache.current = catalog();
  let requests = 0;
  assert.equal(
    commit(
      4,
      epoch,
      { isSelectionCurrent: () => true },
      {},
      cache,
      h.catalogCache,
      oldValue,
      async () => {
        requests++;
        return true;
      },
    ),
    true,
  );
  assert.equal(
    requests,
    0,
    "a replaced authority cache is not the same-object invalidation",
  );
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
