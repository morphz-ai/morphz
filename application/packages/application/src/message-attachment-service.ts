import { createHash, randomBytes } from "node:crypto";
import type { AccessContext, InputAttachment } from "../../core/src/model.js";
import { DomainError } from "../../core/src/model.js";
import {
  maxMessageAttachmentBytes,
  messageAttachmentSizeIssue,
} from "../../core/src/message-attachment-policy.js";
import type {
  PlatformActor,
  PlatformAuthorityVerifier,
} from "../../platform/src/store.js";
import {
  ManagedArtifactStore,
  type StorePrincipal,
} from "../../managed-artifact-store/src/store.js";
import type { HumanPlatformAuthority } from "./human-platform-authority.js";

function attachmentMime(name: string, bytes: Uint8Array) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sizeIssue = messageAttachmentSizeIssue({ name, size: data.length });
  if (sizeIssue) throw new DomainError("invalid", sizeIssue);
  if (
    /\.png$/i.test(name) &&
    data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return "image/png" as const;
  if (
    /\.jpe?g$/i.test(name) &&
    data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
  )
    return "image/jpeg" as const;
  if (
    /\.webp$/i.test(name) &&
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp" as const;
  if (/\.pdf$/i.test(name) && data.subarray(0, 5).toString() === "%PDF-")
    return "application/pdf" as const;
  if (/\.(txt|md|markdown)$/i.test(name)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new DomainError("invalid", "请使用 UTF-8 文本文件。");
    }
    if (data.includes(0)) throw new DomainError("invalid", "这不是文本文件。");
    return /\.txt$/i.test(name)
      ? ("text/plain" as const)
      : ("text/markdown" as const);
  }
  throw new DomainError(
    "invalid",
    "支持 PNG、JPEG、WebP、PDF、TXT 和 Markdown 附件。",
  );
}

type Issued = StorePrincipal & {
  artifactId: string;
  actor?: PlatformActor;
  assertAccess?: () => Promise<void>;
};

/** Message ingress owns draft bytes until Runtime consumes a staged resource.
 * This Store is separate from Platform's catalog and every Cognitive App's
 * originals; its relational manifest never contains file bytes.
 */
export class MessageAttachmentService {
  private constructor(
    private readonly store: ManagedArtifactStore,
    private readonly tenantId: string,
    private readonly verifier: PlatformAuthorityVerifier,
    private readonly human: HumanPlatformAuthority,
    private readonly issued: Map<string, Issued>,
  ) {}

  static async open(request: {
    root: string;
    tenantId: string;
    verifier: PlatformAuthorityVerifier;
    human: HumanPlatformAuthority;
  }) {
    const issued = new Map<string, Issued>();
    const storeId = `store_messages_${createHash("sha256").update(request.tenantId).digest("hex").slice(0, 32)}`;
    const store = await ManagedArtifactStore.sqlite({
      root: request.root,
      storeId,
      maxBytes: maxMessageAttachmentBytes,
      authorizer: {
        authorize: async (credential, operation) => {
          const owner = issued.get(credential);
          if (
            !owner ||
            operation.storeId !== storeId ||
            operation.artifactId !== owner.artifactId
          )
            throw new DomainError("forbidden", "消息附件调用未获授权。");
          if (owner.actor) {
            const current = await request.verifier.resolveActor(owner.actor);
            if (
              !current ||
              current.tenantId !== owner.tenantId ||
              current.principalId !== owner.principalId ||
              current.kind !== "human"
            )
              throw new DomainError("forbidden", "消息附件所属身份已失效。");
          }
          await owner.assertAccess?.();
          return { tenantId: owner.tenantId, principalId: owner.principalId };
        },
      },
    });
    // The Store never receives the caller's Platform credential. Short-lived
    // scoped tokens are retired even when an upload or verification fails.
    return new MessageAttachmentService(
      store,
      request.tenantId,
      request.verifier,
      request.human,
      issued,
    );
  }

  private artifactId(ownerPrincipalId: string, assetId: string) {
    if (!/^[a-f0-9]{64}$/.test(assetId))
      throw new DomainError("invalid", "附件标识无效。");
    const owner = createHash("sha256")
      .update(`${this.tenantId}:${ownerPrincipalId}`)
      .digest("hex")
      .slice(0, 32);
    return `attachment_${owner}_${assetId}`;
  }

  private async withOwner<T>(
    ownerPrincipalId: string,
    assetId: string,
    work: (credential: string, artifactId: string) => Promise<T>,
    actor?: PlatformActor,
    assertAccess?: () => Promise<void>,
  ) {
    const artifactId = this.artifactId(ownerPrincipalId, assetId);
    const credential = randomBytes(32).toString("hex");
    this.issued.set(credential, {
      tenantId: this.tenantId,
      principalId: ownerPrincipalId,
      artifactId,
      actor,
      assertAccess,
    });
    try {
      return await work(credential, artifactId);
    } finally {
      this.issued.delete(credential);
    }
  }

  private async principal(actor: PlatformActor) {
    const identity = await this.verifier.resolveActor(actor);
    if (
      !identity ||
      identity.tenantId !== this.tenantId ||
      identity.kind !== "human"
    )
      throw new DomainError("forbidden", "当前用户不能保存或读取消息附件。");
    return identity.principalId;
  }

  async upload(actor: PlatformActor, name: string, bytes: Uint8Array) {
    const principalId = await this.principal(actor);
    const mime = attachmentMime(name, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const assetId = createHash("sha256")
      .update(`${mime}\0${sha256}`)
      .digest("hex");
    await this.withOwner(
      principalId,
      assetId,
      async (credential, artifactId) =>
        this.store.put({
          credential,
          artifactId,
          commandId: artifactId,
          baseRevision: 0,
          mime,
          expectedSha256: sha256,
          bytes,
        }),
      actor,
    );
    return { assetId, mime };
  }

  async readOwned(actor: PlatformActor, assetId: string) {
    try {
      return await this.readForOwner(
        await this.principal(actor),
        assetId,
        actor,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Artifact 版本不存在。")
        throw new DomainError("not_found", "附件不存在或无权访问。");
      throw error;
    }
  }

  /** Call only after a current Platform conversation-read grant proves that
   * the viewer can see an input carrying this exact asset ID. */
  async readForOwner(
    ownerPrincipalId: string,
    assetId: string,
    actor?: PlatformActor,
    assertAccess?: () => Promise<void>,
  ) {
    return this.withOwner(
      ownerPrincipalId,
      assetId,
      async (credential, artifactId) => {
        const { version, bytes } = await this.store.readRange({
          credential,
          artifactId,
          revision: 1,
        });
        const expected = createHash("sha256")
          .update(`${version.mime}\0${version.sha256}`)
          .digest("hex");
        if (expected !== assetId || bytes.byteLength !== version.byteLength)
          throw new Error("消息附件版本或字节不匹配。");
        return { mime: version.mime, bytes };
      },
      actor,
      assertAccess,
    );
  }

  async readForDispatch(author: AccessContext, attachment: InputAttachment) {
    return this.human.withSession(
      author,
      () => {},
      async (actor) => {
        const value = await this.readOwned(actor, attachment.assetId);
        if (attachment.mime && value.mime !== attachment.mime)
          throw new DomainError("invalid", "附件类型与保存的原件不一致。");
        return value;
      },
    );
  }

  async close() {
    await this.store.close();
  }
}
