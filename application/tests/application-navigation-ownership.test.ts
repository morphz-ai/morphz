import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isFunctionDeclaration, type Node } from "typescript/unstable/ast";
import {
  createWorkspaceNavigationCommands,
  isNavigationPreferenceChange,
  mergeNavigationPreferences,
  type NavigationOwner,
  type NavigationPreferences,
} from "../apps/web/src/host/use-workspace-navigation.js";
import {
  browserApplication,
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
  type ApplicationCatalogEntry,
  type ApplicationInstance,
} from "../packages/core/src/applications.js";
import {
  initialWorkspace,
  type Operation,
  type Receipt,
  type Workspace,
} from "../packages/core/src/model.js";
import {
  createFixedApplicationHostActions,
  createFixedApplicationNavigation,
  type FixedNavigationBindings,
  type FixedHostBindings,
} from "./fixtures/application-navigation-cb7246a2.js";

const now = "2026-10-04T00:00:00.000Z";
type Mode = "fixed" | "production";
type Preferences = NavigationPreferences & { unrelated: string };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function receipt(id = "new-instance"): Receipt {
  return {
    commandId: "navigation-command",
    entityId: id,
    workspaceRevision: 8,
  };
}
function instance(
  id: string,
  app = objectsApplication.id,
  revision = 4,
): ApplicationInstance {
  return {
    id,
    workspaceId: "first-project",
    applicationId: app,
    applicationVersion: "1.0.0",
    revision,
    state: {
      artifactId: "old-artifact",
      url: "https://old.example/",
      panel: { selected: "kept" },
    },
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}
function initialPreferences(): Preferences {
  return {
    view: "projects",
    projectId: "first-project",
    projectOpen: true,
    artifactId: "old-artifact",
    artifactRevision: 9,
    artifactPage: 12,
    scriptLocation: {
      productionId: "old-production",
      requestId: "old-request",
    },
    readerMode: true,
    collaboration: false,
    subjectOpen: true,
    applications: {
      other: "other-instance",
      "first-project": "previous-instance",
    },
    interactions: { "exchange-A": "history", other: "input" },
    pinnedInputs: { other: true },
    exchangeHeights: { other: 360 },
    unrelated: "unchanged",
  };
}
type Scenario = {
  project?: "project" | "desk" | "inbox" | "missing";
  active?: ApplicationInstance;
  historyVisible?: boolean;
  noPersonalDesk?: boolean;
  instances?: ApplicationInstance[];
};
function fixture(mode: Mode, scenario: Scenario = {}) {
  const events: unknown[][] = [],
    operations: Operation[] = [],
    executePromises: Promise<Receipt>[] = [];
  const state = initialWorkspace(now);
  state.applicationInstances = scenario.instances ?? [
    instance("previous-instance"),
    instance("reader", readerApplication.id),
  ];
  const project =
    scenario.project === "missing"
      ? undefined
      : scenario.project && scenario.project !== "project"
        ? state.projects.find((p) => p.kind === scenario.project)
        : state.projects.find((p) => p.id === "first-project");
  const capturedPrefs = initialPreferences();
  let preferences = capturedPrefs;
  let perform: (operation: Operation) => Promise<Receipt> = async () =>
    receipt();
  let bootState: Workspace | undefined = state;
  const owner: NavigationOwner = {
    navigationGeneration: { current: 7 },
    openingObject: false,
    restoredPlace: null,
    trail: { current: { places: [], index: -1 } },
    trailVersion: 0,
    websiteIntent: "old-website",
    beginIntent() {
      const generation = ++owner.navigationGeneration.current;
      events.push(["intent", generation]);
      return generation;
    },
    beginOpen() {
      const generation = owner.beginIntent();
      owner.openingObject = true;
      events.push(["opening", true]);
      return generation;
    },
    isCurrent(generation) {
      return owner.navigationGeneration.current === generation;
    },
    finishOpen(generation) {
      events.push(["finish-open", generation]);
      if (owner.isCurrent(generation)) {
        owner.openingObject = false;
        events.push(["opening", false]);
      }
    },
    resetPreferenceNavigation() {
      owner.openingObject = false;
      owner.restoredPlace = null;
      events.push(["reset-navigation"]);
    },
    setExplicitWebsiteIntent(value) {
      owner.websiteIntent =
        typeof value === "function" ? value(owner.websiteIntent) : value;
      events.push(["website", owner.websiteIntent]);
    },
    recordPlace() {},
    restorePlace() {},
  };
  const client = {
    get boot() {
      events.push(["read-captured-boot"]);
      return bootState ? { workspace: bootState } : null;
    },
    execute(operation: Operation) {
      operations.push(operation);
      events.push(["execute", structuredClone(operation)]);
      const pending = perform(operation);
      executePromises.push(pending);
      return pending;
    },
    async resolveArtifact() {
      throw new Error("unexpected artifact read");
    },
    async resolveScriptLocation() {
      throw new Error("unexpected script read");
    },
  };
  const prefer = (change: Partial<NavigationPreferences>) => {
    events.push(["prefer", change]);
    if (isNavigationPreferenceChange(change)) {
      owner.beginIntent();
      owner.resetPreferenceNavigation();
    }
    preferences = mergeNavigationPreferences<Preferences>(preferences, change);
  };
  const clearCreation = () => events.push(["creating", null]);
  const dismissExecutions = () => events.push(["executions", null]);
  const selectAllContent = () => events.push(["content-scope", "all"]);
  const notice = (message: string) => events.push(["notice", message]);
  const personalDesk = () => {
    events.push(["read-personal-desk"]);
    return scenario.noPersonalDesk
      ? undefined
      : state.projects.find(
          (p) => p.kind === "desk" && p.ownerPrincipalId === "local-owner",
        );
  };
  const fixed: FixedNavigationBindings = {
    navigation: owner,
    client,
    state,
    project,
    prefs: capturedPrefs,
    activeInstance: scenario.active,
    historyVisible: scenario.historyVisible ?? true,
    exchangeKey: "exchange-A",
    personalSpace: (kind) =>
      kind === "desk"
        ? personalDesk()
        : state.projects.find((p) => p.kind === kind),
    prefer,
    setWebsiteIntent: (value) => owner.setExplicitWebsiteIntent(value),
    setCreating: clearCreation,
    setExecutions: dismissExecutions,
    setContentScope: () => selectAllContent(),
    setNotice: notice,
  };
  const production = () =>
    createWorkspaceNavigationCommands<Preferences>({
      owner,
      client,
      workspace: state,
      surface: {
        project,
        applicationWorkspaceOpen: true,
        exchangeKey: "exchange-A",
        activeInstance: scenario.active,
      },
      preferences: capturedPrefs,
      prefer,
      writePreferences(update, failure) {
        preferences = update(preferences);
        events.push(["write", failure]);
      },
      shell: {
        finishCreation: clearCreation,
        dismissExecutionInspector: dismissExecutions,
      },
      recordContentVisit: (id) => events.push(["content-visit", id]),
      onNotice: notice,
      application: {
        historyVisible: scenario.historyVisible ?? true,
        personalDesk,
        readCapturedInstance: (id) =>
          client.boot?.workspace.applicationInstances.find((i) => i.id === id),
        selectAllContent,
      },
    });
  const commands =
    mode === "fixed" ? createFixedApplicationNavigation(fixed) : production();
  assert.deepEqual(
    [...events],
    [],
    "construction must not execute, read, patch or set local UI state",
  );
  function host(
    overrides: Partial<
      Pick<
        FixedHostBindings,
        "workspaceId" | "activeId" | "instances" | "navigationId" | "launching"
      >
    > = {},
  ) {
    const launching = overrides.launching ?? { current: false };
    let busy = false;
    const onActivate = (id: string | null, expected: number) =>
      commands.activateApplication(id, expected);
    const hostBindings: FixedHostBindings = {
      client,
      workspaceId: project?.id ?? "first-project",
      activeId: "previous-instance",
      instances: state.applicationInstances,
      navigationId: owner.navigationGeneration.current,
      onActivate,
      onOpenContents: commands.openWorkspaceContents,
      onNotice: notice,
      launching,
      setBusy(value) {
        busy = value;
        events.push(["busy", value]);
      },
      ...overrides,
    };
    if (mode === "fixed")
      return {
        ...createFixedApplicationHostActions(hostBindings),
        launching,
        busy: () => busy,
      };
    const actions = (
      commands as ReturnType<typeof createWorkspaceNavigationCommands>
    ).applicationActions;
    const captured = {
      workspaceId: hostBindings.workspaceId,
      navigationId: hostBindings.navigationId,
      activeId: hostBindings.activeId,
      instances: hostBindings.instances,
    };
    // This is only the retained local-UI adapter. Production App/Host consumption
    // is checked separately by the root's AST gate/Host tests, not by this copy.
    async function launch(app: ApplicationCatalogEntry, contents = false) {
      if (launching.current) return;
      launching.current = true;
      hostBindings.setBusy(true);
      try {
        const action = actions.launch(app, captured, contents);
        if (action.kind === "contents") {
          await action.pending;
          return;
        }
        action.commit(await action.pending);
      } catch (error) {
        hostBindings.onNotice((error as Error).message);
      } finally {
        launching.current = false;
        hostBindings.setBusy(false);
      }
    }
    async function close(selected: ApplicationInstance) {
      try {
        const action = actions.close(selected, captured);
        await action.pending;
        action.commit();
      } catch (error) {
        hostBindings.onNotice((error as Error).message);
      }
    }
    return { launch, close, launching, busy: () => busy };
  }
  return {
    mode,
    state,
    project,
    capturedPrefs,
    owner,
    events,
    operations,
    executePromises,
    commands,
    host,
    execute: (handler: typeof perform) => {
      perform = handler;
    },
    setBoot: (next: Workspace | undefined) => {
      bootState = next;
    },
    replacePreferences: (change: Partial<Preferences>) => {
      preferences = { ...preferences, ...change };
    },
    preferences: () => preferences,
    snapshot: () => ({
      events,
      preferences,
      generation: owner.navigationGeneration.current,
      opening: owner.openingObject,
    }),
  };
}
type Fixture = ReturnType<typeof fixture>;
async function compare(
  run: (f: Fixture) => Promise<unknown>,
  scenario: Scenario = {},
) {
  const results: unknown[] = [];
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode, scenario);
    results.push({ result: await run(f), ...f.snapshot() });
  }
  assert.deepEqual(results[1], results[0]);
}
const ticks = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const noticeEvents = (f: Fixture) => f.events.filter((e) => e[0] === "notice");
const patches = (f: Fixture) =>
  f.events
    .filter((e) => e[0] === "prefer")
    .map((e) => e[1] as Partial<NavigationPreferences>);
function syntax(node: Node): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(syntax(child));
  });
  return [node.kind, children.length ? children : node.getText()];
}
test("fixed cb7246a2 oracle bodies are genuine original App/Host functions, not copied new navigation algorithms", () => {
  // Verified during extraction against git cb7246a258262d3024fdeb6f58cb654a49b3d005:
  // App's six and ApplicationHost's two original function bodies. These are
  // SHA256(JSON.stringify(syntax(body))) using the pinned TypeScript 7.0.2 AST.
  // CI checks this independent fixed source, not new production functions, and
  // does not need the historical commit to survive a shallow checkout.
  const originalBodyDigests = {
    readingLibrary:
      "d97ba9b8f47598ad4db955b77f42211a36863543e44a1571e77b82dbc3996c0a",
    openScriptLibrary:
      "5c6da074f00d98611259fc79f88369e6a327ad963962e2d54999739f19c3a378",
    openWorkspaceContents:
      "e8e1b32bd3cb7468e74636133d9a74d5ad07ce5eaa4776bbc8f6221ed1058ee5",
    activateApplication:
      "bd004574e7494e7e493446d9890279d17c66c78b140622f2d101ca3f250c07be",
    navigate:
      "5c70bc25a9cbd8ff57252f49527c7882a37a9c13e7364cabbab387b5c8d1afad",
    openBrowser:
      "e6bb1551b0593859d882a0c3491145935ec956d4279809af77c631bd7105534f",
    launch: "777a57c528c180338a8db3a412ab46d92bd48484683c9764446b935506078957",
    close: "f43bfc781e6927dd242df95668d74c328663fb20025c3e57bf516c1b309f35ad",
  };
  const fixed = readFileSync(
    new URL("./fixtures/application-navigation-cb7246a2.ts", import.meta.url),
    "utf8",
  );
  const directory = "/fixed-application-navigation-oracle",
    config = directory + "/tsconfig.json";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [directory + "/fixed.ts"]: fixed,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["fixed.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    function body(name: string) {
      const found: Node[] = [];
      function walk(node: Node) {
        if (
          isFunctionDeclaration(node) &&
          node.name?.text === name &&
          node.body
        )
          found.push(node.body);
        node.forEachChild(walk);
      }
      walk(program.getSourceFile(directory + "/fixed.ts")!);
      assert.equal(found.length, 1, name);
      return syntax(found[0]!);
    }
    for (const [name, digest] of Object.entries(originalBodyDigests))
      assert.equal(
        createHash("sha256")
          .update(JSON.stringify(body(name)))
          .digest("hex"),
        digest,
        name,
      );
    assert.equal(
      /from\s+["'].*use-workspace-navigation/.test(
        fixed.replace(/import type[^;]+;/gs, ""),
      ),
      false,
      "oracle has no production algorithm import",
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
});

test("activation keeps raw captured applications and only null clears script location; history-visible alone changes interaction", async () => {
  for (const visible of [false, true])
    for (const id of [null, "reader", "unloaded-instance"])
      await compare(
        async (f) => {
          f.replacePreferences({
            applications: {
              ...f.capturedPrefs.applications,
              later: "later-instance",
            },
            interactions: { latest: "input" },
          });
          f.commands.activateApplication(id);
          const patch = patches(f)[0] as Partial<NavigationPreferences>;
          assert.deepEqual(patch.applications, {
            ...f.capturedPrefs.applications,
            "first-project": id,
          });
          assert.equal("scriptLocation" in patch, id === null);
          assert.equal("interactions" in patch, visible);
          assert.equal(patch.readerMode, id === "reader");
          assert.equal(
            f.preferences().applications?.later,
            undefined,
            "applications raw spread is not converted to latest merge",
          );
          assert.equal(
            f.preferences().interactions?.latest,
            "input",
            "interaction map remains separately merged by existing prefer",
          );
          assert.equal(f.preferences().unrelated, "unchanged");
          assert.deepEqual(f.events.slice(0, 2), [
            ["website", null],
            ["creating", null],
          ]);
          assert.equal(
            f.events.some((e) => e[0] === "executions"),
            false,
          );
          return patch;
        },
        { historyVisible: visible },
      );
});

test("activation stale expected generation and absent project are inert; same-generation receipt preserves original activation", async () => {
  await compare(async (f) => {
    f.commands.activateApplication("reader", 6);
    assert.deepEqual(f.events, []);
    f.commands.activateApplication("reader", 7);
    assert.equal(patches(f).length, 1);
  });
  await compare(
    async (f) => {
      f.commands.activateApplication(null);
      assert.deepEqual(f.events, []);
    },
    { project: "missing" },
  );
});

test("general navigation preserves ordered shell clearing, exact raw preference patch and no application command", async () => {
  for (const view of [
    "dialogue",
    "inbox",
    "content",
    "desk",
    "projects",
  ] as const)
    await compare(async (f) => {
      f.commands.navigate(view);
      assert.deepEqual(f.events.slice(0, 4), [
        ["website", null],
        ["creating", null],
        ["executions", null],
        ["prefer", { view, artifactId: null, projectOpen: false }],
      ]);
      assert.deepEqual(f.operations, []);
      assert.deepEqual(
        f.preferences().applications,
        f.capturedPrefs.applications,
      );
      assert.equal(f.preferences().projectId, f.capturedPrefs.projectId);
      assert.equal(f.preferences().readerMode, f.capturedPrefs.readerMode);
    });
});

test("reader library without an active Reader only clears its original preference fields and never executes", async () => {
  for (const active of [undefined, instance("objects")])
    await compare(
      async (f) => {
        await f.commands.readingLibrary();
        assert.deepEqual(patches(f), [
          { artifactId: null, readerMode: false, readingTarget: null },
        ]);
        assert.deepEqual(f.operations, []);
      },
      { active },
    );
});

test("Reader library preserves exact instance/revision/state spread and activates only after acknowledged clearing", async () => {
  const active = instance("reader", readerApplication.id, 13);
  await compare(
    async (f) => {
      const pending = deferred<Receipt>();
      f.execute(() => pending.promise);
      const action = f.commands.readingLibrary();
      assert.deepEqual(f.operations, [
        {
          type: "set-application-state",
          instanceId: "reader",
          expectedRevision: 13,
          state: { ...active.state, artifactId: "" },
        },
      ]);
      assert.equal(patches(f).length, 0);
      assert.equal(
        (
          f.operations[0] as Extract<
            Operation,
            { type: "set-application-state" }
          >
        ).state.panel,
        active.state.panel,
      );
      pending.resolve(receipt());
      await action;
      assert.equal(
        (patches(f)[0] as Partial<NavigationPreferences>).applications?.[
          "first-project"
        ],
        "reader",
      );
    },
    { active },
  );
});

test("Reader library retains default-current activation and ungated late error rather than gaining a new generation guard", async () => {
  for (const failed of [false, true])
    await compare(
      async (f) => {
        const pending = deferred<Receipt>();
        f.execute(() => pending.promise);
        const action = f.commands.readingLibrary();
        f.owner.beginIntent();
        f.owner.beginIntent();
        if (failed) pending.reject(new Error("reader clear failed"));
        else pending.resolve(receipt());
        await action;
        assert.equal(patches(f).length, failed ? 0 : 1);
        assert.deepEqual(
          noticeEvents(f),
          failed ? [["notice", "reader clear failed"]] : [],
        );
      },
      { active: instance("reader", readerApplication.id) },
    );
});

test("script library uses personal desk and explicit scriptTarget null with its exact original preference omissions", async () => {
  await compare(async (f) => {
    await f.commands.openScriptLibrary();
    assert.deepEqual(f.operations, [
      {
        type: "launch-application",
        workspaceId: "local-worktable",
        applicationId: scriptStudioApplication.id,
        applicationVersion: scriptStudioApplication.version,
        scriptTarget: null,
      },
    ]);
    const patch = patches(f)[0] as Partial<NavigationPreferences>;
    assert.deepEqual(patch, {
      view: "desk",
      scriptLocation: null,
      artifactId: null,
      applications: {
        ...f.capturedPrefs.applications,
        "local-worktable": "new-instance",
      },
    });
    assert.equal("projectId" in patch, false);
    assert.equal("readerMode" in patch, false);
    assert.equal("interactions" in patch, false);
  });
  await compare(
    async (f) => {
      await f.commands.openScriptLibrary();
      assert.deepEqual(f.events, [["read-personal-desk"]]);
      assert.deepEqual(f.operations, []);
      assert.equal(patches(f).length, 0);
    },
    { noPersonalDesk: true },
  );
});

test("script receipt and error obey original generation including A→B→A without resetting generation", async () => {
  for (const stale of [false, true])
    for (const failed of [false, true])
      await compare(async (f) => {
        const pending = deferred<Receipt>();
        f.execute(() => pending.promise);
        const action = f.commands.openScriptLibrary();
        if (stale) {
          f.owner.beginIntent();
          f.owner.beginIntent();
        }
        if (failed) pending.reject(new Error("script launch failed"));
        else pending.resolve(receipt());
        await action;
        assert.equal(patches(f).length, !stale && !failed ? 1 : 0);
        assert.deepEqual(
          noticeEvents(f),
          !stale && failed ? [["notice", "script launch failed"]] : [],
        );
        assert.equal(
          f.events.some((e) => e[0] === "opening"),
          false,
        );
      });
});

test("personal contents opens all-content without an application operation; missing project performs nothing", async () => {
  for (const project of ["desk", "inbox"] as const)
    await compare(
      async (f) => {
        await f.commands.openWorkspaceContents();
        assert.deepEqual(f.events.slice(0, 4), [
          ["content-scope", "all"],
          ["website", null],
          ["creating", null],
          ["executions", null],
        ]);
        assert.deepEqual(patches(f), [
          { view: "content", artifactId: null, projectOpen: false },
        ]);
        assert.deepEqual(f.operations, []);
      },
      { project },
    );
  await compare(
    async (f) => {
      await f.commands.openWorkspaceContents();
      assert.deepEqual(f.events, []);
    },
    { project: "missing" },
  );
});

test("project contents uses beginOpen and exact artifact-null launch; stale/error/finally remain generation-sensitive", async () => {
  for (const stale of [false, true])
    for (const failed of [false, true])
      await compare(async (f) => {
        const pending = deferred<Receipt>();
        f.execute(() => pending.promise);
        const action = f.commands.openWorkspaceContents();
        assert.deepEqual(f.events.slice(0, 2), [
          ["intent", 8],
          ["opening", true],
        ]);
        assert.deepEqual(f.operations, [
          {
            type: "launch-application",
            workspaceId: "first-project",
            applicationId: objectsApplication.id,
            applicationVersion: objectsApplication.version,
            artifactId: null,
          },
        ]);
        if (stale) {
          f.owner.beginIntent();
          f.owner.beginIntent();
        }
        if (failed) pending.reject(new Error("contents launch failed"));
        else pending.resolve(receipt());
        await action;
        assert.equal(patches(f).length, !stale && !failed ? 1 : 0);
        assert.deepEqual(
          noticeEvents(f),
          !stale && failed ? [["notice", "contents launch failed"]] : [],
        );
        assert.equal(f.events.filter((e) => e[0] === "finish-open").length, 1);
        assert.equal(
          f.events.some((e) => e[0] === "opening" && e[1] === false),
          !stale && failed,
          "successful prefer invalidates the captured beginOpen before finally",
        );
      });
});

test("browser missing project is inert; URL absent/empty or unavailable launched instance never performs extra set-state", async () => {
  await compare(
    async (f) => {
      await f.commands.openBrowser("https://example.test/");
      assert.deepEqual(f.events, []);
    },
    { project: "missing" },
  );
  for (const url of [undefined, "", "https://example.test/"])
    for (const project of ["project", "desk"] as const)
      await compare(
        async (f) => {
          await f.commands.openBrowser(url);
          assert.deepEqual(f.operations, [
            {
              type: "launch-application",
              workspaceId: f.project!.id,
              applicationId: browserApplication.id,
              applicationVersion: browserApplication.version,
            },
          ]);
          const patch = patches(f)[0] as Partial<NavigationPreferences>;
          assert.equal(patch.view, project === "project" ? "projects" : "desk");
          assert.equal("readerMode" in patch, false);
          assert.equal("artifactRevision" in patch, false);
          assert.equal("readingTarget" in patch, false);
        },
        { project },
      );
  await compare(async (f) => {
    f.setBoot(undefined);
    await f.commands.openBrowser("https://example.test/");
    assert.equal(f.operations.length, 1);
    assert.equal(
      patches(f).length,
      1,
      "absent captured boot is not turned into a new failure",
    );
  });
});

test("browser optional URL reads the live acknowledged instance/revision and keeps exact state spread", async () => {
  await compare(async (f) => {
    const pending = deferred<Receipt>();
    let calls = 0;
    f.execute(async () => (++calls === 1 ? pending.promise : receipt()));
    const action = f.commands.openBrowser("https://exact.example/new");
    const live = structuredClone(f.state);
    const created = instance("new-instance", browserApplication.id, 22);
    live.applicationInstances = [created];
    f.setBoot(live);
    pending.resolve(receipt());
    await action;
    assert.deepEqual(f.operations[1], {
      type: "set-application-state",
      instanceId: "new-instance",
      expectedRevision: 22,
      state: { ...created.state, url: "https://exact.example/new" },
    });
    assert.equal(
      (f.operations[1] as Extract<Operation, { type: "set-application-state" }>)
        .state.panel,
      created.state.panel,
    );
    assert.equal(
      f.events.findIndex((e) => e[0] === "prefer") >
        f.events.findLastIndex((e) => e[0] === "execute"),
      true,
    );
  });
});

test("browser stale first receipt does not set-state or activate, but late failures keep original ungated notices", async () => {
  for (const failed of [false, true])
    await compare(async (f) => {
      const pending = deferred<Receipt>();
      f.execute(() => pending.promise);
      const action = f.commands.openBrowser("https://example.test/");
      f.owner.beginIntent();
      f.owner.beginIntent();
      if (failed) pending.reject(new Error("late browser failure"));
      else pending.resolve(receipt());
      await action;
      assert.equal(f.operations.length, 1);
      assert.equal(patches(f).length, 0);
      assert.deepEqual(
        noticeEvents(f),
        failed ? [["notice", "late browser failure"]] : [],
      );
    });
});

test("browser second set-state await deliberately retains original no-extra-generation-gate and non-Error fallback", async () => {
  for (const failed of [false, true])
    await compare(async (f) => {
      f.state.applicationInstances.push(
        instance("new-instance", browserApplication.id),
      );
      const pending = deferred<Receipt>();
      let calls = 0;
      f.execute(async () => (++calls === 1 ? receipt() : pending.promise));
      const action = f.commands.openBrowser("https://exact.example/");
      await ticks();
      assert.equal(calls, 2);
      f.owner.beginIntent();
      f.owner.beginIntent();
      if (failed) pending.reject("plain failure");
      else pending.resolve(receipt());
      await action;
      assert.equal(patches(f).length, failed ? 0 : 1);
      assert.deepEqual(
        noticeEvents(f),
        failed ? [["notice", "浏览器未能打开。"]] : [],
      );
    });
});

test("Launcher retains single local launch lock/busy, exact version/owner and captured navigation without a new intent", async () => {
  await compare(async (f) => {
    const pending = deferred<Receipt>();
    f.execute(() => pending.promise);
    const host = f.host();
    const first = host.launch(readerApplication);
    const duplicate = host.launch(browserApplication);
    await ticks();
    assert.equal(host.launching.current, true);
    assert.equal(host.busy(), true);
    assert.equal(f.operations.length, 1);
    assert.deepEqual(f.operations[0], {
      type: "launch-application",
      workspaceId: "first-project",
      applicationId: readerApplication.id,
      applicationVersion: readerApplication.version,
    });
    assert.deepEqual(f.events[0], ["busy", true]);
    assert.equal(
      f.events.some((e) => e[0] === "intent"),
      false,
    );
    pending.resolve(receipt("reader"));
    await Promise.all([first, duplicate]);
    assert.equal(host.launching.current, false);
    assert.equal(host.busy(), false);
    assert.equal(patches(f).length, 1);
    assert.deepEqual(f.events.at(-1), ["busy", false]);
    return { busy: host.busy(), lock: host.launching.current };
  });
});

test("Launcher stale receipt and errors keep captured navigation and always release local busy", async () => {
  for (const failed of [false, true])
    await compare(async (f) => {
      const pending = deferred<Receipt>();
      f.execute(() => pending.promise);
      const host = f.host();
      const action = host.launch(objectsApplication);
      f.owner.beginIntent();
      f.owner.beginIntent();
      if (failed) pending.reject(new Error("late launcher failure"));
      else pending.resolve(receipt());
      await action;
      assert.equal(patches(f).length, 0);
      assert.equal(host.busy(), false);
      assert.equal(host.launching.current, false);
      assert.deepEqual(
        noticeEvents(f),
        failed ? [["notice", "late launcher failure"]] : [],
      );
      return { busy: host.busy(), lock: host.launching.current };
    });
});

test("Launcher contents branch uses its original local lock and dedicated content navigation, not normal launch", async () => {
  for (const project of ["project", "desk"] as const)
    await compare(
      async (f) => {
        const host = f.host();
        await host.launch(objectsApplication, true);
        assert.equal(host.busy(), false);
        assert.equal(host.launching.current, false);
        assert.equal(f.operations.length, project === "project" ? 1 : 0);
        if (project === "project")
          assert.equal(
            (
              f.operations[0] as Extract<
                Operation,
                { type: "launch-application" }
              >
            ).artifactId,
            null,
          );
        assert.equal(
          patches(f).length,
          1,
          "contents preserves its single dedicated navigation patch",
        );
        assert.deepEqual(f.events[0], ["busy", true]);
        assert.deepEqual(f.events.at(-1), ["busy", false]);
      },
      { project },
    );
});

test("close active uses captured next then previous then explicit null, exact revision and no busy/launch lock", async () => {
  for (const ids of [["a", "b", "c"], ["a", "b"], ["b"]])
    await compare(async (f) => {
      const list = ids.map((id) => instance(id));
      const selected = list.find((i) => i.id === "b")!;
      const host = f.host({ instances: list, activeId: "b" });
      await host.close(selected);
      assert.deepEqual(f.operations, [
        { type: "close-application", instanceId: "b", expectedRevision: 4 },
      ]);
      assert.equal(
        f.events.some((e) => e[0] === "busy"),
        false,
      );
      assert.equal(
        (patches(f)[0] as Partial<NavigationPreferences>).applications?.[
          "first-project"
        ],
        ids.length === 3 ? "c" : ids.length === 2 ? "a" : null,
      );
    });
});

test("close inactive/missing neighbour and stale receipts preserve captured selection and ungated failure notices", async () => {
  for (const stale of [false, true])
    for (const failed of [false, true])
      await compare(async (f) => {
        const pending = deferred<Receipt>();
        f.execute(() => pending.promise);
        const old = [instance("a"), instance("b"), instance("c")];
        const host = f.host({ activeId: "b", instances: old });
        const action = host.close(old[1]!);
        f.state.applicationInstances = [
          instance("new-left"),
          instance("b"),
          instance("new-right"),
        ];
        if (stale) {
          f.owner.beginIntent();
          f.owner.beginIntent();
        }
        if (failed) pending.reject(new Error("close failed"));
        else pending.resolve(receipt());
        await action;
        assert.equal(patches(f).length, !stale && !failed ? 1 : 0);
        if (!stale && !failed)
          assert.equal(
            patches(f)[0]!.applications?.["first-project"],
            "c",
            "activation uses render-captured neighbours, not the later projection",
          );
        assert.deepEqual(
          noticeEvents(f),
          failed ? [["notice", "close failed"]] : [],
        );
      });
  await compare(async (f) => {
    const host = f.host({ activeId: "another" });
    await host.close(instance("closed"));
    assert.equal(patches(f).length, 0);
  });
  await compare(async (f) => {
    const host = f.host({ activeId: "missing", instances: [instance("a")] });
    await host.close(instance("missing"));
    assert.equal(
      (patches(f)[0] as Partial<NavigationPreferences>).applications?.[
        "first-project"
      ],
      "a",
      "index -1 preserves original instances[0] fallback",
    );
  });
});

test("Launcher and close retain the render-captured generation rather than substituting invocation-time current generation", async () => {
  for (const action of ["launch", "close"] as const)
    await compare(async (f) => {
      const host = f.host({
        activeId: "previous-instance",
        instances: [instance("previous-instance"), instance("neighbour")],
      });
      f.owner.beginIntent();
      if (action === "launch") await host.launch(readerApplication);
      else await host.close(instance("previous-instance"));
      assert.equal(f.operations.length, 1);
      assert.equal(
        patches(f).length,
        0,
        "same workspace does not revive a receipt captured before a newer navigation",
      );
      assert.equal(f.owner.navigationGeneration.current, 8);
    });
});

test("prepared launch and close retain the exact execute Promise reference and perform no activation before synchronous commit", async () => {
  for (const operation of ["launch", "close"] as const) {
    const f = fixture("production");
    const pending = deferred<Receipt>();
    f.execute(() => pending.promise);
    const actions = (
      f.commands as ReturnType<typeof createWorkspaceNavigationCommands>
    ).applicationActions;
    const captured = {
      workspaceId: "first-project",
      navigationId: 7,
      activeId: "previous-instance",
      instances: f.state.applicationInstances,
    };
    if (operation === "launch") {
      const action = actions.launch(readerApplication, captured);
      assert.equal(action.kind, "application");
      if (action.kind !== "application")
        assert.fail("normal launch must return the application preparation");
      assert.equal(action.pending, pending.promise);
      assert.equal(action.pending, f.executePromises[0]);
      pending.resolve(receipt("reader"));
      const result = await action.pending;
      assert.equal(patches(f).length, 0);
      const before = f.events.length;
      action.commit(result);
      assert.deepEqual(f.events.slice(before, before + 2), [
        ["website", null],
        ["creating", null],
      ]);
      assert.equal(patches(f)[0]!.applications?.["first-project"], "reader");
    } else {
      const action = actions.close(f.state.applicationInstances[0]!, captured);
      assert.equal(action.pending, pending.promise);
      assert.equal(action.pending, f.executePromises[0]);
      pending.resolve(receipt());
      await action.pending;
      assert.equal(patches(f).length, 0);
      action.commit();
      assert.equal(patches(f)[0]!.applications?.["first-project"], "reader");
    }
  }
});

test("Host resolve/reject and finally share the original execute microtask without an extra async wrapper", async () => {
  for (const failed of [false, true])
    await compare(async (f) => {
      const pending = deferred<Receipt>();
      f.execute(() => pending.promise);
      const host = f.host();
      const action = host.launch(readerApplication);
      void pending.promise.then(
        () => f.events.push(["external-execute-reaction"]),
        () => f.events.push(["external-execute-rejection"]),
      );
      void action.then(() => f.events.push(["host-promise-reaction"]));
      f.events.push([failed ? "execute-reject" : "execute-resolve"]);
      if (failed) pending.reject(new Error("same-microtask failure"));
      else pending.resolve(receipt("reader"));
      await Promise.resolve();
      assert.equal(
        host.busy(),
        false,
        "busy finally must run in the first execute continuation",
      );
      assert.equal(host.launching.current, false);
      assert.equal(patches(f).length, failed ? 0 : 1);
      assert.deepEqual(
        noticeEvents(f),
        failed ? [["notice", "same-microtask failure"]] : [],
      );
      const cleanup = f.events.findIndex(
        (e) => e[0] === "busy" && e[1] === false,
      );
      const external = f.events.findIndex(
        (e) =>
          e[0] ===
          (failed ? "external-execute-rejection" : "external-execute-reaction"),
      );
      const commitOrError = f.events.findIndex(
        (e) => e[0] === (failed ? "notice" : "prefer"),
      );
      assert.equal(
        commitOrError >
          f.events.findIndex(
            (e) => e[0] === (failed ? "execute-reject" : "execute-resolve"),
          ),
        true,
      );
      assert.equal(
        cleanup > commitOrError && cleanup < external,
        true,
        "activation/error and busy release precede the later execute observer in the same reaction",
      );
      assert.equal(
        f.events.some((e) => e[0] === "host-promise-reaction"),
        false,
        "Host promise resolution is a later reaction, not part of execute finally",
      );
      const firstMicrotask = structuredClone(f.events);
      await action;
      return {
        firstMicrotask,
        busy: host.busy(),
        lock: host.launching.current,
      };
    });
});

test("close commit/error runs in the original execute continuation, without an extra prepared-operation await", async () => {
  for (const failed of [false, true])
    await compare(async (f) => {
      const pending = deferred<Receipt>();
      f.execute(() => pending.promise);
      const host = f.host();
      const action = host.close(instance("previous-instance"));
      void pending.promise.then(
        () => f.events.push(["external-close-reaction"]),
        () => f.events.push(["external-close-rejection"]),
      );
      if (failed) pending.reject(new Error("close first reaction"));
      else pending.resolve(receipt());
      await Promise.resolve();
      const committed = f.events.findIndex(
        (e) => e[0] === (failed ? "notice" : "prefer"),
      );
      const external = f.events.findIndex(
        (e) =>
          e[0] ===
          (failed ? "external-close-rejection" : "external-close-reaction"),
      );
      assert.equal(committed >= 0 && committed < external, true);
      assert.equal(
        f.events.some((e) => e[0] === "busy"),
        false,
      );
      assert.deepEqual(
        noticeEvents(f),
        failed ? [["notice", "close first reaction"]] : [],
      );
      await action;
    });
});

test("synchronously thrown execute failures preserve original Host catch/finally and do not leave local busy stuck", async () => {
  for (const operation of ["launch", "close", "contents"] as const)
    await compare(async (f) => {
      f.execute(() => {
        throw new Error("synchronous operation failure");
      });
      const host = f.host();
      if (operation === "close")
        await host.close(instance("previous-instance"));
      else await host.launch(readerApplication, operation === "contents");
      assert.equal(host.busy(), false);
      assert.equal(host.launching.current, false);
      assert.equal(patches(f).length, 0);
      assert.deepEqual(noticeEvents(f), [
        ["notice", "synchronous operation failure"],
      ]);
    });
});
