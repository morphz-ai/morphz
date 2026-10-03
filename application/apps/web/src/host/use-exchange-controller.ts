import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  afterSend,
  revealInput,
  type InteractionMode,
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
  pinnedInputs?: Record<string, boolean>;
  exchangeHeights?: Record<string, number>;
};
type ResizePreview = { scope: string; mode: "recent" } | null;

/** Visibility is a projection of the existing work-surface preferences. The
 * resize preview is transient, not a second persisted interaction model. */
export function exchangeVisibility(
  surface: ExchangeSurface,
  preferences: ExchangePreferences,
  preview: ResizePreview,
) {
  const interaction =
    (preview?.scope === surface.exchangeKey ? preview.mode : undefined) ??
    preferences.interactions?.[surface.exchangeKey] ??
    "input";
  return {
    interaction,
    inputVisible: surface.dialogueCanvas || interaction !== "hidden",
    conversationVisible:
      surface.dialogueCanvas ||
      !!surface.selectedConversation?.archivedAt ||
      interaction === "recent" ||
      interaction === "history",
    historyVisible: surface.dialogueCanvas || interaction === "history",
    inputPinned: !!preferences.pinnedInputs?.[surface.exchangeKey],
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
  const { interaction, inputVisible, inputPinned } = visibility;
  const keepExchangeOpen = useExchangeFocus({
    root: exchange,
    scope: exchangeKey,
    visible: inputVisible,
    pinned: inputPinned,
    suspended,
    onLeave: () => setInteraction("hidden"),
  });
  const latestInteraction = useRef(interaction);
  latestInteraction.current = interaction;
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
  function setInteraction(mode: InteractionMode, id = navigationProject?.id) {
    clearResizePreview();
    if (id)
      prefer({
        interactions: {
          [id === navigationProject?.id ? exchangeKey : id]: mode,
        },
      });
  }
  function showInput() {
    keepExchangeOpen();
    onShowInput();
    previousFocus.current = document.activeElement as HTMLElement;
    requestedComposerFocus.current = navigationGeneration.current;
    setInteraction(revealInput(interaction));
  }
  function hideInput() {
    if (surface.dialogueCanvas) {
      input.current?.blur();
      return;
    }
    setInteraction("hidden");
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
    if (latestInteraction.current !== "hidden")
      sentInputFocus.current = {
        key,
        generation: navigationGeneration.current,
      };
  }
  function showSentInput(key: string) {
    setInteraction(afterSend(latestInteraction.current));
    requestSentInputFocus(key);
  }
  function toggleInputPin() {
    keepExchangeOpen();
    if (inputPinned) input.current?.focus();
    prefer({ pinnedInputs: { [exchangeKey]: !inputPinned } });
  }
  const resize: ExchangeResizeOptions = {
    scope: exchangeKey,
    mode: interaction,
    height: preferences.exchangeHeights?.[exchangeKey],
    onStart: keepExchangeOpen,
    onPreview: (mode) =>
      setResizePreview((previous) =>
        mode
          ? { scope: exchangeKey, mode }
          : previous?.scope === exchangeKey
            ? null
            : previous,
      ),
    onCommit: ({ mode, height }) => {
      keepExchangeOpen();
      clearResizePreview();
      prefer({
        interactions: { [exchangeKey]: mode },
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
