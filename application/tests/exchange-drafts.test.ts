import test from "node:test";
import assert from "node:assert/strict";
import {
  createExchangeDraftCommands,
  type ConversationDraft,
  type InputDraft,
} from "../apps/web/src/host/exchange-drafts.js";
import { draftKey } from "../apps/web/src/local-preferences.js";
import type { Discussion } from "../packages/core/src/model.js";

// Trace contract frozen from App at a5278c21. These tests use the production
// command factory, not React scheduling or an atomic localStorage simulation.
type Inputs = Record<string, InputDraft>;
type Conversations = Record<string, ConversationDraft>;
type Trash = Record<
  string,
  { conversation: ConversationDraft; drafts: Inputs }
>;
const conversation: ConversationDraft = {
  id: "named-a",
  projectId: "project-a",
  title: "原始草稿",
  inputId: "stable-first-input",
};
const other = { ...conversation, id: "named-b", projectId: "project-b" };
const surface = "named-a:document-v2";
const empty: InputDraft = { body: "", selection: "", revision: null };
const draft: InputDraft = {
  ...empty,
  body: "未发送的正文\n保留换行",
  revision: 2,
  selection: "原始引用",
  page: 4,
  model: "isolated-model",
  reasoningEffort: "max",
  continuationFailure: "unknown",
};
function fixture(
  options: {
    inputs?: Inputs;
    conversations?: Conversations;
    trash?: Trash;
    failAt?: number;
  } = {},
) {
  const rendered = {
    inputs: options.inputs ?? {},
    conversations: options.conversations ?? {},
    trash: options.trash ?? {},
  };
  const initial = structuredClone(rendered);
  const published = { ...rendered };
  const ref = { current: rendered.conversations };
  const events: string[] = [];
  const persisted = new Map<string, unknown>([
    [draftKey("inputs"), structuredClone(rendered.inputs)],
    [draftKey("conversations"), structuredClone(rendered.conversations)],
    [draftKey("discarded-conversations"), structuredClone(rendered.trash)],
  ]);
  const notices: string[] = [];
  let writes = 0;
  const commands = createExchangeDraftCommands({
    inputs: {
      value: rendered.inputs,
      set(action) {
        events.push("inputs.set");
        published.inputs =
          typeof action === "function" ? action(published.inputs) : action;
      },
    },
    conversations: {
      value: rendered.conversations,
      ref,
      set(action) {
        events.push("conversations.set");
        // The original create/reconcile ref is updated before publication;
        // discard/restore update it after publication, intentionally.
        events.push(`ref:${Object.keys(ref.current).join(",")}`);
        published.conversations =
          typeof action === "function"
            ? action(published.conversations)
            : action;
      },
    },
    discarded: {
      value: rendered.trash,
      set(action) {
        events.push("trash.set");
        published.trash =
          typeof action === "function" ? action(published.trash) : action;
      },
    },
    storage: {
      readLocal<T>(key: string, fallback: T): T {
        return (persisted.get(key) ?? fallback) as T;
      },
      writeLocal(key: string, value: unknown) {
        const name = key.split(":").at(-1)!;
        events.push(`write:${name}`);
        if (++writes === options.failAt) throw new Error("TEST storage quota");
        persisted.set(key, structuredClone(value));
      },
    },
    onNotice(message) {
      events.push("notice");
      notices.push(message);
    },
  });
  return {
    commands,
    rendered,
    initial,
    published,
    ref,
    events,
    persisted,
    notices,
  };
}
const trashForA: Trash = {
  [conversation.id]: { conversation, drafts: { [surface]: draft } },
};

test("functional input updates use the latest pending value; a failed write still publishes locally", () => {
  const f = fixture({ inputs: { [surface]: draft }, failAt: 1 });
  f.commands.writeInputs((previous) => ({
    ...previous,
    [surface]: { ...previous[surface]!, body: "第一段" },
  }));
  f.commands.writeInputs((previous) => ({
    ...previous,
    [surface]: {
      ...previous[surface]!,
      body: previous[surface]!.body + "\n第二段",
    },
  }));
  assert.deepEqual(f.events, [
    "inputs.set",
    "write:inputs",
    "notice",
    "inputs.set",
    "write:inputs",
  ]);
  assert.equal(f.published.inputs[surface]!.body, "第一段\n第二段");
  assert.equal(f.published.inputs[surface]!.reasoningEffort, "max");
  assert.deepEqual(f.persisted.get(draftKey("inputs")), f.published.inputs);
  assert.deepEqual(f.notices, ["本地草稿保存失败，请不要刷新页面。"]);
  assert.deepEqual(f.rendered, f.initial);
});

test("create persists before ref/state and reuses the original first-input ID before rerender", () => {
  const f = fixture();
  const first = f.commands.createConversation("project-a", "第一次标题");
  const repeated = f.commands.createConversation("project-a", "不能重命名它");
  assert.strictEqual(first, repeated);
  assert.equal(first.title, "第一次标题");
  assert.match(first.id, /^[\da-f-]{36}$/);
  assert.match(first.inputId, /^[\da-f-]{36}$/);
  assert.notEqual(first.id, first.inputId);
  assert.deepEqual(f.events, [
    "write:conversations",
    "conversations.set",
    "ref:project-a",
  ]);
  assert.strictEqual(f.ref.current["project-a"], first);
  assert.deepEqual(
    f.persisted.get(draftKey("conversations")),
    f.published.conversations,
  );
  assert.deepEqual(f.rendered, f.initial);
});

test("create storage failure throws without changing ref/state or adding a server operation", () => {
  const f = fixture({ failAt: 1 });
  assert.throws(
    () => f.commands.createConversation("project-a", "失败"),
    /TEST storage quota/,
  );
  assert.deepEqual(f.events, ["write:conversations"]);
  assert.deepEqual(f.ref.current, {});
  assert.deepEqual(f.published, f.initial);
  assert.deepEqual(f.notices, []);
});

test("only actual persisted conversation identity retires a draft; unchanged observation is a no-op", () => {
  const f = fixture({
    conversations: { "project-a": conversation, "project-b": other },
  });
  f.commands.retireCommittedConversations(undefined);
  f.commands.retireCommittedConversations([{ id: "unrelated" } as Discussion]);
  assert.deepEqual(f.events, []);
  f.commands.retireCommittedConversations([
    { id: conversation.id } as Discussion,
  ]);
  assert.deepEqual(f.events, [
    "conversations.set",
    "ref:project-b",
    "write:conversations",
  ]);
  assert.deepEqual(f.published.conversations, { "project-b": other });
  f.commands.retireCommittedConversations([
    { id: conversation.id } as Discussion,
  ]);
  assert.equal(f.events.length, 3);
  assert.deepEqual(f.rendered, f.initial);
});

test("retirement retains its original ref→state→write failure order, without a new catch", () => {
  const f = fixture({
    conversations: { "project-a": conversation },
    failAt: 1,
  });
  assert.throws(
    () =>
      f.commands.retireCommittedConversations([
        { id: conversation.id } as Discussion,
      ]),
    /TEST storage quota/,
  );
  assert.deepEqual(f.events, [
    "conversations.set",
    "ref:",
    "write:conversations",
  ]);
  assert.deepEqual(f.ref.current, {});
  assert.deepEqual(f.published.conversations, {});
  assert.deepEqual(f.persisted.get(draftKey("conversations")), {
    "project-a": conversation,
  });
  assert.deepEqual(f.notices, []);
});

test("discard isolates exact conversation prefix, including quotes and source settings; writes precede UI/navigation", () => {
  const f = fixture({
    conversations: { "project-a": conversation, "project-b": other },
    inputs: {
      [surface]: draft,
      "named-a:quotes": { ...empty, selection: "共享引用" },
      "named-ab:desk": { ...empty, body: "相似前缀不属于它" },
      "named-b:desk": empty,
    },
  });
  f.commands.discardConversation(
    conversation.id,
    () => {
      assert.fail("local draft must short-circuit the persisted lookup");
    },
    (value) => {
      assert.strictEqual(value, conversation);
      assert.deepEqual(f.ref.current, { "project-b": other });
      f.events.push("navigate");
    },
  );
  assert.deepEqual(f.events, [
    "write:discarded-conversations",
    "write:inputs",
    "write:conversations",
    "trash.set",
    "inputs.set",
    "conversations.set",
    "ref:project-a,project-b",
    "navigate",
  ]);
  assert.deepEqual(Object.keys(f.published.inputs), [
    "named-ab:desk",
    "named-b:desk",
  ]);
  assert.strictEqual(
    f.published.trash[conversation.id]!.conversation.inputId,
    conversation.inputId,
  );
  assert.strictEqual(
    f.published.trash[conversation.id]!.drafts[surface],
    draft,
  );
  assert.equal(
    f.published.trash[conversation.id]!.drafts[surface]!.reasoningEffort,
    "max",
  );
  assert.deepEqual(f.rendered, f.initial);
});

for (const failAt of [1, 2, 3]) {
  test(`discard storage failure ${failAt} preserves original partial persisted prefix without publishing or navigation`, () => {
    const f = fixture({
      conversations: { "project-a": conversation },
      inputs: { [surface]: draft },
      failAt,
    });
    f.commands.discardConversation(
      conversation.id,
      () => undefined,
      () => assert.fail("must not navigate"),
    );
    assert.deepEqual(
      f.events,
      ["write:discarded-conversations", "write:inputs", "write:conversations"]
        .slice(0, failAt)
        .concat("notice"),
    );
    assert.deepEqual(f.published, f.initial);
    assert.strictEqual(f.ref.current, f.rendered.conversations);
    assert.deepEqual(
      f.persisted.get(draftKey("discarded-conversations")),
      failAt > 1 ? trashForA : {},
    );
    assert.deepEqual(
      f.persisted.get(draftKey("inputs")),
      failAt > 2 ? {} : { [surface]: draft },
    );
    assert.deepEqual(f.persisted.get(draftKey("conversations")), {
      "project-a": conversation,
    });
    assert.deepEqual(f.notices, ["草稿整理未完成，原文仍保留，请重试。"]);
  });
}

test("discard persisted fallback retains metadata and does not delete a different pending conversation", () => {
  const pending = { ...conversation, id: "replacement" };
  const persisted: Discussion = {
    id: conversation.id,
    projectId: "project-a",
    title: "已保存但未投递",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    revision: 1,
    archivedAt: null,
  };
  const f = fixture({
    conversations: { "project-a": pending },
    inputs: { [surface]: draft },
  });
  f.commands.discardConversation(
    conversation.id,
    () => persisted,
    () => {},
  );
  assert.deepEqual(f.published.conversations, { "project-a": pending });
  assert.equal(
    Reflect.get(f.published.trash[conversation.id]!.conversation, "createdAt"),
    persisted.createdAt,
  );
  assert.match(
    f.published.trash[conversation.id]!.conversation.inputId,
    /^[\da-f-]{36}$/,
  );
});

test("restore preserves saved IDs/settings/quotes and unrelated drafts; navigation follows state/ref publication", () => {
  const f = fixture({
    trash: trashForA,
    inputs: { "named-b:desk": empty },
    conversations: { "project-b": other },
  });
  f.commands.restoreConversation(
    conversation.id,
    () => false,
    (value) => {
      assert.strictEqual(value, conversation);
      assert.strictEqual(f.ref.current[conversation.projectId], conversation);
      f.events.push("navigate");
    },
  );
  assert.deepEqual(f.events, [
    "write:inputs",
    "write:conversations",
    "write:discarded-conversations",
    "inputs.set",
    "conversations.set",
    "ref:project-b",
    "trash.set",
    "navigate",
  ]);
  assert.deepEqual(f.published.inputs, {
    "named-b:desk": empty,
    [surface]: draft,
  });
  assert.deepEqual(f.published.conversations, {
    "project-b": other,
    "project-a": conversation,
  });
  assert.deepEqual(f.published.trash, {});
  assert.deepEqual(f.rendered, f.initial);
});

for (const failAt of [1, 2, 3]) {
  test(`restore storage failure ${failAt} retains exact preexisting publication and partial persisted prefix`, () => {
    const f = fixture({ trash: trashForA, failAt });
    f.commands.restoreConversation(
      conversation.id,
      () => false,
      () => assert.fail("must not navigate"),
    );
    assert.deepEqual(
      f.events,
      ["write:inputs", "write:conversations", "write:discarded-conversations"]
        .slice(0, failAt)
        .concat("notice"),
    );
    assert.deepEqual(f.published, f.initial);
    assert.strictEqual(f.ref.current, f.rendered.conversations);
    assert.deepEqual(
      f.persisted.get(draftKey("inputs")),
      failAt > 1 ? { [surface]: draft } : {},
    );
    assert.deepEqual(
      f.persisted.get(draftKey("conversations")),
      failAt > 2 ? { "project-a": conversation } : {},
    );
    assert.deepEqual(
      f.persisted.get(draftKey("discarded-conversations")),
      trashForA,
    );
    assert.deepEqual(f.notices, ["草稿恢复失败，保存的原文仍在，请重试。"]);
  });
}

test("restore checks the render snapshot rather than a newer create ref; a conflicting draft is not overwritten", () => {
  const replacement = {
    ...conversation,
    id: "replacement",
    inputId: "replacement-input",
  };
  const f = fixture({
    trash: trashForA,
    conversations: { "project-a": replacement },
  });
  f.ref.current = {};
  const checked: string[] = [];
  f.commands.restoreConversation(
    conversation.id,
    (id) => {
      checked.push(id);
      return true;
    },
    () => assert.fail("must not navigate"),
  );
  assert.deepEqual(checked, [replacement.id]);
  assert.deepEqual(f.events, ["notice"]);
  assert.deepEqual(f.published, f.initial);
  assert.deepEqual(f.notices, [
    "请先发送或丢弃当前项目的新草稿，再恢复这份草稿。",
  ]);
});

test("missing discard/restore IDs have no effects; original callback errors remain inside their catch", () => {
  const missing = fixture();
  missing.commands.discardConversation(
    "missing",
    () => undefined,
    () => assert.fail("must not navigate"),
  );
  missing.commands.restoreConversation(
    "missing",
    () => assert.fail("must not check"),
    () => assert.fail("must not navigate"),
  );
  assert.deepEqual(missing.events, []);
  const discarded = fixture({ conversations: { "project-a": conversation } });
  discarded.commands.discardConversation(
    conversation.id,
    () => undefined,
    () => {
      throw new Error("TEST navigation");
    },
  );
  assert.deepEqual(discarded.notices, ["草稿整理未完成，原文仍保留，请重试。"]);
  const restored = fixture({ trash: trashForA });
  restored.commands.restoreConversation(
    conversation.id,
    () => false,
    () => {
      throw new Error("TEST navigation");
    },
  );
  assert.deepEqual(restored.notices, [
    "草稿恢复失败，保存的原文仍在，请重试。",
  ]);
});
