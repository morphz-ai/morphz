import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Dispatch, SetStateAction } from "react";
import {
  createSubjectInspectorCloseCommand,
  createSubjectInspectorCommands,
  subjectCollaborationVisible,
  subjectInspectorOpen,
  subjectInspectorPresentation,
  subjectInspectorView,
} from "../apps/web/src/host/use-subject-inspector.js";
import {
  initialWorkspace,
  type Workspace,
} from "../packages/core/src/model.js";
import type { ExecutionScope } from "../packages/core/src/execution.js";
import type { SubjectView } from "../apps/web/src/subject-sidebar-model.js";
import {
  createFixedSubjectInspector,
  deriveFixedSubjectInspector,
  type FixedInspectorBindings,
  type FixedInspectorFacts,
  type FixedInspectorSelection,
} from "./fixtures/subject-inspector-85a50934.js";

const oldSource = readFileSync(
  new URL("./fixtures/subject-inspector-85a50934.ts", import.meta.url),
  "utf8",
);
type Mode = "fixed" | "production";
type Commands = ReturnType<typeof createSubjectInspectorCommands>;
type Options = Parameters<typeof createSubjectInspectorCommands>[0];
const now = "2026-10-04T00:00:00.000Z";
const scope: ExecutionScope = {
  projectId: "first-project",
  conversationId: "named-A",
  artifactId: "artifact-A",
  inputId: "input-A",
  threadId: "thread-A",
  taskRun: true,
};
const overview: ExecutionScope = {
  projectId: "render-project",
  conversationId: "render-conversation",
  artifactId: null,
};
const views: readonly SubjectView[] = [
  "activity",
  "permissions",
  "schedules",
  "settings",
];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function source(
  changes: Partial<Workspace["inputs"][number]> = {},
): Workspace["inputs"][number] {
  return {
    id: "input-A",
    projectId: "first-project",
    conversationId: "named-A",
    artifactId: "artifact-A",
    artifactRevision: 3,
    author: { principalId: "human-A", actantId: "human" },
    body: "真实来源",
    createdAt: now,
    ...changes,
  } as Workspace["inputs"][number];
}
type Scenario = {
  executions?: ExecutionScope | null;
  subjectTab?: SubjectView;
  subjectOpen?: boolean;
  collaboration?: boolean;
  mobileCollaboration?: boolean;
  compact?: boolean;
  allActivity?: boolean;
  understandingOpen?: boolean;
  remembered?: FixedInspectorSelection;
  missingProject?: boolean;
  inputs?: Workspace["inputs"];
};
function fixture(mode: Mode, scenario: Scenario = {}) {
  const events: unknown[][] = [],
    frames: FrameRequestCallback[] = [];
  const workspace = initialWorkspace(now);
  workspace.inputs = scenario.inputs ?? [source()];
  if (scenario.missingProject)
    workspace.projects = workspace.projects.filter(
      (p) => p.id !== "first-project",
    );
  const preferences = {
    subjectTab: scenario.subjectTab,
    subjectOpen: scenario.subjectOpen ?? false,
    collaboration: scenario.collaboration ?? false,
    unrelated: "untouched",
  };
  let currentExecution = scenario.executions ?? null,
    allActivity = scenario.allActivity ?? false,
    understanding = scenario.understandingOpen ?? true,
    mobile = scenario.mobileCollaboration ?? true;
  let history: (id: string) => Promise<boolean> = async () => false;
  let snapshot: { workspace: Workspace } | null | undefined = { workspace };
  let readSnapshot = () => snapshot;
  const memory = new Map<string, FixedInspectorSelection>();
  if (scenario.remembered) memory.set("surface-A", scenario.remembered);
  const setExecutions: Dispatch<SetStateAction<ExecutionScope | null>> = (
    value,
  ) => {
    if (typeof value === "function") {
      const previous = currentExecution;
      currentExecution = value(previous);
      events.push([
        "execution-updater",
        previous,
        currentExecution,
        previous === currentExecution,
      ]);
    } else {
      currentExecution = value;
      events.push(["execution", value]);
    }
  };
  const setAllActivity: Dispatch<SetStateAction<boolean>> = (value) => {
    allActivity = typeof value === "function" ? value(allActivity) : value;
    events.push(["all-work", allActivity]);
  };
  const setUnderstandingOpen: Dispatch<SetStateAction<boolean>> = (value) => {
    understanding = typeof value === "function" ? value(understanding) : value;
    events.push(["understanding", understanding]);
  };
  const setMobileCollaboration: Dispatch<SetStateAction<boolean>> = (value) => {
    mobile = typeof value === "function" ? value(mobile) : value;
    events.push(["mobile-collaboration", mobile]);
  };
  const prefer = (change: Partial<typeof preferences>) => {
    events.push(["prefer", change]);
  };
  const keepExchangeOpen = () => {
    events.push(["keep-exchange-open"]);
  };
  const client: FixedInspectorBindings["client"] = {
    loadHistoryUntil(id) {
      events.push(["history", id]);
      return history(id);
    },
    getSnapshot() {
      events.push(["snapshot"]);
      return readSnapshot();
    },
  };
  const raf: typeof requestAnimationFrame = (callback) => {
    events.push(["close-focus"]);
    frames.push(callback);
    return frames.length;
  };
  let trigger: { visible: boolean; name: string } | null = {
    visible: true,
    name: "toggle",
  };
  const focus = (name: string) => ({
    focus() {
      events.push(["focus", name]);
    },
  });
  const input = { current: focus("input") as HTMLTextAreaElement | null };
  const toggle = { current: focus("entry") as HTMLButtonElement | null };
  const document = {
    querySelector(selector: string) {
      events.push(["query", selector]);
      return (
        trigger && {
          ...focus(trigger.name),
          getClientRects: () => (trigger!.visible ? [1] : []),
        }
      );
    },
  } as Pick<Document, "querySelector">;
  const closedFocus = () =>
    raf(() => {
      const target = document.querySelector<HTMLElement>(".inspector-toggle");
      if (target?.getClientRects().length) target.focus();
      else (input.current ?? toggle.current)?.focus();
    });
  const facts: FixedInspectorFacts = {
    prefs: preferences,
    executions: scenario.executions ?? null,
    understandingOpen: understanding,
    mobileCollaboration: mobile,
    compact: scenario.compact ?? false,
    artifact: undefined,
    conversationProjectId: overview.projectId,
    conversationId: overview.conversationId!,
  };
  const fixedBindings: FixedInspectorBindings = {
    ...facts,
    state: workspace,
    contextKey: "surface-A",
    inspectorSelections: { current: memory },
    client,
    setExecutions,
    setUnderstandingOpen,
    setMobileCollaboration,
    setAllActivity,
    setNotice: (message) => {
      events.push(["notice", message]);
    },
    prefer,
    keepExchangeOpen,
    input,
    toggle,
    document,
    requestAnimationFrame: raf,
  };
  const old =
    mode === "fixed" ? createFixedSubjectInspector(fixedBindings) : null;
  const inspection = {
    executions: facts.executions,
    setExecutions,
    understandingOpen: facts.understandingOpen,
    setUnderstandingOpen,
  };
  const collaboration = {
    mobileCollaboration: facts.mobileCollaboration,
    setMobileCollaboration,
  };
  const close =
    old?.closeInspector ??
    createSubjectInspectorCloseCommand({
      inspection,
      collaboration,
      prefer,
      onClosedFocus: closedFocus,
    });
  const actions: Commands = old
    ? {
        close,
        openExecutions: old.openExecutions,
        openCollaboration: old.openCollaboration,
        show: old.showInspector,
        selectSubject: old.selectSubjectView,
        openFromLogo: old.openSubjectFromLogo,
        inspectExecution: old.inspectExecution,
        back: old.onBack,
        selectScope: old.onInspect,
        toggleCollaboration: old.toggleCollaboration,
        selectExecution: setExecutions,
        setAllActivity,
      }
    : createSubjectInspectorCommands({
        activity: { allActivity, setAllActivity },
        inspection,
        collaboration,
        rememberedInspector: memory.get("surface-A"),
        workspace,
        historyClient: client as Options["historyClient"],
        preferences,
        conversationProjectId: facts.conversationProjectId,
        conversationId: facts.conversationId,
        compact: facts.compact,
        prefer,
        keepExchangeOpen,
        onNotice: fixedBindings.setNotice,
        close,
      });
  return {
    events,
    actions,
    workspace,
    memory,
    close,
    setExecutions,
    setAllActivity,
    preferences,
    current: () => ({
      executions: currentExecution,
      allActivity,
      understanding,
      mobile,
    }),
    setCurrentExecution(value: ExecutionScope | null) {
      currentExecution = value;
    },
    setHistory(perform: typeof history) {
      history = perform;
    },
    setSnapshot(value: typeof snapshot) {
      snapshot = value;
    },
    setSnapshotReader(read: typeof readSnapshot) {
      readSnapshot = read;
    },
    setFocus(value: typeof trigger, inputPresent = true, entryPresent = true) {
      trigger = value;
      input.current = inputPresent
        ? (focus("input") as HTMLTextAreaElement)
        : null;
      toggle.current = entryPresent
        ? (focus("entry") as HTMLButtonElement)
        : null;
    },
    flushFrames() {
      for (const callback of frames.splice(0)) callback(0);
    },
  };
}
function pair(scenario: Scenario = {}) {
  return [fixture("fixed", scenario), fixture("production", scenario)] as const;
}
function same(f: ReturnType<typeof pair>) {
  assert.deepEqual(f[1].events, f[0].events);
  assert.deepEqual(f[1].current(), f[0].current());
  for (const item of f) assert.equal(item.preferences.unrelated, "untouched");
}

test("fixed 85a50934 bodies, derived expressions and memory effect were independently verified against Git, with no production algorithm oracle", () => {
  // Extraction proof compared all 17 bodies/initializers plus the exact memory
  // dependency tuple with the real Git App. CI needs no historical checkout.
  assert.equal(
    createHash("sha256").update(oldSource).digest("hex"),
    "458dd64f1247580919e8beb2f236edd5ea4dcb6eba420f82fe8ad181cecb7777",
  );
  assert.doesNotMatch(oldSource, /from\s+["'][^"']*use-subject-inspector/);
});

test("constructing commands/close is inert, retains exact setter/close references and performs no history/snapshot read", () => {
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode, { remembered: { view: "execution", scope } });
    assert.deepEqual(f.events, []);
    assert.equal(f.actions.close, f.close);
    assert.equal(f.actions.selectExecution, f.setExecutions);
    assert.equal(f.actions.setAllActivity, f.setAllActivity);
    assert.deepEqual(
      [...f.memory],
      [["surface-A", { view: "execution", scope }]],
    );
  }
});

test("complete presentation boolean/tab combinations preserve precedence, legacy fallback and execution scope identity", () => {
  const workspace = initialWorkspace(now);
  for (const tab of [undefined, ...views])
    for (let bits = 0; bits < 128; bits++) {
      const facts: FixedInspectorFacts = {
        prefs: {
          subjectOpen: !!(bits & 1),
          subjectTab: tab,
          collaboration: !!(bits & 2),
        },
        executions: bits & 4 ? scope : null,
        understandingOpen: !!(bits & 8),
        compact: !!(bits & 16),
        mobileCollaboration: !!(bits & 32),
        artifact: bits & 64 ? workspace.artifacts[0] : undefined,
        conversationProjectId: overview.projectId,
        conversationId: overview.conversationId!,
      };
      // The workspace seed can have no artifacts; use the real type's minimum
      // truthy identity here because the original expression only tests !!artifact.
      if (bits & 64)
        facts.artifact ??= { id: "artifact" } as Workspace["artifacts"][number];
      const expected = deriveFixedSubjectInspector(facts);
      const subjectView = subjectInspectorView(facts.prefs);
      const collaborationVisible =
        !!facts.artifact &&
        subjectCollaborationVisible({
          ...facts,
          subjectView,
          preferences: facts.prefs,
        });
      const inspectorOpen = subjectInspectorOpen({
        ...facts,
        subjectView,
        collaborationVisible,
      });
      const presentation = subjectInspectorPresentation({
        ...facts,
        collaborationVisible,
      });
      assert.deepEqual(
        { subjectView, collaborationVisible, inspectorOpen, ...presentation },
        expected,
        `${tab}/${bits}`,
      );
      if (facts.executions) assert.equal(presentation.activityScope, scope);
      else assert.deepEqual(presentation.activityScope, overview);
    }
});

test("open executions preserves all six actions in original order without resetting all-work or requesting data", () => {
  const f = pair({ allActivity: true });
  for (const item of f) assert.equal(item.actions.openExecutions(), undefined);
  same(f);
  assert.deepEqual(f[1].events, [
    ["prefer", { subjectTab: "activity", subjectOpen: true }],
    ["keep-exchange-open"],
    ["understanding", false],
    ["mobile-collaboration", false],
    ["prefer", { collaboration: false }],
    ["execution", overview],
  ]);
  assert.equal(f[1].current().allActivity, true);
});

test("open collaboration preserves the old execution/summary clearing and mobile/pref asymmetry, without opening exchange", () => {
  const f = pair({ executions: scope, allActivity: true });
  for (const item of f) item.actions.openCollaboration();
  same(f);
  assert.deepEqual(f[1].events, [
    ["execution", null],
    ["understanding", false],
    ["mobile-collaboration", true],
    ["prefer", { collaboration: true, subjectOpen: false }],
  ]);
  assert.equal(f[1].current().allActivity, true);
});

test("selecting every subject tab leaves concrete scope/all-work intact; activity updater reads actual current state, not captured execution", () => {
  for (const view of views) {
    const f = pair({ executions: scope, allActivity: true });
    const newer = { ...scope, threadId: "newer-thread" };
    for (const item of f) {
      item.setCurrentExecution(newer);
      item.actions.selectSubject(view);
    }
    same(f);
    assert.equal(f[1].current().executions, newer);
    assert.equal(f[1].current().allActivity, true);
    assert.equal(f[1].events.length, view === "activity" ? 4 : 3);
    if (view === "activity")
      assert.deepEqual(f[1].events[3], [
        "execution-updater",
        newer,
        newer,
        true,
      ]);
  }
  const f = pair({ executions: scope });
  for (const item of f) {
    item.setCurrentExecution(null);
    item.actions.selectSubject("activity");
  }
  same(f);
  assert.deepEqual(f[1].current().executions, overview);
  assert.deepEqual(f[1].events[3], [
    "execution-updater",
    null,
    overview,
    false,
  ]);
});

test("Logo activity explicitly replaces detail with all-work while non-activity Logo access only selects its tab", () => {
  for (const view of views) {
    const f = pair({ executions: scope, allActivity: false });
    for (const item of f) item.actions.openFromLogo(view);
    same(f);
    assert.equal(f[1].current().allActivity, view === "activity");
    if (view === "activity") {
      assert.deepEqual(f[1].events.slice(-2), [
        ["all-work", true],
        ["execution", overview],
      ]);
      assert.deepEqual(f[1].current().executions, overview);
    } else assert.equal(f[1].events.length, 3);
    assert.equal(
      f[1].events.some((e) => e[0] === "keep-exchange-open"),
      false,
    );
  }
});

test("show restores only eligible remembered exact execution scopes, accepting legacy missing conversation IDs and source-less threads", () => {
  for (const rememberedScope of [
    scope,
    {
      projectId: "first-project",
      artifactId: null,
      threadId: "unloaded-thread",
    },
    { projectId: "first-project", artifactId: null, inputId: "input-A" },
  ]) {
    const f = pair({
      remembered: { view: "execution", scope: rememberedScope },
      executions: null,
    });
    for (const item of f) item.actions.show();
    same(f);
    assert.equal(f[1].current().executions, rememberedScope);
    assert.deepEqual(f[1].events, [
      ["keep-exchange-open"],
      ["understanding", false],
      ["mobile-collaboration", false],
      [
        "prefer",
        { collaboration: false, subjectTab: "activity", subjectOpen: true },
      ],
      ["execution", rememberedScope],
    ]);
  }
});

test("show rejects absent projects/inputs, ignores old summary/collaboration memories and preserves current functional selection", () => {
  const scenarios: Scenario[] = [
    { remembered: { view: "execution", scope }, missingProject: true },
    { remembered: { view: "execution", scope }, inputs: [] },
    { remembered: { view: "understanding" } },
    { remembered: { view: "collaboration" } },
    {},
  ];
  for (const scenario of scenarios) {
    const f = pair({ ...scenario, executions: scope });
    for (const item of f) item.actions.show();
    same(f);
    assert.equal(f[1].current().executions, scope);
    assert.deepEqual(f[1].events, [
      ["understanding", false],
      ["mobile-collaboration", false],
      [
        "prefer",
        { collaboration: false, subjectTab: "activity", subjectOpen: true },
      ],
      ["execution-updater", scope, scope, true],
    ]);
  }
});

test("show's non-activity remembered preference takes priority over execution eligibility and never opens exchange", () => {
  for (const view of views.filter((view) => view !== "activity")) {
    const f = pair({
      subjectTab: view,
      remembered: { view: "execution", scope },
      missingProject: true,
    });
    for (const item of f) item.actions.show();
    same(f);
    assert.deepEqual(f[1].events, [
      ["understanding", false],
      ["mobile-collaboration", false],
      ["prefer", { collaboration: false, subjectTab: view, subjectOpen: true }],
    ]);
  }
});

test("show uses original render-captured memory, not a later map selection", () => {
  const f = pair({ remembered: { view: "execution", scope } });
  for (const item of f) {
    item.memory.set("surface-A", { view: "understanding" });
    item.actions.show();
  }
  same(f);
  assert.equal(f[1].current().executions, scope);
});

test("back resets detail fields with independent original project/conversation fallback and no preference/write", () => {
  for (const execution of [
    null,
    scope,
    { projectId: "legacy-project", artifactId: "artifact", threadId: "thread" },
  ]) {
    const f = pair({ executions: execution });
    for (const item of f) item.actions.back();
    same(f);
    assert.deepEqual(f[1].events, [
      [
        "execution",
        {
          projectId: execution?.projectId ?? overview.projectId,
          conversationId: execution?.conversationId ?? overview.conversationId,
          artifactId: null,
        },
      ],
    ]);
  }
});

test("scope selection performs original activity functional updater before the exact passed scope setter", () => {
  const f = pair({ executions: scope, allActivity: true });
  const selected: ExecutionScope = {
    projectId: "other-project",
    artifactId: null,
    inputId: "foreign-source",
    threadId: "other-thread",
  };
  for (const item of f) item.actions.selectScope(selected);
  same(f);
  assert.equal(f[1].current().executions, selected);
  assert.deepEqual(f[1].events.slice(-2), [
    ["execution-updater", scope, scope, true],
    ["execution", selected],
  ]);
  assert.equal(f[1].current().allActivity, true);
});

test("collaboration toggle keeps distinct compact captured mobile and desktop captured preference branches", () => {
  for (const compact of [false, true])
    for (const enabled of [false, true]) {
      const f = pair({
        compact,
        collaboration: enabled,
        mobileCollaboration: enabled,
        executions: scope,
      });
      for (const item of f) item.actions.toggleCollaboration();
      same(f);
      assert.deepEqual(f[1].events, [
        ["understanding", false],
        ["execution", null],
        ["prefer", { subjectOpen: false }],
        compact
          ? ["mobile-collaboration", !enabled]
          : ["prefer", { collaboration: !enabled }],
      ]);
    }
});

test("close clears original fields/preferences, invokes original focus scheduling synchronously last and retains all-work", () => {
  const f = pair({ executions: scope, allActivity: true });
  for (const item of f) assert.equal(item.actions.close(), undefined);
  same(f);
  assert.deepEqual(f[1].events, [
    ["execution", null],
    ["understanding", false],
    ["mobile-collaboration", false],
    ["prefer", { collaboration: false, subjectOpen: false }],
    ["close-focus"],
  ]);
  for (const item of f) item.flushFrames();
  same(f);
  assert.deepEqual(f[1].events.slice(-2), [
    ["query", ".inspector-toggle"],
    ["focus", "toggle"],
  ]);
});

test("close focus port follows original deferred visible-toggle/input/entry/null fallback without early DOM access", () => {
  for (const [target, input, entry, expected] of [
    [{ visible: false, name: "hidden" }, true, true, "input"],
    [null, true, true, "input"],
    [null, false, true, "entry"],
    [null, false, false, null],
  ] as const) {
    const f = pair();
    for (const item of f) {
      item.setFocus(target, input, entry);
      item.actions.close();
      assert.equal(
        item.events.some((e) => e[0] === "query"),
        false,
      );
      item.flushFrames();
    }
    same(f);
    assert.deepEqual(
      f[1].events.filter((e) => e[0] === "focus"),
      expected ? [["focus", expected]] : [],
    );
  }
});

test("loaded inspection commits synchronously with exact input/source provenance and returns the same async completion timing", async () => {
  for (const original of [
    source(),
    source({ conversationId: undefined }),
    source({ artifactId: null }),
  ]) {
    const f = pair({ inputs: [original] });
    const completions = f.map((item) => {
      const done = item.actions.inspectExecution(original.id);
      assert.ok(done instanceof Promise);
      assert.equal(
        item.events.some((e) => e[0] === "history" || e[0] === "snapshot"),
        false,
      );
      done.then(() => {
        item.events.push(["caller-complete"]);
      });
      queueMicrotask(() => {
        item.events.push(["queued-turn"]);
      });
      return done;
    });
    same(f);
    assert.deepEqual(f[1].current().executions, {
      projectId: original.projectId,
      conversationId: original.conversationId ?? original.projectId,
      artifactId: original.artifactId,
      inputId: original.id,
    });
    assert.deepEqual(f[1].events.slice(0, 5), [
      ["keep-exchange-open"],
      ["prefer", { subjectTab: "activity", subjectOpen: true }],
      ["understanding", false],
      ["mobile-collaboration", false],
      ["prefer", { collaboration: false }],
    ]);
    await Promise.all(completions);
    same(f);
    assert.deepEqual(f[1].events.slice(-2), [
      ["caller-complete"],
      ["queued-turn"],
    ]);
  }
});

test("unloaded inspection awaits exactly the original history promise then reads current Client snapshot before setters/caller completion", async () => {
  const f = pair({ inputs: [] });
  const waits = f.map(() => deferred<boolean>());
  const original = source({
    projectId: "actual-source-owner",
    conversationId: "actual-source-conversation",
    artifactId: null,
  });
  const completions = f.map((item, index) => {
    item.setHistory(() => waits[index]!.promise);
    item.setSnapshot({ workspace: { ...item.workspace, inputs: [original] } });
    const done = item.actions.inspectExecution(original.id);
    assert.deepEqual(item.events, [["history", original.id]]);
    assert.notEqual(
      done,
      waits[index]!.promise,
      "old async command returns its own completion, not the boolean read promise",
    );
    done.then(() => {
      item.events.push(["caller-complete"]);
    });
    waits[index]!.promise.then(() => {
      item.events.push(["history-observer"]);
    });
    return done;
  });
  waits.forEach((wait) => wait.resolve(true));
  await Promise.all(completions);
  same(f);
  assert.deepEqual(f[1].events, [
    ["history", original.id],
    ["snapshot"],
    ["keep-exchange-open"],
    ["prefer", { subjectTab: "activity", subjectOpen: true }],
    ["understanding", false],
    ["mobile-collaboration", false],
    ["prefer", { collaboration: false }],
    [
      "execution",
      {
        projectId: original.projectId,
        conversationId: original.conversationId,
        artifactId: null,
        inputId: original.id,
      },
    ],
    ["history-observer"],
    ["caller-complete"],
  ]);
});

test("false history receipt never reads snapshot and true-but-missing/null snapshot reports original not-found without opening", async () => {
  for (const variant of ["false", "empty", "null", "undefined"] as const) {
    const f = pair({ inputs: [] });
    for (const item of f) {
      item.setHistory(async () => variant !== "false");
      item.setSnapshot(
        variant === "null"
          ? null
          : variant === "undefined"
            ? undefined
            : { workspace: item.workspace },
      );
      await item.actions.inspectExecution("missing");
    }
    same(f);
    assert.deepEqual(f[1].events, [
      ["history", "missing"],
      ...(variant === "false" ? [] : [["snapshot"]]),
      ["notice", "原消息暂时不在已加载的记录中。"],
    ]);
  }
});

test("history rejection, synchronous throw and snapshot failure preserve Error/non-Error messages and resolve without partial opening", async () => {
  for (const reason of [new Error("原读取错误"), "opaque failure"])
    for (const synchronous of [false, true]) {
      const f = pair({ inputs: [] });
      for (const item of f) {
        item.setHistory(() => {
          if (synchronous) throw reason;
          return Promise.reject(reason);
        });
        await item.actions.inspectExecution("missing");
      }
      same(f);
      assert.deepEqual(f[1].events, [
        ["history", "missing"],
        [
          "notice",
          reason instanceof Error ? reason.message : "原消息暂时无法读取。",
        ],
      ]);
    }
  for (const reason of [new Error("快照读取错误"), null]) {
    const f = pair({ inputs: [] });
    for (const item of f) {
      item.setHistory(async () => true);
      item.setSnapshotReader(() => {
        throw reason;
      });
      await item.actions.inspectExecution("missing");
    }
    same(f);
    assert.deepEqual(f[1].events, [
      ["history", "missing"],
      ["snapshot"],
      [
        "notice",
        reason instanceof Error ? reason.message : "原消息暂时无法读取。",
      ],
    ]);
  }
});

test("late history completion retains original render's source behavior instead of adding new navigation/principal guards", async () => {
  const f = pair({ inputs: [] });
  const waits = f.map(() => deferred<boolean>());
  const done = f.map((item, index) => {
    item.setHistory(() => waits[index]!.promise);
    return item.actions.inspectExecution("input-A");
  });
  const late = source({
    projectId: "late-project",
    conversationId: undefined,
    artifactId: null,
  });
  for (const item of f) {
    item.setCurrentExecution({
      projectId: "new-page",
      artifactId: null,
      threadId: "new-page-thread",
    });
    item.workspace.inputs = [
      source({ id: "other-page-input", projectId: "new-page" }),
    ];
    item.preferences.subjectTab = "settings";
    item.setSnapshot({ workspace: { ...item.workspace, inputs: [late] } });
  }
  waits.forEach((wait) => wait.resolve(true));
  await Promise.all(done);
  same(f);
  assert.deepEqual(f[1].current().executions, {
    projectId: "late-project",
    conversationId: "late-project",
    artifactId: null,
    inputId: "input-A",
  });
  assert.deepEqual(f[1].events.slice(0, 3), [
    ["history", "input-A"],
    ["snapshot"],
    ["keep-exchange-open"],
  ]);
});
