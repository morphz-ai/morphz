import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixtureFinalReply } from "../scripts/runtime-fixture-reply.js";

const result = {
  content: "已完成。",
  title: "完成合成验收",
  result: "合成结果已保存",
};
const properties = {
  content: { type: "string" },
  annotations: {
    properties: {
      execution: {
        properties: { title: { type: "string" }, result: { type: "string" } },
      },
    },
  },
};

test("synthetic final replies use only the real offered annotation carrier", () => {
  for (const definition of [
    { function: { name: "reply", parameters: { properties } } },
    { name: "reply", parameters: { properties } },
  ]) {
    const reply = runtimeFixtureFinalReply(
      { tools: [definition] },
      result,
      "final-id",
    );
    assert.equal(reply.finishReason, "tool_calls");
    assert.equal(reply.message.content, "");
    assert.deepEqual(reply.message.tool_calls, [
      {
        id: "final-id",
        type: "function",
        function: {
          name: "reply",
          arguments: JSON.stringify({
            content: result.content,
            annotations: {
              execution: { title: result.title, result: result.result },
            },
          }),
        },
      },
    ]);
  }
});

test("annotation-off/infer or similarly named business tools never gain a reply tool", () => {
  for (const request of [
    {},
    { tools: null },
    { tools: [] },
    { tools: [{ name: "business_reply", parameters: { properties } }] },
    {
      tools: [
        {
          name: "reply",
          parameters: { properties: { content: { type: "string" } } },
        },
      ],
    },
    {
      tools: [
        {
          name: "reply",
          parameters: {
            properties: { ...properties, content: { type: "object" } },
          },
        },
      ],
    },
    {
      tools: [
        {
          name: "reply",
          parameters: {
            properties: {
              content: { type: "string" },
              annotations: {
                properties: {
                  execution: { properties: { title: { type: "string" } } },
                },
              },
            },
          },
        },
      ],
    },
  ]) {
    assert.deepEqual(runtimeFixtureFinalReply(request, result), {
      message: { role: "assistant", content: result.content },
      finishReason: "stop",
    });
  }
});
