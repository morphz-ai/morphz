import { createHash } from "node:crypto";
import {
  uiPackageHeaderSchema,
  type UiPackageHeader,
} from "../../core/src/applications.js";
import { DomainError } from "../../core/src/model.js";
import {
  isPortableText,
  parseCognitiveAppDefinition,
} from "../../cognitive-app-sdk/src/protocol.js";
import { canonicalJsonBytes } from "../../cognitive-app-sdk/src/domain-wire.js";

export type CognitiveAppUiByteProof = Readonly<{
  purpose: "cognitive-ui-installation";
  tenantId: string;
  principalId: string;
  appId: string;
  version: string;
  definitionHash: string;
  headerHash: string;
  storeId: string;
  artifactId: string;
  artifactRevision: number;
  sha256: string;
  byteLength: number;
}>;
type Entry = {
  appId: string;
  version: string;
  installedByPrincipalId: string;
  header: UiPackageHeader;
  storeId: string;
  artifactId: string;
  artifactRevision: number;
  sha256: string;
  byteLength: number;
  installedAt: string;
};
type Stored = {
  storeId: string;
  artifactId: string;
  revision: number;
  sha256: string;
  byteLength: number;
  mime: string;
};
const proofs = new WeakSet<object>();
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function valid(condition: unknown): asserts condition {
  if (!condition)
    throw new DomainError("invalid", "认知应用界面字节或精确声明核验失败。");
}
function identity(value: unknown) {
  valid(isPortableText(value) && value.length > 0 && value.length <= 200);
}

/** Shared pure declaration check, usable before installing any executable bytes.
 * This parser issues no proof and supplies no permission. */
export function parseCognitiveAppUiHeader(
  definitionInput: unknown,
  headerInput: unknown,
): UiPackageHeader {
  try {
    const definition = parseCognitiveAppDefinition(definitionInput);
    const header = uiPackageHeaderSchema.parse(headerInput);
    valid(definition.ui !== null);
    valid(
      header.id === definition.id &&
        header.version === definition.version &&
        header.title === definition.title &&
        header.description === definition.description &&
        header.icon === definition.icon &&
        header.iconImage === definition.iconImage &&
        digest(canonicalJsonBytes(header.harness)) ===
          digest(canonicalJsonBytes(definition.harness)),
    );
    // The legacy Artifact bridge is not a second data authority for this App.
    valid(
      header.permissions.length === 0 ||
        (header.permissions.length === 1 &&
          header.permissions[0] === "input.compose"),
    );
    return header;
  } catch {
    throw new DomainError("invalid", "认知应用界面字节或精确声明核验失败。");
  }
}

/** Trusted Host code calls this only after reading the actual immutable Store
 * version. It proves byte/definition agreement, not viewer permission. Registry
 * independently checks the actual installation row and Human in the same q.
 * Never register this issuer on Client, Runtime tools or the guest bridge. */
export function verifyCognitiveAppUiBytes(input: {
  tenantId: string;
  principalId: string;
  definition: unknown;
  entry: Entry;
  stored: Stored;
  bytes: Uint8Array;
}): CognitiveAppUiByteProof {
  try {
    const { tenantId, principalId, entry, stored, bytes } = input;
    identity(tenantId);
    identity(principalId);
    const definition = parseCognitiveAppDefinition(input.definition);
    const header = parseCognitiveAppUiHeader(definition, entry.header);
    valid(definition.ui !== null);
    valid(
      entry.appId === definition.id &&
        entry.version === definition.version &&
        entry.installedByPrincipalId === principalId,
    );
    identity(entry.storeId);
    identity(entry.artifactId);
    valid(
      entry.artifactRevision === 1 &&
        Number.isSafeInteger(entry.byteLength) &&
        entry.byteLength > 0 &&
        entry.byteLength <= 1_000_000 &&
        /^[a-f0-9]{64}$/.test(entry.sha256) &&
        Number.isFinite(Date.parse(entry.installedAt)) &&
        stored.storeId === entry.storeId &&
        stored.artifactId === entry.artifactId &&
        stored.revision === entry.artifactRevision &&
        stored.sha256 === entry.sha256 &&
        stored.byteLength === entry.byteLength &&
        stored.mime === "text/html;charset=utf-8" &&
        bytes instanceof Uint8Array &&
        bytes.byteLength === entry.byteLength &&
        digest(bytes) === entry.sha256 &&
        definition.ui.packageVersion === entry.version &&
        definition.ui.sha256 === entry.sha256,
    );
    // Reject malformed UTF-8 instead of silently replacing executable bytes.
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const proof: CognitiveAppUiByteProof = Object.freeze({
      purpose: "cognitive-ui-installation",
      tenantId,
      principalId,
      appId: definition.id,
      version: definition.version,
      definitionHash: digest(canonicalJsonBytes(definition)),
      headerHash: digest(canonicalJsonBytes(header)),
      storeId: entry.storeId,
      artifactId: entry.artifactId,
      artifactRevision: entry.artifactRevision,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
    });
    proofs.add(proof);
    return proof;
  } catch {
    // No raw HTML, filesystem locator, parser detail or nested cause escapes.
    throw new DomainError("invalid", "认知应用界面字节或精确声明核验失败。");
  }
}

/** Structural lookalikes, proxies, serialized and cross-process values cannot
 * stand in for the trusted byte check. This still grants no read permission. */
export function readCognitiveAppUiByteProof(
  value: unknown,
): CognitiveAppUiByteProof | null {
  return value !== null && typeof value === "object" && proofs.has(value)
    ? (value as CognitiveAppUiByteProof)
    : null;
}
