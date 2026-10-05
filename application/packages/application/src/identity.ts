import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type AccessContext,
  type Workspace,
  DomainError,
  id,
  morphzAgentAccess,
} from "../../../packages/core/src/model.js";
import type { WorkspaceStore } from "./store.js";
import {
  PlatformStorageError,
  type PlatformStore,
  type TeamLoginSession,
} from "../../platform/src/store.js";

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
    if (
      value.members.some(
        (member) =>
          member.principalId === morphzAgentAccess.principalId ||
          member.actantId === morphzAgentAccess.actantId,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Human 身份配置不能使用 Morphz Agent 身份。",
      });
  });
type Config = z.infer<typeof identityConfigSchema>;
type OperatorMember = {
  principalId: string;
  actantId: string;
  name?: string;
  projectIds: string[];
  enabled: boolean;
};
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
  private operatorMembers?: OperatorMember[];
  private readonly sessions = new Map<
    string,
    z.infer<typeof sessionsSchema>[number]
  >();
  private platform?: { store: PlatformStore; tenantId: string };
  private configSha256: string;
  private attempts = new Map<string, { start: number; count: number }>();
  constructor(
    private store: WorkspaceStore,
    configuration: unknown,
    private now = Date.now,
    operatorMembers?: OperatorMember[],
  ) {
    const suffix = digest(store.identity()).slice(0, 16);
    this.cookieName = "morphz_" + suffix;
    this.legacyCookieName = "morphzwork_" + suffix;
    this.config = identityConfigSchema.parse(configuration);
    this.operatorMembers = this.validateOperatorMembers(
      this.config,
      operatorMembers,
    );
    this.configSha256 = this.fingerprint(this.config, this.operatorMembers);
  }

  private validateOperatorMembers(config: Config, members?: OperatorMember[]) {
    if (
      members &&
      (members.length !== config.members.length ||
        members.some((member, index) => {
          const current = config.members[index]!;
          return (
            member.principalId !== current.principalId ||
            member.actantId !== current.actantId ||
            member.enabled !== current.enabled
          );
        }))
    )
      throw new Error("成员授权与登录身份配置不一致。");
    return members?.map((member) => ({
      principalId: member.principalId,
      actantId: member.actantId,
      name:
        member.name === undefined
          ? undefined
          : z.string().trim().min(1).max(100).parse(member.name),
      projectIds: [...member.projectIds],
      enabled: member.enabled,
    }));
  }

  private fingerprint(config: Config, members?: OperatorMember[]) {
    const memberships = new Map(
      members?.map((member) => [member.principalId, member.projectIds]) ?? [],
    );
    return digest(
      JSON.stringify(
        config.members
          .map((member) => ({
            ...member,
            projectIds: [...(memberships.get(member.principalId) ?? [])].sort(),
          }))
          .sort((a, b) => a.principalId.localeCompare(b.principalId)),
      ),
    );
  }

  /** Attach the Platform authority before serving a Client or Agent request.
   * Existing local session hashes are moved once; no plaintext credential is
   * recovered, and the Host does not keep a second durable write path. */
  async bindPlatform(platform: PlatformStore, tenantId: string) {
    if (this.platform) throw new Error("团队身份已经绑定 Platform。");
    if (tenantId !== this.store.identity())
      throw new Error("团队身份与 Platform 中心不一致。");
    await platform.bindTeamIdentityConfig(tenantId, this.configSha256);
    const legacy = sessionsSchema.parse(
      this.store.serviceState("identity-sessions") ?? [],
    );
    for (const session of legacy) {
      if (!this.current(session) || session.expiresAt <= this.now()) continue;
      await platform.issueTeamLoginSession(
        tenantId,
        this.configSha256,
        {
          sessionHash: session.hash,
          csrf: session.csrf,
          principalId: session.principalId,
          actantId: session.actantId,
          credentialHash: session.credentialHash,
          expiresAt: session.expiresAt,
        },
        this.now(),
      );
      this.sessions.set(session.hash, session);
    }
    this.platform = { store: platform, tenantId };
    this.store.saveServiceState("identity-sessions", null);
    // A local fail-closed boot sentinel remains until Platform can be opened;
    // it is not a second session or authorization authority.
    this.store.saveServiceState("identity-mode", "team");
  }

  async replaceConfiguration(
    configuration: unknown,
    operatorMembers?: OperatorMember[],
  ) {
    const config = identityConfigSchema.parse(configuration);
    const members = this.validateOperatorMembers(config, operatorMembers);
    const nextSha256 = this.fingerprint(config, members);
    if (!this.platform) throw new Error("团队身份尚未绑定 Platform。");
    try {
      if (members)
        await this.platform.store.reconcileOperatorMembers(
          this.platform.tenantId,
          members,
          {
            expectedSha256: this.configSha256,
            ...(nextSha256 !== this.configSha256
              ? {
                  replacement: {
                    sha256: nextSha256,
                    activeBindings: config.members
                      .filter((member) => member.enabled)
                      .map((member) => ({
                        principalId: member.principalId,
                        actantId: member.actantId,
                        credentialHash: member.loginTokenHash,
                      })),
                    retiredPrincipalIds: this.config.members
                      .filter(
                        (previous) =>
                          !config.members.some(
                            (current) =>
                              current.principalId === previous.principalId,
                          ),
                      )
                      .map((member) => member.principalId),
                  },
                }
              : {}),
          },
        );
      else if (nextSha256 !== this.configSha256)
        await this.platform.store.replaceTeamIdentityConfig(
          this.platform.tenantId,
          this.configSha256,
          nextSha256,
          config.members
            .filter((member) => member.enabled)
            .map((member) => ({
              principalId: member.principalId,
              actantId: member.actantId,
              credentialHash: member.loginTokenHash,
            })),
        );
    } catch (error) {
      // Another Host may have committed this exact operator file first. It is
      // safe to adopt its already-atomic Platform state, not to replay it.
      if (
        !(error instanceof PlatformStorageError) ||
        error.code !== "conflict" ||
        nextSha256 === this.configSha256 ||
        !(await this.platform.store.teamIdentityConfigMatches(
          this.platform.tenantId,
          nextSha256,
        ))
      )
        throw error;
    }
    this.config = config;
    this.operatorMembers = members;
    this.configSha256 = nextSha256;
    for (const [hash, session] of this.sessions)
      if (!this.current(session) || session.expiresAt <= this.now())
        this.sessions.delete(hash);
  }
  async reconcileCurrentMemberships() {
    if (!this.platform) throw new Error("团队身份尚未绑定 Platform。");
    if (!this.operatorMembers) return;
    await this.platform.store.reconcileOperatorMembers(
      this.platform.tenantId,
      this.operatorMembers,
      { expectedSha256: this.configSha256 },
    );
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
  displayName(access: AccessContext) {
    if (!this.allows(access))
      throw new DomainError("forbidden", "当前身份已撤销。");
    return (
      this.operatorMembers?.find(
        (member) =>
          member.enabled &&
          member.principalId === access.principalId &&
          member.actantId === access.actantId,
      )?.name ?? access.actantId
    );
  }
  async allowsShared(access: AccessContext) {
    return (
      this.allows(access) &&
      !!this.platform &&
      (await this.platform.store.teamIdentityConfigMatches(
        this.platform.tenantId,
        this.configSha256,
      ))
    );
  }
  resolveHumanActant(actantId: string) {
    const member = this.config.members.find(
      (m) => m.enabled && m.actantId === actantId,
    );
    return member
      ? { principalId: member.principalId, kind: "human" as const }
      : null;
  }
  /** Host-only directory snapshot; no login tokens or session credentials.
   * Runtime provenance reads still recheck the authoritative team revision. */
  currentHumanAccesses(): AccessContext[] {
    return this.config.members
      .filter((member) => member.enabled)
      .map(({ principalId, actantId }) => ({ principalId, actantId }));
  }
  private access(s: { principalId: string; actantId: string }): AccessContext {
    if (!this.allows(s)) throw new DomainError("forbidden", "当前身份已撤销。");
    return { principalId: s.principalId, actantId: s.actantId };
  }
  async login(token: string, remote: string) {
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
      throw new DomainError("forbidden", "登录凭据无效或已撤销。");
    this.access(member);
    const secret = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    if (!this.platform)
      throw new DomainError("forbidden", "团队身份尚未接入 Platform。");
    const session = {
      hash: digest(secret),
      csrf,
      principalId: member.principalId,
      actantId: member.actantId,
      credentialHash: member.loginTokenHash,
      expiresAt: now + 24 * 60 * 60 * 1000,
    };
    await this.platform.store.issueTeamLoginSession(
      this.platform.tenantId,
      this.configSha256,
      {
        sessionHash: session.hash,
        csrf: session.csrf,
        principalId: session.principalId,
        actantId: session.actantId,
        credentialHash: session.credentialHash,
        expiresAt: session.expiresAt,
      },
      now,
    );
    this.sessions.set(session.hash, session);
    return secret;
  }

  private cookieHash(cookie: string | undefined) {
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
    return digest(secret);
  }

  /** A synchronous assertion for an already verified request in this Host.
   * New HTTP requests must use authenticateShared for cross-Host revocation. */
  authenticate(cookie: string | undefined) {
    const hash = this.cookieHash(cookie);
    const s = hash ? this.sessions.get(hash) : undefined;
    if (!s || s.expiresAt <= this.now() || !this.current(s)) return null;
    return { access: this.access(s), csrf: s.csrf, sessionHash: s.hash };
  }

  async authenticateShared(cookie: string | undefined) {
    const hash = this.cookieHash(cookie);
    if (!hash || !this.platform) return null;
    const record: TeamLoginSession | null =
      await this.platform.store.teamLoginSession(
        this.platform.tenantId,
        this.configSha256,
        hash,
        this.now(),
      );
    if (!record) {
      this.sessions.delete(hash);
      return null;
    }
    const session = {
      hash: record.sessionHash,
      csrf: record.csrf,
      principalId: record.principalId,
      actantId: record.actantId,
      credentialHash: record.credentialHash,
      expiresAt: record.expiresAt,
    };
    if (!this.current(session)) return null;
    this.sessions.set(hash, session);
    return {
      access: this.access(session),
      csrf: session.csrf,
      sessionHash: session.hash,
    };
  }

  async logout(hash: string) {
    if (!this.platform)
      throw new DomainError("forbidden", "团队身份尚未接入 Platform。");
    await this.platform.store.revokeTeamLoginSession(
      this.platform.tenantId,
      hash,
    );
    this.sessions.delete(hash);
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
    scriptProductions: state.scriptProductions.filter((p) =>
      projectIds.has(p.projectId),
    ),
    scriptPreparations: state.scriptPreparations.filter(
      (p) =>
        projectIds.has(p.projectId) &&
        state.inputs.some(
          (i) => i.id === p.inputId && projectIds.has(i.projectId),
        ),
    ),
    bookmarks: state.bookmarks.filter(
      (b) => b.ownerPrincipalId === access.principalId,
    ),
    readingMarks: state.readingMarks.filter(
      (m) =>
        m.ownerPrincipalId === access.principalId &&
        artifactIds.has(m.artifactId),
    ),
    readingStates: state.readingStates.filter(
      (m) =>
        m.ownerPrincipalId === access.principalId &&
        artifactIds.has(m.artifactId),
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
