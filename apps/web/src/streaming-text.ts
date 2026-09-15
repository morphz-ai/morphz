/** Streamdown-style text-node motion without token buffering or a Markdown
 * renderer replacement. Source offsets keep old text out of fresh ranges. */
export const STREAM_TEXT_DURATION = 520;
export type StreamRange = { start: number; end: number; at: number };
export type StreamTextState = {
  source: string;
  active: boolean;
  ranges: StreamRange[];
};
export function advanceStreamText(
  previous: StreamTextState,
  source: string,
  active: boolean,
  now: number,
): StreamTextState {
  if (!active || !previous.active || !source.startsWith(previous.source))
    return { source, active, ranges: [] };
  const ranges = previous.ranges.filter(
    (range) => now - range.at < STREAM_TEXT_DURATION,
  );
  if (source.length > previous.source.length)
    ranges.push({ start: previous.source.length, end: source.length, at: now });
  return { source, active, ranges };
}

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  properties?: Record<string, unknown>;
  children?: Node[];
};
const skip = new Set([
  "code",
  "pre",
  "svg",
  "math",
  "annotation",
  "script",
  "style",
]);
const words = new Intl.Segmenter("zh", { granularity: "word" });

/** Skip code/math and transformed source (e.g. entities); never manufacture an
 * offset for Markdown syntax. Links, lists, tables and emphasis keep their DOM. */
export function streamingTextPlugin(options: {
  source: string;
  ranges: StreamRange[];
}) {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || skip.has(node.tagName ?? "")) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const start = child.position?.start.offset;
        const value = child.value ?? "";
        if (
          start == null ||
          options.source.slice(
            start,
            child.position?.end.offset ?? start + value.length,
          ) !== value
        )
          return [child];
        const result: Node[] = [];
        let cursor = 0;
        for (const range of options.ranges) {
          const from = Math.max(0, range.start - start),
            to = Math.min(value.length, range.end - start);
          if (from >= to) continue;
          if (from > cursor)
            result.push({ type: "text", value: value.slice(cursor, from) });
          for (const part of words.segment(value.slice(from, to))) {
            result.push(
              /^\s+$/.test(part.segment)
                ? { type: "text", value: part.segment }
                : {
                    type: "element",
                    tagName: "span",
                    properties: {
                      "data-stream-at": range.at,
                      "data-stream-offset": start + from + part.index,
                    },
                    children: [{ type: "text", value: part.segment }],
                  },
            );
          }
          cursor = to;
        }
        if (!result.length) return [child];
        if (cursor < value.length)
          result.push({ type: "text", value: value.slice(cursor) });
        return result;
      });
    };
    visit(tree);
  };
}
