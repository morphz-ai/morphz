import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../../core/src/model.js";
import {
  avatarMaximumBytes,
  avatarStoredVersionSchema,
  profileAvatarCommandSchema,
  profileAvatarReadSchema,
  type ProfileAvatarMedia,
  type ProfileSubject,
} from "../../core/src/profile.js";
import {
  ManagedArtifactStore,
  type StoredVersion,
  type StoreAuthorizationRequest,
} from "../../managed-artifact-store/src/store.js";
import type { S3ByteLocation } from "../../managed-artifact-store/src/s3-bytes.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type {
  PlatformActor,
  PlatformAuthorityVerifier,
  PlatformStore,
} from "../../platform/src/store.js";
import { validateProfileAvatar } from "./profile-avatar-decode.js";

type Scope = {
  actor: PlatformActor;
  subject: ProfileSubject;
  subjectId: string;
  artifactId: string;
  operation: "write" | "read";
  assertAccess?: () => Promise<void>;
};
export function profileAvatarStoreId(tenantId: string) {
  return `store_profile_avatars_${createHash("sha256").update(tenantId).digest("hex").slice(0, 24)}`;
}
export function profileAvatarArtifactId(
  tenantId: string,
  subject: ProfileSubject,
  subjectId: string,
  variant: "original" | "poster",
  sha256: string,
) {
  return (
    "avatar_" +
    createHash("sha256")
      .update(JSON.stringify([tenantId, subject, subjectId, variant, sha256]))
      .digest("hex")
  );
}
/** Bytes are published before the Platform pointer CAS. Failed or ambiguous
 * binds never erase bytes or replace a newer head. Custom is a separate authority. */
export class ProfileAvatarService {
  private constructor(
    private readonly store: ManagedArtifactStore,
    private readonly tenantId: string,
    private readonly platform: PlatformStore,
    private readonly scopes: Map<string, Scope>,
  ) {}
  static async open(request: {
    root: string;
    tenantId: string;
    platform: PlatformStore;
    verifier: PlatformAuthorityVerifier;
    cloud?: {
      connectionString: string;
      schema: string;
      bytes: S3ByteLocation;
      s3Client?: S3Client;
    };
  }) {
    const scopes = new Map<string, Scope>(),
      storeId = profileAvatarStoreId(request.tenantId);
    const options = {
      root: request.root,
      storeId,
      maxBytes: avatarMaximumBytes,
      authorizer: {
        authorize: async (
          credential: string,
          operation: StoreAuthorizationRequest,
        ) => {
          const scope = scopes.get(credential);
          if (
            !scope ||
            operation.storeId !== storeId ||
            operation.artifactId !== scope.artifactId ||
            operation.operation !== scope.operation
          )
            throw new DomainError("forbidden", "头像字节操作未获授权。");
          const resolved = await request.verifier.resolveActor(scope.actor);
          if (
            !resolved ||
            resolved.tenantId !== request.tenantId ||
            resolved.kind !== "human"
          )
            throw new DomainError("forbidden", "头像操作身份已失效。");
          const target = await request.platform.profileAvatarSubject(
            scope.actor,
            scope.subject,
            scope.operation === "write",
          );
          if (target.subjectId !== scope.subjectId)
            throw new DomainError("forbidden", "头像主体已变化。");
          await scope.assertAccess?.();
          return {
            tenantId: request.tenantId,
            principalId: "profile-avatar-service",
          };
        },
      },
    };
    const store = request.cloud
      ? await ManagedArtifactStore.cloud({ ...options, ...request.cloud })
      : await ManagedArtifactStore.sqlite(options);
    return new ProfileAvatarService(
      store,
      request.tenantId,
      request.platform,
      scopes,
    );
  }
  private artifactId(
    subject: ProfileSubject,
    subjectId: string,
    variant: "original" | "poster",
    sha256: string,
  ) {
    return profileAvatarArtifactId(
      this.tenantId,
      subject,
      subjectId,
      variant,
      sha256,
    );
  }
  private async scoped<T>(
    scope: Scope,
    work: (credential: string) => Promise<T>,
  ) {
    const credential = randomBytes(32).toString("hex");
    this.scopes.set(credential, scope);
    try {
      return await work(credential);
    } finally {
      this.scopes.delete(credential);
    }
  }
  private async publish(
    actor: PlatformActor,
    subject: ProfileSubject,
    subjectId: string,
    variant: "original" | "poster",
    bytes: Uint8Array,
    mime: string,
  ) {
    const sha256 = createHash("sha256").update(bytes).digest("hex"),
      artifactId = this.artifactId(subject, subjectId, variant, sha256);
    const version = await this.scoped(
      { actor, subject, subjectId, artifactId, operation: "write" },
      (credential) =>
        this.store.put({
          credential,
          commandId: artifactId,
          artifactId,
          baseRevision: 0,
          mime,
          expectedSha256: sha256,
          bytes,
        }),
    );
    return avatarStoredVersionSchema.parse(version);
  }
  private async exact(
    actor: PlatformActor,
    subject: ProfileSubject,
    subjectId: string,
    variant: "original" | "poster",
    reference: StoredVersion,
    assertAccess?: () => Promise<void>,
  ) {
    const artifactId = this.artifactId(
      subject,
      subjectId,
      variant,
      reference.sha256,
    );
    if (
      reference.storeId !== this.store.storeId ||
      reference.artifactId !== artifactId ||
      reference.revision !== 1
    )
      throw new DomainError("forbidden", "头像原件引用不匹配。");
    const found = await this.scoped(
      {
        actor,
        subject,
        subjectId,
        artifactId,
        operation: "read",
        assertAccess,
      },
      (credential) =>
        this.store.readRange({
          credential,
          artifactId,
          revision: reference.revision,
        }),
    );
    if (
      Object.keys(reference).some(
        (key) =>
          found.version[key as keyof StoredVersion] !==
          reference[key as keyof StoredVersion],
      ) ||
      found.bytes.byteLength !== reference.byteLength ||
      createHash("sha256").update(found.bytes).digest("hex") !==
        reference.sha256
    )
      throw new Error("头像字节与保存的版本不匹配。");
    await assertAccess?.();
    return { bytes: found.bytes, mime: found.version.mime };
  }
  async verifyMedia(
    actor: PlatformActor,
    subject: ProfileSubject,
    subjectId: string,
    media: ProfileAvatarMedia,
  ) {
    await this.exact(actor, subject, subjectId, "original", media.original);
    await this.exact(actor, subject, subjectId, "poster", media.poster);
    return true;
  }
  async set(actor: PlatformActor, raw: unknown, data: Uint8Array) {
    const request = profileAvatarCommandSchema.parse(raw);
    const { subjectId } = await this.platform.profileAvatarSubject(
      actor,
      request.subject,
      true,
    );
    const validated = await validateProfileAvatar(data);
    const original = await this.publish(
      actor,
      request.subject,
      subjectId,
      "original",
      validated.bytes,
      validated.mime,
    );
    const poster = await this.publish(
      actor,
      request.subject,
      subjectId,
      "poster",
      validated.poster,
      "image/png",
    );
    return this.platform.updateProfileAvatar(actor, {
      ...request,
      media: {
        original,
        poster,
        width: validated.width,
        height: validated.height,
        frames: validated.frames,
        durationMs: validated.durationMs,
      },
    });
  }
  async clear(actor: PlatformActor, raw: unknown) {
    return this.platform.updateProfileAvatar(actor, {
      ...profileAvatarCommandSchema.parse(raw),
      media: null,
    });
  }
  hasCommittedVersions() {
    return this.store.hasCommittedVersions();
  }
  async read(actor: PlatformActor, raw: unknown) {
    const request = profileAvatarReadSchema.parse(raw),
      { subjectId } = await this.platform.profileAvatarSubject(
        actor,
        request.subject,
      );
    const current = await this.platform.readProfileAvatar(
      actor,
      request.subject,
    );
    if (current.revision !== request.revision)
      throw new DomainError("conflict", "头像已更新，请重新读取。");
    if (!current.media) throw new DomainError("not_found", "尚未设置头像。");
    const reference = current.media[request.variant];
    const assertAccess = async () => {
      const latest = await this.platform.readProfileAvatar(
        actor,
        request.subject,
      );
      if (
        latest.revision !== current.revision ||
        JSON.stringify(latest.media) !== JSON.stringify(current.media)
      )
        throw new DomainError("forbidden", "头像读取权限或版本已变化。");
    };
    return this.exact(
      actor,
      request.subject,
      subjectId,
      request.variant,
      reference,
      assertAccess,
    );
  }
  async close() {
    await this.store.close();
  }
}
