import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { ScriptStudioStore } from "../packages/script-studio/src/store.js";
import { ObjectsStore } from "../packages/objects/src/store.js";
import { BrowserStore } from "../packages/browser/src/store.js";
import {
  ReaderStore,
  type ReaderAuthorityVerifier,
} from "../packages/reader/src/store.js";

const platformAuthority = {} as PlatformAuthorityVerifier;
const readerAuthority = {} as ReaderAuthorityVerifier;

const domains = [
  {
    name: "Platform",
    open: (path: string) => PlatformStore.sqlite(path, platformAuthority),
    versionTable: "platform_schema_version",
    index: "tasks_by_project_order",
  },
  {
    name: "Script Studio",
    open: (path: string) => ScriptStudioStore.sqlite(path),
    versionTable: "script_schema_version",
    index: "items_by_production",
  },
  {
    name: "Reader",
    open: (path: string) => ReaderStore.sqlite(path, readerAuthority),
    versionTable: "reader_schema_version",
    index: "marks_by_source_user",
  },
  {
    name: "Objects",
    open: (path: string) => ObjectsStore.sqlite(path),
    versionTable: "objects_schema_version",
    index: "object_versions_by_object",
  },
  {
    name: "Browser",
    open: (path: string) => BrowserStore.sqlite(path),
    versionTable: "browser_schema_version",
    index: "bookmarks_active_url",
  },
];

for (const domain of domains) {
  test(`${domain.name} 拒绝相同版本号但结构指纹被篡改的库`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-schema-guard-"));
    const filename = join(directory, "domain.sqlite");
    try {
      const store = await domain.open(filename);
      await store.close();
      const db = new DatabaseSync(filename);
      db.exec(`UPDATE ${domain.versionTable} SET schema_sha256='wrong'`);
      db.close();
      await assert.rejects(domain.open(filename), /结构|不受支持/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${domain.name} 拒绝版本标记还在但索引丢失的库`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-schema-guard-"));
    const filename = join(directory, "domain.sqlite");
    try {
      const store = await domain.open(filename);
      await store.close();
      const db = new DatabaseSync(filename);
      db.exec(`DROP INDEX ${domain.index}`);
      db.close();
      await assert.rejects(domain.open(filename), /索引缺失/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
