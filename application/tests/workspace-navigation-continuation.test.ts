import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  createWorkspaceNavigationCommands,
  isNavigationPreferenceChange,
  mergeNavigationPreferences,
  useWorkspaceNavigationState,
  type NavigationOwner,
  type NavigationPreferences,
} from "../apps/web/src/host/use-workspace-navigation.js";
import { initialWorkspace, type Artifact } from "../packages/core/src/model.js";
import {
  browserApplication,
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
  type ApplicationInstance,
} from "../packages/core/src/applications.js";
import type { Boot } from "../apps/web/src/client.js";

type Options = Parameters<
  typeof createWorkspaceNavigationCommands<NavigationPreferences>
>[0];
type Receipt = Awaited<ReturnType<Options["client"]["execute"]>>;
type ScriptRead = NonNullable<
  Awaited<ReturnType<Options["client"]["resolveScriptLocation"]>>
>;
const now = "2026-10-04T00:00:00.000Z";
const receipt = (id = "instance-A"): Receipt => ({
  commandId: "command-A",
  entityId: id,
  workspaceRevision: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function instance(
  id: string,
  app = scriptStudioApplication,
  workspaceId = "first-project",
): ApplicationInstance {
  return {
    id,
    workspaceId,
    applicationId: app.id,
    applicationVersion: app.version,
    revision: 3,
    status: "open",
    state: { retained: "original" },
    createdAt: now,
    updatedAt: now,
  };
}
function document(): Artifact {
  const content = { kind: "document" as const, markdown: "确切引用原文" };
  return {
    id: "document-A",
    projectId: "first-project",
    title: "Document",
    revision: 3,
    content,
    versions: [
      {
        revision: 3,
        content,
        createdAt: now,
        author: { principalId: "local-owner", actantId: "human" },
      },
      {
        revision: 2,
        content,
        createdAt: now,
        author: { principalId: "local-owner", actantId: "human" },
      },
    ],
  } as Artifact;
}
// These are controlled current-projection/transport ports for the actual
// navigation command family, not a second Client or an authorization oracle.
// Real React lifetime/persistence is separately mounted in the Host suite;
// compiled Client+App coverage is required before claiming the live bug fixed.
function fixture(active?: "reader" | "browser") {
  let raw!: NavigationOwner;
  function Probe() {
    raw = useWorkspaceNavigationState();
    return null;
  }
  renderToString(createElement(Probe));
  let privateActive = true,
    hostActive = true,
    incarnation = 1,
    reads = 0,
    captures = 0;
  const workspace = initialWorkspace(now);
  workspace.projects.push({
    ...workspace.projects[0]!,
    id: "desk-A",
    kind: "desk",
    ownerPrincipalId: "principal-A",
  });
  workspace.artifacts = [document()];
  const reader = instance("reader-A", readerApplication),
    browser = instance("browser-A", browserApplication);
  workspace.applicationInstances = [reader, browser, instance("neighbour-A")];
  const entry = {
    id: "production-A",
    contentId: "content-A",
    projectId: "first-project",
    title: "Script",
    updatedAt: now,
    catalogRevision: 4,
    activityRevision: 7,
  };
  let current: Boot | null = {
    centerId: "center-A",
    principalId: "principal-A",
    csrfToken: "session-A",
    workspace: structuredClone(workspace),
    scriptLibrary: [entry],
  } as unknown as Boot;
  const getCurrent = () => {
    reads++;
    return hostActive &&
      current?.centerId === "center-A" &&
      current.principalId === "principal-A" &&
      current.csrfToken === "session-A"
      ? current
      : null;
  };
  const owner: NavigationOwner = {
    ...raw,
    isCurrent: (generation) => !!getCurrent() && raw.isCurrent(generation),
  };
  let preferences: NavigationPreferences = {
    view: "projects",
    projectId: "first-project",
    projectOpen: true,
    artifactId: null,
    artifactRevision: null,
    collaboration: false,
    subjectOpen: true,
    applications: { retained: "old-instance" },
  };
  const writes: NavigationPreferences[] = [],
    visits: string[] = [],
    events: string[] = [],
    operations: Parameters<Options["client"]["execute"]>[0][] = [],
    notices: string[] = [];
  const production = {
    ...entry,
    items: [],
    providerRevision: 2,
  } as unknown as ScriptRead["production"];
  let readArtifact: Options["client"]["resolveArtifact"] = async () =>
    document();
  let readScript: Options["client"]["resolveScriptLocation"] = async () => ({
    production,
    item: undefined,
  });
  let execute: Options["client"]["execute"] = (operation) => {
    if (operation.type === "launch-application")
      install(
        instance(
          "instance-A",
          {
            ...scriptStudioApplication,
            id: operation.applicationId,
            version: operation.applicationVersion,
          },
          operation.workspaceId,
        ),
      );
    if (operation.type === "close-application" && current)
      current.workspace.applicationInstances =
        current.workspace.applicationInstances.filter(
          (value) => value.id !== operation.instanceId,
        );
    return Promise.resolve(receipt());
  };
  function install(value: ApplicationInstance) {
    if (current)
      current.workspace.applicationInstances = [
        ...current.workspace.applicationInstances.filter(
          (item) => item.id !== value.id,
        ),
        value,
      ];
  }
  const options: Options = {
    owner,
    workspace,
    surface: {
      project: workspace.projects[0],
      applicationWorkspaceOpen: true,
      exchangeKey: "exchange-A",
      activeInstance:
        active === "reader"
          ? reader
          : active === "browser"
            ? browser
            : undefined,
    },
    preferences,
    client: {
      resolveArtifact: (...args) => readArtifact(...args),
      resolveScriptLocation: (...args) => readScript(...args),
      execute(operation) {
        operations.push(operation);
        return execute(operation);
      },
    },
    prefer(change) {
      events.push("private-prefer");
      preferences = mergeNavigationPreferences(preferences, change);
    },
    shell: {
      finishCreation() {
        events.push("finish-creation");
      },
      dismissExecutionInspector() {
        events.push("dismiss-executions");
      },
    },
    onNotice: (message) => notices.push(message),
    application: {
      historyVisible: true,
      personalDesk: () =>
        workspace.projects.find((value) => value.id === "desk-A"),
      readCapturedInstance: (id) =>
        workspace.applicationInstances.find((value) => value.id === id),
      selectAllContent() {
        events.push("all-content");
      },
    },
    continuation: {
      isActive: () => privateActive && !!getCurrent(),
      currentProjection: getCurrent,
      captureCommit() {
        captures++;
        const captured = incarnation;
        return () => hostActive && captured === incarnation;
      },
      prefer(change, intent, destination) {
        const before = getCurrent();
        if (!before || !destination(before)) return;
        if (isNavigationPreferenceChange(change))
          intent.generation = raw.beginIntent();
        const latest = getCurrent();
        if (!latest || !destination(latest)) return;
        preferences = mergeNavigationPreferences(preferences, change);
        writes.push(preferences);
        events.push("stable-prefer");
      },
      writePreferences(update, _failure, destination) {
        const before = getCurrent();
        if (!before || !destination(before)) return;
        const latest = getCurrent();
        if (!latest || !destination(latest)) return;
        preferences = update(preferences);
        writes.push(preferences);
        events.push("stable-write");
      },
      recordContentVisit(id, destination) {
        const before = getCurrent();
        if (!before || !destination(before)) return;
        const latest = getCurrent();
        if (latest && destination(latest)) visits.push(id);
      },
    },
  };
  return {
    owner,
    raw,
    options,
    operations,
    writes,
    visits,
    events,
    notices,
    production,
    reader,
    browser,
    commands: () => createWorkspaceNavigationCommands(options),
    preferences: () => preferences,
    counts: () => ({ reads, captures }),
    get current() {
      return current;
    },
    set current(value: Boot | null) {
      current = value;
    },
    setPrivate(value: boolean) {
      privateActive = value;
    },
    retire() {
      privateActive = false;
      hostActive = false;
      incarnation++;
      raw.beginIntent();
    },
    install,
    setExecute(value: Options["client"]["execute"]) {
      execute = value;
    },
    setReadScript(value: Options["client"]["resolveScriptLocation"]) {
      readScript = value;
    },
    setReadArtifact(value: Options["client"]["resolveArtifact"]) {
      readArtifact = value;
    },
  };
}
const turn = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
test("the production continuation factory remains inert, and each retired ordinary private entry performs zero commands/intent/cleanup", async () => {
  const f = fixture();
  const commands = f.commands();
  assert.deepEqual(f.counts(), { reads: 0, captures: 0 });
  f.setPrivate(false);
  const generation = f.raw.navigationGeneration.current;
  await commands.travel(-1);
  await commands.openObject("first-project", "document-A");
  await commands.openScriptLocation({ productionId: "production-A" });
  await commands.launchDockApplication(scriptStudioApplication);
  await commands.readingLibrary();
  await commands.openScriptLibrary();
  await commands.openWorkspaceContents();
  commands.activateApplication("reader-A");
  commands.navigate("desk");
  await commands.openBrowser();
  const captured = {
    workspaceId: "first-project",
    navigationId: generation,
    activeId: "reader-A",
    instances: [f.reader],
  };
  const launch = commands.applicationActions.launch(
    readerApplication,
    captured,
  );
  assert.equal(launch.kind, "application");
  await assert.rejects(launch.pending);
  await assert.rejects(
    commands.applicationActions.close(f.reader, captured).pending,
  );
  assert.equal(f.raw.navigationGeneration.current, generation);
  assert.deepEqual(f.operations, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.visits, []);
});
test("explicit script navigation may continue across same-identity private clear, with original raw prefs/request/recency and no old-child cleanup", async () => {
  const f = fixture(),
    read = deferred<ScriptRead | null>(),
    execute = deferred<Receipt>();
  f.setReadScript(() => read.promise);
  f.setExecute(() => execute.promise);
  const pending = f
    .commands()
    .openScriptLocation({ productionId: "production-A" }, 0);
  const saved = f.current!;
  f.current = null;
  f.setPrivate(false);
  f.current = saved;
  read.resolve({ production: f.production, item: undefined });
  await turn();
  assert.deepEqual(f.operations, [
    {
      type: "launch-application",
      workspaceId: "first-project",
      applicationId: scriptStudioApplication.id,
      applicationVersion: scriptStudioApplication.version,
      scriptTarget: { productionId: "production-A" },
    },
  ]);
  f.install(instance("instance-A"));
  execute.resolve(receipt());
  await pending;
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.preferences().applications, {
    retained: "old-instance",
    "first-project": "instance-A",
  });
  assert.deepEqual(f.preferences().scriptLocation, {
    productionId: "production-A",
    requestId: "command-A",
  });
  assert.deepEqual(f.preferences().interactions, { "exchange-A": "hidden" });
  assert.deepEqual(f.visits, ["content-A"]);
  assert.deepEqual(f.events, ["stable-prefer"]);
});
test("script catalog/owner/version denial after resolve cannot launch under a fresh unauthorized projection", async () => {
  for (const invalid of ["project", "content", "catalog", "activity"]) {
    const f = fixture(),
      read = deferred<ScriptRead | null>();
    f.setReadScript(() => read.promise);
    const pending = f
      .commands()
      .openScriptLocation({ productionId: "production-A" });
    if (invalid === "project") f.current!.workspace.projects = [];
    else
      f.current!.scriptLibrary = [
        {
          ...f.current!.scriptLibrary[0]!,
          ...(invalid === "content"
            ? { contentId: "different" }
            : invalid === "catalog"
              ? { catalogRevision: 5 }
              : { activityRevision: 8 }),
        },
      ];
    read.resolve({ production: f.production, item: undefined });
    await pending;
    assert.deepEqual(f.operations, [], invalid);
    assert.deepEqual(f.writes, [], invalid);
    assert.deepEqual(f.visits, [], invalid);
  }
});
test("script late receipt requires the current exact instance scope/app/version/open state; later human intent/session/ABA all stay inert", async () => {
  for (const invalid of [
    "project",
    "instance-workspace",
    "instance-app",
    "instance-version",
    "instance-status",
    "catalog",
    "intent",
    "session",
    "ABA",
  ]) {
    const f = fixture(),
      execute = deferred<Receipt>();
    f.setExecute(() => execute.promise);
    const pending = f
      .commands()
      .openScriptLocation({ productionId: "production-A" });
    await turn();
    assert.equal(f.operations.length, 1);
    f.install(instance("instance-A"));
    const current = f.current!;
    if (invalid === "project") current.workspace.projects = [];
    else if (invalid.startsWith("instance-")) {
      const value = current.workspace.applicationInstances.find(
        (value) => value.id === "instance-A",
      )!;
      if (invalid === "instance-workspace") value.workspaceId = "desk-A";
      if (invalid === "instance-app")
        value.applicationId = readerApplication.id;
      if (invalid === "instance-version") value.applicationVersion = "wrong";
      if (invalid === "instance-status") value.status = "closed";
    } else if (invalid === "catalog")
      current.scriptLibrary[0]!.catalogRevision++;
    else if (invalid === "intent") f.raw.beginIntent();
    else if (invalid === "session") current.csrfToken = "session-B";
    else {
      f.retire();
      f.current = { ...current, csrfToken: "session-A" };
    }
    execute.resolve(receipt());
    await pending;
    assert.deepEqual(f.writes, [], invalid);
    assert.deepEqual(f.visits, [], invalid);
  }
});
test("object normal launch/reference and both artifact version/current instance guards use the production continuation path", async () => {
  const good = fixture();
  await good.commands().openObject("first-project", "document-A", 2, 4);
  assert.deepEqual(good.operations, [
    {
      type: "launch-application",
      workspaceId: "first-project",
      applicationId: objectsApplication.id,
      applicationVersion: objectsApplication.version,
      artifactId: "document-A",
    },
  ]);
  assert.equal(good.preferences().artifactRevision, 2);
  assert.equal(good.preferences().artifactPage, 4);
  assert.deepEqual(good.visits, ["document-A"]);
  assert.ok(good.events.includes("stable-prefer"));
  assert.ok(!good.events.includes("private-prefer"));
  for (const invalid of ["project", "version", "wrong-owner", "instance"]) {
    const f = fixture(),
      execute = deferred<Receipt>();
    f.setExecute(() => execute.promise);
    const pending = f.commands().openObject("first-project", "document-A", 2);
    await turn();
    assert.equal(f.operations.length, 1);
    f.install(instance("instance-A", objectsApplication));
    if (invalid === "project") f.current!.workspace.projects = [];
    if (invalid === "version") f.current!.workspace.artifacts[0]!.versions = [];
    if (invalid === "wrong-owner")
      f.current!.workspace.artifacts[0]!.projectId = "desk-A";
    if (invalid === "instance") f.current!.workspace.applicationInstances = [];
    execute.resolve(receipt());
    await pending;
    assert.deepEqual(f.writes, [], invalid);
    assert.deepEqual(f.visits, [], invalid);
  }
});
test("Reader preserves original default-current completion and exact captured CAS for a living authorized origin, but rejects retired/revoked completions", async () => {
  for (const invalid of [null, "private", "session", "target"]) {
    const f = fixture("reader"),
      execute = deferred<Receipt>();
    f.setExecute(() => execute.promise);
    const pending = f.commands().readingLibrary();
    assert.deepEqual(f.operations, [
      {
        type: "set-application-state",
        instanceId: "reader-A",
        expectedRevision: 3,
        state: { retained: "original", artifactId: "" },
      },
    ]);
    f.raw.beginIntent();
    if (invalid === "private") f.setPrivate(false);
    if (invalid === "session") f.current!.csrfToken = "new-session";
    if (invalid === "target") f.current!.workspace.applicationInstances = [];
    execute.resolve(receipt());
    await pending;
    assert.equal(f.writes.length, invalid ? 0 : 1, String(invalid));
    if (!invalid)
      assert.equal(f.preferences().applications?.["first-project"], "reader-A");
  }
});
test("Browser preserves the original second-await captured-state policy without replacing CAS, but cannot write a retired/private-revoked target", async () => {
  for (const invalid of [null, "private", "session", "target"]) {
    const f = fixture("browser"),
      setState = deferred<Receipt>();
    f.setExecute((operation) =>
      operation.type === "launch-application"
        ? Promise.resolve(receipt("browser-A"))
        : setState.promise,
    );
    const pending = f.commands().openBrowser("https://example.invalid/path");
    await turn();
    assert.deepEqual(f.operations, [
      {
        type: "launch-application",
        workspaceId: "first-project",
        applicationId: browserApplication.id,
        applicationVersion: browserApplication.version,
      },
      {
        type: "set-application-state",
        instanceId: "browser-A",
        expectedRevision: 3,
        state: { retained: "original", url: "https://example.invalid/path" },
      },
    ]);
    f.raw.beginIntent();
    if (invalid === "private") f.setPrivate(false);
    if (invalid === "session") f.current!.csrfToken = "new-session";
    if (invalid === "target") f.current!.workspace.applicationInstances = [];
    setState.resolve(receipt());
    await pending;
    assert.equal(f.writes.length, invalid ? 0 : 1, String(invalid));
    if (!invalid)
      assert.equal(
        f.preferences().applications?.["first-project"],
        "browser-A",
      );
  }
});
test("prepared Launcher preserves raw Promise/captured generation even when invocation generation changed; retired commits fail current exact-target proof", async () => {
  for (const invalid of [null, "intent", "scope", "app", "private"]) {
    const f = fixture(),
      execute = deferred<Receipt>();
    f.setExecute(() => execute.promise);
    const commands = f.commands();
    const captured = {
      workspaceId: "first-project",
      navigationId: 0,
      activeId: null,
      instances: [],
    };
    if (invalid === "intent") f.raw.beginIntent();
    const launch = commands.applicationActions.launch(
      readerApplication,
      captured,
    );
    assert.equal(launch.kind, "application");
    assert.equal(launch.pending, execute.promise);
    assert.equal(f.operations.length, 1);
    assert.deepEqual(f.writes, []);
    f.install(instance("instance-A", readerApplication));
    if (invalid === "scope")
      f.current!.workspace.applicationInstances.find(
        (value) => value.id === "instance-A",
      )!.workspaceId = "desk-A";
    if (invalid === "app")
      f.current!.workspace.applicationInstances.find(
        (value) => value.id === "instance-A",
      )!.applicationId = browserApplication.id;
    if (invalid === "private") f.retire();
    execute.resolve(receipt());
    const ack = await launch.pending;
    if (launch.kind === "application") launch.commit(ack);
    assert.equal(f.writes.length, invalid ? 0 : 1, String(invalid));
  }
});
test("close chooses only the original captured neighbour/null, keeps raw Promise, and rejects a removed or identity-rebound neighbour", async () => {
  for (const invalid of [null, "neighbour", "version", "intent", "private"]) {
    const f = fixture(),
      execute = deferred<Receipt>();
    f.setExecute(() => execute.promise);
    const commands = f.commands();
    const neighbour = f.options.workspace!.applicationInstances.find(
      (value) => value.id === "neighbour-A",
    )!;
    const captured = {
      workspaceId: "first-project",
      navigationId: 0,
      activeId: "reader-A",
      instances: [f.reader, neighbour],
    };
    const close = commands.applicationActions.close(f.reader, captured);
    assert.equal(close.pending, execute.promise);
    f.current!.workspace.applicationInstances =
      f.current!.workspace.applicationInstances.filter(
        (value) => value.id !== "reader-A",
      );
    if (invalid === "neighbour")
      f.current!.workspace.applicationInstances =
        f.current!.workspace.applicationInstances.filter(
          (value) => value.id !== neighbour.id,
        );
    if (invalid === "version")
      f.current!.workspace.applicationInstances.find(
        (value) => value.id === neighbour.id,
      )!.applicationVersion = "different";
    if (invalid === "intent") f.raw.beginIntent();
    if (invalid === "private") f.retire();
    execute.resolve(receipt());
    await close.pending;
    close.commit();
    assert.equal(f.writes.length, invalid ? 0 : 1, String(invalid));
    if (!invalid)
      assert.equal(
        f.preferences().applications?.["first-project"],
        "neighbour-A",
      );
  }
});
test("script-library, contents and Dock normal paths retain original patches; each launch rejects latest scope/instance loss", async () => {
  for (const command of ["script", "contents", "dock"] as const) {
    for (const denied of [false, true]) {
      const f = fixture(),
        execute = deferred<Receipt>();
      f.setExecute(() => execute.promise);
      const commands = f.commands();
      const pending =
        command === "script"
          ? commands.openScriptLibrary()
          : command === "contents"
            ? commands.openWorkspaceContents()
            : commands.launchDockApplication(readerApplication);
      const operation = f.operations[0]!;
      assert.equal(operation.type, "launch-application");
      if (operation.type !== "launch-application") throw Error("wrong launch");
      assert.equal(
        operation.workspaceId,
        command === "script" ? "desk-A" : "first-project",
      );
      const app =
        command === "script"
          ? scriptStudioApplication
          : command === "contents"
            ? objectsApplication
            : readerApplication;
      assert.equal(operation.applicationId, app.id);
      assert.equal(operation.applicationVersion, app.version);
      f.install(instance("instance-A", app, operation.workspaceId));
      if (denied) f.current!.workspace.applicationInstances = [];
      execute.resolve(receipt());
      await pending;
      assert.equal(f.writes.length, denied ? 0 : 1, command);
      assert.equal(f.visits.length, 0);
    }
  }
});
test("travel restores raw original place only after current project/reference proof, without a new preference generation or recency", async () => {
  for (const denied of [false, true]) {
    const f = fixture();
    const place = {
      view: "projects" as const,
      projectId: "first-project",
      projectOpen: true,
      artifactId: "document-A",
      artifactRevision: 2,
    };
    f.raw.trail.current = {
      places: [place, { ...place, artifactId: null }],
      index: 1,
    };
    if (denied) f.current!.workspace.artifacts = [];
    const generation = f.raw.navigationGeneration.current;
    await f.commands().travel(-1);
    assert.equal(f.writes.length, denied ? 0 : 1);
    assert.equal(f.raw.navigationGeneration.current, generation + 1);
    assert.deepEqual(f.visits, []);
    assert.equal(f.raw.trail.current.index, denied ? 1 : 0);
  }
});
