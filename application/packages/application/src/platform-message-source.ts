import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";

type MarkdownNode = {
  type: string;
  value?: unknown;
  children?: MarkdownNode[];
};

function displayedText(node: MarkdownNode): string {
  if (
    (node.type === "text" ||
      node.type === "inlineCode" ||
      node.type === "code") &&
    typeof node.value === "string"
  )
    return node.value;
  if (!node.children) return "";
  const separator = new Set([
    "root",
    "list",
    "listItem",
    "blockquote",
    "table",
    "tableRow",
  ]).has(node.type)
    ? "\n"
    : "";
  return node.children.map(displayedText).join(separator);
}

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
// Match SafeMarkdown's parsing rules, including emphasis next to CJK text.
const markdown = unified()
  .use(remarkParse)
  .use(remarkCjkFriendly)
  .use(remarkGfm);

/** Message text can be selected in the rendered Markdown view. Verify the
 * actual quoted words against either the saved source or its visible text.
 * The source locator alone does not certify client-supplied quote content.
 */
export function sourceContainsSelection(source: string, selected: string) {
  const target = normalize(selected);
  if (!target) return false;
  if (normalize(source).includes(target)) return true;
  return normalize(displayedText(markdown.parse(source))).includes(target);
}
