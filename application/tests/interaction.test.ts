import test from "node:test";
import assert from "node:assert/strict";
import {
  afterSend,
  afterLeave,
  withoutInput,
  revealInput,
  shouldFollow,
} from "../apps/web/src/interaction.js";
import {
  conversationGroups,
  conversationRuntimeSchema,
} from "../packages/core/src/conversation.js";

test("交流状态只由显式动作展开；迟到的发送回执不重新打开已隐藏的输入", () => {
  assert.equal(afterSend("input"), "recent");
  assert.equal(afterSend("recent"), "recent");
  assert.equal(afterSend("history"), "history");
  assert.equal(afterSend("hidden"), "hidden");
  assert.equal(afterSend("recent-only"), "recent-only");
  assert.equal(afterSend("history-only"), "history-only");
  assert.equal(revealInput("hidden"), "input");
  assert.equal(revealInput("input"), "input");
  assert.equal(revealInput("recent"), "recent");
  assert.equal(revealInput("history"), "history");
  assert.equal(revealInput("recent-only"), "recent");
  assert.equal(revealInput("history-only"), "history");
  assert.equal(shouldFollow(40), true);
  assert.equal(shouldFollow(120), false);
});

test("离开交流区域分别保留已固定且可见的部分，不自动打开已收起的部分", () => {
  for (const mode of [
    "hidden",
    "input",
    "recent",
    "history",
    "recent-only",
    "history-only",
  ] as const) {
    for (const inputPinned of [false, true])
      for (const historyPinned of [false, true]) {
        const result = afterLeave(mode, inputPinned, historyPinned);
        const inputWasVisible = ["input", "recent", "history"].includes(mode);
        const historyWasVisible = [
          "recent",
          "history",
          "recent-only",
          "history-only",
        ].includes(mode);
        assert.equal(
          ["input", "recent", "history"].includes(result),
          inputWasVisible && inputPinned,
        );
        assert.equal(
          ["recent", "history", "recent-only", "history-only"].includes(result),
          historyWasVisible && historyPinned,
        );
        assert.equal(
          revealInput(withoutInput(mode)),
          ["history", "history-only"].includes(mode)
            ? "history"
            : ["recent", "recent-only"].includes(mode)
              ? "recent"
              : "input",
        );
      }
  }
});

test("乱序并发回复按输入标识归组，不用时间猜测旧回复归属", () => {
  const base = {
    projectId: "space",
    artifactId: null,
    text: "reply",
    kind: "reply" as const,
  };
  const groups = conversationGroups(
    [
      { id: "a", createdAt: "01" },
      { id: "b", createdAt: "02" },
    ],
    [
      {
        ...base,
        id: "late-a",
        createdAt: "05",
        inputId: "a",
        rootId: "root-a",
      },
      { ...base, id: "b-reply", createdAt: "03", inputId: "b" },
      { ...base, id: "legacy", createdAt: "04" },
    ],
  );
  assert.deepEqual(
    groups.map((g) => [g.inputId, g.messages.map((m) => m.id)]),
    [
      ["a", ["late-a"]],
      ["b", ["b-reply"]],
      [null, ["legacy"]],
    ],
  );
  assert.equal(
    conversationRuntimeSchema.safeParse({
      configured: false,
      connected: false,
      model: "",
      error: "",
      deliveries: [],
      messages: [{ ...base, id: "old", createdAt: "04" }],
    }).success,
    true,
  );
});
