type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const prose = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"]);
const literal = new Set([
  "code",
  "pre",
  "script",
  "style",
  "textarea",
  "svg",
  "math",
  "annotation",
]);
const blocks = new Set([
  ...prose,
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "div",
  "section",
]);

/** Soft source breaks are meaningful in conversation and object prose. Run
 * after text-reveal decoration: source positions and stored Markdown stay
 * untouched. Generated whitespace between blocks is not a source break. */
export function preserveMarkdownLineBreaks() {
  return (tree: Node) => {
    const visit = (node: Node, inline = false) => {
      if (!node.children || literal.has(node.tagName ?? "")) return;
      const content = inline || prose.has(node.tagName ?? "");
      const original = node.children;
      node.children = original.flatMap((child, index) => {
        if (child.type !== "text") {
          visit(child, content);
          return [child];
        }
        const value = child.value ?? "";
        // Tight list items have no <p>. Skip the serializer's whitespace
        // around nested lists/blocks, while keeping their inline soft breaks.
        const tightList =
          node.tagName === "li" &&
          (!/^\s*$/.test(value) ||
            (!blocks.has(original[index - 1]?.tagName ?? "") &&
              !blocks.has(original[index + 1]?.tagName ?? "")));
        if ((!content && !tightList) || !/[\r\n]/.test(value)) return [child];
        const result: Node[] = [];
        const parts = value.split(/\r\n|\r|\n/);
        // mdast-to-hast already emits <br> plus a formatting newline for an
        // explicit Markdown hard break. It must not become a second <br>.
        if (original[index - 1]?.tagName === "br" && parts[0] === "")
          parts.shift();
        parts.forEach((part, at) => {
          if (at)
            result.push({
              type: "element",
              tagName: "br",
              properties: {},
              children: [],
            });
          if (part) result.push({ ...child, value: part });
        });
        return result;
      });
    };
    visit(tree);
  };
}
