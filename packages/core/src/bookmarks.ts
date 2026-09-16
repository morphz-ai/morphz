import { z } from "zod";
import { websiteURL } from "./browser.js";

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(180);
const author = z.object({ principalId: id, actantId: id }).strict();
export const bookmarkSchema = z
  .object({
    id,
    ownerPrincipalId: id,
    title,
    url: websiteURL,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    createdBy: author,
    updatedBy: author,
    deletedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type Bookmark = z.infer<typeof bookmarkSchema>;

const version = {
  bookmarkId: id,
  expectedRevision: z.number().int().positive(),
};
export const bookmarkOperations = [
  z
    .object({ type: z.literal("bookmark-add"), title, url: websiteURL })
    .strict(),
  z
    .object({
      type: z.literal("bookmark-update"),
      ...version,
      title,
      url: websiteURL,
    })
    .strict(),
  z.object({ type: z.literal("bookmark-remove"), ...version }).strict(),
  z.object({ type: z.literal("bookmark-restore"), ...version }).strict(),
] as const;

const agentVersion = { bookmarkId: id, revision: z.number().int().positive() };
// The shared command validates/normalizes URLs; the advertised tool schema is JSON Schema.
const requestedURL = z.string().min(1).max(4000);
export const bookmarkRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      query: z.string().max(200).optional(),
      offset: z.number().int().min(0).max(10000).default(0),
      limit: z.number().int().min(1).max(50).default(20),
      deleted: z.boolean().default(false),
    })
    .strict(),
  z.object({ action: z.literal("add"), title, url: requestedURL }).strict(),
  z
    .object({
      action: z.literal("update"),
      ...agentVersion,
      title,
      url: requestedURL,
    })
    .strict(),
  z.object({ action: z.literal("remove"), ...agentVersion }).strict(),
  z.object({ action: z.literal("restore"), ...agentVersion }).strict(),
]);

export function findBookmarks(
  bookmarks: Bookmark[],
  query = "",
  deleted = false,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return bookmarks
    .filter(
      (b) =>
        !!b.deletedAt === deleted &&
        terms.every((term) =>
          `${b.title}\n${b.url}`.toLocaleLowerCase().includes(term),
        ),
    )
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
}
