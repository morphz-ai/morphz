import { z } from "zod";

export const ocrEngine = "PaddleOCR.js 0.4.2 / PP-OCRv6_small";
export const ocrLayoutSchema = z.enum(["horizontal", "columns", "vertical"]);
export type OcrLayout = z.infer<typeof ocrLayoutSchema>;
const point = z.tuple([
  z.number().finite().min(0).max(3200),
  z.number().finite().min(0).max(3200),
]);
export const ocrResultSchema = z
  .object({
    image: z
      .object({
        width: z.number().int().positive().max(3200),
        height: z.number().int().positive().max(3200),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            poly: z.array(point).length(4),
            text: z.string().max(4000),
            score: z.number().min(0).max(1),
            correction: z.string().max(4000).optional(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict()
  .refine(
    (r) =>
      r.items.every((i) =>
        i.poly.every(([x, y]) => x <= r.image.width && y <= r.image.height),
      ) &&
      r.items.reduce((n, i) => n + (i.correction ?? i.text).length, 0) <=
        100_000,
    "OCR 结果超出页面范围或文字限制。",
  );
export type OcrResult = z.infer<typeof ocrResultSchema>;
export type ReadingOcr = OcrResult & {
  engine: string;
  layout: OcrLayout;
  parent?: string;
};
const binding = {
  artifactId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  revision: z.number().int().positive(),
  page: z.number().int().min(1).max(300),
};
const jobId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const readerOcrRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("status"),
      ...binding,
      jobId: jobId.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("start"),
      ...binding,
      jobId,
      layout: ocrLayoutSchema,
      download: z.boolean().default(false),
      force: z.boolean().default(false),
    })
    .strict(),
  z.object({ operation: z.literal("cancel"), ...binding, jobId }).strict(),
  z
    .object({
      operation: z.literal("correct"),
      ...binding,
      sectionId: z.string().regex(/^page-\d+-ocr-[a-f0-9]{64}$/),
      line: z.number().int().min(0).max(1999),
      text: z.string().max(4000),
    })
    .strict(),
]);
export type ReaderOcrRequest = z.infer<typeof readerOcrRequestSchema>;
export type ReaderOcrStatus = {
  available: boolean;
  installed: boolean;
  downloadBytes: number;
  state:
    "idle" | "loading" | "recognizing" | "complete" | "cancelled" | "failed";
  sectionId?: string;
  jobId?: string;
  message?: string;
};
export function readingBaseSection(id: string) {
  return id.replace(/-ocr-[a-f0-9]{64}$/, "");
}
export function readingPage(id: string) {
  return Number(/^page-([1-9]\d*)/.exec(id)?.[1] ?? 0);
}

/** Explicit layout choice; no confidence score is treated as calibrated accuracy. */
export function orderOcr(result: OcrResult, layout: OcrLayout): OcrResult {
  const box = (item: OcrResult["items"][number]) => {
    const xs = item.poly.map((p) => p[0]),
      ys = item.poly.map((p) => p[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  };
  const items = [...result.items].filter((i) => i.text.trim());
  if (layout === "vertical") {
    const columns: Array<{
      center: number;
      width: number;
      items: typeof items;
    }> = [];
    for (const item of [...items].sort((a, b) => box(b).right - box(a).right)) {
      const b = box(item),
        center = (b.x + b.right) / 2,
        width = b.right - b.x;
      const column = columns.find(
        (c) => Math.abs(c.center - center) <= Math.max(c.width, width) * 0.5,
      );
      if (column) column.items.push(item);
      else columns.push({ center, width, items: [item] });
    }
    return {
      ...result,
      items: columns
        .sort((a, b) => b.center - a.center)
        .flatMap((c) => c.items.sort((a, b) => box(a).y - box(b).y)),
    };
  } else if (layout === "columns") {
    // A two-column reading mode, not an automatic table/layout reconstruction claim.
    const half = result.image.width / 2;
    items.sort(
      (a, b) =>
        Number(box(a).x >= half) - Number(box(b).x >= half) ||
        box(a).y - box(b).y ||
        box(a).x - box(b).x,
    );
  } else items.sort((a, b) => box(a).y - box(b).y || box(a).x - box(b).x);
  return { ...result, items };
}
