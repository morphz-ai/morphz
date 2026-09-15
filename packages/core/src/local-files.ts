import { z } from "zod";

export const directoryGrantSchema = z
  .object({
    grantId: z.uuid(),
    name: z.string().min(1).max(255),
    path: z.string().min(1).max(4096),
    access: z.literal("read-write"),
  })
  .strict();
export type DirectoryGrant = z.infer<typeof directoryGrantSchema>;
export const directoryRequestSchema = z
  .object({
    grantId: z.uuid(),
    operation: z.enum(["list", "read", "write"]),
    path: z.string().max(4096).default(""),
    text: z.string().max(500000).optional(),
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    offset: z.number().int().min(0).max(2000000).optional(),
    limit: z.number().int().min(1).max(24000).optional(),
  })
  .strict();
export type DirectoryRequest = z.infer<typeof directoryRequestSchema>;

export const localFileReferenceSchema = z
  .object({
    grantId: z.uuid(),
    path: z.string().max(4096),
    name: z.string().min(1).max(255),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["directory", "text", "pdf", "image"]),
  })
  .strict();
export type LocalFileReference = z.infer<typeof localFileReferenceSchema>;
export type LocalFileView = {
  reference: LocalFileReference;
  location: string;
  text?: string;
  mime?: string;
  data?: string;
  entries?: { name: string; path: string; directory: boolean }[];
};
