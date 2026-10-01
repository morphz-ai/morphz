import test from "node:test";
import assert from "node:assert/strict";
import { sourceContainsSelection } from "../packages/application/src/platform-message-source.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";

test("Platform 引用校验保存的原文与 Markdown 可见选文", () => {
  assert.equal(sourceContainsSelection("普通原文", "普通原文"), true);
  assert.equal(
    sourceContainsSelection(
      "这是 **重点**，见[正文](https://example.com)。",
      "这是 重点，见正文。",
    ),
    true,
  );
  assert.equal(
    sourceContainsSelection(
      "这是 **重点**，见[正文](https://example.com)。",
      "没有出现的文字",
    ),
    false,
  );
});

test("CJK-adjacent emphasis uses exactly the message UI's visible text", () => {
  const source =
    "好，提前一天就是 **10 月 23 日**。当天**上午 9 点（北京时间）**提醒你，可以吗？确认后我再设置定时提醒。";
  const selected =
    "好，提前一天就是 10 月 23 日。当天上午 9 点（北京时间）提醒你，可以吗？确认后我再设置定时提醒。";
  assert.equal(source.length, 61);
  assert.equal(selected.length, 53);
  assert.equal(
    renderToStaticMarkup(
      createElement(Markdown, {
        remarkPlugins: [remarkCjkFriendly, remarkGfm],
        children: source,
      }),
    ),
    "<p>好，提前一天就是 <strong>10 月 23 日</strong>。当天<strong>上午 9 点（北京时间）</strong>提醒你，可以吗？确认后我再设置定时提醒。</p>",
  );
  assert.equal(sourceContainsSelection(source, selected), true);
  assert.equal(
    sourceContainsSelection(source, selected.replace("上午 9 点", "上午 8 点")),
    false,
  );
  assert.equal(
    sourceContainsSelection("文字**不是完整 Markdown", "文字不是完整 Markdown"),
    false,
  );
});

test("GFM strikethrough and table text are verified as the UI displays them", () => {
  const source =
    "~~旧内容~~\n\n| 项目 | 日期 |\n| --- | --- |\n| 提醒 | 今天 |";
  assert.equal(sourceContainsSelection(source, "旧内容"), true);
  assert.equal(sourceContainsSelection(source, "提醒 今天"), true);
  assert.equal(sourceContainsSelection(source, "提醒 明天"), false);
});
