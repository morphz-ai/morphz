import { z } from "zod";
import type {
  CommentDiscussionMessage,
  CommentDiscussionPage,
} from "./comment-discussion-types.js";
export type {
  CommentDiscussionMessage,
  CommentDiscussionPage,
} from "./comment-discussion-types.js";
import {
  textQuoteSchema,
  textQuoteSourceSchema,
  type TextQuote,
  type TextQuoteSource,
} from "./text-quotes.js";

/** This is a message presentation/work route, not another project, Session,
 * content object, or permission grant. The first command owns its stable ID. */
export const commentDiscussionReferenceSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\s\u0000-\u001f\u007f]+$/),
    publishToConversation: z.boolean().optional(),
  })
  .strict();
export type CommentDiscussionReference = z.infer<
  typeof commentDiscussionReferenceSchema
>;

export const nativeDiscussionSourceSchema = z.object({
  key: z.string().min(1).max(512),
  title: z.string().min(1).max(500),
  text: z.string().min(1).max(30_000),
  locator: z.record(z.string(), z.unknown()),
});
export const nativeDiscussionDescriptorSchema = z.object({
  id: z.string().min(1).max(128),
  session_id: z.string(),
  principal_id: z.string(),
  source_event_id: z.string(),
  source_key: z.string(),
  title: z.string(),
  preview: z.string(),
  locator: z.record(z.string(), z.unknown()),
  publish_to_session: z.boolean(),
  created_at_micros: z.number().int().safe(),
});
export const commentDiscussionCursorSchema = z
  .object({
    createdAtMicros: z.number().int().safe(),
    id: z.string().min(1).max(128),
  })
  .strict();
export const commentDiscussionScopeSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
});
export const discussionReplyNoticeScopeSchema = commentDiscussionScopeSchema
  .extend({ kind: z.literal("discussion-replies") })
  .strict();
export type DiscussionReplyNoticeScope = z.infer<
  typeof discussionReplyNoticeScopeSchema
>;
export const discussionReplyNoticeSchema = z.object({
  discussionId: z.string().min(1).max(128),
  eventId: z.string().min(1).max(512),
});
export const discussionReplyNoticesSchema = z.object({
  kind: z.literal("discussion-replies"),
  sequence: z.number().int().positive(),
  replies: z.array(discussionReplyNoticeSchema).max(128),
});
export type DiscussionReplyNotices = z.infer<
  typeof discussionReplyNoticesSchema
>;
export const commentDiscussionsRequestSchema = commentDiscussionScopeSchema
  .extend({
    source: textQuoteSourceSchema,
    before: commentDiscussionCursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const commentDiscussionReadSchema = commentDiscussionScopeSchema
  .extend({ id: z.string().min(1).max(128) })
  .strict();
export const commentDiscussionHistoryRequestSchema = commentDiscussionReadSchema
  .extend({
    before: z
      .object({ createdAt: z.iso.datetime({ offset: true }), id: z.string() })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const commentDiscussionContentRequestSchema = commentDiscussionReadSchema
  .extend({
    messageId: z.string().min(1).max(256),
    eventId: z.string().min(1).max(512),
    offset: z.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export const commentDiscussionChunkSchema = z.object({
  id: z.string(),
  event_id: z.string(),
  root_id: z.string(),
  created_at_micros: z.number().int().safe(),
  kind: z.enum(["input", "reply", "progress", "error"]),
  text: z.string().max(65536),
  next_offset: z.number().int().nonnegative().nullable(),
});
export const commentDiscussionMessageSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  entryId: z.string().optional(),
  contentOmitted: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
  rootId: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  kind: z.enum(["input", "reply", "progress", "error"]),
  text: z.string(),
  streaming: z.boolean().optional(),
  replace: z.boolean().optional(),
  truncated: z.boolean().optional(),
  threadId: z.string().optional(),
  generation: z.number().int().positive().optional(),
}) satisfies z.ZodType<CommentDiscussionMessage>;
export const commentDiscussionPageSchema = z.object({
  id: z.string(),
  messages: z.array(commentDiscussionMessageSchema).max(50),
  nextCursor: z
    .object({ createdAt: z.iso.datetime({ offset: true }), id: z.string() })
    .nullable(),
}) satisfies z.ZodType<CommentDiscussionPage>;
export const commentDiscussionSchema = z.object({
  descriptor: nativeDiscussionDescriptorSchema,
  quote: textQuoteSchema,
});
export type CommentDiscussion = z.infer<typeof commentDiscussionSchema>;

export function commentDiscussionSourceKey(source: TextQuoteSource): string {
  switch (source.kind) {
    case "message":
      return source.messageId === source.inputId
        ? `input:${source.inputId}`
        : source.messageId.startsWith("stream:")
          ? `publication:${source.messageId.slice("stream:".length)}`
          : source.messageId.startsWith("publication:")
            ? source.messageId
            : `event:${source.messageId}`;
    case "artifact":
    case "reading":
      return `artifact:${source.artifactId}`;
    case "script":
      return `script:${source.productionId}`;
    case "web":
      return `web:${source.pageId}`;
    case "surface":
      return `surface:${source.applicationInstanceId ?? source.projectId}`;
  }
}

export function commentDiscussionSource(quote: TextQuote) {
  return {
    key: commentDiscussionSourceKey(quote.source),
    title: quote.source.title,
    text: quote.text,
    locator: {
      kind: "platform-text",
      quoteId: quote.id,
      source: quote.source,
      ...(quote.anchor ? { anchor: quote.anchor } : {}),
      ...(quote.draft ? { draft: true } : {}),
    },
  };
}
