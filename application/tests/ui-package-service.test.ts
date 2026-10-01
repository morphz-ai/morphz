import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { UiPackageService } from "../packages/application/src/ui-package-service.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";

const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    if (credential !== "alice" && credential !== "bob") return null;
    return {
      tenantId: "tenant-a",
      principalId: credential,
      actantId: credential,
      kind: "human" as const,
      runtimeInputId: null,
    };
  },
  async resolveActant(request) {
    return request.actantId === "alice" || request.actantId === "bob"
      ? { principalId: request.actantId, kind: "human" }
      : null;
  },
  async resolveProjectAgent() {
    return null;
  },
  async verifyApplicationObject() {
    return false;
  },
};

function manifest(html: string, version = "1.0.0") {
  return {
    format: applicationManifestFormat,
    id: "example.notes",
    version,
    title: "便笺",
    description: "记录想法",
    icon: "document" as const,
    permissions: ["artifacts.read" as const],
    harness: null,
    ui: { type: "sandbox" as const, html },
  };
}

test("应用安装以 Platform 回执引用独立 Store 字节，按安装者读取且重启可用", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-ui-package-"));
  let platform: PlatformStore | undefined;
  let service: UiPackageService | undefined;
  const alice = { credential: "alice" },
    bob = { credential: "bob" };
  try {
    platform = await PlatformStore.sqlite(
      join(root, "platform.sqlite"),
      verifier,
    );
    await platform.provisionTenant("tenant-a");
    service = await UiPackageService.open({
      root: join(root, "ui-packages"),
      tenantId: "tenant-a",
      platform,
      verifier,
    });
    const commandId = randomUUID();
    const input = manifest("<!doctype html><title>便笺</title>");
    assert.equal(
      await service.install(alice, commandId, input),
      "example.notes@1.0.0",
    );
    assert.equal(
      await service.install(alice, commandId, input),
      "example.notes@1.0.0",
    );
    await assert.rejects(
      service.install(alice, commandId, manifest("<h1>改写同一命令</h1>")),
    );
    await assert.rejects(
      service.install(alice, randomUUID(), manifest("<h1>同版本改写</h1>")),
    );
    const rows = await service.list(alice);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.header.ui.type, "sandbox");
    assert.equal(JSON.stringify(rows).includes(input.ui.html), false);
    assert.deepEqual(await service.list(bob), []);
    await assert.rejects(service.read(bob, input.id, input.version));
    assert.deepEqual(await service.read(alice, input.id, input.version), input);
    await service.close();
    service = undefined;
    await platform.close();
    platform = undefined;
    platform = await PlatformStore.sqlite(
      join(root, "platform.sqlite"),
      verifier,
    );
    service = await UiPackageService.open({
      root: join(root, "ui-packages"),
      tenantId: "tenant-a",
      platform,
      verifier,
    });
    assert.deepEqual(await service.read(alice, input.id, input.version), input);
  } finally {
    await service?.close();
    await platform?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL 安装记录与界面包 Store 分 schema，重启后按原版本读取",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const suffix = randomUUID().replaceAll("-", "");
    const platformSchema = `morphz_test_platform_${suffix}`;
    const storeSchema = `morphz_test_ui_${suffix}`;
    const root = mkdtempSync(join(tmpdir(), "morphz-ui-package-pg-"));
    const admin = new Pool({ connectionString });
    let platform: PlatformStore | undefined;
    let service: UiPackageService | undefined;
    const alice = { credential: "alice" };
    try {
      await admin.query(`CREATE SCHEMA "${platformSchema}"`);
      await admin.query(`CREATE SCHEMA "${storeSchema}"`);
      platform = await PlatformStore.postgres(
        { connectionString, schema: platformSchema },
        verifier,
      );
      await platform.provisionTenant("tenant-a");
      const openService = () =>
        UiPackageService.open({
          root: join(root, "ui-packages"),
          tenantId: "tenant-a",
          platform: platform!,
          verifier,
          postgres: { connectionString, schema: storeSchema },
        });
      service = await openService();
      const input = manifest("<!doctype html><title>PostgreSQL 便笺</title>");
      assert.equal(
        await service.install(alice, randomUUID(), input),
        "example.notes@1.0.0",
      );
      const { rows } = await admin.query<{ manifest_header: string }>(
        `SELECT manifest_header FROM "${platformSchema}".app_ui_packages`,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.manifest_header.includes(input.ui.html), false);
      await service.close();
      service = undefined;
      await platform.close();
      platform = await PlatformStore.postgres(
        { connectionString, schema: platformSchema },
        verifier,
      );
      service = await openService();
      assert.deepEqual(
        await service.read(alice, input.id, input.version),
        input,
      );
    } finally {
      await service?.close();
      await platform?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${storeSchema}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
