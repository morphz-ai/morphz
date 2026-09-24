import { z } from "zod";
import { documentImportIssue } from "./sources.js";
import { maxReadingFileBytes } from "./reader.js";

export const maxPdfBytes = maxReadingFileBytes;
export const maxPdfPages = 300;
export const pdfContentSchema = z
  .object({
    kind: z.literal("pdf"),
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    pages: z.array(z.string().max(500_000)).min(1).max(maxPdfPages),
  })
  .strict()
  .refine(
    (value) => value.pages.reduce((n, page) => n + page.length, 0) <= 500_000,
    "PDF 文字总量过大。",
  );

export function pdfImportIssue(path: string): string | null {
  if (!/\.pdf$/i.test(path)) return "请选择 PDF 文件。";
  // Reuse the same credential, hidden-path and traversal exclusions as text sources.
  return documentImportIssue(path.replace(/\.pdf$/i, ".txt"));
}
