import type { WorkspaceStore } from "../packages/application/src/store.js";
import type { IdentityCenter } from "../packages/application/src/identity.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

const noBusinessAuthority: PlatformAuthorityVerifier = {
  resolveActor: async () => null,
  resolveActant: async () => null,
  resolveProjectAgent: async () => null,
  verifyApplicationObject: async () => false,
};

/** Identity-only tests use the real Platform tables, without granting access
 * to projects or app originals through their unrelated business verifier. */
export async function bindIdentityTestPlatform(
  workspace: WorkspaceStore,
  identity: IdentityCenter,
  existing?: PlatformStore,
  filename = ":memory:",
) {
  const platform =
    existing ?? (await PlatformStore.sqlite(filename, noBusinessAuthority));
  await platform.provisionTenant(workspace.identity());
  await identity.bindPlatform(platform, workspace.identity());
  return platform;
}
