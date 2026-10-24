import type { Link, Parent, Root, Text } from "mdast";
import type { Plugin } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { location } from "vfile-location";

export type ContentLink = { id: string; revision?: number };
const contentId = /^content_[a-f0-9]{40}$/;

/** Electron adds a transport envelope to rejected IPC; retain the actual cause. */
export function resourceLinkError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message.replace(
        /^Error invoking remote method '(?:open-local-file|open-external)': (?:Error: )?/,
        "",
      )
    : "链接未打开，请重试。";
}

/** Navigation references only, never delivery receipts or access grants. */
export function contentLink(value: string): ContentLink | null {
  const legacy =
    /^(?:morphz:\/\/artifact\/|artifact:|\/artifacts\/)([a-zA-Z0-9_-]{1,100})$/.exec(
      value,
    );
  if (legacy) return { id: legacy[1]! };
  try {
    const url = new URL(value);
    if (
      url.protocol !== "morphz:" ||
      url.host !== "content" ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/[a-zA-Z0-9_-]{1,100}$/.test(url.pathname)
    )
      return null;
    const entries = [...url.searchParams];
    if (
      entries.length &&
      (entries.length !== 1 ||
        entries[0]![0] !== "revision" ||
        !/^[1-9]\d*$/.test(entries[0]![1]))
    )
      return null;
    const revision = entries.length ? Number(entries[0]![1]) : undefined;
    if (revision !== undefined && !Number.isSafeInteger(revision)) return null;
    return {
      id: url.pathname.slice(1),
      ...(revision !== undefined ? { revision } : {}),
    };
  } catch {
    return null;
  }
}

/** A local absolute address, not an application-relative URL or remote share.
 * Main independently validates the real filesystem target at the click. */
export function localFileLink(value: string): string | null {
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value))
    return null;
  if (
    !value.startsWith("file:") &&
    !/^\/(?!\/)/.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value)
  )
    return null;
  if (/^\/(?:api|artifacts)(?:\/|$)/.test(value)) return null;
  try {
    const url = new URL(
      value.startsWith("file:")
        ? value
        : /^[A-Za-z]:/.test(value)
          ? `file:///${value.replaceAll("\\", "/")}`
          : `file://${value}`,
    );
    if (
      url.protocol !== "file:" ||
      url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /%2f|%5c/i.test(url.pathname)
    )
      return null;
    const path = decodeURIComponent(url.pathname);
    if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith("//"))
      return null;
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** Inline code is literal, so encode once before passing through URL policy. */
export function literalResourceLink(value: string): string | null {
  if (contentId.test(value)) return `morphz://content/${value}`;
  if (contentLink(value)) return value;
  if (/^\/(?!\/)/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    const href =
      (/^[A-Za-z]:/.test(value) ? "file:///" : "file://") +
      value
        .replaceAll("\\", "/")
        .split("/")
        .map(encodeURIComponent)
        .join("/")
        .replace(/^([A-Za-z])%3A/, "$1:");
    return localFileLink(href) ? href : null;
  }
  return value.startsWith("file:") && localFileLink(value) ? value : null;
}

/** Use the mature Markdown AST. Only semantic IDs in prose are decorated;
 * links, HTML, fences and arbitrary code remain literal and copyable. */
export const contentReferenceLinks: Plugin<[], Root> = function () {
  return (tree, file) => {
    const source = String(file);
    let positions: ReturnType<typeof location> | undefined;
    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type === "inlineCode" && index !== undefined && parent) {
        const href = literalResourceLink(node.value);
        if (href) {
          (parent as Parent).children.splice(index, 1, {
            type: "link",
            url: href,
            children: [node],
            position: node.position,
          });
          return index + 1;
        }
        return;
      }
      if (node.type !== "text" || index === undefined || !parent) return;
      const matches = [
        ...node.value.matchAll(
          /(?<![A-Za-z0-9_\/-])content_[a-f0-9]{40}(?![A-Za-z0-9_-])/g,
        ),
      ];
      if (!matches.length) return;
      const start = node.position?.start.offset;
      const exact =
        start !== undefined &&
        source.slice(start, node.position?.end.offset) === node.value;
      const text = (from: number, to: number): Text => ({
        type: "text",
        value: node.value.slice(from, to),
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
        const label = text(match.index, match.index + match[0].length);
        replacement.push({
          type: "link",
          url: `morphz://content/${match[0]}`,
          children: [label],
          ...(label.position ? { position: label.position } : {}),
        });
        cursor = match.index + match[0].length;
      }
      if (cursor < node.value.length)
        replacement.push(text(cursor, node.value.length));
      (parent as Parent).children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
};
