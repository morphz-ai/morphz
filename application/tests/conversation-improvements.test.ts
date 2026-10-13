import test from "node:test";
import assert from "node:assert/strict";
import { exchangeDraftLengthError } from "../apps/web/src/host/exchange-draft-validation.js";
import {
  messageSourceSummary,
  responseElapsed,
  responseWaitingPresentation,
} from "../apps/web/src/conversation-presentation.js";
import {
  searchConversationPage,
  conversationSearchPageSchema,
  conversationSearchRequestSchema,
} from "../packages/core/src/conversation-search.js";
import type { RecordedInput } from "../packages/core/src/model.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";

const quote = {
  id: "11111111-1111-4111-8111-111111111111",
  source: {
    kind: "artifact" as const,
    projectId: "p",
    artifactId: "a",
    revision: 1,
    title: "资料",
  },
  text: "引用原文",
  comment: "请修改这一段",
};
const input = (fields: Partial<RecordedInput> = {}): RecordedInput => ({
  id: "i",
  projectId: "p",
  conversationId: "c",
  body: "你好",
  author: { principalId: "h", actantId: "h" },
  targetActantId: "a",
  artifactId: null,
  artifactRevision: null,
  selection: "",
  status: "recorded",
  createdAt: "2026-10-11T00:00:00Z",
  ...fields,
});
const message = (fields: Partial<LiveMessage> = {}): LiveMessage => ({
  id: "r",
  projectId: "p",
  conversationId: "c",
  inputId: "i",
  rootId: "root",
  artifactId: null,
  text: "回复",
  kind: "reply",
  createdAt: "2026-10-11T00:00:01Z",
  ...fields,
});
const draft = (body: string): InputDraft => ({
  body,
  selection: "",
  revision: null,
});

test("长输入逐字符保留，只在 typed 预算上阻止发送；边界、emoji 和批注合成预算", () => {
  const long = draft("前".repeat(30000) + "末尾标记");
  const before = structuredClone(long);
  assert.match(exchangeDraftLengthError(long)!, /30,000.*全文已保留/);
  assert.deepEqual(long, before);
  assert.equal(exchangeDraftLengthError(draft("前".repeat(30000))), undefined);
  assert.equal(
    exchangeDraftLengthError(draft(" " + "前".repeat(30000) + " ")),
    undefined,
  );
  assert.equal(exchangeDraftLengthError(draft("🙂".repeat(15000))), undefined);
  assert.match(
    exchangeDraftLengthError({
      ...draft(""),
      textQuotes: [{ ...quote, text: "原".repeat(30000), comment: "多" }],
    })!,
    /引用与评论/,
  );
  assert.match(
    exchangeDraftLengthError(
      { ...draft("前".repeat(10000)), textQuotes: [quote] },
      true,
    )!,
    /10,000/,
  );
  assert.equal(
    exchangeDraftLengthError({
      ...draft("前".repeat(10000)),
      textQuotes: [quote],
    }),
    undefined,
  );
  assert.match(
    exchangeDraftLengthError(
      {
        ...draft("前".repeat(10000)),
        textQuotes: [quote],
        taskResult: { taskId: "i", revision: 1 },
      },
      true,
    )!,
    /10,000/,
  );
});
test("来源摘要优先正文或批注评论，不拿原文盖过人的问题，也不切断 emoji", () => {
  assert.equal(
    messageSourceSummary(input({ body: "", textQuotes: [quote] })),
    "请修改这一段",
  );
  assert.equal(
    messageSourceSummary(
      input({ body: " 新问题\n第二行", textQuotes: [quote] }),
    ),
    "新问题 第二行",
  );
  assert.equal(
    messageSourceSummary(
      input({ body: "", textQuotes: [{ ...quote, comment: "" }] }),
    ),
    "引用原文",
  );
  assert.equal(messageSourceSummary(undefined), "原消息");
  assert.equal(
    messageSourceSummary(input({ body: "🙂".repeat(51) })),
    "🙂".repeat(50) + "…",
  );
});
test("等待阶段来自同一输入的真实回执，不从耗时、另一项工作或完成的工具猜模型进度", () => {
  const d = {
    inputId: "i",
    state: "running" as const,
    error: null,
    retryable: false,
  };
  assert.equal(responseWaitingPresentation(d, [], true).label, "等待回复…");
  assert.equal(
    responseWaitingPresentation({ ...d, state: "queued" }, [], true).label,
    "排队等待…",
  );
  assert.equal(
    responseWaitingPresentation({ ...d, state: "sending" }, [], true).label,
    "正在发送…",
  );
  const tool = (status: string) =>
    message({
      kind: "tool",
      text: "",
      tool: { name: "host_morphz", status, arguments: "" },
    });
  assert.equal(
    responseWaitingPresentation(d, [tool("running")], true).label,
    "正在执行工具…",
  );
  assert.equal(
    responseWaitingPresentation(d, [tool("generating")], true).label,
    "正在生成工具调用…",
  );
  assert.equal(
    responseWaitingPresentation(d, [tool("pending")], true).label,
    "工具调用等待执行…",
  );
  assert.equal(
    responseWaitingPresentation(
      d,
      [tool("success"), { ...tool("running"), inputId: "other" }],
      true,
    ).label,
    "等待回复…",
  );
  assert.equal(
    responseWaitingPresentation(d, [tool("running")], false).label,
    "连接中断，等待恢复",
  );
  assert.equal(
    responseWaitingPresentation(d, [], true, true).label,
    "已请求停止，等待确认",
  );
});
test("耗时是发送后实际经过时间，无效／未来时间不伪造等待或完成", () => {
  const start = "2026-10-11T00:00:00Z",
    now = Date.parse(start);
  assert.equal(responseElapsed(start, now + 65000), "1 分 05 秒");
  assert.equal(responseElapsed(start, now + 3600000), "1 小时 0 分");
  assert.equal(responseElapsed("invalid", now), null);
  assert.equal(responseElapsed(start, now - 1), null);
});
test("搜索严格 literal，包含评论、返回确切身份，只查公开输入／回复；预览不执行 HTML", () => {
  const inputs = [
    input({ body: "测试 [.*]" }),
    input({ id: "comment", body: "", textQuotes: [quote] }),
  ];
  assert.deepEqual(
    searchConversationPage(inputs, [], "[.*]").map((h) => h.messageId),
    ["i"],
  );
  assert.deepEqual(
    searchConversationPage(inputs, [], "修改").map((h) => h.messageId),
    ["comment"],
  );
  const messages = [
    message({ text: "TEST <script>内容</script>" }),
    message({ id: "private", kind: "progress", text: "TEST" }),
    message({ id: "tool", kind: "tool", text: "TEST" }),
  ];
  const hits = searchConversationPage([], messages, "test");
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ["r"],
  );
  assert.equal(hits[0]!.conversationId, "c");
  assert.match(hits[0]!.preview, /<script>/);
  conversationSearchPageSchema.parse({ hits, nextCursor: null, scanned: 3 });
  conversationSearchPageSchema.parse({
    hits: searchConversationPage(
      [input({ body: "🙂".repeat(1000) })],
      [],
      "🙂",
    ),
    nextCursor: null,
    scanned: 1,
  });
  assert.throws(() =>
    conversationSearchRequestSchema.parse({
      projectId: "p",
      conversationId: "c",
      query: " ",
      principalId: "spoof",
    }),
  );
});
