// Pure grammar adapter shared by the renderer and authoritative quote checks.
import { LinkifyIt } from "linkify-it";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import type { Link, Parent, Root, Text } from "mdast";
import type { Plugin } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { location } from "vfile-location";

const links = new LinkifyIt({ fuzzyLink: true, urlAuth: true });
const literalTransforms = new Set(gfmAutolinkLiteralFromMarkdown().transforms);

/** Keep CommonMark/GFM parsing, but recognize bare links only after emphasis
 * has been parsed. linkify-it owns Unicode URL boundaries, not a local regex.
 * Explicit links, references, code and stored Markdown are never rewritten. */
export const readableAutolinks: Plugin<[], Root> = function () {
  const data = this.data();
  // GFM registers both syntax tokenizers and an mdast fallback. Disable both
  // through their published extension interfaces; retain every other GFM rule.
  data.micromarkExtensions ??= [];
  data.micromarkExtensions.push({
    disable: { null: ["protocolAutolink", "wwwAutolink", "emailAutolink"] },
  });
  data.fromMarkdownExtensions = data.fromMarkdownExtensions
    ?.flat()
    .filter(
      (extension) =>
        !extension.transforms?.some((transform) =>
          literalTransforms.has(transform),
        ),
    );

  return (tree, file) => {
    let positions: ReturnType<typeof location> | undefined;
    const source = String(file);
    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "text" || index === undefined || !parent) return;
      const matches = links
        .match(node.value)
        ?.filter(
          (match) =>
            match.schema === "http:" ||
            match.schema === "https:" ||
            match.schema === "mailto:" ||
            (match.schema === "" && match.raw.toLowerCase().startsWith("www.")),
        );
      if (!matches?.length) return;
      const start = node.position?.start.offset;
      const exact =
        start !== undefined &&
        source.slice(start, node.position?.end.offset) === node.value;
      const text = (from: number, to: number): Text => ({
        type: "text",
        value: node.value.slice(from, to),
        // Do not invent source offsets for decoded entities or escapes. The
        // existing stream renderer deliberately leaves transformed text static.
        ...(exact
          ? {
              position: {
                start: (positions ??= location(file)).toPoint(start + from)!,
                end: positions.toPoint(start + to)!,
              },
            }
          : {}),
      });
      const replacement: (Text | Link)[] = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.index > cursor) replacement.push(text(cursor, match.index));
        const label = text(match.index, match.lastIndex);
        replacement.push({
          type: "link",
          url: match.url,
          title: null,
          children: [label],
          ...(label.position ? { position: label.position } : {}),
        });
        cursor = match.lastIndex;
      }
      if (cursor < node.value.length)
        replacement.push(text(cursor, node.value.length));
      const owner: Parent = parent;
      owner.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
};
