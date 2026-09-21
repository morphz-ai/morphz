import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeReplies,
  conversationMessages,
  focusedInputs,
  hasUnreadReplies,
  readReplyReceipts,
  reconcileReplyReceipts,
  replyReceipts,
} from "../apps/web/src/conversation-read.js";
import type { Workspace } from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";

const message = (id: string, text = "已看到的回复") => ({
  id,
  text,
  kind: "reply" as const,
});
const output = {
  commandId: "delivery",
  inputId: "input-b",
  projectId: "desk",
  artifactId: "result",
  revision: 1,
  createdAt: "2026-09-20T00:00:00Z",
};

test("已读按实际消息保存：刷新、重排、移除和重新出现不制造未读", () => {
  const messages = [message("one"), message("two")];
  const seen = acknowledgeReplies({}, replyReceipts(messages, [output]));
  const restored = readReplyReceipts(JSON.parse(JSON.stringify(seen)))!;
  assert.equal(
    hasUnreadReplies(restored, replyReceipts(messages.toReversed(), [output])),
    false,
  );
  assert.equal(
    hasUnreadReplies(restored, replyReceipts(messages.slice(1), [])),
    false,
  );
  assert.equal(
    hasUnreadReplies(restored, replyReceipts(messages, [output])),
    false,
  );
  assert.equal(
    acknowledgeReplies(seen, replyReceipts(messages, [output])),
    seen,
  );
});

test("仅正文、错误或交付形成未读，后台进度、工具和空回复不算新回复", () => {
  const messages = [
    { ...message("progress"), kind: "progress" as const },
    { ...message("tool"), kind: "tool" as const },
    message("empty", " \n"),
  ];
  assert.deepEqual(replyReceipts(messages, []), []);
  assert.equal(
    hasUnreadReplies(
      {},
      replyReceipts([{ ...message("error"), kind: "error" }], []),
    ),
    true,
  );
  assert.equal(hasUnreadReplies({}, replyReceipts([], [output])), true);
});

test("同长度文字变化及新交付仍然提醒，不以字数或消息数量充当已读", () => {
  const seen = acknowledgeReplies(
    {},
    replyReceipts([message("one", "原稿")], [output]),
  );
  assert.equal(
    hasUnreadReplies(seen, replyReceipts([message("one", "改稿")], [])),
    true,
  );
  assert.equal(
    hasUnreadReplies(seen, replyReceipts([message("two", "原稿")], [])),
    true,
  );
  assert.equal(
    hasUnreadReplies(
      seen,
      replyReceipts([], [{ ...output, commandId: "delivery-2", revision: 2 }]),
    ),
    true,
  );
});

test("读过的流式正文转为正式回执不重复提醒；真正续写仍未读", () => {
  const streaming = {
    ...message("stream:attempt"),
    publicationKey: "attempt",
    streaming: true,
  };
  const seen = acknowledgeReplies({}, replyReceipts([streaming], []));
  const final = { ...streaming, id: "durable", streaming: false };
  assert.equal(hasUnreadReplies(seen, replyReceipts([final], [])), false);
  const reconciled = reconcileReplyReceipts(seen, replyReceipts([final], []));
  assert.equal(
    hasUnreadReplies(reconciled, replyReceipts([message("durable")], [])),
    false,
  );
  assert.equal(
    hasUnreadReplies(
      reconciled,
      replyReceipts([{ ...final, text: final.text + "新的补充" }], []),
    ),
    true,
  );
});

test("历史流重放不能用较早错误覆盖同一发布的最终错误，再次刷新不制造未读", () => {
  const final = {
    id: "publication:attempt",
    publicationKey: "attempt",
    sequence: 471,
    projectId: "desk",
    conversationId: "conversation",
    artifactId: null,
    inputId: "input",
    rootId: "root",
    createdAt: "2026-09-20T00:00:00Z",
    kind: "error" as const,
    text: "最终失败说明",
  };
  const runtime = { ...disconnectedRuntime, messages: [final] };
  const state = { projects: [] } as unknown as Workspace;
  const older = { ...final, sequence: 470, text: "较早的底层错误" };
  const seen = acknowledgeReplies({}, replyReceipts([final], []));
  for (const live of [[older], [older, final], [final, older], []]) {
    const merged = conversationMessages(
      state,
      "conversation",
      runtime,
      live,
      false,
    );
    assert.deepEqual(merged, [final]);
    assert.equal(hasUnreadReplies(seen, replyReceipts(merged, [])), false);
  }
  const draft = {
    ...final,
    kind: "reply" as const,
    sequence: undefined,
    streaming: true,
    text: "重连时回放的旧流式片段",
  };
  assert.deepEqual(
    conversationMessages(state, "conversation", runtime, [draft], false),
    [final],
  );
  const newer = { ...final, sequence: 472, text: "真正的新错误说明" };
  const merged = conversationMessages(
    state,
    "conversation",
    runtime,
    [newer],
    false,
  );
  assert.equal(hasUnreadReplies(seen, replyReceipts(merged, [])), true);
});

test("局部历史与提示共用关联筛选，其他对象或应用的回复不混入", () => {
  const inputs = [
    {
      id: "input-a",
      artifactId: "source",
      application: { instanceId: "browser-a" },
    },
    { id: "input-b", artifactId: null },
    {
      id: "input-c",
      artifactId: null,
      application: { instanceId: "browser-b" },
    },
  ] as Workspace["inputs"];
  assert.deepEqual(
    focusedInputs(inputs, [output], { artifactId: "result" }).map((i) => i.id),
    ["input-b"],
  );
  assert.deepEqual(
    focusedInputs(inputs, [output], { artifactId: "source" }).map((i) => i.id),
    ["input-a"],
  );
  assert.deepEqual(
    focusedInputs(inputs, [output], { applicationId: "browser-a" }).map(
      (i) => i.id,
    ),
    ["input-a"],
  );
  assert.equal(focusedInputs(inputs, [], {}), inputs);
});

test("内部 infer 流不冒充用户回复；输入身份到达后真实根线程流仍正常显示", () => {
  const state = { projects: [] } as unknown as Workspace;
  const stream = {
    id: "stream:child",
    publicationKey: "child",
    projectId: "desk",
    conversationId: "conversation",
    artifactId: null,
    inputId: null,
    rootId: "infer-root",
    createdAt: "2026-09-20T00:00:00Z",
    kind: "reply" as const,
    streaming: true,
    text: "内部工作结果",
  };
  for (const streaming of [true, false])
    assert.deepEqual(
      conversationMessages(
        state,
        "conversation",
        disconnectedRuntime,
        [{ ...stream, streaming }],
        false,
      ),
      [],
    );
  const actual = {
    ...stream,
    id: "stream:root",
    rootId: "input-root",
    inputId: "input",
  };
  assert.deepEqual(
    conversationMessages(
      state,
      "conversation",
      disconnectedRuntime,
      [actual],
      false,
    ),
    [actual],
  );
  const { streaming: _streaming, ...historical } = stream;
  assert.equal(
    conversationMessages(
      state,
      "conversation",
      { ...disconnectedRuntime, messages: [historical] },
      [],
      false,
    ).length,
    1,
  );
});

test("损坏的已读偏好不阻止打开，记录中不保存回复原文", () => {
  for (const value of [null, [], "old", { "reply:x": 3 }, { unrelated: "x" }])
    assert.equal(readReplyReceipts(value), null);
  const privateText = "不应再次存入本机偏好的回复原文";
  const seen = acknowledgeReplies(
    {},
    replyReceipts([message("one", privateText)], []),
  );
  assert.equal(JSON.stringify(seen).includes(privateText), false);
});
