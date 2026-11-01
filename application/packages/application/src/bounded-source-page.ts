import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../core/src/model.js";

/** A locator derived from current Platform grants and immutable input roots.
 * It never grants a Runtime resource and never contains screen bytes. */
export type BoundedReadSource = {
  key: string;
  sessionId: string;
  contextId: string;
  roots: readonly string[];
  scopeRef?: string;
};
const coordinate = z
  .object({
    version: z.literal(1),
    owner: z.string().length(64),
    source: z.string().max(1500),
    afterRoot: z.string().max(500).nullable(),
    native: z.string().max(2048).nullable(),
    roots: z.string().length(64),
  })
  .strict();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Exactly one physical source page per demand. A retained source registry
 * does not authorize draining every source to paint the terminal tab bar. */
export async function boundedSourcePage<
  T extends { has_more: boolean; next_cursor?: string | null },
>(options: {
  owner: readonly unknown[];
  sources: readonly BoundedReadSource[];
  cursor?: string;
  parse(value: unknown): T;
  read(
    source: BoundedReadSource,
    roots: readonly string[],
    cursor: string | null,
  ): Promise<unknown>;
}) {
  const owner = digest(options.owner);
  let key: z.infer<typeof coordinate> | undefined;
  if (options.cursor !== undefined) {
    try {
      if (!options.cursor || options.cursor.length > 8192) throw new Error();
      key = coordinate.parse(
        JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")),
      );
      if (key.owner !== owner) throw new Error();
    } catch {
      throw new DomainError("conflict", "集合读取范围已变化，请重新载入列表。");
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sources = [...options.sources].sort((a, b) => compare(a.key, b.key));
  const source = key
    ? sources.find((source) => source.key === key!.source)
    : sources[0];
  if (!source) {
    if (key) throw new DomainError("forbidden", "集合来源已不在当前授权范围。");
    return { page: null, has_more: false, next_cursor: null };
  }
  const roots = [...new Set(source.roots)]
    .sort()
    .filter((root) => !key?.afterRoot || root > key.afterRoot);
  const selected: string[] = [];
  for (const root of roots) {
    if (
      selected.length >= 32 ||
      new URLSearchParams({
        root_ids: JSON.stringify([...selected, root]),
      }).toString().length > 6000
    )
      break;
    selected.push(root);
  }
  if (roots.length && !selected.length)
    throw new DomainError("invalid", "集合来源超过单页字节上限。");
  const fingerprint = digest(selected);
  if (key?.native && key.roots !== fingerprint)
    throw new DomainError("conflict", "集合来源发生变化，请重新载入列表。");
  const page = options.parse(
    await options.read(
      key?.afterRoot ? { ...source, scopeRef: undefined } : source,
      selected,
      key?.native ?? null,
    ),
  );
  const continuationFor = (page: {
    has_more: boolean;
    next_cursor?: string | null;
  }) => {
    let next: z.infer<typeof coordinate> | undefined;
    if (page.has_more) {
      if (!page.next_cursor || page.next_cursor === key?.native)
        throw new DomainError("invalid", "集合分页未返回可推进的游标。");
      next = {
        version: 1,
        owner,
        source: source.key,
        afterRoot: key?.afterRoot ?? null,
        native: page.next_cursor,
        roots: fingerprint,
      };
    } else if (roots.length > selected.length) {
      next = {
        version: 1,
        owner,
        source: source.key,
        afterRoot: selected.at(-1)!,
        native: null,
        roots: digest([]),
      };
    } else {
      const following = sources.find(
        (candidate) => compare(candidate.key, source.key) > 0,
      );
      if (following)
        next = {
          version: 1,
          owner,
          source: following.key,
          afterRoot: null,
          native: null,
          roots: digest([]),
        };
    }
    return next
      ? Buffer.from(JSON.stringify(next)).toString("base64url")
      : null;
  };
  const next_cursor = continuationFor(page);
  return { page, has_more: !!next_cursor, next_cursor, continuationFor };
}
