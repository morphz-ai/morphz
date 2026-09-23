import {
  textQuoteSourceSchema,
  quoteSourceKey,
  type TextQuote,
  type TextQuoteSource,
} from "../../../packages/core/src/text-quotes.js";

export type QuotePoint = { x: number; y: number };
export type QuoteSelection = {
  quote: TextQuote;
  point: QuotePoint;
  range?: Range;
};
export function quoteSource(source: TextQuoteSource) {
  return { "data-text-source": JSON.stringify(source) };
}
const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;
type TextField = HTMLInputElement | HTMLTextAreaElement;
const fieldKey = (field: TextField, root: HTMLElement) =>
  field.getAttribute("aria-label") ||
  field.name ||
  field.id ||
  `field:${Array.from(root.querySelectorAll("input,textarea")).indexOf(field)}`;

export function locateTextQuoteField(quote: TextQuote) {
  if (!quote.draft || !quote.anchor?.field) return null;
  for (const field of document.querySelectorAll<TextField>(
    "textarea,input[type=text],input[type=search]",
  )) {
    const root = field.closest<HTMLElement>("[data-text-source]");
    if (!root || !field.getClientRects().length) continue;
    try {
      const source = textQuoteSourceSchema.parse(
        JSON.parse(root.dataset.textSource!),
      );
      if (
        quoteSourceKey(source) !== quoteSourceKey(quote.source) ||
        fieldKey(field, root) !== quote.anchor.field
      )
        continue;
      if (
        field.value.slice(quote.anchor.start, quote.anchor.end) === quote.text
      )
        return field;
    } catch {
      /* The source may have been replaced while navigating. */
    }
  }
  return null;
}
export function revealTextQuote(quote: TextQuote) {
  const field = locateTextQuoteField(quote);
  if (field) {
    field.scrollIntoView({ block: "center" });
    field.focus({ preventScroll: true });
    field.setSelectionRange(quote.anchor!.start, quote.anchor!.end);
    return true;
  }
  const range = locateTextQuote(quote);
  if (!range) return false;
  range.startContainer.parentElement?.scrollIntoView({ block: "center" });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}
export function captureTextQuote(): QuoteSelection | null {
  const field = document.activeElement;
  if (
    (field instanceof HTMLTextAreaElement ||
      (field instanceof HTMLInputElement &&
        ["text", "search"].includes(field.type))) &&
    !field.closest("[data-quote-ignore], [data-quote-ui], .composer, dialog")
  ) {
    const root = field.closest<HTMLElement>("[data-text-source]"),
      start = field.selectionStart,
      end = field.selectionEnd;
    if (
      root &&
      start !== null &&
      end !== null &&
      end > start &&
      field.value.slice(start, end).trim()
    ) {
      try {
        const source = textQuoteSourceSchema.parse(
            JSON.parse(root.dataset.textSource!),
          ),
          rect = field.getBoundingClientRect(),
          text = field.value.slice(start, end).trim(),
          offset = start + field.value.slice(start, end).indexOf(text);
        return {
          quote: {
            id: crypto.randomUUID(),
            source,
            text,
            comment: "",
            draft: true,
            anchor: {
              start: offset,
              end: offset + text.length,
              prefix: field.value.slice(Math.max(0, offset - 40), offset),
              suffix: field.value.slice(
                offset + text.length,
                offset + text.length + 40,
              ),
              field: fieldKey(field, root),
            },
          },
          point: { x: rect.right, y: Math.min(innerHeight - 50, rect.bottom) },
        };
      } catch {
        return null;
      }
    }
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0),
    start = elementOf(range.startContainer),
    end = elementOf(range.endContainer);
  const root = start?.closest<HTMLElement>("[data-text-source]");
  if (
    !root ||
    root !== end?.closest("[data-text-source]") ||
    start?.closest(
      "[data-quote-ignore],button,input,textarea,[contenteditable],dialog",
    ) ||
    end?.closest(
      "[data-quote-ignore],button,input,textarea,[contenteditable],dialog",
    )
  )
    return null;
  const text = range.toString().trim();
  if (!text) return null;
  let source: TextQuoteSource;
  try {
    source = textQuoteSourceSchema.parse(JSON.parse(root.dataset.textSource!));
  } catch {
    return null;
  }
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const raw = range.toString(),
    offset = before.toString().length + raw.indexOf(text);
  const all = root.textContent ?? "";
  const rect = Array.from(range.getClientRects())
    .filter((r) => r.height && r.bottom > 0 && r.top < innerHeight)
    .at(-1);
  if (!rect) return null;
  return {
    quote: {
      id: crypto.randomUUID(),
      source,
      text,
      comment: "",
      anchor: {
        start: offset,
        end: offset + text.length,
        prefix: all.slice(Math.max(0, offset - 40), offset),
        suffix: all.slice(offset + text.length, offset + text.length + 40),
      },
    },
    range: range.cloneRange(),
    point: { x: rect.right, y: rect.bottom },
  };
}

/** Match a fixed source and exact text; never highlight a different edition/page. */
export function locateTextQuote(quote: TextQuote): Range | null {
  if (quote.anchor?.field) return null;
  for (const root of document.querySelectorAll<HTMLElement>(
    "[data-text-source]",
  )) {
    let source: TextQuoteSource;
    try {
      source = textQuoteSourceSchema.parse(
        JSON.parse(root.dataset.textSource!),
      );
    } catch {
      continue;
    }
    if (
      quoteSourceKey(source) !== quoteSourceKey(quote.source) ||
      !root.getClientRects().length
    )
      continue;
    const all = root.textContent ?? "",
      anchor = quote.anchor;
    let start = anchor?.start ?? -1;
    if (
      start < 0 ||
      all.slice(start, start + quote.text.length) !== quote.text
    ) {
      start = -1;
      for (
        let found = all.indexOf(quote.text);
        found >= 0;
        found = all.indexOf(quote.text, found + 1)
      ) {
        if (
          (!anchor?.prefix ||
            all.slice(Math.max(0, found - anchor.prefix.length), found) ===
              anchor.prefix) &&
          (!anchor?.suffix ||
            all.slice(
              found + quote.text.length,
              found + quote.text.length + anchor.suffix.length,
            ) === anchor.suffix)
        ) {
          if (start >= 0) {
            start = -1;
            break;
          }
          start = found;
        }
      }
    }
    if (start < 0) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      range = document.createRange();
    let offset = 0,
      began = false,
      node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (!began && start < offset + length) {
        range.setStart(node, start - offset);
        began = true;
      }
      if (began && start + quote.text.length <= offset + length) {
        range.setEnd(node, start + quote.text.length - offset);
        return range;
      }
      offset += length;
    }
  }
  return null;
}
