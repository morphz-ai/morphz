import test from "node:test";
import assert from "node:assert/strict";
import {
  maxMessageAttachmentBytes,
  maxMessageImageBytes,
  maxMessageTextBytes,
  messageAttachmentSizeIssue,
} from "../packages/core/src/message-attachment-policy.js";

test("消息附件大小限制在上传前给出对应文件类型的明确提示", () => {
  for (const [name, limit, message] of [
    ["photo.png", maxMessageImageBytes, "图片不能超过 6 MB。"],
    ["notes.md", maxMessageTextBytes, "文本文件不能超过 8 MB。"],
    ["book.pdf", maxMessageAttachmentBytes, "附件不能超过 20 MB。"],
  ] as const) {
    assert.equal(messageAttachmentSizeIssue({ name, size: limit }), null);
    assert.equal(
      messageAttachmentSizeIssue({ name, size: limit + 1 }),
      message,
    );
  }
  assert.equal(
    messageAttachmentSizeIssue({ name: "empty.txt", size: 0 }),
    "不能添加空文件。",
  );
});
