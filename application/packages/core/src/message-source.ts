import type { RecordedInput } from "./model.js";

type MessageSource = Partial<
  Pick<RecordedInput, "body" | "textQuotes" | "attachments">
>;

/** A deterministic excerpt of an authorized original input, not a generated
 * title, message identity or read grant. Shared by history, live and UI. */
export function messageSourceSummary(
  input: MessageSource | undefined,
): string | null {
  if (!input) return null;
  const text =
    input.body?.trim() ||
    input.textQuotes
      ?.map((quote) => quote.comment.trim())
      .filter(Boolean)
      .join("；") ||
    input.textQuotes
      ?.map((quote) => quote.text.trim())
      .filter(Boolean)
      .join("；") ||
    input.attachments?.map((attachment) => attachment.name).join("、") ||
    "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const chars = Array.from(compact);
  return chars.length > 50 ? chars.slice(0, 50).join("") + "…" : compact;
}
