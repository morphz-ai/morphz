import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  replaceComposerSurface,
  updateComposerDraft,
} from "../apps/web/src/composer-drafts.js";
import type { TextQuote } from "../packages/core/src/text-quotes.js";

type Draft = {
  body: string;
  selection: string;
  textQuotes?: TextQuote[];
};
const empty: Draft = { body: "", selection: "" };
const conversation = "conversation-1";
const surface = `${conversation}:desk`;
const otherSurface = `${conversation}:artifact-1`;
const quotesKey = `${conversation}:quotes`;
const quote = (index: number): TextQuote => ({
  id: randomUUID(),
  source: {
    kind: "message",
    messageId: `publication:fixture-${index}`,
    inputId: randomUUID(),
    projectId: randomUUID(),
    conversationId: conversation,
    title: "Morphz",
    createdAt: "2026-09-24T00:00:00.000Z",
  },
  text: `选文 ${index}`,
  comment: `评论 ${index}`,
});

test("普通输入的旧快照不能清空同一会话的四条待发引用", () => {
  const quotes = [quote(1), quote(2), quote(3), quote(4)];
  const current = {
    [surface]: { ...empty, body: "原有输入" },
    [quotesKey]: { ...empty, textQuotes: quotes },
  };
  const stale = { ...empty, body: "原有输入", textQuotes: [] };
  const next = replaceComposerSurface(current, surface, empty, stale);
  assert.deepEqual(next[quotesKey]!.textQuotes, quotes);
  assert.equal(next[surface]!.body, "原有输入");
  assert.equal(next[surface]!.textQuotes, undefined);
});

test("连续跨页面输入只更新正文；显式编辑和移除引用仍然生效", () => {
  const quotes = [quote(1), quote(2), quote(3), quote(4)];
  const current = {
    [surface]: { ...empty },
    [otherSurface]: { ...empty },
    [quotesKey]: { ...empty, textQuotes: quotes },
  };
  const changed = replaceComposerSurface(current, otherSurface, empty, {
    ...empty,
    body: "另一页的输入",
    textQuotes: [],
  });
  assert.deepEqual(changed[quotesKey]!.textQuotes, quotes);
  const edited = updateComposerDraft(changed, otherSurface, empty, (draft) => ({
    ...draft,
    textQuotes: draft.textQuotes?.map((item, index) =>
      index === 0 ? { ...item, comment: "已修改" } : item,
    ),
  }));
  assert.equal(edited[quotesKey]!.textQuotes?.[0]!.comment, "已修改");
  const removed = updateComposerDraft(edited, surface, empty, (draft) => ({
    ...draft,
    textQuotes: draft.textQuotes?.filter((item) => item.id !== quotes[1]!.id),
  }));
  assert.deepEqual(
    removed[quotesKey]!.textQuotes?.map((item) => item.id),
    [quotes[0]!.id, quotes[2]!.id, quotes[3]!.id],
  );
  const sent = updateComposerDraft(removed, surface, empty, () => ({
    ...empty,
    textQuotes: [],
  }));
  assert.deepEqual(sent[quotesKey]!.textQuotes, []);
});
