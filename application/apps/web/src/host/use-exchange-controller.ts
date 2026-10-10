import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  afterSend,
  afterLeave,
  exchangeView,
  readingMode,
  revealInput,
  withoutInput,
  type InteractionMode,
  type ExchangeView,
} from "../interaction.js";
import { useExchangeFocus } from "../useExchangeFocus.js";
import type { ExchangeResizeOptions } from "../ExchangeResizeHandle.js";
import type { deriveWorkSurface } from "./work-surface.js";

type ExchangeSurface = Pick<
  ReturnType<typeof deriveWorkSurface>,
  | "navigationProject"
  | "selectedConversation"
  | "exchangeKey"
  | "contextKey"
  | "conversationId"
  | "dialogueCanvas"
>;
export type ExchangePreferences = {
  interactions?: Record<string, InteractionMode>;
  exchangeViews?: Record<string, "input" | "recent" | "history">;
  pinnedInputs?: Record<string, boolean>;
  pinnedHistories?: Record<string, boolean>;
  exchangeHeights?: Record<string, number>;
};
type ResizePreview = { scope: string; mode: "recent" | "recent-only" } | null;

/** Visibility is a projection of the existing work-surface preferences. The
 * resize preview is transient, not a second persisted interaction model. */
export function exchangeVisibility(
  surface: ExchangeSurface,
  preferences: ExchangePreferences,
  preview: ResizePreview,
) {
  const layout = preferences.interactions?.[surface.exchangeKey] ?? "input";
  const view = exchangeView(
    layout,
    preferences.exchangeViews?.[surface.exchangeKey],
  );
  const interaction =
    (preview?.scope === surface.exchangeKey ? preview.mode : undefined) ??
    (layout === "hidden"
      ? "hidden"
      : layout === "recent-only" || layout === "history-only"
        ? withoutInput(view)
        : view);
  return {
    interaction,
    view,
    inputVisible:
      surface.dialogueCanvas ||
      interaction === "input" ||
      interaction === "recent" ||
      interaction === "history",
    conversationVisible:
      surface.dialogueCanvas ||
      !!surface.selectedConversation?.archivedAt ||
      readingMode(interaction) === "recent" ||
      readingMode(interaction) === "history",
    historyVisible:
      surface.dialogueCanvas || readingMode(interaction) === "history",
    inputPinned: !!preferences.pinnedInputs?.[surface.exchangeKey],
    historyPinned: !!preferences.pinnedHistories?.[surface.exchangeKey],
  };
}

/** Owns exchange layout intent and focus requests, not drafts, navigation,
 * message delivery, read receipts or ExchangePanel's DOM/geometry. */
export function useExchangeController({
  surface,
  preferences,
  input,
  exchange,
  toggle,
  navigationGeneration,
  sending,
  suspended,
  prefer,
  onShowInput,
}: {
  surface: ExchangeSurface;
  preferences: ExchangePreferences;
  input: RefObject<HTMLTextAreaElement | null>;
  exchange: RefObject<HTMLDivElement | null>;
  toggle: RefObject<HTMLButtonElement | null>;
  navigationGeneration: RefObject<number>;
  sending: boolean;
  suspended: boolean;
  prefer: (change: Partial<ExchangePreferences>) => void;
  onShowInput: () => void;
}) {
  const { navigationProject, exchangeKey, contextKey, conversationId } =
    surface;
  const [resizePreview, setResizePreview] = useState<ResizePreview>(null);
  const visibility = exchangeVisibility(surface, preferences, resizePreview);
  const {
    interaction,
    view,
    inputVisible,
    conversationVisible,
    inputPinned,
    historyPinned,
  } = visibility;
  const collapsed = afterLeave(interaction, inputPinned, historyPinned, view);
  const keepExchangeOpen = useExchangeFocus({
    root: exchange,
    scope: exchangeKey,
    visible: inputVisible || conversationVisible,
    pinned: collapsed === interaction,
    suspended,
    onLeave: () => commitInteraction(collapsed),
  });
  const latestInteraction = useRef({ interaction, view });
  latestInteraction.current = { interaction, view };
  const previousFocus = useRef<HTMLElement | null>(null);
  const requestedComposerFocus = useRef<number | null>(null);
  const requestedConversationFocus = useRef<{
    id: string;
    generation: number;
  } | null>(null);
  const sentInputFocus = useRef<{
    key: string;
    generation: number;
  } | null>(null);

  function clearResizePreview() {
    setResizePreview(null);
  }
  function commitInteraction(
    mode: InteractionMode,
    id = navigationProject?.id,
    selected?: ExchangeView,
  ) {
    clearResizePreview();
    if (id) {
      const scope = id === navigationProject?.id ? exchangeKey : id;
      prefer({
        interactions: { [scope]: mode },
        exchangeViews: {
          [scope]:
            selected ??
            exchangeView(
              preferences.interactions?.[scope] ?? "input",
              preferences.exchangeViews?.[scope],
            ),
        },
      });
    }
  }
  function setInteraction(mode: InteractionMode, id = navigationProject?.id) {
    if (id === navigationProject?.id && mode !== "hidden") keepExchangeOpen();
    commitInteraction(mode, id, exchangeView(mode));
  }
  function showInput() {
    keepExchangeOpen();
    onShowInput();
    previousFocus.current = document.activeElement as HTMLElement;
    requestedComposerFocus.current = navigationGeneration.current;
    commitInteraction(revealInput(interaction, view));
  }
  function hideInput() {
    if (surface.dialogueCanvas) {
      input.current?.blur();
      return;
    }
    // Preserve the existing collapse shortcut: an unpinned reading preview
    // follows input collapse. Only explicitly pinned history remains visible.
    commitInteraction(historyPinned ? withoutInput(interaction) : "hidden");
    if (document.activeElement?.closest("#global-composer")) {
      const origin = document.activeElement;
      const restore = previousFocus.current;
      const generation = navigationGeneration.current;
      requestAnimationFrame(() => {
        // A newer focus or reopen wins over this delayed hide callback.
        if (generation !== navigationGeneration.current || input.current)
          return;
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          active !== origin &&
          active.isConnected
        )
          return;
        if (restore?.isConnected) restore.focus();
        else toggle.current?.focus();
      });
    }
  }
  function requestConversationFocus(id: string, generation: number) {
    requestedConversationFocus.current = { id, generation };
  }
  function requestSentInputFocus(key: string) {
    if (latestInteraction.current.interaction !== "hidden")
      sentInputFocus.current = {
        key,
        generation: navigationGeneration.current,
      };
  }
  function showSentInput(key: string) {
    const latest = latestInteraction.current;
    const mode = afterSend(latest.interaction, latest.view);
    commitInteraction(mode, navigationProject?.id, latest.view);
    requestSentInputFocus(key);
  }
  function toggleInputPin() {
    keepExchangeOpen();
    if (inputPinned) {
      input.current?.focus();
    }
    prefer({ pinnedInputs: { [exchangeKey]: !inputPinned } });
  }
  function toggleHistoryPin() {
    keepExchangeOpen();
    prefer({ pinnedHistories: { [exchangeKey]: !historyPinned } });
  }
  const resize: ExchangeResizeOptions = {
    scope: exchangeKey,
    mode: readingMode(interaction),
    height: preferences.exchangeHeights?.[exchangeKey],
    onStart: keepExchangeOpen,
    onPreview: (mode) =>
      setResizePreview((previous) =>
        mode
          ? { scope: exchangeKey, mode: inputVisible ? mode : "recent-only" }
          : previous?.scope === exchangeKey
            ? null
            : previous,
      ),
    onCommit: ({ mode, height }) => {
      keepExchangeOpen();
      clearResizePreview();
      prefer({
        interactions: {
          [exchangeKey]: inputVisible ? mode : withoutInput(mode),
        },
        exchangeViews: { [exchangeKey]: exchangeView(mode) },
        ...(mode === "recent"
          ? { exchangeHeights: { [exchangeKey]: height } }
          : {}),
      });
    },
  };

  // These commits are registered separately below so App preserves its existing
  // layout-effect order after canvas/trail restoration. Requests stay private.
  const focus = {
    sending,
    contextKey,
    inputVisible,
    composer() {
      const generation = requestedComposerFocus.current;
      if (generation === null) return;
      requestedComposerFocus.current = null;
      if (
        generation === navigationGeneration.current &&
        inputVisible &&
        input.current
      ) {
        keepExchangeOpen();
        input.current.focus({ preventScroll: true });
      }
    },
    conversation() {
      const request = requestedConversationFocus.current;
      if (!request) return;
      if (request.generation !== navigationGeneration.current) {
        requestedConversationFocus.current = null;
        return;
      }
      if (request.id === conversationId && inputVisible && input.current) {
        requestedConversationFocus.current = null;
        keepExchangeOpen();
        input.current.focus();
      }
    },
    sent() {
      const request = sentInputFocus.current;
      if (!request || sending) return;
      sentInputFocus.current = null;
      if (
        request.key === contextKey &&
        request.generation === navigationGeneration.current &&
        inputVisible &&
        input.current
      ) {
        keepExchangeOpen();
        input.current.focus();
      }
    },
  };
  return {
    ...visibility,
    keepExchangeOpen,
    clearResizePreview,
    setInteraction,
    showInput,
    hideInput,
    requestConversationFocus,
    requestSentInputFocus,
    showSentInput,
    toggleInputPin,
    toggleHistoryPin,
    resize,
    sentInputFocusPending: !!sentInputFocus.current,
    focus,
  };
}

/** Same three layout commits, in the same order and with the original deps.
 * Call after canvas/trail restoration and before dependent inspector effects. */
export function useExchangeControllerFocus(
  controller: ReturnType<typeof useExchangeController>,
) {
  const { focus } = controller;
  useLayoutEffect(() => focus.composer());
  useLayoutEffect(() => focus.conversation());
  useLayoutEffect(
    () => focus.sent(),
    [focus.sending, focus.contextKey, focus.inputVisible],
  );
}
