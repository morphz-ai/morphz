import type { TextQuote } from "../../../packages/core/src/text-quotes.js";

type QuotedDraft = { textQuotes?: TextQuote[] };

export function updateComposerDraft<T extends QuotedDraft>(
  previous: Record<string, T>,
  key: string,
  empty: T,
  update: (current: T) => T,
): Record<string, T> {
  const quotesKey = key.split(":")[0] + ":quotes";
  const currentQuotes = previous[quotesKey]?.textQuotes ?? [];
  const { textQuotes = currentQuotes, ...surface } = update({
    ...(previous[key] ?? empty),
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
