import { z } from "zod";
import type { RecordedInput } from "./model.js";
import type { LiveMessage } from "./live-conversation.js";

export const conversationSearchCursorSchema = z
  .object({
    createdAt: z.iso.datetime(),
    id: z.string().min(1),
  })
  .strict();
export const conversationSearchRequestSchema = z
  .object({
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    query: z.string().trim().min(1).max(200),
    before: conversationSearchCursorSchema.optional(),
  })
  .strict();
export type ConversationSearchRequest = z.infer<
  typeof conversationSearchRequestSchema
>;
// The model cannot select a project, conversation, Human or Runtime Session.
export const conversationSearchToolSchema =
  conversationSearchRequestSchema.omit({
    projectId: true,
    conversationId: true,
  });
export const conversationSearchHitSchema = z
  .object({
    messageId: z.string().min(1),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    createdAt: z.string(),
    kind: z.enum(["input", "reply", "error"]),
    preview: z.string().max(400),
  })
  .strict();
export const conversationSearchPageSchema = z
  .object({
    hits: z.array(conversationSearchHitSchema).max(200),
    nextCursor: conversationSearchCursorSchema.nullable(),
    scanned: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationSearchHit = z.infer<typeof conversationSearchHitSchema>;
export type ConversationSearchPage = z.infer<
  typeof conversationSearchPageSchema
>;

/** Literal, case-insensitive matching of already-authorized public bytes.
 * Tools/progress/hidden inference never become searchable replies. */
export function searchConversationPage(
  inputs: readonly Pick<
    RecordedInput,
    "id" | "projectId" | "conversationId" | "createdAt" | "body" | "textQuotes"
  >[],
  messages: readonly (Pick<
    LiveMessage,
    "id" | "projectId" | "createdAt" | "kind" | "text"
  > & { conversationId?: string })[],
  query: string,
): ConversationSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const entries = [
    ...inputs.map((i) => ({
      messageId: i.id,
      projectId: i.projectId,
      conversationId: i.conversationId ?? i.projectId,
      createdAt: i.createdAt,
      kind: "input" as const,
      text: [
        i.body,
        ...(i.textQuotes?.flatMap((q) => [q.comment, q.text]) ?? []),
      ]
        .filter(Boolean)
        .join("\n"),
    })),
    ...messages
      .filter((m) => m.kind === "reply" || m.kind === "error")
      .map((m) => ({
        messageId: m.id,
        projectId: m.projectId,
        conversationId: m.conversationId ?? m.projectId,
        createdAt: m.createdAt,
        kind: m.kind as "reply" | "error",
        text: m.text,
      })),
  ];
  return entries
    .flatMap(({ text, ...source }) => {
      const index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) return [];
      const start = Math.max(0, index - 40);
      const preview =
        (start ? "…" : "") +
        Array.from(text.slice(start))
          .slice(0, 180)
          .join("")
          .replace(/\s+/g, " ") +
        (text.length > start + 180 ? "…" : "");
      return [{ ...source, preview }];
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.messageId.localeCompare(a.messageId),
    );
}
