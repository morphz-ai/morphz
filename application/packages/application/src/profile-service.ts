import { DomainError, type AccessContext } from "../../core/src/model.js";
import {
  defaultAgentProfile,
  defaultHumanProfile,
  profileSnapshotSchema,
  profileToolSchema,
  profileUpdateSchema,
  profileCustomStyleEnabled,
  mergeAgentProfilePatch,
  normalizeAgentProfileData,
  type ProfileSnapshot,
} from "../../core/src/profile.js";
import type { PlatformActor, PlatformStore } from "../../platform/src/store.js";
import type { ProfileAvatarService } from "./profile-avatar-service.js";
import type { RuntimeBridge } from "./runtime.js";

/** Names and preferences have exactly one writable authority: Runtime Custom.
 * Platform only owns independent, versioned avatar presentation. */
export class ProfileService {
  constructor(
    private readonly runtime: () => RuntimeBridge | undefined,
    private readonly platform: PlatformStore,
    readonly avatars?: ProfileAvatarService,
    _initialHumanName?: (access: AccessContext) => string | undefined,
  ) {}
  async read(
    actor: PlatformActor,
    active: () => void = () => {},
  ): Promise<ProfileSnapshot> {
    active();
    const owner = await this.platform.profileAvatarSubject(actor, "human");
    const access: AccessContext = {
      principalId: owner.actor.principalId,
      actantId:
        owner.actor.kind === "agent"
          ? owner.actor.initiatingHumanActantId!
          : owner.actor.actantId,
    };
    // Existing identity presentation remains separate from optional Custom fields.
    // Merely viewing/saving an unset Profile must not copy identity defaults into it.
    let profile:
      Awaited<ReturnType<RuntimeBridge["profiles"]["read"]>> | undefined;
    const runtime = this.runtime();
    if (runtime) {
      try {
        profile = await runtime.profiles.read(access, active);
      } catch (error) {
        active();
        if (error instanceof DomainError && error.code === "forbidden")
          throw error;
        // Unsupported/offline Custom is a visible unavailable state, not fake data.
      }
    }
    const humanAvatar = await this.platform.readProfileAvatar(actor, "human");
    const agentAvatar = profile
      ? await this.platform.readProfileAvatar(actor, "agent")
      : { revision: 0, media: null };
    active();
    return profileSnapshotSchema.parse({
      human: {
        data: profile?.human.data ?? defaultHumanProfile,
        revision: profile?.human.revision ?? 0,
        available: !!profile,
        enabled: profile?.human.enabled ?? false,
        editable: true,
        avatar: humanAvatar,
      },
      agent: {
        id: profile?.identity.agentId ?? "",
        data: profile?.agent.data ?? defaultAgentProfile,
        revision: profile?.agent.revision ?? 0,
        available: !!profile,
        enabled: profile?.agent.enabled ?? false,
        editable: profile?.identity.agentEditable ?? false,
        avatar: agentAvatar,
      },
      avatarUploadAvailable: !!this.avatars,
    });
  }
  async update(
    actor: PlatformActor,
    raw: unknown,
    active: () => void = () => {},
  ) {
    const owner = await this.platform.profileAvatarSubject(
      actor,
      "human",
      true,
    );
    active();
    const runtime = this.runtime();
    if (!runtime)
      throw new DomainError("invalid", "尚未连接 Runtime，Profile 未保存。");
    return runtime.profiles.update(
      { principalId: owner.actor.principalId, actantId: owner.actor.actantId },
      profileUpdateSchema.parse(raw),
      active,
    );
  }
  /** Human proposals remain proposals. The host may perform a narrowly scoped
   * self-Agent Custom update under the actual persisted invocation identity. */
  async agentOperation(
    actor: PlatformActor,
    raw: unknown,
    trustedAgentId?: string,
  ) {
    const request = profileToolSchema.parse(raw);
    if (request.action === "read") {
      const snapshot = await this.read(actor);
      // The Human/operator may retain inactive authoring text, but an Agent
      // tool result must not reintroduce it after the Custom compiler omitted it.
      if (
        !snapshot.agent.enabled ||
        !profileCustomStyleEnabled(snapshot.agent.data)
      )
        snapshot.agent.data = { ...snapshot.agent.data, customStyle: null };
      return snapshot;
    }
    if (request.action === "update") {
      const owner = await this.platform.profileAvatarSubject(actor, "agent");
      if (
        owner.actor.kind !== "agent" ||
        !owner.actor.runtimeInputId ||
        !trustedAgentId ||
        owner.subjectId !== trustedAgentId ||
        !("editable" in owner) ||
        !owner.editable
      )
        throw new DomainError(
          "forbidden",
          "只能修改本次调用所属的个人智能体资料。",
        );
      if (
        request.enabled === undefined &&
        (!request.data ||
          !Object.values(request.data).some(
            (value) =>
              value !== undefined &&
              (typeof value !== "object" ||
                value === null ||
                Object.keys(value).length > 0),
          ))
      )
        throw new DomainError("invalid", "请指定要修改的资料字段或使用开关。");
      const runtime = this.runtime();
      if (!runtime)
        throw new DomainError("invalid", "尚未连接 Runtime，Profile 未保存。");
      const access: AccessContext = {
        principalId: owner.actor.principalId,
        actantId: owner.actor.initiatingHumanActantId!,
      };
      // Full authoring data remains inside the trusted Host. It is never
      // returned to the Agent simply to reconstruct a sparse write.
      const current = await runtime.profiles.readAgentRevision(
        access,
        request.expectedRevision,
        trustedAgentId,
      );
      const saved = await runtime.profiles.update(
        access,
        {
          subject: "agent",
          commandId: request.commandId,
          expectedRevision: request.expectedRevision,
          enabled: request.enabled ?? current.enabled,
          data: mergeAgentProfilePatch(current.data, request.data ?? {}),
        },
        () => {},
        trustedAgentId,
      );
      const data = normalizeAgentProfileData(saved.data);
      return {
        ...saved,
        data:
          !saved.enabled || !profileCustomStyleEnabled(data)
            ? { ...data, customStyle: null }
            : data,
      };
    }
    await this.platform.profileAvatarSubject(actor, "human");
    return {
      ok: false,
      code: "requires_human_confirmation",
      saved: false,
      proposal: request.change,
      message: "请用户在个人资料中确认后保存；此建议尚未修改 Profile。",
    };
  }
}
