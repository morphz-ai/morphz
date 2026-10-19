import test from "node:test";
import assert from "node:assert/strict";
import { resendRecordedInput } from "../apps/web/src/host/resend-recorded-input.js";
import {
  operationSchema,
  type RecordedInput,
} from "../packages/core/src/model.js";

test("重新发送使用原问题、引用和阅读位置，而不是当前页面；不复制原消息身份", () => {
  const original: RecordedInput = {
    id: "old-input",
    projectId: "original-project",
    conversationId: "original-conversation",
    artifactId: "original-book",
    artifactRevision: 2,
    selection: "原选文",
    body: "原问题",
    status: "recorded",
    targetActantId: "morphz-agent",
    author: { principalId: "human", actantId: "human" },
    createdAt: "2026-10-18T14:00:00Z",
    model: "deepseek-flash",
    reasoningEffort: "low",
    reading: {
      book: { title: "合成原书", author: "合成", edition: "", format: "epub" },
      chapter: "原章",
      location: {
        sourceId: "original-book@2",
        sectionId: "original-section",
        start: 10,
        end: 20,
      },
    },
    textQuotes: [
      {
        id: "1a13d398-8ba9-4dd1-aa46-f31a097a651f",
        source: {
          kind: "artifact",
          projectId: "original-project",
          artifactId: "original-book",
          revision: 2,
          title: "合成原书",
        },
        text: "原句",
        comment: "原问题",
      },
    ],
    attachments: [
      { assetId: "a".repeat(64), mime: "text/plain", name: "合成附件.txt" },
    ],
    application: {
      id: "morphz.reader",
      version: "1.0.0",
      instanceId: "original-reader",
      harness: null,
    },
  };
  const frozen = JSON.stringify(original),
    next = operationSchema.parse(resendRecordedInput(original));
  assert.equal(next.type, "record-input");
  assert.equal(next.projectId, original.projectId);
  assert.equal(next.conversationId, original.conversationId);
  assert.equal(next.body, original.body);
  assert.deepEqual(next.reading, original.reading);
  assert.deepEqual(next.attachments, original.attachments);
  assert.deepEqual(next.textQuotes, original.textQuotes);
  assert.equal(next.model, "deepseek-flash");
  assert.equal(next.reasoningEffort, "low");
  assert.equal("id" in next, false);
  assert.equal("author" in next, false);
  assert.equal("createdAt" in next, false);
  assert.equal(JSON.stringify(original), frozen);
});
