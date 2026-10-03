import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveWorkSurface,
  readWorkSurfaceDraft,
  workSurfaceConversationId,
  type WorkSurfaceInput,
  type WorkSurfacePreferences,
} from "../apps/web/src/host/work-surface.js";
import { initialWorkspace, type Artifact } from "../packages/core/src/model.js";
import {
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
  type ApplicationInstance,
} from "../packages/core/src/applications.js";
import type { TextQuote } from "../packages/core/src/text-quotes.js";

const now = "2026-10-03T00:00:00.000Z";
const principalId = "local-owner";
const deskId = "local-worktable";
const dialogueId = "local-dialogue";
const inboxId = "local-inbox";
const projectId = "first-project";
const otherProjectId = "second-project";
const namedId = "named-conversation";
const reservedId = "reserved-conversation";
type ConversationDraft = {
  id: string;
  projectId: string;
  title: string;
  inputId: string;
};
type ScriptEntry = {
  id: string;
  projectId: string;
  title: string;
  catalogRevision: number;
};
type Input = WorkSurfaceInput<ConversationDraft, ScriptEntry>;

function preferences(
  change: Partial<WorkSurfacePreferences> = {},
): WorkSurfacePreferences {
  return {
    view: "projects",
    projectId,
    projectOpen: true,
    artifactId: null,
    ...change,
  };
}
function fixture(change: Partial<Input> = {}): Input {
  const state = initialWorkspace(now);
  state.projects.push({
    id: otherProjectId,
    title: "另一个项目",
    members: [principalId, "morphz-service"],
    createdAt: now,
    kind: "project",
  });
  state.conversations.push(
    {
      id: otherProjectId,
      projectId: otherProjectId,
      title: "另一个项目",
      revision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: namedId,
      projectId,
      title: "独立会话",
      revision: 7,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  );
  return {
    state,
    prefs: preferences(),
    principalId,
    teamAuthentication: false,
    scriptLibrary: [],
    contentScope: "all",
    conversationDrafts: {
      [projectId]: {
        id: reservedId,
        projectId,
        title: "未首发的会话",
        inputId: "stable-first-input",
      },
    },
    restoredPlace: null,
    ...change,
  };
}
function object(id: string, owner = projectId, revision = 9): Artifact {
  const content = { kind: "document" as const, markdown: `正文 ${id}` };
  return {
    id,
    projectId: owner,
    title: id,
    content,
    revision,
    createdBy: { principalId, actantId: "local-human" },
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        revision,
        title: id,
        content,
        author: { principalId, actantId: "local-human" },
        createdAt: now,
      },
    ],
    source: null,
  };
}
function instance(
  id: string,
  owner = projectId,
  application = objectsApplication,
  change: Partial<ApplicationInstance> = {},
): ApplicationInstance {
  return {
    id,
    workspaceId: owner,
    applicationId: application.id,
    applicationVersion: application.version,
    revision: 4,
    state: {},
    status: "open",
    createdAt: now,
    updatedAt: now,
    ...change,
  };
}
function identity(surface: ReturnType<typeof deriveWorkSurface>) {
  return {
    navigation: surface.navigationProject?.id,
    owner: surface.project?.id,
    conversation: surface.conversationId,
    conversationOwner: surface.conversationProjectId,
    context: surface.contextKey,
    exchange: surface.exchangeKey,
    legacy: surface.legacyContextKey,
    quotes: surface.quoteKey,
    directory: surface.directoryScope,
    applications: surface.applicationWorkspaceOpen,
    dialogue: surface.dialogueCanvas,
  };
}

// These literal keys record the pre-extraction routes. They deliberately keep
// the content suffix and the different owner/conversation namespaces visible.
const routes = [
  ["dialogue", true, "all", dialogueId, deskId, false, true],
  ["inbox", true, "all", inboxId, deskId, false, false],
  ["desk", true, "all", deskId, deskId, true, false],
  ["projects", false, "all", deskId, deskId, false, false],
  ["projects", true, "all", projectId, projectId, true, false],
  ["content", true, "all", deskId, deskId, false, false],
  ["content", true, deskId, deskId, deskId, false, false],
  [
    "content",
    true,
    otherProjectId,
    otherProjectId,
    otherProjectId,
    false,
    false,
  ],
  ["content", true, "missing-scope", deskId, deskId, false, false],
] as const;
for (const teamAuthentication of [false, true]) {
  for (const [
    view,
    projectOpen,
    contentScope,
    navigation,
    owner,
    applications,
    dialogue,
  ] of routes) {
    test(`${teamAuthentication ? "团队" : "个人"}工作面原路由：${view}/${projectOpen}/${contentScope}`, () => {
      const input = fixture({
        teamAuthentication,
        contentScope,
        prefs: preferences({
          view,
          projectOpen,
          selectedConversations: { [projectId]: namedId },
        }),
      });
      // Named selections apply only to an explicitly open project.
      const named = view === "projects" && projectOpen;
      const conversation = named
        ? namedId
        : teamAuthentication
          ? navigation
          : dialogueId;
      const conversationOwner = named
        ? projectId
        : teamAuthentication
          ? navigation
          : dialogueId;
      const exchange = named
        ? namedId
        : view === "content"
          ? `${navigation}:content`
          : navigation;
      assert.deepEqual(identity(deriveWorkSurface(input)), {
        navigation,
        owner,
        conversation,
        conversationOwner,
        context: `${conversation}:${navigation}:${view}`,
        exchange,
        legacy: `${navigation}:${view}`,
        quotes: `${conversation}:quotes`,
        directory: `${owner}:${conversation}`,
        applications,
        dialogue,
      });
    });
  }
}

test("项目默认入口忽略个人 legacy 默认选择，团队仍使用原项目会话", () => {
  for (const teamAuthentication of [false, true]) {
    const input = fixture({
      teamAuthentication,
      prefs: preferences({ selectedConversations: { [projectId]: projectId } }),
    });
    const surface = deriveWorkSurface(input);
    assert.equal(
      surface.conversationId,
      teamAuthentication ? projectId : dialogueId,
    );
    assert.equal(surface.exchangeKey, projectId);
    assert.equal(surface.selectedDraft, undefined);
    assert.strictEqual(
      surface.selectedConversation,
      input.state!.conversations.find((c) => c.id === surface.conversationId),
    );
  }
});

test("命名会话及首发本机草稿保持各自身份、owner与稳定inputId", () => {
  const input = fixture({
    prefs: preferences({ selectedConversations: { [projectId]: reservedId } }),
  });
  const surface = deriveWorkSurface(input);
  assert.strictEqual(
    surface.selectedDraft,
    input.conversationDrafts[projectId],
  );
  assert.equal(surface.selectedDraft!.inputId, "stable-first-input");
  assert.equal(surface.conversationId, reservedId);
  assert.equal(surface.conversationProjectId, projectId);
  assert.equal(
    surface.contextKey,
    "reserved-conversation:first-project:projects",
  );
  assert.equal(surface.exchangeKey, reservedId);
  assert.equal(surface.directoryScope, "first-project:reserved-conversation");
  // The last persisted authorized history remains available during preparation.
  assert.equal(surface.selectedConversation?.id, dialogueId);

  const mismatch = deriveWorkSurface({
    ...input,
    prefs: preferences({
      selectedConversations: { [projectId]: "missing-conversation" },
    }),
  });
  assert.equal(mismatch.selectedDraft, undefined);
  assert.equal(mismatch.conversationId, dialogueId);
  const foreign = input.state!.conversations.find((c) => c.id === namedId)!;
  foreign.projectId = otherProjectId;
  assert.equal(
    deriveWorkSurface({
      ...input,
      prefs: preferences({ selectedConversations: { [projectId]: namedId } }),
    }).conversationId,
    dialogueId,
  );
});

test("归档会话保持原身份；归档／删除项目关闭应用选择但不改所属与键", () => {
  const input = fixture({
    prefs: preferences({ selectedConversations: { [projectId]: namedId } }),
  });
  input.state!.conversations.find((c) => c.id === namedId)!.archivedAt = now;
  const app = instance("old-application");
  input.state!.applicationInstances.push(app);
  const archivedConversation = deriveWorkSurface(input);
  assert.equal(archivedConversation.selectedConversation?.archivedAt, now);
  assert.equal(archivedConversation.conversationId, namedId);
  for (const field of ["archivedAt", "deletedAt"] as const) {
    const owner = input.state!.projects.find((p) => p.id === projectId)!;
    owner[field] = now;
    const surface = deriveWorkSurface(input);
    assert.strictEqual(surface.project, owner);
    assert.equal(surface.applicationWorkspaceOpen, false);
    assert.equal(surface.activeId, null);
    assert.equal(surface.activeInstance, undefined);
    assert.equal(
      surface.contextKey,
      "named-conversation:first-project:projects",
    );
    assert.equal(surface.exchangeKey, namedId);
    owner[field] = null;
  }
});

test("内容对象／交付剧本的原owner优先，导航与共享会话不被搬移", () => {
  const input = fixture({
    prefs: preferences({ view: "content", artifactId: "other-object" }),
  });
  const artifact = object("other-object", otherProjectId, 17);
  input.state!.artifacts.push(artifact);
  const surface = deriveWorkSurface(input);
  assert.equal(surface.navigationProject?.id, deskId);
  assert.equal(surface.project?.id, otherProjectId);
  assert.strictEqual(surface.artifact, artifact);
  assert.equal(surface.artifact!.revision, 17);
  assert.equal(surface.contextKey, "local-dialogue:other-object");
  assert.equal(surface.exchangeKey, "local-worktable:content");
  assert.equal(surface.directoryScope, "second-project:local-dialogue");

  const script: ScriptEntry = {
    id: "delivered-script",
    projectId,
    title: "原交付",
    catalogRevision: 23,
  };
  const delivered = deriveWorkSurface({
    ...input,
    scriptLibrary: [script],
    prefs: { ...input.prefs, scriptLocation: { productionId: script.id } },
  });
  assert.strictEqual(delivered.deliveredScript?.production, script);
  assert.equal(delivered.deliveredScript!.production.catalogRevision, 23);
  assert.equal(delivered.project?.id, projectId);
  assert.equal(delivered.artifact, undefined);
  assert.equal(delivered.applicationWorkspaceOpen, true);
  const missing = deriveWorkSurface({
    ...input,
    scriptLibrary: [script],
    prefs: {
      ...input.prefs,
      scriptLocation: { productionId: "missing-script" },
    },
  });
  assert.equal(missing.deliveredScript, null);
  assert.strictEqual(missing.artifact, artifact);
  assert.equal(missing.project?.id, otherProjectId);
});

test("应用显式null、失效／关闭／跨项目选择和首个open回退保持原顺序", () => {
  const input = fixture();
  const closed = instance("closed", projectId, objectsApplication, {
    status: "closed",
  });
  const first = instance("first-open");
  const second = instance("second-open");
  const foreign = instance("foreign-open", otherProjectId);
  input.state!.applicationInstances.push(closed, first, foreign, second);
  for (const [choice, expected] of [
    [undefined, first],
    ["missing", first],
    [closed.id, first],
    [foreign.id, first],
    [second.id, second],
    [null, undefined],
  ] as const) {
    const surface = deriveWorkSurface({
      ...input,
      prefs: preferences({
        applications:
          choice === undefined ? undefined : { [projectId]: choice },
      }),
    });
    assert.strictEqual(surface.activeInstance, expected);
    assert.equal(surface.activeId, expected?.id ?? null);
    assert.equal(
      surface.contextKey,
      expected
        ? `local-dialogue:${expected.id}`
        : "local-dialogue:first-project:projects",
    );
    assert.equal(surface.exchangeKey, projectId);
  }
});

test("Reader对象胜过还原／偏好，objects保持还原／偏好／本实例的精确优先级", () => {
  const input = fixture();
  const fromReader = object("reader-object");
  const fromRestore = object("restored-object");
  const fromPreference = object("preference-object");
  const fromInstance = object("instance-object");
  input.state!.artifacts.push(
    fromReader,
    fromRestore,
    fromPreference,
    fromInstance,
    object("foreign-object", otherProjectId),
  );
  const reader = instance("reader", projectId, readerApplication, {
    state: { artifactId: fromReader.id },
  });
  const objects = instance("objects", projectId, objectsApplication, {
    state: { artifactId: fromInstance.id },
  });
  input.state!.applicationInstances.push(reader, objects);
  const cases = [
    [reader.id, fromPreference.id, { artifactId: fromRestore.id }, fromReader],
    [
      objects.id,
      fromPreference.id,
      { artifactId: fromRestore.id },
      fromRestore,
    ],
    [objects.id, fromPreference.id, null, fromPreference],
    [objects.id, null, null, fromInstance],
    [objects.id, "missing-object", null, undefined],
    [objects.id, fromPreference.id, { artifactId: null }, undefined],
  ] as const;
  for (const [applicationId, artifactId, restoredPlace, expected] of cases) {
    const surface = deriveWorkSurface({
      ...input,
      restoredPlace,
      prefs: preferences({
        artifactId,
        applications: { [projectId]: applicationId },
      }),
    });
    assert.strictEqual(surface.artifact, expected);
    assert.equal(
      surface.contextKey,
      `local-dialogue:${expected?.id ?? applicationId}`,
    );
    assert.equal(
      surface.legacyContextKey,
      `first-project:${expected?.id ?? applicationId}`,
    );
  }
  reader.state.artifactId = "foreign-object";
  assert.equal(
    deriveWorkSurface({
      ...input,
      prefs: preferences({ applications: { [projectId]: reader.id } }),
    }).artifact,
    undefined,
  );
  const inbox = deriveWorkSurface({
    ...input,
    prefs: preferences({ view: "inbox" }),
  });
  assert.equal(inbox.activeInstance, undefined);
  assert.equal(inbox.artifact, undefined);
});

test("剧本应用不夹带对象；自定义应用按打开实例的原确切版本决定沉浸", () => {
  const input = fixture({ prefs: preferences({ artifactId: "object" }) });
  input.state!.artifacts.push(object("object"));
  const script = instance(
    "script-instance",
    projectId,
    scriptStudioApplication,
    { state: { artifactId: "object" } },
  );
  input.state!.applicationInstances.push(script);
  const surface = deriveWorkSurface(input);
  assert.equal(surface.artifact, undefined);
  assert.strictEqual(surface.activeInstance, script);
  assert.equal(surface.contextKey, "local-dialogue:script-instance");

  const app = {
    ...objectsApplication,
    id: "fixture.editor",
    installedBy: principalId,
  };
  input.state!.applications.push(
    { ...app, version: "1.0.0", ui: { ...app.ui, presentation: "workspace" } },
    { ...app, version: "2.0.0", ui: { ...app.ui, presentation: "immersive" } },
  );
  const custom = instance("custom-instance", projectId, app, {
    applicationVersion: "2.0.0",
  });
  input.state!.applicationInstances.push(custom);
  const immersive = deriveWorkSurface({
    ...input,
    prefs: preferences({ applications: { [projectId]: custom.id } }),
  });
  assert.strictEqual(immersive.activeInstance, custom);
  assert.equal(immersive.activeInstance!.applicationVersion, "2.0.0");
  assert.equal(immersive.immersiveApplication, true);
  custom.applicationVersion = "1.0.0";
  assert.equal(
    deriveWorkSurface({
      ...input,
      prefs: preferences({ applications: { [projectId]: custom.id } }),
    }).immersiveApplication,
    false,
  );
  custom.applicationVersion = "uninstalled-version";
  assert.throws(
    () =>
      deriveWorkSurface({
        ...input,
        prefs: preferences({ applications: { [projectId]: custom.id } }),
      }),
    /应用版本未安装或不可用/,
  );
});

test("缺失项目／会话／个人范围及空ID维持原nullish回退和精确键bytes", () => {
  const input = fixture({
    prefs: preferences({ projectId: "missing-project" }),
  });
  assert.equal(deriveWorkSurface(input).project?.id, projectId);
  input.state!.projects = input.state!.projects.filter(
    (p) => p.id !== projectId && p.id !== otherProjectId,
  );
  assert.equal(deriveWorkSurface(input).project?.id, deskId);
  input.state!.conversations = [];
  const noConversation = deriveWorkSurface(input);
  assert.equal(noConversation.defaultConversation, dialogueId);
  assert.equal(noConversation.conversationId, deskId);
  assert.equal(noConversation.exchangeKey, deskId);
  input.state!.projects = [];
  assert.deepEqual(identity(deriveWorkSurface(input)), {
    navigation: undefined,
    owner: undefined,
    conversation: "",
    conversationOwner: "",
    context: "::projects",
    exchange: "",
    legacy: ":projects",
    quotes: ":quotes",
    directory: "undefined:",
    applications: false,
    dialogue: false,
  });
  assert.deepEqual(
    identity(deriveWorkSurface({ ...input, state: undefined })),
    identity(deriveWorkSurface(input)),
  );
  const emptyId = fixture({
    conversationDrafts: {
      [projectId]: {
        id: "",
        projectId,
        title: "原空ID",
        inputId: "stable-input",
      },
    },
    prefs: preferences({ selectedConversations: { [projectId]: "" } }),
  });
  assert.equal(
    deriveWorkSurface(emptyId).contextKey,
    ":first-project:projects",
  );
  assert.equal(deriveWorkSurface(emptyId).conversationId, "");
});

test("个人范围按本人owner选择，默认／legacy项目种类和目录的fallback不改", () => {
  const input = fixture({ prefs: preferences({ view: "dialogue" }) });
  const foreign = {
    ...input.state!.projects.find((p) => p.id === dialogueId)!,
    id: "foreign-dialogue",
    ownerPrincipalId: "another-human",
  };
  input.state!.projects.unshift(foreign);
  assert.equal(deriveWorkSurface(input).navigationProject?.id, dialogueId);
  input.state!.projects = input.state!.projects.filter(
    (p) => p.id !== dialogueId,
  );
  const missingPersonal = deriveWorkSurface(input);
  assert.equal(missingPersonal.navigationProject, undefined);
  assert.equal(missingPersonal.defaultConversation, undefined);
  assert.equal(missingPersonal.conversationId, "");
  assert.equal(missingPersonal.dialogueCanvas, true);
  // The first project in initialWorkspace intentionally omits kind.
  assert.equal(
    deriveWorkSurface({ ...input, prefs: preferences() }).project?.id,
    projectId,
  );
});

type Draft = {
  body: string;
  revision: number | null;
  textQuotes?: TextQuote[];
  model?: string;
  reasoningEffort?: "max" | "low";
  attachments?: { id: string }[];
  continuation?: { inputId: string };
};
const emptyDraft: Draft = { body: "", revision: null };
const quote: TextQuote = {
  id: "quote",
  text: "原选文",
  comment: "未发评论",
  source: {
    kind: "surface",
    projectId,
    applicationInstanceId: "application",
    title: "原画布",
  },
};

test("旧草稿只在默认会话回读；新key优先；所有正文／绑定／附件／模型／版本保持", () => {
  const defaultSurface = deriveWorkSurface(fixture());
  const legacy: Draft = {
    body: "原旧稿",
    revision: 3,
    model: "old-route",
    reasoningEffort: "max",
    attachments: [{ id: "original-attachment" }],
    continuation: { inputId: "original-input" },
    textQuotes: [quote],
  };
  const drafts: Record<string, Draft> = {
    [defaultSurface.legacyContextKey]: legacy,
  };
  const restored = readWorkSurfaceDraft(defaultSurface, drafts, emptyDraft);
  assert.strictEqual(restored.surfaceDraft, legacy);
  assert.deepEqual(restored.draft, { ...legacy, textQuotes: [] });
  assert.strictEqual(restored.draft.attachments, legacy.attachments);
  assert.strictEqual(restored.draft.continuation, legacy.continuation);
  const named = deriveWorkSurface(
    fixture({
      prefs: preferences({ selectedConversations: { [projectId]: namedId } }),
    }),
  );
  assert.strictEqual(
    readWorkSurfaceDraft(named, drafts, emptyDraft).surfaceDraft,
    emptyDraft,
  );
  const pending = deriveWorkSurface(
    fixture({
      prefs: preferences({
        selectedConversations: { [projectId]: reservedId },
      }),
    }),
  );
  assert.strictEqual(
    readWorkSurfaceDraft(pending, drafts, emptyDraft).surfaceDraft,
    emptyDraft,
  );
  const latest: Draft = {
    body: "下一条未发送稿",
    revision: 11,
    reasoningEffort: "low",
  };
  drafts[defaultSurface.contextKey] = latest;
  assert.strictEqual(
    readWorkSurfaceDraft(defaultSurface, drafts, emptyDraft).surfaceDraft,
    latest,
  );
  assert.deepEqual(drafts[defaultSurface.legacyContextKey], legacy);
});

test("换对象共享同会话选文但不搬正文；捕获原surface后换会话不改原草稿或输入范围", () => {
  const input = fixture({ prefs: preferences({ artifactId: "object-a" }) });
  input.state!.artifacts.push(
    object("object-a", projectId, 5),
    object("object-b", projectId, 8),
  );
  const captured = deriveWorkSurface(input);
  const otherObject = deriveWorkSurface({
    ...input,
    prefs: preferences({ artifactId: "object-b" }),
  });
  assert.equal(captured.contextKey, "local-dialogue:object-a");
  assert.equal(otherObject.contextKey, "local-dialogue:object-b");
  assert.equal(captured.quoteKey, otherObject.quoteKey);
  assert.equal(captured.exchangeKey, otherObject.exchangeKey);
  const original: Draft = {
    body: "A正文",
    revision: 2,
    attachments: [{ id: "a" }],
  };
  const other: Draft = { body: "B正文", revision: 7, model: "b-route" };
  const drafts = {
    [captured.contextKey]: original,
    [otherObject.contextKey]: other,
    [captured.quoteKey]: { ...emptyDraft, textQuotes: [quote] },
  };
  assert.deepEqual(readWorkSurfaceDraft(captured, drafts, emptyDraft).draft, {
    ...original,
    textQuotes: [quote],
  });
  assert.deepEqual(
    readWorkSurfaceDraft(otherObject, drafts, emptyDraft).draft,
    { ...other, textQuotes: [quote] },
  );
  const later = deriveWorkSurface({
    ...input,
    prefs: preferences({
      artifactId: "object-b",
      selectedConversations: { [projectId]: namedId },
    }),
  });
  assert.equal(later.contextKey, "named-conversation:object-b");
  assert.deepEqual(readWorkSurfaceDraft(later, drafts, emptyDraft).draft, {
    ...emptyDraft,
    textQuotes: [],
  });
  assert.equal(
    workSurfaceConversationId(captured, { [projectId]: namedId }, projectId),
    dialogueId,
  );
  assert.equal(captured.artifact?.revision, 5);
  assert.equal(
    readWorkSurfaceDraft(captured, drafts, emptyDraft).draft.revision,
    2,
  );
  assert.strictEqual(drafts[captured.contextKey], original);
  assert.strictEqual(drafts[otherObject.contextKey], other);
});

test("另一工作空间的会话key遵守显式选择→默认→workspace顺序，空选择保持", () => {
  const surface = deriveWorkSurface(fixture());
  assert.equal(
    workSurfaceConversationId(surface, { [projectId]: namedId }, projectId),
    dialogueId,
  );
  assert.equal(
    workSurfaceConversationId(
      surface,
      { [otherProjectId]: namedId },
      otherProjectId,
    ),
    namedId,
  );
  assert.equal(
    workSurfaceConversationId(
      surface,
      { [otherProjectId]: "" },
      otherProjectId,
    ),
    "",
  );
  assert.equal(
    workSurfaceConversationId(surface, undefined, otherProjectId),
    dialogueId,
  );
  const unavailable = deriveWorkSurface(fixture({ state: undefined }));
  assert.equal(
    workSurfaceConversationId(unavailable, undefined, otherProjectId),
    otherProjectId,
  );
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
test("纯推导与草稿读取接受冻结输入，保留原owner／会话／对象／实例／草稿ref", () => {
  const input = fixture({
    prefs: preferences({
      artifactId: "original-object",
      selectedConversations: { [projectId]: reservedId },
    }),
  });
  const artifact = object("original-object");
  const app = instance("original-instance");
  input.state!.artifacts.push(artifact);
  input.state!.applicationInstances.push(app);
  deepFreeze(input);
  const surface = deriveWorkSurface(input);
  assert.strictEqual(surface.project, input.state!.projects[0]);
  assert.strictEqual(surface.artifact, artifact);
  assert.strictEqual(surface.activeInstance, app);
  assert.strictEqual(
    surface.selectedDraft,
    input.conversationDrafts[projectId],
  );
  const original: Draft = {
    body: "原稿",
    revision: 4,
    attachments: [{ id: "a" }],
  };
  const drafts = deepFreeze({
    [surface.contextKey]: original,
    [surface.quoteKey]: { ...emptyDraft, textQuotes: [quote] },
  });
  const result = readWorkSurfaceDraft(surface, drafts, deepFreeze(emptyDraft));
  assert.strictEqual(result.surfaceDraft, original);
  assert.strictEqual(result.draft.attachments, original.attachments);
  assert.strictEqual(
    result.draft.textQuotes,
    drafts[surface.quoteKey]!.textQuotes,
  );
});
