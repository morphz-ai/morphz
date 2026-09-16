import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type AccessContext,
  type Workspace,
  DomainError,
  id,
} from "../../../packages/core/src/model.js";
import type { WorkspaceStore } from "./store.js";

// A center operator provisions these records locally. Clients never supply Principal/Actant mappings.
export const identityConfigSchema = z
  .object({
    version: z.literal(1),
    members: z
      .array(
        z
          .object({
            principalId: id,
            actantId: id,
            loginTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const field of ["principalId", "actantId", "loginTokenHash"] as const)
      if (
        new Set(value.members.map((m) => m[field])).size !==
        value.members.length
      )
        ctx.addIssue({ code: "custom", message: "身份配置包含重复映射。" });
  });
type Config = z.infer<typeof identityConfigSchema>;
const sessionsSchema = z
  .array(
    z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        csrf: z.string().regex(/^[a-f0-9]{64}$/),
        principalId: id,
        actantId: id,
        credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
        expiresAt: z.number().int(),
      })
      .strict(),
  )
  .max(4000);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Authentication is a durable property of a center, not merely of a live process.
// The sessions check also protects centers created before the explicit mode marker.
export function requiresIdentity(store: WorkspaceStore): boolean {
  return (
    store.serviceState("identity-mode") === "team" ||
    store.serviceState("identity-sessions") !== null
  );
}
export class IdentityCenter {
  readonly cookieName: string;
  readonly legacyCookieName: string;
  private config: Config;
  private sessions: z.infer<typeof sessionsSchema>;
  private attempts = new Map<string, { start: number; count: number }>();
  constructor(
    private store: WorkspaceStore,
    configuration: unknown,
    private now = Date.now,
  ) {
    const suffix = digest(store.identity()).slice(0, 16);
    this.cookieName = "morphz_" + suffix;
    this.legacyCookieName = "morphzwork_" + suffix;
    this.config = identityConfigSchema.parse(configuration);
    this.sessions = sessionsSchema.parse(
      store.serviceState("identity-sessions") ?? [],
    );
    this.replaceConfiguration(configuration);
    this.store.saveServiceState("identity-mode", "team");
  }
  replaceConfiguration(configuration: unknown) {
    const config = identityConfigSchema.parse(configuration),
      state = this.store.snapshot();
    for (const member of config.members) {
      const actor = state.actants.find((a) => a.id === member.actantId);
      if (
        !actor ||
        actor.kind !== "human" ||
        actor.principalId !== member.principalId
      )
        throw new Error("身份配置未绑定到中心中已有的 Human。");
    }
    this.config = config;
    this.sessions = this.sessions.filter(
      (s) => this.current(s) && s.expiresAt > this.now(),
    );
    this.save();
  }
  private current(s: z.infer<typeof sessionsSchema>[number]) {
    return this.config.members.some(
      (m) =>
        m.enabled &&
        m.principalId === s.principalId &&
        m.actantId === s.actantId &&
        m.loginTokenHash === s.credentialHash,
    );
  }
  allows(access: AccessContext) {
    return this.config.members.some(
      (m) =>
        m.enabled &&
        m.principalId === access.principalId &&
        m.actantId === access.actantId,
    );
  }
  private save() {
    this.store.saveServiceState("identity-sessions", this.sessions);
  }
  private access(s: { principalId: string; actantId: string }): AccessContext {
    const actor = this.store
      .snapshot()
      .actants.find((a) => a.id === s.actantId);
    if (!actor || actor.kind !== "human" || actor.principalId !== s.principalId)
      throw new DomainError("forbidden", "当前身份已撤销。");
    return { principalId: s.principalId, actantId: s.actantId };
  }
  login(token: string, remote: string) {
    const prior = this.attempts.get(remote),
      now = this.now();
    const attempts =
      prior && now - prior.start < 60000 ? prior : { start: now, count: 0 };
    attempts.count++;
    this.attempts.set(remote, attempts);
    if (this.attempts.size > 2000)
      for (const [key, value] of this.attempts)
        if (now - value.start > 60000) this.attempts.delete(key);
    if (attempts.count > 10)
      throw new DomainError("forbidden", "尝试过于频繁，请稍后重试。");
    const hash = digest(token),
      bytes = Buffer.from(hash, "hex");
    const member = this.config.members.find(
      (m) =>
        m.enabled &&
        timingSafeEqual(bytes, Buffer.from(m.loginTokenHash, "hex")),
    );
    if (!/^[a-f0-9]{64}$/.test(token) || !member)
      throw new DomainError("forbidden", "连接凭据无效或已撤销。");
    this.access(member);
    const secret = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    this.sessions = this.sessions.filter(
      (s) => s.expiresAt > now && this.current(s),
    );
    if (this.sessions.length >= 4000)
      throw new DomainError("invalid", "中心连接数量已达上限。");
    this.sessions.push({
      hash: digest(secret),
      csrf,
      principalId: member.principalId,
      actantId: member.actantId,
      credentialHash: member.loginTokenHash,
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    this.save();
    return secret;
  }
  authenticate(cookie: string | undefined) {
    const parts = (cookie ?? "").split(";").map((part) => part.trim());
    // Prefer an explicitly supplied current cookie, even when invalid. Falling
    // back in that case could restore an older identity after a failed switch.
    const name = parts.some((part) => part.startsWith(this.cookieName + "="))
      ? this.cookieName
      : this.legacyCookieName;
    const values = parts.filter((part) => part.startsWith(name + "="));
    if (values.length !== 1) return null;
    const secret = values[0]!.slice(name.length + 1);
    if (!/^[a-f0-9]{64}$/.test(secret)) return null;
    const s = this.sessions.find((s) => s.hash === digest(secret));
    if (!s || s.expiresAt <= this.now() || !this.current(s)) return null;
    return { access: this.access(s), csrf: s.csrf, sessionHash: s.hash };
  }
  logout(hash: string) {
    this.sessions = this.sessions.filter((s) => s.hash !== hash);
    this.save();
  }
}

/** Projects are the current sharing boundary. An excluded object must not leak through graph edges, drafts or participants. */
export function workspaceFor(
  state: Workspace,
  access: AccessContext,
): Workspace {
  const projects = state.projects.filter((p) =>
      p.members.includes(access.principalId),
    ),
    projectIds = new Set(projects.map((p) => p.id)),
    artifacts = state.artifacts.filter((a) => projectIds.has(a.projectId)),
    artifactIds = new Set(artifacts.map((a) => a.id)),
    principalIds = new Set([
      access.principalId,
      ...projects.flatMap((p) => p.members),
    ]);
  return {
    ...state,
    projects,
    conversations: state.conversations.filter((c) =>
      projectIds.has(c.projectId),
    ),
    artifacts,
    bookmarks: state.bookmarks.filter(
      (b) => b.ownerPrincipalId === access.principalId,
    ),
    taskOrder: state.taskOrder.filter((id) => artifactIds.has(id)),
    applicationInstances: state.applicationInstances.filter((i) =>
      projectIds.has(i.workspaceId),
    ),
    applications: state.applications.filter(
      (a) =>
        a.installedBy === access.principalId ||
        state.applicationInstances.some(
          (i) =>
            projectIds.has(i.workspaceId) &&
            i.applicationId === a.id &&
            i.applicationVersion === a.version,
        ),
    ),
    principals: state.principals.filter((p) => principalIds.has(p.id)),
    actants: state.actants.filter((a) => principalIds.has(a.principalId)),
    relations: state.relations.filter(
      (r) => artifactIds.has(r.fromId) && artifactIds.has(r.toId),
    ),
    annotations: state.annotations.filter((a) => artifactIds.has(a.artifactId)),
    inputs: state.inputs.filter((i) => projectIds.has(i.projectId)),
    taskResponses: state.taskResponses.filter((r) => artifactIds.has(r.taskId)),
  };
}
