import type {
  DiscussionDraft,
  DiscussionDraftJournal,
} from "./comment-discussion-controller.js";

export function canonicalDiscussionSource(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

/** Point-keyed, per-window draft journal, loaded only for a requested source.
 * No transcript or source registry. The hash is only a cache address; the full
 * source is checked before restoring or replacing anything at that address. */
export function discussionDraftStore<Q>(
  prefix: string,
  identity: (quote: Q) => unknown,
  parse: (value: unknown) => DiscussionDraft<Q>,
  verifyOwner: () => void = () => {},
): DiscussionDraftJournal<Q> {
  const locate = (quote: Q) => {
    const source = canonicalDiscussionSource(identity(quote));
    let a = 0x811c9dc5,
      b = 0x9e3779b9;
    for (let i = 0; i < source.length; i++) {
      a = Math.imul(a ^ source.charCodeAt(i), 0x01000193);
      b = Math.imul(b ^ source.charCodeAt(i), 0x85ebca6b);
    }
    return {
      source,
      key: `${prefix}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`,
    };
  };
  const read = (key: string, source: string): DiscussionDraft<Q>[] => {
    verifyOwner();
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    if (new TextEncoder().encode(raw).length > 768 * 1024)
      throw new Error("讨论草稿超过本机读取预算，原记录已保留。");
    const value = JSON.parse(raw) as {
      version?: unknown;
      source?: unknown;
      drafts?: unknown;
    };
    if (
      value.version !== 1 ||
      value.source !== source ||
      !Array.isArray(value.drafts) ||
      value.drafts.length > 32
    )
      throw new Error("讨论草稿索引不一致，原记录已保留。");
    const drafts = value.drafts.map(parse);
    if (
      drafts.some(
        (draft) => canonicalDiscussionSource(identity(draft.quote)) !== source,
      )
    )
      throw new Error("讨论草稿来源不一致，原记录已保留。");
    return drafts;
  };
  return {
    load: (quote, id) => {
      const { key, source } = locate(quote);
      const drafts = read(key, source);
      return (
        (id ? drafts.find((draft) => draft.id === id) : drafts.at(-1)) ?? null
      );
    },
    save: (value) => {
      const { key, source } = locate(value.quote);
      const drafts = read(key, source).filter((draft) => draft.id !== value.id);
      if (value.draft || value.pending) drafts.push(value);
      if (!drafts.length) {
        localStorage.removeItem(key);
        return;
      }
      const raw = JSON.stringify({ version: 1, source, drafts });
      if (
        drafts.length > 32 ||
        new TextEncoder().encode(raw).length > 768 * 1024
      )
        throw new Error(
          "此来源的未发送讨论过多；原草稿已保留，请先完成已有讨论。",
        );
      localStorage.setItem(key, raw);
    },
  };
}

/** Restored local data is a draft, never a grant or an accepted receipt. */
export function parseDiscussionDraft<Q>(
  value: unknown,
  quote: (raw: unknown) => Q,
  envelope: (raw: unknown, draft: DiscussionDraft<Q>) => void,
): DiscussionDraft<Q> {
  if (!value || typeof value !== "object")
    throw new Error("Invalid discussion draft");
  const draft = value as DiscussionDraft<Q>;
  if (
    typeof draft.id !== "string" ||
    !/^[^\s\u0000-\u001f\u007f]{1,128}$/.test(draft.id) ||
    typeof draft.draft !== "string" ||
    draft.draft.length > 10000 ||
    typeof draft.publish !== "boolean" ||
    typeof draft.submitted !== "boolean"
  )
    throw new Error("Invalid discussion draft");
  const result = { ...draft, quote: quote(draft.quote) };
  if (draft.pending) {
    const command = draft.pending;
    if (
      typeof command.commandId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(command.commandId) ||
      command.discussionId !== draft.id ||
      typeof command.body !== "string" ||
      !command.body.trim() ||
      command.body.length > 10000 ||
      command.first !== !draft.submitted ||
      command.publish !== draft.publish ||
      (command.first && command.commandId !== draft.id) ||
      canonicalDiscussionSource(command.quote) !==
        canonicalDiscussionSource(result.quote)
    )
      throw new Error("Invalid saved discussion request");
    envelope(command.envelope, result);
  }
  return result;
}

/** getRandomValues works on an HTTP LAN Dashboard too, where randomUUID is
 * unavailable. This is still a random UUID, not a timestamp-based identity. */
export function discussionCommandId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const value = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
