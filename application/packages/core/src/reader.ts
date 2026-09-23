import { z } from "zod";
import { readerOcrRequestSchema, type ReadingOcr } from "./reader-ocr.js";

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const maxReadingFileBytes = 32 * 1024 * 1024;
export const maxReadingCharacters = 8_000_000;
export const readerFileAccept =
  ".epub,.pdf,.md,.markdown,.txt,.docx,.html,.htm,.rtf,.doc";

/** Catalog metadata only. Whole books and images never ride every workspace refresh. */
export const publicationSchema = z
  .object({
    kind: z.literal("publication"),
    assetId: hash,
    format: z.enum(["epub", "docx", "doc", "rtf", "html", "markdown", "text"]),
    author: z.string().max(1000),
    language: z.string().max(80),
    edition: z.string().max(500),
    sections: z
      .array(
        z
          .object({
            id,
            title: z.string().max(180),
            characters: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict()
  .refine(
    (p) =>
      p.sections.reduce((sum, s) => sum + s.characters, 0) <=
      maxReadingCharacters,
    "读物文字超过 800 万字，请拆分后导入。",
  );
export type Publication = z.infer<typeof publicationSchema>;
export type ReaderSection = {
  id: string;
  title: string;
  html: string;
  text: string;
};
export type ParsedPublication = {
  title: string;
  content: Publication;
  sections: ReaderSection[];
};

export const readingPreferencesSchema = z
  .object({
    fontSize: z.number().int().min(14).max(32).default(20),
    font: z.enum(["serif", "sans"]).default("serif"),
    theme: z.enum(["system", "paper", "night"]).default("system"),
    personalContext: z.boolean().default(true),
    spoilers: z.boolean().default(false),
  })
  .strict();
export type ReadingPreferences = z.infer<typeof readingPreferencesSchema>;
export const readingLocationSchema = z
  .object({
    sourceId: z.string().min(1).max(220),
    sectionId: id,
    start: z.number().int().min(0).max(1_000_000),
    end: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .refine(
    (r) => r.end >= r.start && r.end - r.start <= 8000,
    "请选择不超过 8000 字的连续原文。",
  );
export type ReadingLocation = z.infer<typeof readingLocationSchema>;
export const readingBookSchema = z
  .object({
    title: z.string().max(180),
    author: z.string().max(1000),
    edition: z.string().max(500),
    format: z.string().max(30),
  })
  .strict();
export type ReadingSection = ReaderSection & {
  sourceId: string;
  book: z.infer<typeof readingBookSchema>;
  ocr?: ReadingOcr;
};
/** Awareness of the reading surface, without sending any source text. */
export const readingPositionSchema = z
  .object({
    book: readingBookSchema,
    location: readingLocationSchema,
    chapter: z.string().max(180),
    personalContext: z.boolean(),
    spoilers: z.boolean(),
  })
  .strict();
export type ReadingPosition = z.infer<typeof readingPositionSchema>;
export const readingReferenceSchema = readingPositionSchema.extend({
  quote: z.string().max(8000),
  before: z.string().max(600),
  after: z.string().max(300),
});
export type ReadingReference = z.infer<typeof readingReferenceSchema>;
export const readingInputSchema = z.union([
  readingReferenceSchema,
  readingPositionSchema,
]);
export type ReadingInput = z.infer<typeof readingInputSchema>;
export type ReaderTarget = {
  artifactId: string;
  revision: number;
  location: ReadingLocation;
  requestId?: string;
};

export function readingPosition(
  section: ReadingSection,
  location: ReadingLocation,
  preferences: Pick<ReadingPreferences, "personalContext" | "spoilers">,
): ReadingPosition {
  const checked = readingLocationSchema.parse(location);
  if (section.id !== checked.sectionId || checked.end > section.text.length)
    throw new Error("阅读位置与原文不匹配，请重新选择。");
  return {
    book: structuredClone(section.book),
    location: checked,
    chapter: section.title,
    personalContext: preferences.personalContext,
    spoilers: preferences.spoilers,
  };
}

export function readingReference(
  section: ReadingSection,
  location: ReadingLocation,
  preferences: Pick<ReadingPreferences, "personalContext" | "spoilers">,
): ReadingReference {
  const position = readingPosition(section, location, preferences);
  const checked = position.location;
  return {
    ...position,
    quote: section.text.slice(checked.start, checked.end),
    before: section.text.slice(Math.max(0, checked.start - 600), checked.start),
    // No future text is silently attached while the no-spoiler preference is on.
    after: preferences.spoilers
      ? section.text.slice(checked.end, checked.end + 300)
      : "",
  };
}

const binding = {
  artifactId: id,
  artifactRevision: z.number().int().positive(),
};
export const readingMarkSchema = z
  .object({
    id,
    ownerPrincipalId: id,
    ...binding,
    location: readingLocationSchema,
    quote: z.string().max(8000),
    kind: z.enum(["bookmark", "highlight", "note"]),
    color: z.enum(["yellow", "green", "blue", "pink"]),
    note: z.string().max(8000),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ReadingMark = z.infer<typeof readingMarkSchema>;
export const readingStateSchema = z
  .object({
    ownerPrincipalId: id,
    ...binding,
    location: readingLocationSchema,
    preferences: readingPreferencesSchema,
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const readerCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("mark-add"),
      ...binding,
      location: readingLocationSchema,
      quote: z.string().max(8000),
      kind: z.enum(["bookmark", "highlight", "note"]),
      color: z.enum(["yellow", "green", "blue", "pink"]).default("yellow"),
      note: z.string().max(8000).default(""),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-update"),
      markId: id,
      expectedRevision: z.number().int().positive(),
      note: z.string().max(8000),
      color: z.enum(["yellow", "green", "blue", "pink"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-remove"),
      markId: id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-restore"),
      markId: id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("save-position"),
      ...binding,
      location: readingLocationSchema,
      preferences: readingPreferencesSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ReaderCommand = z.infer<typeof readerCommandSchema>;

export const readerReadSchema = z
  .object({
    artifactId: id,
    revision: z.number().int().positive(),
    sectionId: id,
  })
  .strict();

export const readerToolSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("ocr"), request: readerOcrRequestSchema })
    .strict(),
  z
    .object({
      action: z.literal("catalog"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("contents"),
      artifactId: id,
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      ...readerReadSchema.shape,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(8000).default(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal("marks"),
      artifactId: id,
      deleted: z.boolean().default(false),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  ...readerCommandSchema.options,
]);

export function readable(content: { kind: string; understanding?: unknown }) {
  return (
    content.kind === "publication" ||
    content.kind === "pdf" ||
    (content.kind === "document" && !content.understanding)
  );
}
export function readingSourceId(
  artifactId: string,
  revision: number,
  content: { kind: string; assetId?: string },
) {
  return content.assetId ?? `${artifactId}@${revision}`;
}
