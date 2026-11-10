import { internalModelOutput } from "./model-publication.js";
import type { CommentDiscussionPage } from "./comment-discussion-types.js";

type NativeEvent = {
  id: string;
  timestamp: string;
  topic: string;
  type?: string;
  payload: Record<string, unknown>;
};
export type DiscussionTimelineEntry = {
  entry_id: string;
  attempt_id?: string | null;
  final_event?: boolean;
  visible_at: string;
  root_turn_id: string;
  display_kind: "input" | "reply" | "progress" | "error";
  event: NativeEvent;
  root_event: NativeEvent | null;
  input_event: NativeEvent | null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Decode only display text; it is never routing, authentication or a grant. */
function metadataText(payload: Record<string, unknown>) {
  const request = object(object(payload.session_io).request);
  const metadata = object(request.client_metadata);
  const fields = metadata.type === "object" ? object(metadata.value) : metadata;
  const text = (value: unknown) => {
    const data = object(value);
    return typeof value === "string"
      ? value
      : data.type === "string" && typeof data.value === "string"
        ? data.value
        : null;
  };
  const kind = text(fields.kind);
  if (kind === "morphz.dashboard-discussion") return text(fields.body);
  if (kind === "morphz.platform-input") {
    const source = object(fields.source),
      values = source.type === "object" ? object(source.value) : source;
    return text(values.body);
  }
  return null;
}
export function discussionTimelinePage(
  id: string,
  entries: DiscussionTimelineEntry[],
  nextCursor: CommentDiscussionPage["nextCursor"],
): CommentDiscussionPage {
  if (entries.length > 50)
    throw new Error("Discussion page exceeds its row budget");
  return {
    id,
    nextCursor,
    messages: entries.flatMap((item) => {
      if (internalModelOutput(item.event, item.root_event)) return [];
      const payload = item.event.payload;
      const text =
        item.display_kind === "input"
          ? (metadataText(payload) ?? payload.text)
          : (payload.text ?? payload.error ?? payload.message);
      if (typeof text !== "string" || !text) return [];
      return [
        {
          id:
            item.final_event === false && item.attempt_id
              ? `stream:${item.attempt_id}`
              : item.entry_id,
          eventId: item.event.id,
          ...(item.final_event !== false && item.display_kind === "reply"
            ? { entryId: item.entry_id }
            : {}),
          rootId: item.root_turn_id,
          createdAt: item.visible_at,
          kind: item.display_kind,
          text,
          ...(payload.truncated === true ? { truncated: true } : {}),
          ...(typeof payload.thread_id === "string"
            ? { threadId: payload.thread_id }
            : {}),
        },
      ];
    }),
  };
}
