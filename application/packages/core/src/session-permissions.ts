import { z } from "zod";

export const sessionPermissionPresetSchema = z.enum([
  "request_approval",
  "auto_review",
  "full_access",
]);
export const sessionPermissionModeSchema = z.enum([
  ...sessionPermissionPresetSchema.options,
  "custom",
]);
const identifier = z.string().min(1).max(200);
export const sessionPermissionsReadSchema = z
  .object({ projectId: identifier, conversationId: identifier })
  .strict();
export type SessionPermissionsRead = z.infer<
  typeof sessionPermissionsReadSchema
>;
export const sessionPermissionsUpdateSchema = sessionPermissionsReadSchema
  .extend({
    permissionMode: sessionPermissionPresetSchema,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.permissionMode !== "full_access" || value.confirmation === true,
    {
      message: "完全访问需要本人明确确认风险。",
      path: ["confirmation"],
    },
  );
export type SessionPermissionsUpdate = z.infer<
  typeof sessionPermissionsUpdateSchema
>;

/** Runtime owns the policy. A fingerprint is a Host preflight observation,
 * not an atomic Runtime revision or a grant to a tool/application. */
export const sessionPermissionsSnapshotSchema = z.object({
  scope: sessionPermissionsReadSchema.extend({
    kind: z.enum(["global", "conversation"]),
  }),
  runtimeSessionId: z.string().nullable(),
  permissionMode: sessionPermissionModeSchema.nullable(),
  sandboxMode: z.enum(["workspace-write", "danger-full-access"]).nullable(),
  reviewer: z.enum(["user", "auto_review", "deny"]).nullable(),
  source: z.enum(["runtime", "safe_default"]),
  canUpdate: z.boolean(),
  readOnlyReason: z
    .enum(["not_started", "team_managed", "local_only"])
    .nullable(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  workspace: z.object({
    targetId: z.string().nullable(),
    targetName: z.string().nullable(),
    workspaceRoot: z.string().nullable(),
    ready: z.boolean(),
    reason: z.string().nullable(),
  }),
});
export type SessionPermissionsSnapshot = z.infer<
  typeof sessionPermissionsSnapshotSchema
>;
