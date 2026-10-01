import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../../core/src/model.js";
import {
  ManagedArtifactStore,
  type StoreAuthorizationRequest,
} from "../../managed-artifact-store/src/store.js";
import type { S3ByteLocation } from "../../managed-artifact-store/src/s3-bytes.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type {
  ObjectsByteReference,
  ObjectsStore,
} from "../../objects/src/store.js";
import type {
  PlatformActor,
  PlatformAuthorityVerifier,
} from "../../platform/src/store.js";

const maximumBytes = 6 * 1024 * 1024;
type Scope = {
  artifactId: string;
  operation: "write" | "read";
  actor: PlatformActor;
  assertAccess?: () => Promise<void>;
};

function imageMime(bytes: Uint8Array) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!data.length || data.length > maximumBytes)
    throw new DomainError("invalid", "图片不能超过 6 MB，且不能为空。");
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
    return "image/jpeg";
  if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw new DomainError("invalid", "支持 PNG、JPEG 和 WebP 图片。");
}

/** Objects owns the image version; this app-private Store owns only bytes.
 * A digest in a URL or create request never grants access to those bytes. */
export class ImageService {
  private constructor(
    private readonly store: ManagedArtifactStore,
    private readonly tenantId: string,
    private readonly verifier: PlatformAuthorityVerifier,
    private readonly objects: ObjectsStore,
    private readonly scopes: Map<string, Scope>,
  ) {}

  static async open(request: {
    root: string;
    tenantId: string;
    verifier: PlatformAuthorityVerifier;
    objects: ObjectsStore;
    authorizeProvider: (actor: PlatformActor) => Promise<void>;
    cloud?: {
      connectionString: string;
      schema: string;
      bytes: S3ByteLocation;
      s3Client?: S3Client;
    };
  }) {
    const scopes = new Map<string, Scope>();
    const storeId = `store_objects_images_${createHash("sha256")
      .update(request.tenantId)
      .digest("hex")
      .slice(0, 24)}`;
    const options = {
      root: request.root,
      storeId,
      maxBytes: maximumBytes,
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
            throw new DomainError("forbidden", "图片 Store 调用未获授权。");
          const actor = await request.verifier.resolveActor(scope.actor);
          if (
            !actor ||
            actor.tenantId !== request.tenantId ||
            actor.kind !== "human"
          )
            throw new DomainError("forbidden", "图片操作身份已失效。");
          await request.authorizeProvider(scope.actor);
          await scope.assertAccess?.();
          return {
            tenantId: request.tenantId,
            principalId: "objects-image-service",
          };
        },
      },
    };
    const store = request.cloud
      ? await ManagedArtifactStore.cloud({ ...options, ...request.cloud })
      : await ManagedArtifactStore.sqlite(options);
    return new ImageService(
      store,
      request.tenantId,
      request.verifier,
      request.objects,
      scopes,
    );
  }

  hasCommittedVersions() {
    return this.store.hasCommittedVersions();
  }

  private async principal(actor: PlatformActor) {
    const resolved = await this.verifier.resolveActor(actor);
    if (
      !resolved ||
      resolved.tenantId !== this.tenantId ||
      resolved.kind !== "human"
    )
      throw new DomainError("forbidden", "当前用户不能保存图片。");
    return resolved.principalId;
  }

  private artifactId(principalId: string, assetId: string) {
    if (!/^[a-f0-9]{64}$/.test(assetId))
      throw new DomainError("invalid", "图片摘要无效。");
    const owner = createHash("sha256")
      .update(`${this.tenantId}:${principalId}`)
      .digest("hex")
      .slice(0, 24);
    return `image_${owner}_${assetId}`;
  }

  private async scoped<T>(
    actor: PlatformActor,
    artifactId: string,
    operation: "write" | "read",
    work: (credential: string) => Promise<T>,
    assertAccess?: () => Promise<void>,
  ) {
    const credential = randomBytes(32).toString("hex");
    this.scopes.set(credential, { actor, artifactId, operation, assertAccess });
    try {
      return await work(credential);
    } finally {
      this.scopes.delete(credential);
    }
  }

  async upload(actor: PlatformActor, bytes: Uint8Array) {
    const principalId = await this.principal(actor);
    const mime = imageMime(bytes);
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const artifactId = this.artifactId(principalId, assetId);
    await this.scoped(actor, artifactId, "write", (credential) =>
      this.store.put({
        credential,
        commandId: artifactId,
        artifactId,
        baseRevision: 0,
        mime,
        expectedSha256: assetId,
        bytes,
      }),
    );
    return { assetId, mime };
  }

  async uploadedReference(
    actor: PlatformActor,
    assetId: string,
  ): Promise<ObjectsByteReference> {
    const artifactId = this.artifactId(await this.principal(actor), assetId);
    let found;
    try {
      found = await this.scoped(actor, artifactId, "read", (credential) =>
        this.store.readRange({ credential, artifactId, revision: 1 }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Artifact 版本不存在。")
        throw new DomainError("invalid", "请先上传这张图片，再创建内容。");
      throw error;
    }
    const { version, bytes } = found;
    if (
      version.sha256 !== assetId ||
      bytes.byteLength !== version.byteLength ||
      imageMime(bytes) !== version.mime ||
      createHash("sha256").update(bytes).digest("hex") !== assetId
    )
      throw new Error("上传图片的 Store 版本与摘要不匹配。");
    return {
      storeId: version.storeId,
      artifactId,
      revision: version.revision,
      sha256: assetId,
      byteLength: version.byteLength,
      mime: version.mime,
    };
  }

  async revisionReference(
    actor: PlatformActor,
    objectId: string,
    revision: number,
    assetId: string,
  ) {
    const previous = await this.objects.authorizeVersionBytes({
      credential: actor.credential,
      objectId,
      objectRevision: revision,
    });
    if (
      previous.reference.sha256 === assetId &&
      previous.reference.storeId === this.store.storeId
    )
      return previous.reference;
    return this.uploadedReference(actor, assetId);
  }

  async read(actor: PlatformActor, assetId: string) {
    await this.principal(actor);
    const authorized = await this.objects.authorizeAssetBytes({
      credential: actor.credential,
      tenantId: this.tenantId,
      assetId,
      storeId: this.store.storeId,
    });
    if (!authorized || authorized.reference.storeId !== this.store.storeId)
      throw new DomainError("not_found", "图片不存在或无权访问。");
    const { reference } = authorized;
    const assertAccess = async () => {
      const current = await this.objects.authorizeVersionBytes({
        credential: actor.credential,
        objectId: authorized.objectId,
        objectRevision: authorized.objectRevision,
      });
      if (
        current.tenantId !== this.tenantId ||
        current.principalId !== authorized.principalId ||
        current.contentId !== authorized.contentId ||
        JSON.stringify(current.reference) !== JSON.stringify(reference)
      )
        throw new DomainError("forbidden", "图片读取权限已变化。");
    };
    const { version, bytes } = await this.scoped(
      actor,
      reference.artifactId,
      "read",
      (credential) =>
        this.store.readRange({
          credential,
          artifactId: reference.artifactId,
          revision: reference.revision,
        }),
      assertAccess,
    );
    await assertAccess();
    if (
      version.storeId !== reference.storeId ||
      version.sha256 !== assetId ||
      version.mime !== reference.mime ||
      version.byteLength !== reference.byteLength ||
      bytes.byteLength !== reference.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== assetId
    )
      throw new Error("图片字节与 Objects 原件版本不匹配。");
    return { mime: version.mime, bytes };
  }

  async close() {
    await this.store.close();
  }
}
