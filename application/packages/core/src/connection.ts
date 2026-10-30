import { z } from "zod";

/** Ephemeral read evidence, never execution state or a request/response dump. */
export const connectionReadFailureSchema = z.object({
  operation: z.enum([
    "status",
    "session-events",
    "conversation-history",
    "activity-current",
    "activity-history",
    "activity-projection",
  ]),
  code: z.string().min(1).max(64),
  at: z.string(),
  timeoutMs: z.number().int().positive(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  recoveredAt: z.string().optional(),
});
export type ConnectionReadFailure = z.infer<typeof connectionReadFailureSchema>;

export const connectionDetailsSchema = z.object({
  state: z.enum([
    "not-configured",
    "connected",
    "unreachable",
    "authentication-required",
    "error",
  ]),
  modelState: z.enum([
    "unknown",
    "configured",
    "not-configured",
    "unavailable",
  ]),
  model: z.string(),
  message: z.string(),
  checkedAt: z.string().nullable(),
  configurable: z.boolean(),
  endpoint: z.string().optional(),
  version: z.string().optional(),
  modelSettingsAvailable: z.boolean().optional(),
  lastReadFailure: connectionReadFailureSchema.optional(),
});
export type ConnectionDetails = z.infer<typeof connectionDetailsSchema>;
export const unconfiguredConnection: ConnectionDetails = {
  state: "not-configured",
  modelState: "unknown",
  model: "",
  message: "尚未连接智能体。连接后才能发送给智能体处理。",
  checkedAt: null,
  configurable: false,
};

export const configureConnectionSchema = z
  .object({
    endpoint: z.string().trim().min(1).max(2048),
    token: z.string().trim().min(1).max(4096),
    expectedVersion: z.string().min(1).max(128),
  })
  .strict();
export type ConfigureConnection = z.infer<typeof configureConnectionSchema>;
