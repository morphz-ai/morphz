import { z } from "zod";

export const notificationIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const notificationStateSchema = z
  .object({
    mode: z.enum(["all", "off"]),
    read: z.array(notificationIdSchema).max(2000).default([]),
  })
  .strict()
  .superRefine((state, context) => {
    if (new Set(state.read).size !== state.read.length)
      context.addIssue({
        code: "custom",
        message: "通知已读记录重复。",
        path: ["read"],
      });
  });

export type NotificationState = z.infer<typeof notificationStateSchema>;
