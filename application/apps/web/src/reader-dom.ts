/** Exact whole-section alignment, not indexOf(quote): repeated sentences stay distinct. */
export function readerOffsets(domText: string, sourceText: string) {
  const domToSource = new Uint32Array(domText.length + 1),
    sourceToDom = new Uint32Array(sourceText.length + 1);
  let a = 0,
    b = 0;
  while (a < domText.length || b < sourceText.length) {
    domToSource[a] = b;
    sourceToDom[b] = a;
    if (
      a < domText.length &&
      b < sourceText.length &&
      domText[a] === sourceText[b]
    ) {
      a++;
      b++;
    } else if (a < domText.length && /\s/.test(domText[a]!)) a++;
    else if (b < sourceText.length && /\s/.test(sourceText[b]!)) b++;
    else return null;
  }
  domToSource[a] = b;
  sourceToDom[b] = a;
  return { domToSource, sourceToDom };
}
export function readerRange(root: HTMLElement, start: number, end: number) {
  const range = document.createRange(),
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null,
    offset = 0,
    started = false;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= offset + length) {
      range.setStart(node, Math.max(0, start - offset));
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, Math.max(0, end - offset));
      return range;
    }
    offset += length;
  }
  return null;
}
export function readerSelection(root: HTMLElement, source: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const offsets = readerOffsets(root.textContent ?? "", source);
  if (!offsets)
    throw new Error(
      "页面文字与存储原文不一致，选文尚未提交；请重新打开这份读物。",
    );
  const start = offsets.domToSource[prefix.toString().length]!,
    end =
      offsets.domToSource[prefix.toString().length + range.toString().length]!;
  if (end - start > 8000) throw new Error("请一次选择不超过 8000 字。");
  return { start, end, rect: range.getBoundingClientRect() };
}

/** CSS highlights do not create DOM hit targets. Hit-test their actual line
 * rectangles so a click on a mark (including a PDF text layer) can edit it.
 * Keep source offsets, rather than looking up the quote: it may repeat.
 */
export function readerMarksAtPoint<
  T extends { location: { start: number; end: number } },
>(root: HTMLElement, source: string, marks: T[], x: number, y: number): T[] {
  const offsets = readerOffsets(root.textContent ?? "", source);
  if (!offsets) return [];
  return marks
    .filter((mark) => {
      const { start, end } = mark.location;
      if (start === end || end > source.length) return false;
      const range = readerRange(
        root,
        offsets.sourceToDom[start]!,
        offsets.sourceToDom[end]!,
      );
      return (
        range &&
        [...range.getClientRects()].some(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            x >= r.left &&
            x <= r.right &&
            y >= r.top &&
            y <= r.bottom,
        )
      );
    })
    .sort(
      (a, b) =>
        a.location.end - a.location.start - (b.location.end - b.location.start),
    );
}

/** Freeze the actual clicked glyph as source offsets before layout changes.
 * Each split is hit-tested against real text rectangles, never a nearest
 * caret, quote search, or the whole range of a possibly very long mark. */
export function readerSourceSpanAtPoint(
  root: HTMLElement,
  source: string,
  x: number,
  y: number,
) {
  const text = root.textContent ?? "";
  const offsets = readerOffsets(text, source);
  if (!offsets || !text.length) return null;
  const contains = (start: number, end: number) => {
    const range = readerRange(root, start, end);
    return (
      !!range &&
      [...range.getClientRects()].some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom,
      )
    );
  };
  let start = 0,
    end = text.length;
  if (!contains(start, end)) return null;
  while (end - start > 1) {
    const middle = Math.floor((start + end) / 2);
    if (contains(start, middle)) end = middle;
    else start = middle;
  }
  if (!contains(start, end)) return null;
  // A Range may address half of a surrogate pair; keep its source glyph whole.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end++;
  const from = offsets.domToSource[start]!;
  const glyph = text.slice(start, end);
  const to = from + glyph.length;
  // The next boundary may have skipped source paragraph whitespace. It is
  // not part of the clicked glyph and must not acquire unrelated mark IDs.
  return source.slice(from, to) === glyph ? { start: from, end: to } : null;
}

/** Only current, authorized marks overlapping the exact clicked source glyph.
 * Empty/currently removed results never recover an old selected mark object. */
export function readerMarksAtSourceSpan<
  T extends { location: { start: number; end: number } },
>(marks: T[], span: { start: number; end: number }): T[] {
  if (span.end <= span.start) return [];
  return marks
    .filter(
      (mark) =>
        mark.location.start < span.end &&
        mark.location.end > span.start &&
        mark.location.end > mark.location.start,
    )
    .sort(
      (a, b) =>
        a.location.end - a.location.start - (b.location.end - b.location.start),
    );
}

/** Source offsets for the reading viewport, not the overlaid conversation.
 * Inspect text geometry: scroll percentages and saved progress can be stale,
 * and identical sentences must remain distinguishable. Never copy the chapter.
 */
export function readerViewport(
  root: HTMLElement,
  source: string,
  view: HTMLElement,
  scope: "context" | "visible" = "context",
) {
  if (!source.length) return { start: 0, end: 0 };
  const offsets = readerOffsets(root.textContent ?? "", source);
  if (!offsets) return null;
  const bounds = view.getBoundingClientRect();
  const visible = (r: DOMRect) =>
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > bounds.top &&
    r.top < bounds.bottom &&
    r.right > bounds.left &&
    r.left < bounds.right;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node: Node | null,
    offset = 0,
    start = -1,
    end = 0;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    range.selectNodeContents(node);
    if (length && [...range.getClientRects()].some(visible)) {
      // A paragraph can be one long text node spanning many screens. Locate
      // its visible lines instead of attaching that entire node.
      const boundary = (bottom: boolean) => {
        let low = 0,
          high = length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          range.setStart(node!, mid);
          range.setEnd(node!, mid + 1);
          const r = range.getBoundingClientRect();
          if (bottom ? r.top < bounds.bottom : r.bottom <= bounds.top)
            low = mid + 1;
          else high = mid;
        }
        return low;
      };
      if (start < 0) start = offset + boundary(false);
      end = offset + boundary(true);
    }
    offset += length;
  }
  if (start < 0) return null;
  const from = offsets.domToSource[start] ?? 0;
  return {
    start: from,
    end:
      scope === "visible"
        ? (offsets.domToSource[end] ?? from)
        : Math.min(offsets.domToSource[end] ?? from, from + 3200),
  };
}
