import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isExpressionStatement,
  isFunctionDeclaration,
  isReturnStatement,
  isVariableDeclaration,
  type Node,
} from "typescript/unstable/ast";
import {
  initialWorkspace,
  type Workspace,
} from "../packages/core/src/model.js";
import {
  createExchangeDraftCommands,
  type ConversationDraft,
  type InputDraft,
} from "../apps/web/src/host/exchange-drafts.js";
import { draftKey } from "../apps/web/src/local-preferences.js";
import {
  createPrivateProjectConversationScope,
  projectConversationDraftPresence,
  startedProjectConversationIds,
  type PrivateProjectConversationPorts,
} from "../apps/web/src/host/private-project-conversation-scope.js";
import {
  createFixedPrivateProjectConversationScope,
  fixedProjectConversationDraftPresence,
  fixedProjectConversationHashes,
  fixedStartedProjectConversationIds,
} from "./fixtures/private-project-conversation-scope-c35b9fde.js";

// Complete fixed algorithms plus actual existing draft owner with controlled
// storage/navigation/authority ports. No Platform, HTTP, Runtime or App is run.
const now = "2026-10-04T00:00:00.000Z";
const empty: InputDraft = { body: "", selection: "", revision: null };
const saved: ConversationDraft = {
  id: "named-A",
  projectId: "first-project",
  title: "原始标题",
  inputId: "stable-input-A",
};
const body: InputDraft = {
  ...empty,
  body: "未发送的原文\n第二行",
  selection: "引用",
  revision: 2,
  page: 3,
};
type Projection = NonNullable<
  ReturnType<import("../apps/web/src/client.js").WorkspaceClient["getSnapshot"]>
>;
type Inputs = Record<string, InputDraft>;
type Conversations = Record<string, ConversationDraft>;
type Trash = Record<
  string,
  { conversation: ConversationDraft; drafts: Inputs }
>;
type Mode = "fixed" | "production";
const factories = {
  fixed: createFixedPrivateProjectConversationScope,
  production: createPrivateProjectConversationScope,
};
function projection() {
  const workspace = initialWorkspace(now);
  workspace.projects.push({
    ...workspace.projects[0]!,
    id: "created-project",
    title: "新增项目",
    kind: "project",
  });
  workspace.projects.push({
    ...workspace.projects[0]!,
    id: "personal-default",
    title: "默认",
    kind: "dialogue",
    ownerPrincipalId: "human-A",
  });
  return {
    workspace,
    centerId: "center-A",
    principalId: "human-A",
    csrfToken: "session-A",
    capabilities: { teamAuthentication: false },
    runtime: { messages: [] },
    localSavedInputIds: [],
  } as unknown as Projection;
}
function fixture(
  mode: Mode,
  options: {
    inputs?: Inputs;
    conversations?: Conversations;
    trash?: Trash;
    failAt?: number;
    view?: "projects" | "desk";
    projectOpen?: boolean;
    navigationProject?: string;
    project?: string;
    conversationId?: string;
    sharedDefault?: boolean;
    active?: boolean;
    sendPending?: boolean;
  } = {},
) {
  const events: unknown[][] = [],
    inputs = options.inputs ?? {},
    conversations = options.conversations ?? {},
    trash = options.trash ?? {};
  const published = { inputs, conversations, trash },
    conversationRef = { current: conversations };
  const persisted = new Map<string, unknown>([
    [draftKey("inputs"), structuredClone(inputs)],
    [draftKey("conversations"), structuredClone(conversations)],
    [draftKey("discarded-conversations"), structuredClone(trash)],
  ]);
  let writes = 0,
    generation = 7,
    active = options.active ?? true,
    hostActive = true,
    incarnation = 1,
    current: Projection | null = projection(),
    locked = options.sendPending ?? false;
  const state = current.workspace;
  const draftCommands = createExchangeDraftCommands({
    inputs: {
      value: inputs,
      set(action) {
        events.push(["inputs.set"]);
        published.inputs =
          typeof action === "function" ? action(published.inputs) : action;
      },
    },
    conversations: {
      value: conversations,
      ref: conversationRef,
      set(action) {
        events.push([
          "conversations.set",
          Object.keys(conversationRef.current),
        ]);
        published.conversations =
          typeof action === "function"
            ? action(published.conversations)
            : action;
      },
    },
    discarded: {
      value: trash,
      set(action) {
        events.push(["trash.set"]);
        published.trash =
          typeof action === "function" ? action(published.trash) : action;
      },
    },
    storage: {
      readLocal<T>(key: string, fallback: T): T {
        events.push(["storage.read", key]);
        return (persisted.get(key) ?? fallback) as T;
      },
      writeLocal(key, value) {
        events.push(["storage.write", key, structuredClone(value)]);
        if (++writes === options.failAt) throw Error("controlled quota");
        persisted.set(key, structuredClone(value));
      },
    },
    onNotice(message) {
      events.push(["notice", message]);
    },
  });
  const prefs = {
    view: options.view ?? "projects",
    projectOpen: options.projectOpen ?? true,
    interactions: {
      "first-project": "history",
      "named-A": "history",
      "created-project": "history",
    },
  } satisfies PrivateProjectConversationPorts["render"]["prefs"];
  const ports: PrivateProjectConversationPorts = {
    render: {
      state,
      prefs,
      navigationProject: { id: options.navigationProject ?? "first-project" },
      project: { id: options.project ?? "first-project" },
      sharedDefault: options.sharedDefault ?? true,
      defaultConversation: "personal-default",
      conversationId: options.conversationId ?? "named-A",
      hasConversationDraft: projectConversationDraftPresence({
        state,
        client: { boot: current },
        drafts: inputs,
      }),
      personalSpace(kind) {
        events.push(["personalSpace", kind]);
        return state.projects.find(
          (p) => p.kind === kind && p.ownerPrincipalId === "human-A",
        );
      },
    },
    origin: {
      isActive() {
        events.push(["origin.read", active]);
        return active;
      },
    },
    draftCommands,
    sendPending: {
      get current() {
        events.push(["send.read", locked]);
        return locked;
      },
    },
    navigation: {
      navigationGeneration: {
        get current() {
          events.push(["generation.read", generation]);
          return generation;
        },
      },
      isCurrent(expected) {
        events.push(["generation.check", expected, generation]);
        return hostActive && expected === generation;
      },
      setWebsiteIntent(value) {
        events.push(["website", value]);
      },
      prefer(change) {
        events.push(["prefer", change]);
        generation++;
      },
      continueNavigation(change, intent, destination) {
        events.push([
          "continue",
          change,
          intent,
          current ? destination(current) : false,
        ]);
      },
    },
    host: {
      captureCommit() {
        events.push(["host.capture", incarnation]);
        const captured = incarnation;
        return () => {
          events.push(["lifetime.check", captured, incarnation, hostActive]);
          return hostActive && captured === incarnation;
        };
      },
      currentProjection() {
        events.push(["host.read"]);
        return current &&
          current.centerId === "center-A" &&
          current.principalId === "human-A" &&
          current.csrfToken === "session-A"
          ? current
          : null;
      },
    },
    privateUi: {
      setContentScope(value) {
        events.push(["contentScope", value]);
      },
      setCreating(value) {
        events.push(["creating", value]);
      },
      setExecutions(value) {
        events.push(["executions", value]);
      },
    },
    exchange: {
      keepExchangeOpen() {
        events.push(["keepOpen"]);
      },
      requestConversationFocus(id, value) {
        events.push(["focus", id, value]);
      },
    },
    onNotice(message) {
      events.push(["notice", message]);
    },
  };
  const commands = factories[mode](ports);
  return {
    commands,
    events,
    ports,
    state,
    published,
    conversationRef,
    persisted,
    setActive(value: boolean) {
      active = value;
    },
    setCurrent(value: Projection | null) {
      current = value;
    },
    getCurrent: () => current!,
    retireHost() {
      hostActive = false;
      incarnation++;
    },
    bumpGeneration() {
      generation++;
    },
    setLocked(value: boolean) {
      locked = value;
    },
  };
}
const last = (f: ReturnType<typeof fixture>, kind: string) =>
  f.events.filter((e) => e[0] === kind).at(-1);

test("fixed fixture preserves actual Git c35 complete seven actions, two projections, initializer and both effects", () => {
  const path = "/fixed/fixture.ts",
    text = readFileSync(
      resolve("tests/fixtures/private-project-conversation-scope-c35b9fde.ts"),
      "utf8",
    );
  const api = new API({
    cwd: "/fixed",
    fs: createVirtualFileSystem({
      [path]: text,
      "/fixed/tsconfig.json": JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["fixture.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({
    openProjects: ["/fixed/tsconfig.json"],
  });
  try {
    const program = snapshot.getProject("/fixed/tsconfig.json")!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const nodes: Node[] = [];
    function visit(node: Node) {
      nodes.push(node);
      node.forEachChild(visit);
    }
    visit(program.getSourceFile(path)!);
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    for (const name of [
      "selectContentScope",
      "selectConversation",
      "createProjectConversation",
      "discardConversationDraft",
      "restoreConversationDraft",
      "openProject",
      "prepareCreatedProject",
    ] as const) {
      const matches = nodes
        .filter(isFunctionDeclaration)
        .filter((n) => n.name?.text === name);
      assert.equal(matches.length, 1);
      assert.equal(
        hash(matches[0]!.getText()),
        fixedProjectConversationHashes[name],
        name + ": complete original raw function",
      );
    }
    for (const [fn, key] of [
      ["fixedStartedProjectConversationIds", "startedConversations"],
      ["fixedProjectConversationDraftPresence", "hasConversationDraft"],
    ] as const) {
      const node = nodes
        .filter(isFunctionDeclaration)
        .find((n) => n.name?.text === fn)!;
      const statement = node.body!.statements.find(isReturnStatement)!;
      assert.equal(
        hash(statement.expression!.getText()),
        fixedProjectConversationHashes[key],
        key + ": exact original expression",
      );
    }
    const declaration = nodes
      .filter(isVariableDeclaration)
      .find((n) => n.name.getText() === "[contentScope, setContentScope]")!;
    assert.equal(
      hash(declaration.initializer!.getText()),
      fixedProjectConversationHashes.contentScope,
    );
    for (const [fn, key] of [
      ["useFixedCommittedConversationDraftRetirement", "retirement"],
      ["useFixedPrivateConversationHistorySelection", "history"],
    ] as const) {
      const node = nodes
        .filter(isFunctionDeclaration)
        .find((n) => n.name?.text === fn)!;
      const effect = node.body!.statements.filter(isExpressionStatement);
      assert.equal(effect.length, 1);
      assert.equal(
        hash(effect[0]!.getText()),
        fixedProjectConversationHashes[key],
        key + ": exact original effect and dependency array",
      );
    }
  } finally {
    snapshot.dispose();
    api.close();
  }
});

test("scope construction borrows ports without storage, authority, ref, generation or private UI reads", () => {
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode);
    assert.deepEqual(f.events, []);
    assert.deepEqual(Object.keys(f.commands), [
      "selectContentScope",
      "selectConversation",
      "createProjectConversation",
      "discardConversationDraft",
      "restoreConversationDraft",
      "openProject",
      "prepareCreatedProject",
    ]);
  }
});

test("content scope and same-project switching preserve exact private ordering, both ownership witnesses and post-prefer focus generation", () => {
  for (const options of [
    {},
    { navigationProject: "other" },
    { project: "search-cross-project" },
    { view: "desk" as const },
    { projectOpen: false },
  ]) {
    const traces = [];
    for (const mode of ["fixed", "production"] as const) {
      const f = fixture(mode, options);
      f.commands.selectContentScope("owner-B");
      assert.deepEqual(f.events, [
        ["origin.read", true],
        ["contentScope", "owner-B"],
        ["prefer", { artifactId: null, scriptLocation: null }],
      ]);
      f.events.length = 0;
      f.commands.selectConversation("first-project", "named-A", true);
      const change = last(f, "prefer")![1] as Record<string, unknown>;
      assert.equal("artifactId" in change, Object.keys(options).length !== 0);
      assert.deepEqual(change.interactions, { "named-A": "history" });
      assert.deepEqual(f.events.slice(-3), [
        ["keepOpen"],
        ["generation.read", 9],
        ["focus", "named-A", 9],
      ]);
      traces.push(f.events);
    }
    assert.deepEqual(traces[1], traces[0]);
  }
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode, { active: false });
    f.commands.selectContentScope("B");
    f.commands.selectConversation("B", "named-B", true);
    assert.deepEqual(f.events, [
      ["origin.read", false],
      ["origin.read", false],
    ]);
  }
});

test("default and named conversations retain their different interaction keys and explicit project clicks select the correct personal/team default", () => {
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode);
    f.commands.selectConversation("first-project", "personal-default");
    assert.deepEqual(
      (last(f, "prefer")![1] as { interactions: unknown }).interactions,
      { "first-project": "history" },
    );
    f.events.length = 0;
    f.commands.openProject("first-project");
    assert.deepEqual(f.events[0], ["personalSpace", "dialogue"]);
    assert.deepEqual(
      (last(f, "prefer")![1] as { selectedConversations: unknown })
        .selectedConversations,
      { "first-project": "personal-default" },
    );
    assert.equal(
      f.events.some((e) => e[0] === "focus"),
      false,
    );
    const team = fixture(mode, { sharedDefault: false });
    team.commands.openProject("first-project");
    assert.equal(
      team.events.some((e) => e[0] === "personalSpace"),
      false,
    );
    assert.deepEqual(
      (last(team, "prefer")![1] as { selectedConversations: unknown })
        .selectedConversations,
      { "first-project": "first-project" },
    );
  }
});

test("commands retain the original render's scalar/object bindings and restore predicate instead of rebinding to newer port fields", () => {
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode);
    Object.assign(f.ports.render, {
      prefs: {
        view: "desk",
        projectOpen: false,
        interactions: { "named-A": "recent" },
      },
      navigationProject: { id: "other-project" },
      project: { id: "other-project" },
      sharedDefault: false,
    });
    f.commands.selectConversation("first-project", "named-A");
    const change = last(f, "prefer")![1] as Record<string, unknown>;
    assert.equal("artifactId" in change, false);
    assert.deepEqual(change.interactions, { "named-A": "history" });
    f.commands.openProject("first-project");
    assert.deepEqual(
      (last(f, "prefer")![1] as { selectedConversations: unknown })
        .selectedConversations,
      { "first-project": "personal-default" },
    );
    const conflict = { ...saved, id: "other-named" };
    const restore = fixture(mode, {
      trash: {
        [saved.id]: { conversation: saved, drafts: { "named-A:object": body } },
      },
      conversations: { "first-project": conflict },
      inputs: { "other-named:object": body },
    });
    restore.ports.render.hasConversationDraft = () => false;
    restore.commands.restoreConversationDraft(saved.id);
    assert.deepEqual(restore.events, [
      ["notice", "请先发送或丢弃当前项目的新草稿，再恢复这份草稿。"],
    ]);
  }
});

test("actual draft owner reuses both stable IDs before rerender; create failure stays rejected and retired navigation does not invent a create guard", async (context) => {
  let uuid = 0;
  context.mock.method(
    crypto,
    "randomUUID",
    () =>
      `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as ReturnType<
        Crypto["randomUUID"]
      >,
  );
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode);
    await f.commands.createProjectConversation("first-project", "第一次标题");
    const pending = f.conversationRef.current["first-project"]!;
    await f.commands.createProjectConversation(
      "first-project",
      "不能覆盖原标题",
    );
    assert.strictEqual(f.conversationRef.current["first-project"], pending);
    assert.equal(pending.title, "第一次标题");
    assert.notEqual(pending.id, pending.inputId);
    assert.equal(f.events.filter((e) => e[0] === "storage.write").length, 1);
    assert.equal(f.events.filter((e) => e[0] === "focus").length, 2);
    const failed = fixture(mode, { failAt: 1 });
    await assert.rejects(
      failed.commands.createProjectConversation("first-project", "失败"),
      /controlled quota/,
    );
    assert.equal(failed.events.length, 1);
    assert.deepEqual(failed.conversationRef.current, {});
    const retired = fixture(mode, { active: false });
    await retired.commands.createProjectConversation(
      "first-project",
      "原局部行为",
    );
    assert.ok(retired.conversationRef.current["first-project"]);
    assert.equal(
      retired.events.some((e) => e[0] === "prefer"),
      false,
    );
  }
});

test("send lock only guards discard; real discard preserves original partial-write failure and routes active conversation back to default", () => {
  for (const mode of ["fixed", "production"] as const) {
    const locked = fixture(mode, {
      conversations: { "first-project": saved },
      sendPending: true,
    });
    locked.commands.discardConversationDraft(saved.id);
    assert.deepEqual(locked.events, [
      ["send.read", true],
      ["notice", "消息正在提交，请等待结果后整理草稿。"],
    ]);
    for (const failAt of [1, 2, 3]) {
      const f = fixture(mode, {
        conversations: { "first-project": saved },
        inputs: { "named-A:object": body, "other:object": empty },
        failAt,
      });
      f.commands.discardConversationDraft(saved.id);
      assert.equal(
        f.events.filter((e) => e[0] === "storage.write").length,
        failAt,
      );
      assert.deepEqual(f.published.inputs, {
        "named-A:object": body,
        "other:object": empty,
      });
      assert.equal(f.published.conversations["first-project"], saved);
      assert.equal(
        f.events.some((e) => e[0] === "prefer"),
        false,
      );
      assert.deepEqual(last(f, "notice"), [
        "notice",
        "草稿整理未完成，原文仍保留，请重试。",
      ]);
      assert.deepEqual(
        f.persisted.get(draftKey("discarded-conversations")),
        failAt === 1
          ? {}
          : {
              [saved.id]: {
                conversation: saved,
                drafts: { "named-A:object": body },
              },
            },
      );
      assert.deepEqual(
        f.persisted.get(draftKey("inputs")),
        failAt === 3
          ? { "other:object": empty }
          : { "named-A:object": body, "other:object": empty },
      );
    }
    const f = fixture(mode, {
      conversations: { "first-project": saved },
      inputs: { "named-A:object": body },
    });
    f.commands.discardConversationDraft(saved.id);
    assert.deepEqual(f.published.inputs, {});
    assert.deepEqual(f.conversationRef.current, {});
    assert.deepEqual(f.published.trash[saved.id]!.conversation, saved);
    assert.deepEqual(
      (last(f, "prefer")![1] as { selectedConversations: unknown })
        .selectedConversations,
      { "first-project": "personal-default" },
    );
  }
});

test("restore retains captured draft conflicts, write/publication order, saved IDs and original absence of send lock", () => {
  for (const mode of ["fixed", "production"] as const) {
    const trash: Trash = {
      [saved.id]: { conversation: saved, drafts: { "named-A:object": body } },
    };
    const conflict = { ...saved, id: "other-named", inputId: "other-first" };
    const blocked = fixture(mode, {
      trash,
      conversations: { "first-project": conflict },
      inputs: { "other-named:object": body },
    });
    blocked.commands.restoreConversationDraft(saved.id);
    assert.deepEqual(blocked.events, [
      ["notice", "请先发送或丢弃当前项目的新草稿，再恢复这份草稿。"],
    ]);
    for (const failAt of [1, 2, 3]) {
      const failed = fixture(mode, { trash, failAt });
      failed.commands.restoreConversationDraft(saved.id);
      assert.equal(
        failed.events.filter((e) => e[0] === "storage.write").length,
        failAt,
      );
      assert.deepEqual(failed.published.trash, trash);
      assert.deepEqual(failed.published.inputs, {});
      assert.deepEqual(last(failed, "notice"), [
        "notice",
        "草稿恢复失败，保存的原文仍在，请重试。",
      ]);
      assert.equal(
        failed.events.some((e) => e[0] === "focus"),
        false,
      );
    }
    const f = fixture(mode, { trash, sendPending: true });
    f.commands.restoreConversationDraft(saved.id);
    assert.equal(
      f.events.some((e) => e[0] === "send.read"),
      false,
    );
    assert.deepEqual(
      f.events.slice(0, 7).map((e) => e[0]),
      [
        "storage.write",
        "storage.write",
        "storage.write",
        "inputs.set",
        "conversations.set",
        "trash.set",
        "origin.read",
      ],
    );
    assert.strictEqual(f.conversationRef.current["first-project"], saved);
    assert.deepEqual(f.published.inputs, { "named-A:object": body });
    assert.deepEqual(last(f, "focus"), ["focus", saved.id, 8]);
  }
});

test("discard falls back to the captured authoritative conversation, only the active conversation navigates, and missing IDs keep their original no-op behavior", () => {
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode, { inputs: { "named-A:object": body } });
    const persisted = {
      id: saved.id,
      projectId: "first-project",
      title: "已开始的会话",
      revision: 3,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    f.state.conversations = [persisted];
    f.commands.discardConversationDraft(saved.id);
    assert.equal(
      f.published.trash[saved.id]!.conversation.title,
      "已开始的会话",
    );
    assert.match(
      f.published.trash[saved.id]!.conversation.inputId,
      /^[\da-f-]{36}$/,
    );
    assert.deepEqual(
      (last(f, "prefer")![1] as { selectedConversations: unknown })
        .selectedConversations,
      { "first-project": "personal-default" },
    );
    const inactive = fixture(mode, {
      conversationId: "other-named",
      inputs: { "named-A:object": body },
    });
    inactive.state.conversations = [persisted];
    inactive.commands.discardConversationDraft(saved.id);
    assert.ok(inactive.published.trash[saved.id]);
    assert.equal(last(inactive, "prefer"), undefined);
    const missing = fixture(mode);
    missing.commands.discardConversationDraft("missing");
    missing.commands.restoreConversationDraft("missing");
    assert.deepEqual(missing.events, [["send.read", false]]);
  }
});

test("two factual projections preserve local-saved versus persisted identity, optional-state undefined and lazy captured client/draft reads", () => {
  const current = projection(),
    state = current.workspace;
  state.conversations = [
    {
      id: "named-existing",
      projectId: "first-project",
    } as Workspace["conversations"][number],
    {
      id: "first-project",
      projectId: "first-project",
    } as Workspace["conversations"][number],
  ];
  const input = (id: string, conversationId: string) =>
    ({
      id,
      projectId: "first-project",
      conversationId,
    }) as Workspace["inputs"][number];
  state.inputs = [
    input("saved-input", "reserved-id"),
    input("persisted-input", "started-input"),
  ];
  current.localSavedInputIds = ["saved-input"];
  current.runtime.messages = [
    {
      projectId: "first-project",
      conversationId: "runtime-only",
    } as Projection["runtime"]["messages"][number],
  ];
  for (const [started, presence] of [
    [fixedStartedProjectConversationIds, fixedProjectConversationDraftPresence],
    [startedProjectConversationIds, projectConversationDraftPresence],
  ] as const) {
    const reads: string[] = [],
      client = {
        get boot() {
          reads.push("boot");
          return current;
        },
      },
      drafts: Inputs = {
        "whitespace:object": { ...empty, body: " \n " },
        "selection:object": { ...empty, selection: " " },
        "attachment:object": {
          ...empty,
          attachments: [
            { assetId: "asset" } as NonNullable<
              InputDraft["attachments"]
            >[number],
          ],
        },
        "intent:object": { ...empty, intent: "document" },
      };
    const has = presence({ state, client, drafts });
    assert.deepEqual(reads, []);
    assert.equal(has("reserved-id"), true);
    assert.equal(has("started-input"), false);
    assert.equal(has("whitespace"), false);
    assert.equal(has("selection"), true);
    assert.equal(has("attachment"), true);
    assert.equal(has("intent"), true);
    assert.deepEqual(
      [...started({ state, client })],
      ["named-existing", "started-input", "runtime-only"],
    );
    current.localSavedInputIds = [];
    assert.equal(has("reserved-id"), false);
    current.localSavedInputIds = ["saved-input"];
    assert.equal(
      presence({ state: undefined, client: { boot: null }, drafts: {} })(
        "missing",
      ),
      false,
    );
  }
});

test("created-project completion captures preparation activity but uses latest authorized Host and personal/team routes, without transferring private UI", () => {
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode),
      complete = f.commands.prepareCreatedProject();
    assert.deepEqual(f.events, [
      ["generation.read", 7],
      ["host.capture", 1],
      ["origin.read", true],
    ]);
    f.events.length = 0;
    f.setActive(false);
    const latest = projection();
    latest.workspace.projects.find((p) => p.id === "personal-default")!.id =
      "latest-personal-default";
    f.setCurrent(latest);
    complete("created-project", "project");
    const change = last(f, "continue")![1] as {
      selectedConversations: unknown;
      interactions: unknown;
    };
    assert.deepEqual(change.selectedConversations, {
      "created-project": "latest-personal-default",
    });
    assert.deepEqual(change.interactions, { "created-project": "history" });
    assert.equal(
      f.events.some((e) =>
        [
          "focus",
          "creating",
          "executions",
          "contentScope",
          "notice",
          "origin.read",
        ].includes(String(e[0])),
      ),
      false,
    );
    const team = fixture(mode),
      teamComplete = team.commands.prepareCreatedProject();
    team.getCurrent().capabilities.teamAuthentication = true;
    teamComplete("created-project", "project");
    assert.deepEqual(
      (last(team, "continue")![1] as { selectedConversations: unknown })
        .selectedConversations,
      { "created-project": "created-project" },
    );
    const nullThenRestore = fixture(mode),
      restoreComplete = nullThenRestore.commands.prepareCreatedProject();
    nullThenRestore.setActive(false);
    nullThenRestore.setCurrent(null);
    restoreComplete("created-project", "project");
    assert.equal(last(nullThenRestore, "continue"), undefined);
    nullThenRestore.setCurrent(projection());
    restoreComplete("created-project", "project");
    assert.ok(last(nullThenRestore, "continue"));
  }
});

test("created-project completions reject inactive preparation, wrong kind, null/current identity loss, revoked/deleted/non-project destination, newer navigation and retired Host", () => {
  for (const mode of ["fixed", "production"] as const) {
    for (const scenario of [
      "inactive",
      "kind",
      "null",
      "identity",
      "session",
      "revoked",
      "deleted",
      "desk",
      "generation",
      "host",
    ] as const) {
      const f = fixture(mode, { active: scenario !== "inactive" }),
        complete = f.commands.prepareCreatedProject();
      if (scenario === "null") f.setCurrent(null);
      if (scenario === "identity") f.getCurrent().principalId = "human-B";
      if (scenario === "session") f.getCurrent().csrfToken = "rotated";
      if (scenario === "revoked")
        f.getCurrent().workspace.projects = f
          .getCurrent()
          .workspace.projects.filter((p) => p.id !== "created-project");
      if (scenario === "deleted")
        f
          .getCurrent()
          .workspace.projects.find(
            (p) => p.id === "created-project",
          )!.deletedAt = now;
      if (scenario === "desk")
        f
          .getCurrent()
          .workspace.projects.find((p) => p.id === "created-project")!.kind =
          "desk";
      if (scenario === "generation") f.bumpGeneration();
      if (scenario === "host") f.retireHost();
      complete("created-project", scenario === "kind" ? "document" : "project");
      assert.equal(last(f, "continue"), undefined, mode + ":" + scenario);
    }
  }
});
