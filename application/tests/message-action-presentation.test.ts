import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import {
  sameMessageActionPresentation,
  type MessageActionProps,
} from "../apps/web/src/message-action-presentation.js";

function original(): MessageActionProps {
  return {
    createdAt: "2026-10-23T00:00:00Z",
    text: "TEST original",
    control: undefined,
    client: {} as MessageActionProps["client"],
    share: {
      text: "TEST original",
      author: "Morphz",
      createdAt: "2026-10-23T00:00:00Z",
      format: "markdown",
      partial: false,
      quotes: [{ text: "TEST quote", comment: "TEST comment" }],
      attachments: ["TEST attachment"],
      state: {} as MessageActionProps["share"]["state"],
      catalog: [],
    },
  };
}

test("unchanged footer accepts freshly projected share arrays without reparsing or hashing prose", () => {
  const before = original();
  assert.equal(
    sameMessageActionPresentation(before, {
      ...before,
      share: {
        ...before.share,
        quotes: before.share.quotes.map((quote) => ({ ...quote })),
        attachments: [...before.share.attachments],
      },
    }),
    true,
  );
});

test("every share field, current permission reference, action and Client invalidates the footer", () => {
  const before = original();
  const changes: Partial<MessageActionProps["share"]>[] = [
    { text: "TEST new" },
    { author: "我" },
    { createdAt: "2026-10-24T00:00:00Z" },
    { format: "plain" },
    { partial: true },
    { quotes: [] },
    { quotes: [{ text: "TEST changed", comment: "TEST comment" }] },
    { quotes: [{ text: "TEST quote", comment: "TEST changed" }] },
    { attachments: [] },
    { attachments: ["TEST changed"] },
    { state: { ...before.share.state } },
    { catalog: [...before.share.catalog] },
  ];
  assert.deepEqual(
    [...new Set(changes.flatMap(Object.keys))].sort(),
    Object.keys(before.share).sort(),
    "cover every current share field, not just prose",
  );
  for (const change of changes)
    assert.equal(
      sameMessageActionPresentation(before, {
        ...before,
        share: { ...before.share, ...change },
      }),
      false,
      JSON.stringify(Object.keys(change)),
    );
  for (const change of [
    { createdAt: "2026-10-24T00:00:00Z" },
    { text: "TEST changed copy" },
    { client: {} as MessageActionProps["client"] },
    { control: createElement("button", {}, "TEST stop") },
  ])
    assert.equal(
      sameMessageActionPresentation(before, { ...before, ...change }),
      false,
    );
  const oldControl = { ...before, control: createElement("button") };
  assert.equal(sameMessageActionPresentation(oldControl, before), false);
});

test("new or removed presentation fields fail closed rather than retain stale data", () => {
  const before = original();
  const newSurface = { ...before, future: "TEST" };
  const newContent = { ...before, share: { ...before.share, future: "TEST" } };
  const newQuote = {
    ...before,
    share: {
      ...before.share,
      quotes: [{ ...before.share.quotes[0]!, future: "TEST" }],
    },
  };
  for (const [oldValue, newValue] of [
    [before, newSurface],
    [before, newContent],
    [before, newQuote],
  ] as const) {
    assert.equal(sameMessageActionPresentation(oldValue, newValue), false);
    assert.equal(sameMessageActionPresentation(newValue, oldValue), false);
  }
});
