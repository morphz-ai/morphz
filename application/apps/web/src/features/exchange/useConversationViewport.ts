import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Workspace } from "../../../../../packages/core/src/model.js";
import type { LiveMessage } from "../../../../../packages/core/src/live-conversation.js";
import type { TextQuote } from "../../../../../packages/core/src/text-quotes.js";
import type { WorkspaceClient } from "../../client.js";
import type { ReplyReceipt } from "../../conversation-read.js";
import { shouldFollow } from "../../interaction.js";
import { locateTextQuote } from "../../text-quote-dom.js";

export type ExchangePosition = {
  top: number;
  following: boolean;
  revealed: string | null;
};

const viewportRegistration = Symbol("conversation viewport registration");

type ConversationViewportStateOptions = {
  conversationId: string;
  focused: boolean;
  focusedArtifactId?: string;
  focusedApplicationId?: string;
  focusedCognitiveKey?: string;
  positions: Map<string, ExchangePosition>;
  revealInputId: string | null;
};

/** Register the reading state before the renderer builds its timeline. */
export function useConversationViewportState({
  conversationId,
  focused,
  focusedArtifactId,
  focusedApplicationId,
  focusedCognitiveKey,
  positions,
  revealInputId,
}: ConversationViewportStateOptions) {
  const scroller = useRef<HTMLElement>(null);
  const prependPosition = useRef<{
    key: string;
    height: number;
    top: number;
  } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState("");
  const revealedQuote = useRef<string | null>(null);
  const loadingQuote = useRef<string | null>(null);
  const latestButton = useRef<HTMLButtonElement>(null);
  const positionKey =
    focused && focusedCognitiveKey !== undefined
      ? JSON.stringify(["cognitive", conversationId, focusedCognitiveKey])
      : conversationId +
        (focused
          ? ":focus:" + (focusedArtifactId ?? focusedApplicationId)
          : ":all");
  const saved = positions.get(positionKey);
  const previousPositionKey = useRef(positionKey);
  const following = useRef(saved?.following ?? true);
  const initialized = useRef(false);
  const revealed = useRef(saved?.revealed ?? revealInputId);
  const [awayFromLatest, setAwayFromLatest] = useState(!following.current);
  return {
    scroller,
    latestButton,
    loadingEarlier,
    earlierError,
    awayFromLatest,
    // Only the commit hook consumes this render's private registration handle.
    [viewportRegistration]: {
      positions,
      revealInputId,
      prependPosition,
      revealedQuote,
      loadingQuote,
      previousPositionKey,
      following,
      initialized,
      revealed,
      positionKey,
      saved,
      setLoadingEarlier,
      setEarlierError,
      setAwayFromLatest,
    },
  };
}

type ConversationViewportState = ReturnType<
  typeof useConversationViewportState
>;
type ConversationViewportCommitOptions = {
  contentVersion: string;
  readVersion: string;
  receipts: ReplyReceipt[];
  onRead: (receipts: ReplyReceipt[]) => void;
  onFocusComposer?: () => void;
  onLoadEarlierHistory?: () => Promise<void>;
  quoteReveal?: { quote: TextQuote; token: string } | null;
  onQuoteUnavailable?: (reason?: string) => void;
  focused: boolean;
  allInputs: Workspace["inputs"];
  messages: LiveMessage[];
  hasEarlierHistory?: boolean;
  setAllHistory: Dispatch<SetStateAction<boolean>>;
  client: Pick<WorkspaceClient, "loadHistoryUntil">;
};

/** Commit reading/navigation state; observe content geometry after layout. */
export function useConversationViewportCommit(
  viewport: ConversationViewportState,
  {
    contentVersion,
    readVersion,
    receipts,
    onRead,
    onFocusComposer,
    onLoadEarlierHistory,
    quoteReveal,
    onQuoteUnavailable,
    focused,
    allInputs,
    messages,
    hasEarlierHistory,
    setAllHistory,
    client,
  }: ConversationViewportCommitOptions,
) {
  const { scroller, latestButton, loadingEarlier } = viewport;
  const {
    positions,
    revealInputId,
    prependPosition,
    revealedQuote,
    loadingQuote,
    previousPositionKey,
    following,
    initialized,
    revealed,
    positionKey,
    saved,
    setLoadingEarlier,
    setEarlierError,
    setAwayFromLatest,
  } = viewport[viewportRegistration];
  async function loadEarlier() {
    if (
      !onLoadEarlierHistory ||
      loadingEarlier ||
      prependPosition.current?.key === positionKey
    )
      return;
    const el = scroller.current;
    if (el)
      prependPosition.current = {
        key: positionKey,
        height: el.scrollHeight,
        top: el.scrollTop,
      };
    setLoadingEarlier(true);
    setEarlierError("");
    try {
      await onLoadEarlierHistory();
    } catch (error) {
      prependPosition.current = null;
      setEarlierError(
        error instanceof Error ? error.message : "旧消息暂时无法读取，请重试。",
      );
    } finally {
      setLoadingEarlier(false);
    }
  }
  function acknowledgeVisibleReplies() {
    if (
      following.current &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      !document.querySelector("dialog[open]")
    )
      onRead(receipts);
  }
  function updateLatestIndicator() {
    if (following.current) {
      // Move focus before removing its button. A detached focused control
      // otherwise looks like leaving the unpinned exchange. Do not steal
      // focus when ordinary scrolling or new content reaches the bottom.
      if (latestButton.current === document.activeElement) {
        onFocusComposer?.();
        if (latestButton.current === document.activeElement)
          scroller.current?.focus({ preventScroll: true });
      }
      acknowledgeVisibleReplies();
    }
    setAwayFromLatest(!following.current);
  }
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (previousPositionKey.current !== positionKey) {
      initialized.current = false;
      following.current = saved?.following ?? true;
      revealed.current = saved?.revealed ?? revealInputId;
      previousPositionKey.current = positionKey;
    }
    // Initial restore and explicit navigation must settle before paint. Normal
    // stream growth follows in ResizeObserver, after the browser lays it out;
    // reading scrollHeight here forces the whole message DOM to lay out during
    // each React commit, including the nested read-receipt commit.
    const commitPosition =
      !initialized.current ||
      (!!revealInputId && revealed.current !== revealInputId);
    if (!initialized.current && saved) el.scrollTop = saved.top;
    if (revealInputId && revealed.current !== revealInputId)
      following.current = true;
    if (following.current && commitPosition) {
      el.scrollTop = el.scrollHeight;
    }
    revealed.current = revealInputId;
    initialized.current = true;
    updateLatestIndicator();
    if (commitPosition)
      positions.set(positionKey, {
        top: el.scrollTop,
        following: following.current,
        revealed: revealed.current,
      });
  }, [contentVersion, readVersion, revealInputId, positionKey, onRead]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const old = prependPosition.current;
    if (!el || !old || old.key !== positionKey || loadingEarlier) return;
    following.current = false;
    el.scrollTop = old.top + el.scrollHeight - old.height;
    positions.set(positionKey, {
      top: el.scrollTop,
      following: false,
      revealed: revealed.current,
    });
    setAwayFromLatest(true);
    prependPosition.current = null;
  }, [contentVersion, loadingEarlier, positionKey]);
  useEffect(() => {
    const read = () => acknowledgeVisibleReplies();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    document.addEventListener("focusin", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      document.removeEventListener("focusin", read);
    };
  }, [readVersion, positionKey, onRead]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (following.current) {
        el.scrollTop = el.scrollHeight;
        positions.set(positionKey, {
          top: el.scrollTop,
          following: true,
          revealed: revealed.current,
        });
      }
    });
    observer.observe(el);
    const content = el.querySelector(".conversation-messages");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [contentVersion, positionKey]);
  useLayoutEffect(() => {
    if (!quoteReveal || revealedQuote.current === quoteReveal.token) return;
    const quote = quoteReveal.quote.source;
    if (quote.kind !== "message") return;
    const el = scroller.current;
    const message = el?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(quote.messageId)}"]`,
    );
    if (!message) {
      if (
        focused &&
        (allInputs.some((item) => item.id === quote.messageId) ||
          messages.some((item) => item.id === quote.messageId))
      ) {
        setAllHistory(true);
      } else if (
        hasEarlierHistory &&
        loadingQuote.current !== quoteReveal.token
      ) {
        loadingQuote.current = quoteReveal.token;
        void client.loadHistoryUntil(quote.messageId).then(
          (found) => {
            if (!found) {
              revealedQuote.current = quoteReveal.token;
              onQuoteUnavailable?.();
            }
          },
          (error: unknown) => {
            revealedQuote.current = quoteReveal.token;
            onQuoteUnavailable?.(
              error instanceof Error ? error.message : undefined,
            );
          },
        );
      } else {
        if (loadingQuote.current !== quoteReveal.token) {
          revealedQuote.current = quoteReveal.token;
          onQuoteUnavailable?.();
        }
      }
      return;
    }
    revealedQuote.current = quoteReveal.token;
    // A source jump is explicit navigation, not a request to follow new output.
    following.current = false;
    el!.scrollTop +=
      message.getBoundingClientRect().top -
      el!.getBoundingClientRect().top -
      24;
    setAwayFromLatest(true);
    positions.set(positionKey, {
      top: el!.scrollTop,
      following: false,
      revealed: revealed.current,
    });
    const range = locateTextQuote(quoteReveal.quote);
    if (range) {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    message.setAttribute("data-quote-revealed", "true");
    const timeout = window.setTimeout(
      () => message.removeAttribute("data-quote-revealed"),
      2200,
    );
    return () => {
      clearTimeout(timeout);
      message.removeAttribute("data-quote-revealed");
    };
  }, [quoteReveal, focused, contentVersion, hasEarlierHistory]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const previousTop = positions.get(positionKey)?.top;
    following.current = shouldFollow(
      el.scrollHeight - el.clientHeight - el.scrollTop,
    );
    updateLatestIndicator();
    positions.set(positionKey, {
      top: el.scrollTop,
      following: following.current,
      revealed: revealed.current,
    });
    // Only movement towards older content requests a page. Mount/restore,
    // auto-follow and prepend anchoring must never drain the history cursor.
    if (
      hasEarlierHistory &&
      previousTop !== undefined &&
      el.scrollTop < previousTop &&
      el.scrollTop < 80
    )
      void loadEarlier();
  };
  const returnLatest = () => {
    following.current = true;
    if (scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
    updateLatestIndicator();
  };
  return { loadEarlier, onScroll, returnLatest };
}

/** Explicit message navigation has no quote bytes or business command. The
 * quote-selection effect above retains its distinct exact-range contract. */
export function useConversationMessageReveal(
  messageViewport: ConversationViewportState,
  {
    request,
    contentVersion,
    quoteToken,
    focused,
    allInputs,
    messages,
    hasEarlierHistory,
    setAllHistory,
    client,
    onUnavailable,
  }: {
    request: { messageId: string; token: string } | null;
    contentVersion: string;
    quoteToken?: string;
    focused: boolean;
    allInputs: Workspace["inputs"];
    messages: LiveMessage[];
    hasEarlierHistory?: boolean;
    setAllHistory: Dispatch<SetStateAction<boolean>>;
    client: Pick<WorkspaceClient, "loadHistoryUntil">;
    onUnavailable?: (reason?: string) => void;
  },
) {
  const { scroller } = messageViewport;
  const { following, positions, positionKey, revealed, setAwayFromLatest } =
    messageViewport[viewportRegistration];
  const complete = useRef<string | null>(null),
    loading = useRef<string | null>(null);
  const latest = useRef({
    token: request?.token,
    key: positionKey,
    quoteToken,
  });
  latest.current = { token: request?.token, key: positionKey, quoteToken };
  useLayoutEffect(() => {
    if (!request || complete.current === request.token) return;
    const el = scroller.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(request.messageId)}"]`,
    );
    if (!target) {
      if (
        focused &&
        (allInputs.some((i) => i.id === request.messageId) ||
          messages.some((m) => m.id === request.messageId))
      ) {
        setAllHistory(true);
      } else if (hasEarlierHistory && loading.current !== request.token) {
        loading.current = request.token;
        following.current = false;
        setAwayFromLatest(true);
        const current = () =>
          scroller.current === el &&
          latest.current.token === request.token &&
          latest.current.key === positionKey &&
          latest.current.quoteToken === quoteToken;
        void client.loadHistoryUntil(request.messageId).then(
          (found) => {
            if (current() && !found) {
              complete.current = request.token;
              onUnavailable?.();
            }
          },
          (cause: unknown) => {
            if (current()) {
              complete.current = request.token;
              onUnavailable?.(
                cause instanceof Error ? cause.message : undefined,
              );
            }
          },
        );
      } else if (loading.current !== request.token) {
        complete.current = request.token;
        onUnavailable?.();
      }
      return;
    }
    complete.current = request.token;
    following.current = false;
    el.scrollTop +=
      target.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
    setAwayFromLatest(true);
    positions.set(positionKey, {
      top: el.scrollTop,
      following: false,
      revealed: revealed.current,
    });
    target.setAttribute("data-quote-revealed", "true");
    const timer = setTimeout(
      () => target.removeAttribute("data-quote-revealed"),
      2200,
    );
    return () => {
      clearTimeout(timer);
      target.removeAttribute("data-quote-revealed");
    };
  }, [request, contentVersion, focused, hasEarlierHistory, quoteToken]);
}
