import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  appendNavigationPlace,
  createWorkspaceNavigationCommands,
  isNavigationPreferenceChange,
  mergeNavigationPreferences,
  useWorkspaceNavigationState,
  type NavigationOwner,
  type NavigationPlace,
  type NavigationPreferences,
} from "../apps/web/src/host/use-workspace-navigation.js";
import {
  initialWorkspace,
  type Artifact,
  type Content,
  type Operation,
} from "../packages/core/src/model.js";
import {
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
} from "../packages/core/src/applications.js";
import type { Boot } from "../apps/web/src/client.js";

type Options = Parameters<
  typeof createWorkspaceNavigationCommands<NavigationPreferences>
>[0];
type ScriptRead = Awaited<
  ReturnType<Options["client"]["resolveScriptLocation"]>
>;
const now = "2026-10-04T00:00:00.000Z";
function prefs(
  change: Partial<NavigationPreferences> = {},
): NavigationPreferences {
  return {
    view: "projects",
    projectId: "first-project",
    projectOpen: true,
    artifactId: null,
    artifactRevision: null,
    collaboration: false,
    subjectOpen: true,
    ...change,
  };
}
function place(id: string): NavigationPlace {
  return {
    view: "projects",
    projectId: "first-project",
    projectOpen: true,
    artifactId: id,
    artifactRevision: null,
  };
}
function artifact(
  id = "document-A",
  content: Content = { kind: "document", markdown: "确切引用原文" },
): Artifact {
  return {
    id,
    projectId: "first-project",
    title: id,
    revision: 3,
    content,
    versions: [
      {
        revision: 2,
        content,
        createdAt: now,
        author: { principalId: "local-owner", actantId: "human" },
      },
    ],
  } as Artifact;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function script(): NonNullable<ScriptRead> {
  return {
    production: {
      id: "production-A",
      projectId: "first-project",
      contentId: "script-content-A",
    },
    item: undefined,
  } as NonNullable<ScriptRead>;
}
function fixture(change: Partial<NavigationPreferences> = {}) {
  const events: unknown[][] = [];
  const notices: string[] = [];
  const patches: Partial<NavigationPreferences>[] = [];
  let preferences = prefs(change);
  // Current authorization is a finite controlled projection, distinct from
  // the render capture. This is port-level coverage, not a real Client proof.
  const authorized = initialWorkspace(now);
  authorized.artifacts = ["document-A", "reader-object", "excluded"].map((id) =>
    artifact(id),
  );
  const projection = {
    centerId: "fixture-center",
    principalId: "local-owner",
    csrfToken: "fixture-session",
    workspace: authorized,
    scriptLibrary: [{ ...script().production }],
  } as unknown as Boot;
  let alive = true;
  const current = () =>
    alive &&
    projection.centerId === "fixture-center" &&
    projection.principalId === "local-owner" &&
    projection.csrfToken === "fixture-session"
      ? projection
      : null;
  const owner: NavigationOwner = {
    navigationGeneration: { current: 0 },
    openingObject: false,
    restoredPlace: null,
    trail: { current: { places: [], index: -1 } },
    trailVersion: 0,
    websiteIntent: null,
    beginIntent() {
      events.push(["begin"]);
      return ++owner.navigationGeneration.current;
    },
    beginOpen() {
      const epoch = owner.beginIntent();
      owner.openingObject = true;
      events.push(["opening", true]);
      return epoch;
    },
    isCurrent(epoch) {
      return epoch === owner.navigationGeneration.current;
    },
    finishOpen(epoch) {
      if (owner.isCurrent(epoch)) {
        owner.openingObject = false;
        events.push(["opening", false]);
      }
    },
    resetPreferenceNavigation() {
      owner.restoredPlace = null;
      owner.openingObject = false;
      events.push(["reset"]);
    },
    setExplicitWebsiteIntent(id) {
      owner.websiteIntent =
        typeof id === "function" ? id(owner.websiteIntent) : id;
      events.push(["website", id]);
    },
    recordPlace(next, key) {
      if (appendNavigationPlace(owner.trail.current, next, key))
        owner.trailVersion++;
    },
    restorePlace(current, index, next, commit) {
      current.index = index;
      owner.restoredPlace = next;
      events.push(["restore", index, next]);
      commit();
      owner.trailVersion++;
      events.push(["trail-version", owner.trailVersion]);
    },
  };
  const client: Options["client"] = {
    boot: projection,
    contentCatalog: [],
    async resolveCatalogContent() {
      return null;
    },
    async resolveArtifact(id, revision) {
      events.push(["resolve-artifact", id, revision]);
      return artifact(id);
    },
    async resolveScriptLocation(target) {
      events.push(["resolve-script", target]);
      return script();
    },
    async execute(operation) {
      events.push(["execute", operation]);
      if (operation.type === "launch-application")
        authorized.applicationInstances = [
          {
            id: "instance-A",
            workspaceId: operation.workspaceId,
            applicationId: operation.applicationId,
            applicationVersion: operation.applicationVersion,
            revision: 1,
            state: {},
            status: "open",
            createdAt: now,
            updatedAt: now,
          },
        ];
      return {
        commandId: "command-A",
        entityId: "instance-A",
        workspaceRevision: 1,
      };
    },
  };
  const options: Options = {
    owner,
    client,
    workspace: initialWorkspace(now),
    surface: {
      project: initialWorkspace(now).projects[0],
      applicationWorkspaceOpen: true,
      exchangeKey: "exchange-A",
      activeInstance: undefined,
    },
    preferences,
    prefer(change) {
      patches.push(change);
      events.push(["prefer", change]);
      if (isNavigationPreferenceChange(change)) {
        owner.beginIntent();
        owner.resetPreferenceNavigation();
      }
      preferences = mergeNavigationPreferences(preferences, change);
    },
    shell: {
      finishCreation() {
        events.push(["finish-creation"]);
      },
      dismissExecutionInspector() {
        events.push(["dismiss-executions"]);
      },
    },
    continuation: {
      isActive: () => !!current(),
      currentProjection: current,
      captureCommit() {
        const identity = [
          projection.centerId,
          projection.principalId,
          projection.csrfToken,
        ];
        return (value) =>
          alive &&
          value.centerId === identity[0] &&
          value.principalId === identity[1] &&
          value.csrfToken === identity[2];
      },
      prefer(change, intent, destination) {
        const before = current();
        if (!before || !destination(before)) return;
        options.prefer(change);
        intent.generation = owner.navigationGeneration.current;
      },
      writePreferences(update, failure, destination) {
        const before = current();
        if (!before || !destination(before)) return;
        preferences = update(preferences);
        events.push(["write", failure, preferences]);
      },
      recordContentVisit(id, destination) {
        const before = current();
        if (before && destination(before)) events.push(["visit", id]);
      },
    },
    onNotice(message) {
      notices.push(message);
      events.push(["notice", message]);
    },
    application: {
      historyVisible: false,
      personalDesk: () => undefined,
      readCapturedInstance: () => undefined,
      selectAllContent() {
        events.push(["all-content"]);
      },
    },
  };
  return {
    options,
    owner,
    events,
    notices,
    patches,
    client,
    preferences: () => preferences,
    commands: () => createWorkspaceNavigationCommands(options),
  };
}

test("six navigation fields invalidate by presence, including explicit undefined; layout-only fields do not", () => {
  for (const key of [
    "view",
    "projectId",
    "artifactId",
    "applications",
    "scriptLocation",
    "selectedConversations",
  ])
    assert.equal(isNavigationPreferenceChange({ [key]: undefined }), true, key);
  for (const key of [
    "artifactRevision",
    "artifactPage",
    "readerMode",
    "readingTarget",
    "projectOpen",
    "interactions",
    "pinnedInputs",
    "pinnedHistories",
    "exchangeHeights",
    "collaboration",
  ])
    assert.equal(
      isNavigationPreferenceChange({ [key]: undefined }),
      false,
      key,
    );
});

test("patch keeps the original asymmetric resets and map merging, without mutating prior preferences", () => {
  const old = prefs({
    artifactRevision: 7,
    scriptLocation: { productionId: "old-script", requestId: "old-request" },
    localFile: {
      projectId: "first-project",
      reference: {
        grantId: "g",
        path: "a.txt",
        name: "a.txt",
        version: "v1",
        kind: "text",
      },
    },
    applications: { A: "instance-A", B: null },
    selectedConversations: { A: "named-A", B: "named-B" },
    interactions: { A: "history", B: "input" },
    pinnedInputs: { A: true, B: false },
    pinnedHistories: { A: false, B: true },
    exchangeHeights: { A: 250, B: 280 },
  });
  const before = structuredClone(old);
  const next = mergeNavigationPreferences(old, {
    artifactId: null,
    applications: { A: "new-instance" },
    selectedConversations: { A: "new-named" },
    interactions: { A: "recent" },
    pinnedInputs: { A: false },
    pinnedHistories: { A: true },
    exchangeHeights: { A: 300 },
    collaboration: true,
  });
  assert.deepEqual(next.applications, { A: "new-instance" });
  assert.deepEqual(next.selectedConversations, {
    A: "new-named",
    B: "named-B",
  });
  assert.deepEqual(next.interactions, { A: "recent", B: "input" });
  assert.deepEqual(next.pinnedInputs, { A: false, B: false });
  assert.deepEqual(next.pinnedHistories, { A: true, B: true });
  assert.deepEqual(next.exchangeHeights, { A: 300, B: 280 });
  assert.equal(next.artifactRevision, null);
  assert.equal(next.scriptLocation, null);
  assert.equal(next.localFile, undefined);
  assert.equal(next.subjectOpen, false);
  assert.deepEqual(old, before);
  assert.strictEqual(
    mergeNavigationPreferences(old, { artifactId: null }).scriptLocation,
    old.scriptLocation,
  );
  assert.strictEqual(
    mergeNavigationPreferences(old, { scriptLocation: null }).localFile,
    old.localFile,
  );
  assert.equal(
    mergeNavigationPreferences(old, { artifactId: "next", artifactRevision: 2 })
      .artifactRevision,
    2,
  );
  assert.equal(
    mergeNavigationPreferences(old, { view: undefined }).scriptLocation,
    null,
  );
  assert.equal(
    mergeNavigationPreferences(old, { collaboration: false }).subjectOpen,
    true,
  );
});

test("trail deduplicates exact places, cuts only the forward branch and bounds history at 100", () => {
  const trail = { places: [] as NavigationPlace[], index: -1 };
  for (let n = 0; n < 104; n++) {
    const next = place(String(n));
    assert.equal(
      appendNavigationPlace(trail, next, JSON.stringify(next)),
      true,
    );
  }
  assert.equal(trail.places.length, 100);
  assert.equal(trail.index, 99);
  assert.equal(trail.places[0]!.artifactId, "4");
  const current = trail.places[99]!;
  assert.equal(
    appendNavigationPlace(trail, { ...current }, JSON.stringify(current)),
    false,
  );
  trail.index = 97;
  const next = place("new-branch");
  appendNavigationPlace(trail, next, JSON.stringify(next));
  assert.equal(trail.places.length, 99);
  assert.equal(trail.index, 98);
  assert.strictEqual(trail.places[98], next);
  assert.equal(
    trail.places.some((entry) => entry.artifactId === "103"),
    false,
  );
});

test("state hook renders independent initial owners without DOM/effects or eager commands", () => {
  const owners: NavigationOwner[] = [];
  function Probe() {
    owners.push(useWorkspaceNavigationState());
    return createElement("span");
  }
  renderToStaticMarkup(createElement(Probe));
  renderToStaticMarkup(createElement(Probe));
  assert.equal(owners.length, 2);
  assert.notStrictEqual(
    owners[0]!.navigationGeneration,
    owners[1]!.navigationGeneration,
  );
  assert.deepEqual(owners[0]!.trail.current, { places: [], index: -1 });
  assert.equal(owners[0]!.openingObject, false);
  assert.equal(owners[0]!.restoredPlace, null);
  assert.equal(owners[0]!.websiteIntent, null);
  assert.equal(owners[0]!.navigationGeneration.current, 0);
});

test("factory construction performs zero reads, writes, lifecycle transitions or hooks", () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.commands()), [
    "travel",
    "openObject",
    "openUser",
    "openReading",
    "openScriptLocation",
    "launchDockApplication",
    "readingLibrary",
    "openScriptLibrary",
    "openWorkspaceContents",
    "activateApplication",
    "navigate",
    "openBrowser",
    "applicationActions",
  ]);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.patches, []);
});

test("object open keeps exact launch/reference patch and returns the epoch after prefer invalidation", async () => {
  const f = fixture({
    applications: { old: "kept" },
    interactions: { "exchange-A": "history" },
  });
  const epoch = await f
    .commands()
    .openObject(
      "first-project",
      "document-A",
      2,
      4,
      false,
      undefined,
      "确切引用",
    );
  assert.equal(epoch, 2);
  assert.equal(f.owner.navigationGeneration.current, 2);
  assert.equal(f.owner.openingObject, false);
  assert.deepEqual(f.events.find((e) => e[0] === "execute")![1], {
    type: "launch-application",
    workspaceId: "first-project",
    applicationId: objectsApplication.id,
    applicationVersion: objectsApplication.version,
    artifactId: "document-A",
  });
  assert.deepEqual(f.patches[0], {
    artifactId: "document-A",
    artifactRevision: 2,
    artifactPage: 4,
    readerMode: false,
    readingTarget: null,
    interactions: { "exchange-A": "recent" },
    applications: { old: "kept", "first-project": "instance-A" },
  });
  assert.deepEqual(
    f.events.map((e) => e[0]),
    [
      "begin",
      "opening",
      "resolve-artifact",
      "execute",
      "finish-creation",
      "prefer",
      "begin",
      "reset",
      "visit",
    ],
  );
});

test("catalog object open is only a read, follows the live head, and explicit reader mode builds an exact target", async () => {
  const f = fixture();
  f.options.surface.applicationWorkspaceOpen = false;
  const location = { sourceId: "book", sectionId: "one", start: 4, end: 8 };
  await f
    .commands()
    .openObject(
      "first-project",
      "document-A",
      undefined,
      undefined,
      true,
      location,
    );
  assert.equal(
    f.events.some((e) => e[0] === "execute"),
    false,
  );
  assert.equal(f.patches[0]!.artifactRevision, null);
  assert.equal(f.patches[0]!.readerMode, true);
  assert.equal(f.patches[0]!.readingTarget!.revision, 3);
  assert.deepEqual(f.patches[0]!.readingTarget!.location, location);
  assert.match(f.patches[0]!.readingTarget!.requestId!, /^[0-9a-f-]{36}$/);
});

test("publication/pdf route through the Reader; tasks and understanding do not become recents", async () => {
  for (const kind of ["publication", "pdf"] as const) {
    const f = fixture();
    f.client.resolveArtifact = async () =>
      artifact("reader-object", { kind } as Content);
    await f.commands().openObject("first-project", "reader-object");
    assert.equal(
      (
        f.events.find((e) => e[0] === "execute")![1] as Operation & {
          applicationId: string;
        }
      ).applicationId,
      readerApplication.id,
    );
    assert.equal(f.patches[0]!.readerMode, true);
  }
  for (const content of [
    { kind: "task" },
    { kind: "document", markdown: "旧理解", understanding: true },
  ] as Content[]) {
    const f = fixture();
    f.client.resolveArtifact = async () => artifact("excluded", content);
    await f.commands().openObject("first-project", "excluded");
    assert.equal(
      f.events.some((e) => e[0] === "visit"),
      false,
    );
  }
});

test("unreadable/wrong-owner/wrong-version quote rejects before launch without consuming references", async () => {
  for (const value of [
    undefined,
    { ...artifact(), projectId: "other-project" },
    artifact(),
  ]) {
    const f = fixture();
    f.client.resolveArtifact = async () => value;
    assert.equal(
      await f
        .commands()
        .openObject(
          "first-project",
          "document-A",
          9,
          undefined,
          false,
          undefined,
          "不存在引用",
        ),
      undefined,
    );
    assert.equal(f.patches.length, 0);
    assert.equal(
      f.events.some((e) => e[0] === "execute" || e[0] === "visit"),
      false,
    );
    assert.equal(f.owner.openingObject, false);
    assert.equal(f.notices.length, 1);
  }
});

test("stale artifact success/finally cannot launch, commit, record recency or clear the later open", async () => {
  const f = fixture();
  const read = deferred<Artifact | undefined>();
  f.client.resolveArtifact = () => read.promise;
  const pending = f.commands().openObject("first-project", "document-A");
  f.owner.beginOpen();
  read.resolve(artifact());
  assert.equal(await pending, undefined);
  assert.equal(f.owner.openingObject, true);
  assert.equal(f.patches.length, 0);
  assert.equal(
    f.events.some((e) => e[0] === "execute" || e[0] === "visit"),
    false,
  );
});

test("stale launch receipt and ABA navigation do not activate the old object", async () => {
  const f = fixture();
  const receipt = deferred<Awaited<ReturnType<Options["client"]["execute"]>>>();
  const ready = deferred<void>();
  f.client.execute = async () => {
    ready.resolve();
    return receipt.promise;
  };
  const pending = f.commands().openObject("first-project", "document-A");
  await ready.promise;
  f.owner.beginIntent();
  f.owner.beginOpen();
  receipt.resolve({
    commandId: "slow",
    entityId: "old-instance",
    workspaceRevision: 1,
  });
  assert.equal(await pending, undefined);
  assert.equal(f.patches.length, 0);
  assert.equal(f.owner.openingObject, true);
});

test("object stale rejection still reports the original catch error; it does not clear a newer open", async () => {
  const f = fixture();
  const read = deferred<Artifact | undefined>();
  f.client.resolveArtifact = () => read.promise;
  const pending = f.commands().openObject("first-project", "document-A");
  f.owner.beginOpen();
  read.reject(new Error("原对象读取失败"));
  await pending;
  assert.deepEqual(f.notices, ["原对象读取失败"]);
  assert.equal(f.owner.openingObject, true);
});

test("script open retains exact target/request receipt and records only the resolved content identity", async () => {
  const f = fixture({ applications: { other: "other-instance" } });
  const target = {
    productionId: "production-A",
    itemId: "episode-A",
    revision: 2,
    candidateId: "candidate-A",
  };
  await f.commands().openScriptLocation(target);
  assert.deepEqual(f.events.find((e) => e[0] === "execute")![1], {
    type: "launch-application",
    workspaceId: "first-project",
    applicationId: scriptStudioApplication.id,
    applicationVersion: scriptStudioApplication.version,
    scriptTarget: target,
  });
  assert.deepEqual(f.patches[0], {
    artifactId: null,
    scriptLocation: { ...target, requestId: "command-A" },
    applications: { other: "other-instance", "first-project": "instance-A" },
    interactions: { "exchange-A": "hidden" },
  });
  assert.deepEqual(
    f.events
      .filter((e) =>
        ["finish-creation", "visit", "prefer"].includes(e[0] as string),
      )
      .map((e) => e[0]),
    ["finish-creation", "visit", "prefer"],
  );
});

test("script absent/failed and stale responses preserve their original gated errors and finally", async () => {
  const missing = fixture();
  missing.client.resolveScriptLocation = async () => null;
  await missing.commands().openScriptLocation({ productionId: "missing" });
  assert.deepEqual(missing.notices, ["剧本结果已不可用或无访问权限。"]);
  assert.equal(missing.patches.length, 0);
  for (const outcome of ["resolve", "reject"] as const) {
    const f = fixture();
    const read = deferred<ScriptRead>();
    f.client.resolveScriptLocation = () => read.promise;
    const pending = f
      .commands()
      .openScriptLocation({ productionId: "production-A" });
    f.owner.beginOpen();
    if (outcome === "resolve") read.resolve(script());
    else read.reject(new Error("旧错误"));
    await pending;
    assert.deepEqual(f.notices, []);
    assert.equal(f.patches.length, 0);
    assert.equal(f.owner.openingObject, true);
  }
});

test("history authorized reread restores raw place without prefer invalidation, recency or preview changes", async () => {
  const f = fixture({
    pinnedInputs: { A: true },
    interactions: { A: "history" },
  });
  const previous = { ...place("document-A"), artifactRevision: 2 };
  f.owner.trail.current = { places: [previous, place("document-B")], index: 1 };
  await f.commands().travel(-1);
  assert.equal(f.owner.trail.current.index, 0);
  assert.strictEqual(f.owner.restoredPlace, previous);
  assert.equal(f.owner.navigationGeneration.current, 1);
  assert.equal(f.owner.openingObject, false);
  assert.deepEqual(f.preferences().pinnedInputs, { A: true });
  assert.deepEqual(f.preferences().interactions, { A: "history" });
  assert.equal(f.patches.length, 0);
  assert.equal(
    f.events.some(
      (e) => e[0] === "visit" || e[0] === "execute" || e[0] === "reset",
    ),
    false,
  );
  assert.deepEqual(
    f.events.map((e) => e[0]),
    [
      "begin",
      "opening",
      "resolve-artifact",
      "finish-creation",
      "website",
      "dismiss-executions",
      "restore",
      "write",
      "trail-version",
      "opening",
    ],
  );
});

test("history invalid target/no neighbour/read denial leaves cursor and place intact", async () => {
  for (const mode of ["none", "missing-project", "missing-artifact"] as const) {
    const f = fixture();
    const destination =
      mode === "missing-project"
        ? { ...place(""), artifactId: null, projectId: "deleted" }
        : place("denied");
    f.owner.trail.current = {
      places:
        mode === "none" ? [place("current")] : [destination, place("current")],
      index: mode === "none" ? 0 : 1,
    };
    f.client.resolveArtifact = async () => undefined;
    const index = f.owner.trail.current.index;
    await f.commands().travel(-1);
    assert.equal(f.owner.trail.current.index, index);
    assert.equal(f.owner.restoredPlace, null);
    assert.equal(
      f.events.some((e) => e[0] === "write"),
      false,
    );
    assert.deepEqual(
      f.notices,
      mode === "none" ? [] : ["原位置已不可用或无访问权限。"],
    );
  }
});

test("history with both references preserves the second read before its original stale guard", async () => {
  const f = fixture();
  const read = deferred<Artifact | undefined>();
  f.client.resolveArtifact = () => read.promise;
  const target = {
    ...place("document-A"),
    scriptLocation: {
      productionId: "production-A",
      requestId: "saved-request",
    },
  };
  f.owner.trail.current = { places: [target, place("current")], index: 1 };
  const pending = f.commands().travel(-1);
  f.owner.beginOpen();
  read.resolve(artifact());
  await pending;
  assert.equal(
    f.events.some((e) => e[0] === "resolve-script"),
    true,
  );
  assert.equal(f.owner.trail.current.index, 1);
  assert.equal(f.owner.openingObject, true);
  assert.deepEqual(f.notices, []);
});

test("history stale read failure remains silent and does not advance or clear the new open", async () => {
  const f = fixture();
  const read = deferred<Artifact | undefined>();
  f.client.resolveArtifact = () => read.promise;
  f.owner.trail.current = {
    places: [place("document-A"), place("current")],
    index: 1,
  };
  const pending = f.commands().travel(-1);
  f.owner.beginOpen();
  read.reject(new Error("旧失败"));
  await pending;
  assert.deepEqual(f.notices, []);
  assert.equal(f.owner.trail.current.index, 1);
  assert.equal(f.owner.openingObject, true);
});

test("Dock retains its exact launch patch, no opening/creation/execution side effects, and caller-owned rejection", async () => {
  const f = fixture({ applications: { other: "other-instance" } });
  await f.commands().launchDockApplication(readerApplication);
  assert.deepEqual(f.patches[0], {
    view: "projects",
    projectId: "first-project",
    projectOpen: true,
    artifactId: null,
    artifactRevision: null,
    scriptLocation: null,
    readerMode: true,
    applications: { other: "other-instance", "first-project": "instance-A" },
  });
  assert.equal(
    f.events.some((e) =>
      ["opening", "finish-creation", "dismiss-executions", "visit"].includes(
        e[0] as string,
      ),
    ),
    false,
  );
  const failed = fixture();
  failed.client.execute = async () => {
    throw new Error("Dock 原失败");
  };
  await assert.rejects(
    failed.commands().launchDockApplication(readerApplication),
    /Dock 原失败/,
  );
  assert.deepEqual(failed.notices, []);
  assert.equal(failed.patches.length, 0);
});

test("Dock delayed receipt does not take over a later navigation or rebind another project's selection", async () => {
  const f = fixture();
  const receipt = deferred<Awaited<ReturnType<Options["client"]["execute"]>>>();
  f.client.execute = () => receipt.promise;
  const pending = f.commands().launchDockApplication(readerApplication);
  f.owner.beginIntent();
  receipt.resolve({
    commandId: "slow",
    entityId: "old-instance",
    workspaceRevision: 1,
  });
  await pending;
  assert.equal(f.patches.length, 0);
  assert.equal(f.owner.openingObject, false);
});
