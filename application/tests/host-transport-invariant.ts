import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const retiredBusinessMethods = [
  "snapshot",
  "execute",
  "provisionMembers",
  "addAsset",
  "addAttachment",
  "addPdf",
  "addPublication",
  "search",
  "importText",
] as const;

/** The current Host has no retired business API, not a disabled second backend. */
export function assertNoLegacyBusinessApi(store: object) {
  for (const method of retiredBusinessMethods)
    assert.equal(
      Reflect.has(store, method),
      false,
      `${method} must be removed`,
    );
}

export function assertNoLegacyBusinessTables(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
            "('workspace','commands','assets','asset_owners','artifact_outputs'," +
            "'script_outputs','pdf_metadata','publication_metadata'," +
            "'publication_sections','reading_ocr') ORDER BY name",
        )
        .all(),
      [],
      "The Host must not create business snapshots or original-byte tables",
    );
  } finally {
    db.close();
  }
}

/** Test-only tripwire. There is deliberately no production compatibility method. */
export function forbidLegacySnapshot(store: object) {
  assert.equal(Reflect.has(store, "snapshot"), false);
  let calls = 0;
  Object.defineProperty(store, "snapshot", {
    configurable: true,
    value: () => {
      calls++;
      throw new Error("A formal operation must not read the retired workspace");
    },
  });
  return {
    calls: () => calls,
    restore: () => {
      Reflect.deleteProperty(store, "snapshot");
    },
  };
}
