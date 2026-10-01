import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { id } from "../../../packages/core/src/model.js";
import {
  IdentityCenter,
  identityConfigSchema,
  requiresIdentity,
} from "./identity.js";
import type { WorkspaceStore } from "./store.js";

export const centerMembersSchema = z
  .object({
    version: z.literal(1),
    members: z
      .array(
        z
          .object({
            principalId: id,
            actantId: id,
            name: z.string().trim().min(1).max(100),
            projectIds: z.array(id).max(1000),
            enabled: z.boolean(),
            loginTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type CenterMembers = z.infer<typeof centerMembersSchema>;

/** Operator-owned local control plane, never an HTTP body or a project document. */
export function readCenterMembers(directory: string) {
  const filename = join(directory, "members.json");
  if (!existsSync(filename)) return undefined;
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > 256 * 1024 ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error("members.json 必须是仅当前用户可读写的普通文件。");
    try {
      return centerMembersSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      throw new Error("members.json 格式无效；配置内容不会写入日志。");
    }
  } finally {
    closeSync(fd);
  }
}

export function identityConfiguration(config: CenterMembers) {
  return identityConfigSchema.parse({
    version: 1,
    members: config.members.map(
      ({ principalId, actantId, enabled, loginTokenHash }) => ({
        principalId,
        actantId,
        enabled,
        loginTokenHash,
      }),
    ),
  });
}

export async function loadIdentity(
  store: WorkspaceStore,
  directory: string,
  existing?: IdentityCenter,
) {
  const config = readCenterMembers(directory);
  if (!config) {
    if (existing || requiresIdentity(store))
      throw new Error("身份配置不可用；不允许回退为单用户模式。");
    return undefined;
  }
  const identity = identityConfiguration(config);
  if (existing) {
    await existing.replaceConfiguration(identity, config.members);
    return existing;
  }
  return new IdentityCenter(store, identity, Date.now, config.members);
}
