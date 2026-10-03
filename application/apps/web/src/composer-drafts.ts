import type { TextQuote } from "../../../packages/core/src/text-quotes.js";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";

type QuotedDraft = { textQuotes?: TextQuote[] };
type ComposerExecutionChoice = {
  model?: string;
  reasoningEffort?: ReasoningEffort;
};
type ArtifactComposeDraft = QuotedDraft &
  ComposerExecutionChoice & {
    body: string;
    selection: string;
    revision: number | null;
    reading?: unknown;
    page?: number;
    continuation?: unknown;
    continuationFailure?: unknown;
    pendingSupplement?: unknown;
    annotation?: boolean;
    taskResult?: unknown;
    scriptGeneration?: unknown;
  };

/** Embedded compose prepares ordinary input on the destination surface. It
 * must not consume that surface's settings or repurpose a bound operation. */
export function composeArtifactDrafts<T extends ArtifactComposeDraft>(
  previous: Record<string, T>,
  key: string,
  empty: T,
  text: string,
  revision: number | null,
  legacyKey?: string,
):
  | { ok: true; drafts: Record<string, T>; bodyChanged: boolean }
  | { ok: false; error: string } {
  const current =
    previous[key] ?? (legacyKey ? previous[legacyKey] : undefined) ?? empty;
  if (
    current.continuation ||
    current.continuationFailure ||
    current.pendingSupplement ||
    current.annotation ||
    current.taskResult ||
    current.scriptGeneration
  )
    return {
      ok: false,
      error: "目标输入中已有专用请求，请先处理原请求；原输入已保留。",
    };
  const body = [current.body, text].filter(Boolean).join("\n");
  if (body.length > 30000)
    return {
      ok: false,
      error: "追加后正文超过 30000 字，请缩短文字；原输入已保留。",
    };
  return {
    ok: true,
    drafts: {
      ...previous,
      [key]: {
        ...current,
        body,
        // Keep the exact old source even if the object head has advanced.
        // A legacy unbound selection is not authority to guess a new version.
        revision:
          current.revision ??
          (current.selection || current.reading || current.page !== undefined
            ? null
            : revision),
      },
    },
    bodyChanged: body !== current.body,
  };
}

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
