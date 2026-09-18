import { z } from "zod";

export const speechFrameMilliseconds = 200;
export const maxSpeechFrameBytes = 6400; // 16 kHz, mono, PCM16, 200 ms
export const speechScopeSchema = z
  .object({
    projectId: z.string().min(1).max(100),
    artifactId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();
export type SpeechStreamScope = z.infer<typeof speechScopeSchema>;
const base = { id: z.uuid(), scope: speechScopeSchema };
const pcm = z.preprocess(
  (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value),
  z
    .union([
      z.instanceof(Uint8Array),
      z
        .array(z.number().int().min(0).max(255))
        .max(maxSpeechFrameBytes)
        .transform((value) => new Uint8Array(value)),
    ])
    .refine(
      (value) =>
        value.byteLength > 0 &&
        value.byteLength <= maxSpeechFrameBytes &&
        value.byteLength % 2 === 0,
    ),
);
export const speechStreamCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("open") }).strict(),
  z
    .object({
      ...base,
      action: z.literal("push"),
      sequence: z.number().int().positive(),
      data: pcm,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("read"),
      after: z.number().int().min(-1),
    })
    .strict(),
  z.object({ ...base, action: z.literal("finish") }).strict(),
  z.object({ ...base, action: z.literal("cancel") }).strict(),
]);
export type SpeechStreamCommand = z.infer<typeof speechStreamCommandSchema>;
export const speechStreamStateSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  text: z.string().max(30000),
  status: z.enum(["listening", "finishing", "complete", "cancelled", "error"]),
  error: z.string().optional(),
});
export type SpeechStreamState = z.infer<typeof speechStreamStateSchema>;
