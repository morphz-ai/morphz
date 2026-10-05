import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  verifyCognitiveAppUiBytes,
  readCognitiveAppUiByteProof,
} from "../packages/platform/src/cognitive-app-ui-proof.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import type { UiPackageHeader } from "../packages/core/src/applications.js";

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = new TextEncoder().encode("<!doctype html><h1>原件 😀</h1>");
  const definition = {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: "example.notes",
    version: "1.0.0",
    title: "便笺",
    description: "独立原件服务",
    icon: "document",
    harness: null,
    ui: { packageVersion: "1.0.0", sha256: sha(bytes) },
    operations: [],
  };
  const header: UiPackageHeader = {
    format: applicationManifestFormat,
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    icon: "document" as const,
    permissions: ["input.compose" as const],
    harness: null,
    ui: { type: "sandbox" as const, presentation: "workspace" as const },
  };
  const stored = {
    storeId: "store_ui_tenant",
    artifactId: "ui_owner_notes",
    revision: 1,
    sha256: sha(bytes),
    byteLength: bytes.byteLength,
    mime: "text/html;charset=utf-8",
  };
  const entry = {
    appId: definition.id,
    version: definition.version,
    installedByPrincipalId: "alice",
    header,
    storeId: stored.storeId,
    artifactId: stored.artifactId,
    artifactRevision: stored.revision,
    sha256: stored.sha256,
    byteLength: stored.byteLength,
    installedAt: "2026-10-05T00:00:00.000Z",
  };
  return {
    tenantId: "tenant-a",
    principalId: "alice",
    definition,
    entry,
    stored,
    bytes,
  };
}

test("UI byte proof is process-local, frozen, detached metadata without executable bytes", () => {
  const input = fixture();
  const proof = verifyCognitiveAppUiBytes(input);
  assert.equal(readCognitiveAppUiByteProof(proof), proof);
  assert.ok(Object.isFrozen(proof));
  assert.equal(proof.sha256, input.stored.sha256);
  assert.equal(proof.artifactRevision, 1);
  assert.equal(JSON.stringify(proof).includes("doctype"), false);
  assert.equal(JSON.stringify(proof).includes("原件"), false);
  input.entry.artifactId = "other";
  input.definition.title = "changed";
  input.bytes.fill(0);
  assert.equal(proof.artifactId, "ui_owner_notes");
  assert.equal(readCognitiveAppUiByteProof({ ...proof }), null);
  assert.equal(
    readCognitiveAppUiByteProof(JSON.parse(JSON.stringify(proof))),
    null,
  );
  assert.equal(readCognitiveAppUiByteProof(new Proxy(proof, {})), null);
  for (const candidate of [null, 1, "true", { verified: true }])
    assert.equal(readCognitiveAppUiByteProof(candidate), null);
});

test("UI byte proof checks actual bytes, SHA, exact immutable Store metadata and fatal UTF8", () => {
  for (const mutate of [
    (x: ReturnType<typeof fixture>) => {
      x.bytes[0] = 0;
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.sha256 = "a".repeat(64);
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.byteLength++;
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.mime = "text/plain";
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.storeId = "other";
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.artifactId = "other";
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.revision = 2;
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.sha256 = "a".repeat(64);
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.artifactRevision = 0;
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.byteLength = 1_000_001;
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.installedByPrincipalId = "bob";
    },
    (x: ReturnType<typeof fixture>) => {
      x.tenantId = "bad\u0000tenant";
    },
    (x: ReturnType<typeof fixture>) => {
      x.stored.artifactId = x.entry.artifactId = "bad\ud800";
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyCognitiveAppUiBytes(input));
  }
  const invalid = fixture();
  invalid.bytes = new Uint8Array([0xc3, 0x28]);
  invalid.stored.byteLength = invalid.entry.byteLength =
    invalid.bytes.byteLength;
  invalid.stored.sha256 =
    invalid.entry.sha256 =
    invalid.definition.ui.sha256 =
      sha(invalid.bytes);
  assert.throws(() => verifyCognitiveAppUiBytes(invalid));
});

test("UI byte proof binds the exact definition metadata and forbids legacy Artifact authority", () => {
  for (const mutate of [
    (x: ReturnType<typeof fixture>) => {
      x.definition.ui.sha256 = "a".repeat(64);
    },
    (x: ReturnType<typeof fixture>) => {
      x.definition.ui.packageVersion = "2.0.0";
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.appId = "other.notes";
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.version = "2.0.0";
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.header.title = "other";
    },
    (x: ReturnType<typeof fixture>) => {
      x.entry.header.description = "other";
    },
    (x: ReturnType<typeof fixture>) => {
      Reflect.set(x.entry.header, "icon", "film");
    },
    (x: ReturnType<typeof fixture>) => {
      Reflect.set(x.entry.header, "iconImage", "data:image/png;base64,AA==");
    },
    (x: ReturnType<typeof fixture>) => {
      Reflect.set(x.entry.header, "harness", { id: "other", version: "1" });
    },
    (x: ReturnType<typeof fixture>) => {
      Reflect.set(x.entry.header, "permissions", ["artifacts.read"]);
    },
    (x: ReturnType<typeof fixture>) => {
      Reflect.set(x.entry.header, "permissions", ["artifacts.write"]);
    },
    (x: ReturnType<typeof fixture>) => {
      Reflect.set(x.entry.header, "permissions", [
        "input.compose",
        "input.compose",
      ]);
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyCognitiveAppUiBytes(input));
  }
  const input = fixture();
  Reflect.set(input.entry.header, "permissions", []);
  assert.ok(verifyCognitiveAppUiBytes(input));
});
