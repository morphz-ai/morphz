import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeVisibility,
  type ExchangePreferences,
} from "../apps/web/src/host/use-exchange-controller.js";
import { exchangeView } from "../apps/web/src/interaction.js";

type Surface = Parameters<typeof exchangeVisibility>[0];
const surface: Surface = {
  navigationProject: undefined,
  selectedConversation: undefined,
  exchangeKey: "surface-A",
  contextKey: "conversation-A:object-A",
  conversationId: "conversation-A",
  dialogueCanvas: false,
};

test("exchange visibility projects six layouts and two independent scoped pins", () => {
  for (const interaction of [
    "hidden",
    "input",
    "recent",
    "history",
    "recent-only",
    "history-only",
  ] as const) {
    const preferences: ExchangePreferences = {
      interactions: { "surface-A": interaction, "surface-B": "history" },
      pinnedInputs: { "surface-A": false, "surface-B": true },
      pinnedHistories: { "surface-A": true, "surface-B": false },
    };
    assert.deepEqual(exchangeVisibility(surface, preferences, null), {
      interaction,
      view: exchangeView(interaction),
      inputVisible: ["input", "recent", "history"].includes(interaction),
      conversationVisible: [
        "recent",
        "history",
        "recent-only",
        "history-only",
      ].includes(interaction),
      historyVisible:
        interaction === "history" || interaction === "history-only",
      inputPinned: false,
      historyPinned: true,
    });
    assert.equal(
      exchangeVisibility(surface, preferences, {
        scope: "surface-B",
        mode: "recent",
      }).interaction,
      interaction,
    );
    assert.equal(
      exchangeVisibility(surface, preferences, {
        scope: "surface-A",
        mode: "recent",
      }).interaction,
      "recent",
    );
    assert.equal(preferences.interactions?.["surface-A"], interaction);
  }
  assert.equal(exchangeVisibility(surface, {}, null).interaction, "input");
});

test("dialogue remains visible and archived conversations remain readable without a new mode", () => {
  for (const interaction of ["hidden", "input", "recent", "history"] as const) {
    const preferences = { interactions: { "surface-A": interaction } };
    assert.deepEqual(
      exchangeVisibility(
        { ...surface, dialogueCanvas: true },
        preferences,
        null,
      ),
      {
        interaction,
        view: exchangeView(interaction),
        inputVisible: true,
        conversationVisible: true,
        historyVisible: true,
        inputPinned: false,
        historyPinned: false,
      },
    );
    const archived = exchangeVisibility(
      {
        ...surface,
        selectedConversation: {
          id: "conversation-A",
          projectId: "project-A",
          title: "Archived",
          revision: 1,
          archivedAt: "2026-10-03T00:00:00Z",
          createdAt: "2026-10-03T00:00:00Z",
          updatedAt: "2026-10-03T00:00:00Z",
        },
      },
      preferences,
      null,
    );
    assert.equal(archived.conversationVisible, true);
    assert.equal(archived.inputVisible, interaction !== "hidden");
    assert.equal(archived.historyVisible, interaction === "history");
  }
});

test("remembered record selection is scoped and does not reopen a hidden layout", () => {
  for (const view of ["input", "recent", "history"] as const) {
    const preferences: ExchangePreferences = {
      exchangeViews: { "surface-A": view, "surface-B": "history" },
      interactions: { "surface-A": "hidden", "surface-B": "history" },
    };
    const hidden = exchangeVisibility(surface, preferences, null);
    assert.equal(hidden.view, view);
    assert.equal(hidden.interaction, "hidden");
    assert.equal(hidden.inputVisible, false);
    assert.equal(hidden.conversationVisible, false);
    for (const mode of ["input", "recent", "history"] as const) {
      preferences.interactions!["surface-A"] = mode;
      const visible = exchangeVisibility(surface, preferences, null);
      assert.equal(visible.view, view);
      assert.equal(visible.interaction, view);
      assert.equal(visible.inputVisible, true);
      assert.equal(visible.conversationVisible, view !== "input");
      assert.equal(visible.historyVisible, view === "history");
    }
  }
});
