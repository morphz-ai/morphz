import { z } from "zod";
import { modelCatalogSchema } from "./inference.js";

export const apiProtocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "gemini-content",
]);
const id = z.string().min(1).max(250);
const apiConnection = {
  protocol: apiProtocolSchema,
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().min(1).max(16384),
};
export const modelSettingsActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("default"),
      model: id,
      expectedCurrent: z.string(),
    })
    .strict(),
  z.object({ action: z.literal("discover"), ...apiConnection }).strict(),
  z
    .object({
      action: z.literal("connect-api"),
      ...apiConnection,
      requestId: z.uuid(),
      label: z.string().trim().min(1).max(100),
      model: id,
    })
    .strict(),
  z.object({ action: z.literal("account-refresh"), accountId: id }).strict(),
  z
    .object({ action: z.literal("api-connection-read"), accountId: id })
    .strict(),
  z
    .object({
      action: z.literal("api-endpoint"),
      accountId: id,
      expectedVersion: id,
      baseUrl: apiConnection.baseUrl,
    })
    .strict(),
  z
    .object({
      action: z.literal("api-key"),
      accountId: id,
      expectedVersion: id,
      apiKey: apiConnection.apiKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("account-models"),
      accountId: id,
      models: z.array(id).min(1).max(300),
      expectedVersion: id,
    })
    .strict(),
  z.object({ action: z.literal("oauth-start"), service: id }).strict(),
  z.object({ action: z.literal("oauth-poll"), loginId: id }).strict(),
  z.object({ action: z.literal("oauth-cancel"), loginId: id }).strict(),
  z
    .object({
      action: z.literal("oauth-complete"),
      loginId: id,
      response: z.string().trim().min(1).max(8192),
    })
    .strict(),
]);
export type ModelSettingsAction = z.infer<typeof modelSettingsActionSchema>;
export const modelSettingsSchema = z.object({
  catalog: modelCatalogSchema,
  accounts: z.array(
    z.object({
      id,
      label: z.string(),
      kind: z.enum(["oauth", "api"]),
      state: z.enum(["ready", "disabled", "needs-login", "configured"]),
      version: z.string(),
      models: z.array(z.object({ id, enabled: z.boolean() })),
    }),
  ),
  services: z.array(
    z.object({ id, label: z.string(), experimental: z.boolean() }),
  ),
  servicesUnavailable: z.boolean(),
});
export type ModelSettingsSnapshot = z.infer<typeof modelSettingsSchema>;
export const modelLoginSchema = z.object({
  loginId: id,
  accountId: id,
  url: z.string(),
  userCode: z.string().optional(),
  expiresAt: z.string(),
  pollSeconds: z.number(),
  manualResponse: z.boolean(),
});
export type ModelLogin = z.infer<typeof modelLoginSchema>;
export const apiConnectionSettingsSchema = z.object({
  accountId: id,
  baseUrl: z.string(),
  protocol: apiProtocolSchema,
  version: id,
  keyEditable: z.boolean(),
  keyUnavailableReason: z.string().nullable(),
  endpointAccounts: z.array(z.string()),
  keyAccounts: z.array(z.string()),
});
export type ApiConnectionSettings = z.infer<typeof apiConnectionSettingsSchema>;
export const modelSettingsResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connection"),
    connection: apiConnectionSettingsSchema,
  }),
  z.object({
    kind: z.literal("saved"),
    accountId: z.string().optional(),
    warning: z.string().optional(),
  }),
  z.object({ kind: z.literal("discovered"), models: z.array(z.string()) }),
  z.object({ kind: z.literal("login"), login: modelLoginSchema }),
  z.object({ kind: z.literal("pending"), retrySeconds: z.number() }),
  z.object({ kind: z.literal("cancelled") }),
]);
export type ModelSettingsResult = z.infer<typeof modelSettingsResultSchema>;
