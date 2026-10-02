import type { TextQuote } from "../../../packages/core/src/text-quotes.js";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";

type QuotedDraft = { textQuotes?: TextQuote[] };
type ComposerExecutionChoice = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

/** Sending consumes contents and exact source bindings, not the user's choice
 * for subsequent inputs on this work surface. The admitted payload is already
 * frozen separately; preserve the latest local choice, not its old snapshot. */
export function consumeComposerDraft<
  T extends QuotedDraft & ComposerExecutionChoice,
>(current: T, empty: T): T {
  return {
    ...empty,
    model: current.model,
    reasoningEffort: current.reasoningEffort,
    textQuotes: [],
  };
}

export function updateComposerDraft<T extends QuotedDraft>(
  previous: Record<string, T>,
  key: string,
  empty: T,
  update: (current: T) => T,
  initial: T = empty,
): Record<string, T> {
  const quotesKey = key.split(":")[0] + ":quotes";
  const currentQuotes = previous[quotesKey]?.textQuotes ?? [];
  const { textQuotes = currentQuotes, ...surface } = update({
    ...(previous[key] ?? initial),
    textQuotes: currentQuotes,
  });
  return {
    ...previous,
    [key]: surface as T,
    [quotesKey]: { ...empty, textQuotes },
  };
}

export function replaceComposerSurface<T extends QuotedDraft>(
  previous: Record<string, T>,
  key: string,
  empty: T,
  value: T,
): Record<string, T> {
  // A rendered surface can carry an old copy of the conversation-wide quotes.
  // Only an explicit quote update may replace them.
  return updateComposerDraft(previous, key, empty, (current) => ({
    ...value,
    textQuotes: current.textQuotes,
  }));
}
