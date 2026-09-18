import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceStreamText,
  streamingTextPlugin,
  STREAM_TEXT_DURATION,
} from "../apps/web/src/streaming-text.js";
import {
  activeExecutionThreads,
  disconnectedRuntime,
} from "../packages/core/src/conversation.js";

test("text motion only tracks append ranges, not history, corrections or reconnect prefixes", () => {
  const initial = { source: "已有前缀", active: true, ranges: [] };
  assert.deepEqual(
    advanceStreamText(initial, initial.source, true, 100).ranges,
    [],
  );
  const first = advanceStreamText(initial, "已有前缀新增", true, 100);
  assert.deepEqual(first.ranges, [{ start: 4, end: 6, at: 100 }]);
  const second = advanceStreamText(first, "已有前缀新增文字", true, 150);
  assert.equal(second.ranges[0]!.at, 100);
  assert.equal(second.ranges[1]!.start, 6);
  assert.equal(
    advanceStreamText(second, second.source, true, 150 + STREAM_TEXT_DURATION)
      .ranges.length,
    0,
  );
  assert.equal(
    advanceStreamText(second, "修正内容", true, 200).ranges.length,
    0,
  );
  assert.equal(
    advanceStreamText(second, second.source, false, 200).ranges.length,
    0,
  );
  assert.equal(
    advanceStreamText(
      { ...second, active: false },
      second.source + "重新连接",
      true,
      200,
    ).ranges.length,
    0,
  );
});

test("text-node motion preserves exact text and Markdown structure, skipping code and transformed source", () => {
  const source = "旧文字新文字 `代码` &amp;";
  const text = (value: string, offset: number) => ({
    type: "text",
    value,
    position: { start: { offset }, end: { offset: offset + value.length } },
  });
  const tree: Parameters<ReturnType<typeof streamingTextPlugin>>[0] = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        children: [
          text("旧文字新文字 ", 0),
          { type: "element", tagName: "code", children: [text("代码", 8)] },
          {
            ...text("&", 12),
            position: { start: { offset: 12 }, end: { offset: 17 } },
          },
        ],
      },
    ],
  };
  streamingTextPlugin({
    source,
    ranges: [{ start: 3, end: source.length, at: 100 }],
  })(tree);
  const serialized = JSON.stringify(tree);
  assert.ok(serialized.includes("data-stream-at"));
  assert.equal(tree.children![0]!.children![0]!.value, "旧文字");
  const code = tree.children![0]!.children!.find((x) => x.tagName === "code")!;
  assert.equal(code.children![0]!.value, "代码");
  assert.equal(code.children![0]!.type, "text");
  assert.equal(tree.children![0]!.children!.at(-1)!.type, "text");
});

test("only live authoritative execution kinds receive background motion", () => {
  const thread = {
    id: "one",
    projectId: "p",
    conversationId: "c",
    inputId: "i",
    rootId: "r",
    sessionId: "s",
    title: "work",
    phase: "running",
    lifecycle: "open",
    revision: 1,
    updatedAt: "now",
  };
  const runtime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity: {
      available: true,
      truncated: false,
      threads: [
        { ...thread, kind: "dialogue_turn" },
        { ...thread, kind: "delivery" },
        thread,
        { ...thread, id: "actual", kind: "execution" },
        { ...thread, kind: "execution", lifecycle: "cancelled" },
      ],
    },
  };
  assert.deepEqual(
    activeExecutionThreads(runtime).map((t) => t.id),
    ["actual"],
  );
  assert.deepEqual(
    activeExecutionThreads({ ...runtime, connected: false }),
    [],
  );
  assert.deepEqual(
    activeExecutionThreads({
      ...runtime,
      activity: { ...runtime.activity, available: false },
    }),
    [],
  );
});
