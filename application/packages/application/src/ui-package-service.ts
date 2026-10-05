import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  applicationManifestSchema,
  uiPackageHeader,
  type ApplicationManifest,
} from "../../core/src/applications.js";
import { DomainError } from "../../core/src/model.js";
import {
  ManagedArtifactStore,
  type StoreAuthorizationRequest,
} from "../../managed-artifact-store/src/store.js";
import type { S3ByteLocation } from "../../managed-artifact-store/src/s3-bytes.js";
import type { S3Client } from "@aws-sdk/client-s3";
import { parseCognitiveAppDefinition } from "../../cognitive-app-sdk/src/protocol.js";
import { canonicalJsonBytes } from "../../cognitive-app-sdk/src/domain-wire.js";
import { parseCognitiveAppDocumentResourceRequest } from "../../core/src/cognitive-app-document-resource.js";
import { createCognitiveDocumentBootstrapFromBytes } from "./cognitive-document-bootstrap.js";
import {
  parseCognitiveAppUiHeader,
  verifyCognitiveAppUiBytes,
} from "../../platform/src/cognitive-app-ui-proof.js";
import {
  type PlatformActor,
  type PlatformAuthorityVerifier,
  type PlatformStore,
  type PreparedCognitiveAppUiRead,
} from "../../platform/src/store.js";

const maximumBytes = 1_000_000;
const mime = "text/html;charset=utf-8";
type Scope = {
  actor: PlatformActor;
  artifactId: string;
  operation: "read" | "write";
} & (
  | { purpose: "installer-owned"; assertAccess?: () => Promise<void> }
  | {
      purpose: "cognitive-view-read";
      operation: "read";
      artifactRevision: number;
      authorizedByteOwner: (actualViewer: string) => Promise<string>;
    }
);
const viewReadShape = z
  .object({
    viewId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    expectedViewRevision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    expectedBindingRevision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

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
        operation: StoreAuthorizationRequest,
      ) => {
        const scope = scopes.get(credential);
        if (
          !scope ||
          operation.storeId !== storeId ||
          operation.artifactId !== scope.artifactId ||
          operation.operation !== scope.operation
        )
          throw new DomainError("forbidden", "应用包 Store 调用未获授权。");
        if (
          scope.purpose === "cognitive-view-read" &&
          (operation.operation !== "read" ||
            operation.revision !== scope.artifactRevision)
        )
          throw new DomainError(
            "forbidden",
            "认知窗口只允许读取固定界面版本。",
          );
        const actor = await request.verifier.resolveActor(scope.actor);
        if (
          !actor ||
          actor.tenantId !== request.tenantId ||
          actor.kind !== "human"
        )
          throw new DomainError("forbidden", "应用包操作身份已失效。");
        if (scope.purpose === "cognitive-view-read") {
          // Only a private, one-read scope minted after the actual window gate
          // may use an installer's retained immutable bytes. This is not a
          // caller owner parameter or a new grant on the generic Store API.
          const byteOwner = await scope.authorizedByteOwner(actor.principalId);
          return { tenantId: request.tenantId, principalId: byteOwner };
        }
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
        ? await ManagedArtifactStore.postgres({
            ...options,
            ...request.postgres,
          })
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
    this.scopes.set(credential, {
      purpose: "installer-owned",
      actor,
      artifactId,
      operation,
      assertAccess,
    });
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

  /** Host-only GUI installation: read real immutable bytes before presenting a
   * process-local proof to Platform. This creates no grant, connection or view;
   * a failure after the first commit can leave only a valid UI-only package. */
  async installCognitive(
    actor: PlatformActor,
    commandId: string,
    input: { definition: unknown; manifest: unknown },
  ) {
    // Copy the actual ingress credential and parsed declarations before any
    // async permission/store work. Caller edits cannot change installed bytes.
    const access = { credential: actor.credential };
    if (
      typeof commandId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(commandId)
    )
      throw new DomainError("invalid", "认知应用安装操作标识无效。");
    const definition = parseCognitiveAppDefinition(
      JSON.parse(
        new TextDecoder().decode(
          canonicalJsonBytes(parseCognitiveAppDefinition(input.definition)),
        ),
      ),
    );
    const manifest = applicationManifestSchema.parse(input.manifest);
    if (manifest.ui.type !== "sandbox" || definition.ui === null)
      throw new DomainError("invalid", "认知应用安装需要精确独立界面声明。");
    parseCognitiveAppUiHeader(definition, uiPackageHeader(manifest));
    const submittedBytes = Buffer.from(manifest.ui.html, "utf8");
    if (
      !submittedBytes.length ||
      submittedBytes.length > maximumBytes ||
      submittedBytes.toString("utf8") !== manifest.ui.html ||
      createHash("sha256").update(submittedBytes).digest("hex") !==
        definition.ui.sha256
    )
      throw new DomainError("invalid", "认知应用界面字节不符合精确声明。");
    const principal = await this.human(access);
    await this.install(access, commandId, manifest);
    const entry = await this.platform.uiPackage(
      access,
      definition.id,
      definition.version,
    );
    if (
      entry.installedByPrincipalId !== principal.principalId ||
      entry.storeId !== this.store.storeId ||
      entry.artifactId !==
        this.artifactId(
          principal.principalId,
          definition.id,
          definition.version,
        )
    )
      throw new DomainError(
        "forbidden",
        "认知应用包存储引用不属于本次安装者。",
      );
    const assertAccess = async () => {
      const current = await this.platform.uiPackage(
        access,
        definition.id,
        definition.version,
      );
      if (JSON.stringify(current) !== JSON.stringify(entry))
        throw new DomainError("forbidden", "认知应用包授权或版本已变化。");
    };
    const { version: stored, bytes } = await this.scoped(
      access,
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
    const verifiedUi = verifyCognitiveAppUiBytes({
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      definition,
      entry,
      stored,
      bytes,
    });
    return this.platform.installCognitiveApp(access, {
      definition,
      verifiedUi,
    });
  }

  async read(
    actor: PlatformActor,
    appId: string,
    version: string,
  ): Promise<ApplicationManifest> {
    const principal = await this.human(actor);
    const entry = await this.platform.uiPackage(actor, appId, version);
    if (entry.cognitive)
      throw new DomainError("forbidden", "认知应用不能通过旧界面入口读取。");
    if (
      entry.installedByPrincipalId !== principal.principalId ||
      entry.storeId !== this.store.storeId ||
      entry.artifactId !==
        this.artifactId(principal.principalId, appId, version)
    )
      throw new DomainError("forbidden", "应用包存储引用不属于当前用户。");
    const assertAccess = async () => {
      const current = await this.platform.uiPackage(actor, appId, version);
      if (
        current.cognitive ||
        JSON.stringify(current) !== JSON.stringify(entry)
      )
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

  /** Host-only bound-window read. The requester never names a byte owner,
   * package, service or address. Human ownership/current consent and exact
   * view/binding CAS are checked by the real Platform before, during and after
   * the actual immutable Store read. UI-only reads remain installer-only. */
  private async readCognitivePrepared<T>(
    actor: PlatformActor,
    input: unknown,
    project: (
      prepared: PreparedCognitiveAppUiRead,
      bytes: Uint8Array,
    ) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const access = { credential: actor.credential };
    let request: z.infer<typeof viewReadShape>;
    try {
      request = viewReadShape.parse(
        JSON.parse(new TextDecoder().decode(canonicalJsonBytes(input))),
      );
    } catch {
      throw new DomainError("invalid", "认知窗口读取请求无效。");
    }
    const active = () => {
      if (signal?.aborted)
        throw new DomainError("forbidden", "认知文档读取已取消。");
    };
    active();
    const prepared = await this.platform.prepareCognitiveAppUiRead(
      access,
      request,
    );
    active();
    const { target, uiPackage: entry } = prepared;
    if (
      prepared.actor.kind !== "human" ||
      prepared.actor.tenantId !== this.tenantId ||
      entry.storeId !== this.store.storeId ||
      entry.artifactId !==
        this.artifactId(
          entry.installedByPrincipalId,
          target.appId,
          target.version,
        )
    )
      throw new DomainError("forbidden", "认知窗口的固定界面存储引用不可用。");
    const original = Buffer.from(canonicalJsonBytes(prepared));
    const assertAccess = async (): Promise<PreparedCognitiveAppUiRead> => {
      active();
      const current = await this.platform.prepareCognitiveAppUiRead(
        access,
        request,
      );
      active();
      if (!original.equals(Buffer.from(canonicalJsonBytes(current))))
        throw new DomainError(
          "conflict",
          "认知窗口授权、绑定或精确版本已变化。",
        );
      return current;
    };
    const credential = randomBytes(32).toString("hex");
    this.scopes.set(credential, {
      purpose: "cognitive-view-read",
      actor: access,
      artifactId: entry.artifactId,
      operation: "read",
      artifactRevision: entry.artifactRevision,
      authorizedByteOwner: async (actualViewer) => {
        if (actualViewer !== prepared.actor.principalId)
          throw new DomainError("forbidden", "认知窗口读取者身份已变化。");
        const current = await assertAccess();
        return current.uiPackage.installedByPrincipalId;
      },
    });
    try {
      active();
      const { version: stored, bytes } = await this.store.readRange({
        credential,
        artifactId: entry.artifactId,
        revision: entry.artifactRevision,
      });
      active();
      // Re-use the same complete byte/metadata validator. The proof is private
      // and discarded; it neither installs anything nor grants UI permissions.
      verifyCognitiveAppUiBytes({
        tenantId: this.tenantId,
        principalId: entry.installedByPrincipalId,
        definition: target.definition,
        entry,
        stored,
        bytes,
      });
      // This callback is private trusted Host code, never a caller projection.
      // An asynchronous wrapper digest must finish before the SAME complete
      // prepare gate compares the original current-consent/installation CAS.
      active();
      const result = await project(prepared, bytes);
      active();
      await assertAccess();
      active();
      return result;
    } finally {
      this.scopes.delete(credential);
    }
  }

  async readCognitive(actor: PlatformActor, input: unknown) {
    return this.readCognitivePrepared(actor, input, (prepared, bytes) => {
      const { target, uiPackage: entry } = prepared;
      const html = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const manifest = applicationManifestSchema.parse({
        ...entry.header,
        ui: { ...entry.header.ui, html },
      });
      const {
        appId,
        version,
        definitionHash,
        instanceId,
        serviceId,
        dataAuthorityId,
      } = target;
      // Explicit public projection: the actual actor, byte owner/reference and
      // private gate snapshot never cross the Client/guest boundary.
      return {
        manifest,
        definition: target.definition,
        authority: {
          appId,
          version,
          definitionHash,
          instanceId,
          serviceId,
          dataAuthorityId,
        },
        view: prepared.view,
        binding: prepared.binding,
        grantRevision: target.grantRevision,
        connectionRevision: target.connectionRevision,
      };
    });
  }

  /** Internal document carrier; nonce is correlation, not Platform authority. */
  async readCognitiveDocument(
    actor: PlatformActor,
    input: unknown,
    signal?: AbortSignal,
  ) {
    let request;
    try {
      request = parseCognitiveAppDocumentResourceRequest(input);
    } catch {
      throw new DomainError("invalid", "认知文档读取请求无效。");
    }
    const { documentProof, ...cas } = request;
    return this.readCognitivePrepared(
      actor,
      cas,
      async (_prepared, bytes) => {
        const document = await createCognitiveDocumentBootstrapFromBytes(
          bytes,
          documentProof,
        );
        return { mime: document.mime, bytes: document.bytes };
      },
      signal,
    );
  }

  async close() {
    await this.store.close();
  }
}
