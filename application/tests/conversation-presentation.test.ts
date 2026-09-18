import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../apps/web/src/SafeMarkdown.js";
import { conversationDate } from "../apps/web/src/conversation-presentation.js";
import type { Workspace } from "../packages/core/src/model.js";

const render = (children: string) =>
  renderToStaticMarkup(
    createElement(SafeMarkdown, {
      children,
      state: { artifacts: [] } as unknown as Workspace,
      onOpen: () => {},
    }),
  );

test("日期分隔使用本地日历边界，跨年不混淆，无效时间不伪造日期", () => {
  const date = new Date(2026, 8, 11, 0, 5);
  assert.equal(conversationDate(date.toISOString())?.key, "2026-09-11");
  assert.match(conversationDate(date.toISOString())!.label, /2026.*9.*11/);
  assert.equal(
    conversationDate(new Date(2027, 0, 1).toISOString())?.key,
    "2027-01-01",
  );
  assert.equal(conversationDate("invalid"), null);
});

test("真实中文标点强调与 GFM 表格正确渲染，不改原文", () => {
  const text =
    "是的，截图里**「截图输入」弹窗和灰色遮罩挡住了 PDF**，同时继续。\n\n当天 **上午 9:30（北京时间）**在本会话提醒。\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |";
  const html = render(text);
  assert.match(html, /<strong>「截图输入」弹窗和灰色遮罩挡住了 PDF<\/strong>/);
  assert.match(html, /<strong>上午 9:30（北京时间）<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>完成<\/td>/);
  assert.match(html, /aria-label="表格"/);
  assert.ok(text.includes("**"));
});

test("代码、转义与未完成流片段不被正则改写，HTML 和远程图片仍不可执行", () => {
  assert.match(
    render("`中文**「原样」**保留`"),
    /<code>中文\*\*「原样」\*\*保留<\/code>/,
  );
  assert.match(render("```txt\n**不处理。**\n```"), /\*\*不处理。\*\*/);
  assert.match(render("\\*\\*字面星号\\*\\*"), /\*\*字面星号\*\*/);
  assert.match(render("中文**「未完成"), /中文\*\*「未完成/);
  const html = render(
    "<script>alert(1)</script>\n\n![外图](https://example.com/private.png)\n\n[危险](javascript:alert(1))",
  );
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /查看外部图片/);
});
