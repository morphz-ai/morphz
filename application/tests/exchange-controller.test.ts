import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeVisibility,
  type ExchangePreferences,
} from "../apps/web/src/host/use-exchange-controller.js";

type Surface = Parameters<typeof exchangeVisibility>[0];
const surface: Surface = {
  navigationProject: undefined,
  selectedConversation: undefined,
  exchangeKey: "surface-A",
  contextKey: "conversation-A:object-A",
  conversationId: "conversation-A",
  dialogueCanvas: false,
};

test("exchange visibility reads the existing four modes, scoped pin and preview", () => {
  for (const interaction of ["hidden", "input", "recent", "history"] as const) {
    const preferences: ExchangePreferences = {
      interactions: { "surface-A": interaction, "surface-B": "history" },
      pinnedInputs: { "surface-A": false, "surface-B": true },
    };
    assert.deepEqual(exchangeVisibility(surface, preferences, null), {
      interaction,
      inputVisible: interaction !== "hidden",
      conversationVisible:
        interaction === "recent" || interaction === "history",
      historyVisible: interaction === "history",
      inputPinned: false,
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
        inputVisible: true,
        conversationVisible: true,
        historyVisible: true,
        inputPinned: false,
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
