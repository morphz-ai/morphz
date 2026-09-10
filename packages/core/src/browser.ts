import { z } from "zod";

export const websiteURL = z
  .string()
  .max(4000)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      return url.href;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "网站地址需要是无内嵌凭据的 HTTP 或 HTTPS 地址。",
      });
      return z.NEVER;
    }
  });
export const browserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }).strict(),
  z
    .object({
      type: z.literal("fill"),
      snapshotId: z.uuid(),
      ref: z.string().regex(/^e\d+$/),
      value: z.string().max(30000),
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      snapshotId: z.uuid(),
      ref: z.string().regex(/^e\d+$/),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export const browserReceiptSchema = z
  .object({
    id: z.uuid(),
    pageId: z.uuid(),
    epoch: z.uuid(),
    projectId: z.string(),
    artifactId: z.string().nullable(),
    sourceSessionId: z.string().optional(),
    action: browserActionSchema,
    status: z.enum([
      "queued",
      "awaiting_approval",
      "executing",
      "succeeded",
      "rejected",
      "unknown",
    ]),
    createdAt: z.string(),
    result: z.string().max(45000).nullable(),
  })
  .strict();
export type BrowserReceipt = z.infer<typeof browserReceiptSchema>;
export const pageStateSchema = z
  .object({
    pageId: z.uuid(),
    artifactId: z.string().min(1).max(100).nullable(),
    projectId: z.string().min(1).max(100).optional(),
    epoch: z.uuid(),
    url: websiteURL,
    title: z.string().max(500),
    granted: z.boolean(),
    visible: z.boolean(),
  })
  .strict();
export type BrowserPageState = z.infer<typeof pageStateSchema>;
