import { createHash, randomBytes } from "node:crypto";
import {
  applicationManifestSchema,
  uiPackageHeader,
  type ApplicationManifest,
} from "../../core/src/applications.js";
import { DomainError } from "../../core/src/model.js";
import { ManagedArtifactStore } from "../../managed-artifact-store/src/store.js";
import type { S3ByteLocation } from "../../managed-artifact-store/src/s3-bytes.js";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  type PlatformActor,
  type PlatformAuthorityVerifier,
  type PlatformStore,
} from "../../platform/src/store.js";

const maximumBytes = 1_000_000;
const mime = "text/html;charset=utf-8";
type Scope = {
  actor: PlatformActor;
  artifactId: string;
  operation: "read" | "write";
  assertAccess?: () => Promise<void>;
};

/** Executable UI bytes are private Store versions. Platform holds the
 * installation, installer, bounded declaration and immutable Store reference;
 * Cognitive Apps remain responsible for their professional data. */
export class UiPackageService {
  private constructor(
    private readonly tenantId: string,
    private readonly platform: PlatformStore,
    private readonly verifier: PlatformAuthorityVerifier,
    private readonly store: ManagedArtifactStore,
    private readonly scopes: Map<string, Scope>,
  ) {}

  static async open(request: {
    tenantId: string;
    platform: PlatformStore;
    verifier: PlatformAuthorityVerifier;
    root: string;
    postgres?: { connectionString: string; schema: string };
    cloud?: {
      connectionString: string;
      schema: string;
      bytes: S3ByteLocation;
      s3Client?: S3Client;
    };
  }) {
    if (request.postgres && request.cloud)
      throw new Error("应用包 Store 只能选择一种字节后端。");
    const scopes = new Map<string, Scope>();
    const storeId = `store_ui_${createHash("sha256")
      .update(request.tenantId)
      .digest("hex")
      .slice(0, 32)}`;
    const authorizer = {
      authorize: async (
        credential: string,
        operation: {
          storeId: string;
          artifactId: string;
          operation: "read" | "write" | "delete";
        },
      ) => {
        const scope = scopes.get(credential);
        if (
          !scope ||
          operation.storeId !== storeId ||
          operation.artifactId !== scope.artifactId ||
          operation.operation !== scope.operation
        )
          throw new DomainError("forbidden", "应用包 Store 调用未获授权。");
        const actor = await request.verifier.resolveActor(scope.actor);
        if (
          !actor ||
          actor.tenantId !== request.tenantId ||
          actor.kind !== "human"
        )
          throw new DomainError("forbidden", "应用包操作身份已失效。");
        await scope.assertAccess?.();
        return { tenantId: request.tenantId, principalId: actor.principalId };
      },
    };
    const options = {
      root: request.root,
      storeId,
      authorizer,
      maxBytes: maximumBytes,
    };
    const store = request.cloud
      ? await ManagedArtifactStore.cloud({ ...options, ...request.cloud })
      : request.postgres
        ? await ManagedArtifactStore.postgres({ ...options, ...request.postgres })
        : await ManagedArtifactStore.sqlite(options);
    return new UiPackageService(
      request.tenantId,
      request.platform,
      request.verifier,
      store,
      scopes,
    );
  }

  hasCommittedVersions() {
    return this.store.hasCommittedVersions();
  }

  private async human(actor: PlatformActor) {
    const resolved = await this.verifier.resolveActor(actor);
    if (
      !resolved ||
      resolved.tenantId !== this.tenantId ||
      resolved.kind !== "human"
    )
      throw new DomainError("forbidden", "当前用户不能安装或读取应用包。");
    return resolved;
  }

  private artifactId(principalId: string, appId: string, version: string) {
    return `ui_${createHash("sha256")
      .update(JSON.stringify([this.tenantId, principalId, appId, version]))
      .digest("hex")
      .slice(0, 48)}`;
  }

  private async scoped<T>(
    actor: PlatformActor,
    artifactId: string,
    operation: Scope["operation"],
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

  async install(actor: PlatformActor, commandId: string, input: unknown) {
    const principal = await this.human(actor);
    const manifest = applicationManifestSchema.parse(input);
    if (manifest.ui.type !== "sandbox" || manifest.id.startsWith("morphz."))
      throw new DomainError("invalid", "只能安装第三方独立界面包。");
    const bytes = Buffer.from(manifest.ui.html, "utf8");
    if (!bytes.length || bytes.length > maximumBytes)
      throw new DomainError("invalid", "应用包界面超过 1 MB。");
    const artifactId = this.artifactId(
      principal.principalId,
      manifest.id,
      manifest.version,
    );
    const version = await this.scoped(
      actor,
      artifactId,
      "write",
      (credential) =>
        this.store.put({
          credential,
          commandId: `ui_${commandId}`,
          artifactId,
          baseRevision: 0,
          mime,
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
          bytes,
        }),
    );
    await this.scoped(actor, artifactId, "read", (credential) =>
      this.store.verifyVersion({
        credential,
        artifactId,
        revision: version.revision,
      }),
    );
    return this.platform.installUiPackage(actor, {
      commandId,
      header: uiPackageHeader(manifest),
      storeVersion: version,
    });
  }

  async list(actor: PlatformActor) {
    await this.human(actor);
    return this.platform.listUiPackages(actor);
  }

  async read(
    actor: PlatformActor,
    appId: string,
    version: string,
  ): Promise<ApplicationManifest> {
    const principal = await this.human(actor);
    const entry = await this.platform.uiPackage(actor, appId, version);
    if (
      entry.installedByPrincipalId !== principal.principalId ||
      entry.storeId !== this.store.storeId ||
      entry.artifactId !==
        this.artifactId(principal.principalId, appId, version)
    )
      throw new DomainError("forbidden", "应用包存储引用不属于当前用户。");
    const assertAccess = async () => {
      const current = await this.platform.uiPackage(actor, appId, version);
      if (JSON.stringify(current) !== JSON.stringify(entry))
        throw new DomainError("forbidden", "应用包授权或版本已变化。");
    };
    const { version: stored, bytes } = await this.scoped(
      actor,
      entry.artifactId,
      "read",
      (credential) =>
        this.store.readRange({
          credential,
          artifactId: entry.artifactId,
          revision: entry.artifactRevision,
        }),
      assertAccess,
    );
    await assertAccess();
    if (
      stored.sha256 !== entry.sha256 ||
      stored.byteLength !== entry.byteLength ||
      stored.mime !== mime ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error("应用包字节与安装记录不匹配。");
    return applicationManifestSchema.parse({
      ...entry.header,
      ui: { ...entry.header.ui, html: Buffer.from(bytes).toString("utf8") },
    });
  }

  async close() {
    await this.store.close();
  }
}
