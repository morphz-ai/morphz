import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approvedConfirmedScriptSelection,
  approvedScriptCatalogCapture,
  approvedScriptCatalogCas,
  approvedScriptLibraryPublisher,
  inverseScriptCatalogPublicationFix,
  originalScriptEpochSelectionGuard,
  originalScriptPublicationClientSha,
} from "./fixtures/script-catalog-publication-fix.js";
import { expandExecutionInteractionConsumption } from "./fixtures/execution-interactions-consumption.js";
import { expandLocalInputDeliveryConsumption } from "./fixtures/local-input-delivery-consumption.js";
import { parseReaderSources } from "./fixtures/reader-reads-contract.js";

const client = readFileSync("apps/web/src/client.ts", "utf8");
const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
function spanChanged(source: string, before: string, after: string) {
  assert.equal(
    source.split(before).length,
    2,
    "one finite legal mutation target",
  );
  return source.replace(before, after);
}
function changed(source: string, before: string, after: string) {
  const mutation = spanChanged(source, before, after);
  parseReaderSources({ Mutation: mutation });
  return mutation;
}
function validate(source = client) {
  const original = inverseScriptCatalogPublicationFix(source);
  assert.equal(
    hash(original),
    originalScriptPublicationClientSha,
    "complete actual Git b20 Client after only approved publication-fix inverse",
  );
  return original;
}

test("approved script publication fix inverses the complete actual fixed Git b20 Client and is strictly idempotent", () => {
  const original = validate();
  assert.equal(inverseScriptCatalogPublicationFix(original), original);
  const stage24 = expandExecutionInteractionConsumption(client);
  assert.equal(inverseScriptCatalogPublicationFix(stage24), stage24);
  const stage23 = expandLocalInputDeliveryConsumption(stage24);
  assert.equal(inverseScriptCatalogPublicationFix(stage23), stage23);
});

test("legal publisher variants reject incomplete metadata, stale capture, updater replay, wrappers and unapproved fields", () => {
  const variants: [string, string, string][] = [
    [
      "const latest = current.current;",
      "const latest = boot;",
      "live authority capture",
    ],
    ["if (!latest) return;", "if (latest) return;", "null authority guard"],
    [
      "latest.scriptLibrary.length === entries.length",
      "latest.scriptLibrary.length <= entries.length",
      "complete metadata cardinality",
    ],
    [
      "existing.updatedAt === entry.updatedAt &&\n",
      "",
      "all seven metadata fields",
    ],
    [
      "existing.activityRevision === entry.activityRevision",
      "existing.activityRevision <= entry.activityRevision",
      "exact activity version",
    ],
    [
      "current.current = updated;\n      setBoot(updated);",
      "setBoot(updated);\n      current.current = updated;",
      "current before React",
    ],
    [
      "setBoot(updated);",
      "setBoot(() => { current.current = updated; return updated; });",
      "no function-updater replay",
    ],
    [
      "{ ...latest, scriptLibrary: entries }",
      "{ ...latest, scriptLibrary: entries, taskRuns: {} }",
      "no extra projection field",
    ],
    [
      "publishScriptLibrary: (entries) =>",
      "publishScriptLibrary: async (entries) =>",
      "synchronous publisher",
    ],
    [
      "current.current = updated;",
      "snapshotText.current = JSON.stringify(updated); current.current = updated;",
      "no serializer mutation",
    ],
  ];
  for (const [before, after, label] of variants) {
    const publisher = spanChanged(
      approvedScriptLibraryPublisher,
      before,
      after,
    );
    assert.throws(
      () =>
        validate(changed(client, approvedScriptLibraryPublisher, publisher)),
      {
        name: "AssertionError",
        message:
          /complete approved current-before-React script publisher and ports/,
      },
      label,
    );
  }
  assert.throws(
    () =>
      validate(
        changed(
          client,
          'import { createContentReads } from "./data/content-reads.js";',
          'import { type createContentReads } from "./data/content-reads.js";',
        ),
      ),
    {
      name: "AssertionError",
      message: /actual runtime content-read publisher import/,
    },
  );
});

test("legal capture and selection variants reject snapshots, unsafe source scope, unbounded reads and partial fixes", () => {
  const captures = [
    [
      "const readCatalogCache = catalogCache.current;",
      "const readCatalogCache = { ...catalogCache.current };",
    ],
    [
      "const readCatalogValue = readCatalogCache?.value;",
      "const readCatalogValue = catalogCache.current?.value;",
    ],
  ];
  for (const [before, after] of captures)
    assert.throws(
      () =>
        validate(
          changed(
            client,
            approvedScriptCatalogCapture,
            spanChanged(approvedScriptCatalogCapture, before!, after!),
          ),
        ),
      {
        name: "AssertionError",
        message:
          /approved same-object\/value capture immediately before workspace read/,
      },
    );
  assert.throws(
    () => validate(changed(client, approvedScriptCatalogCapture, "")),
    {
      name: "AssertionError",
      message:
        /approved same-object\/value capture immediately before workspace read/,
    },
  );
  const selections: [string, string][] = [
    ['entry.appId === "morphz.script-studio"', "true"],
    ['entry.kind === "script"', "true"],
    ['entry.availability === "available"', "true"],
    [
      "!readCatalogValue?.headContents.some(",
      "readCatalogValue?.headContents.some(",
    ],
    ["].slice(0, 150)", "].slice(0, 200)"],
    ["readCatalogValue?.contents", "catalogCache.current?.value.contents"],
    [".map((entry) => entry.id)", ".map((entry) => entry.appObjectId)"],
  ];
  for (const [before, after] of selections)
    assert.throws(
      () =>
        validate(
          changed(
            client,
            approvedConfirmedScriptSelection,
            spanChanged(approvedConfirmedScriptSelection, before, after),
          ),
        ),
      {
        name: "AssertionError",
        message: /complete approved confirmed-script selection and budget/,
      },
    );
  assert.throws(
    () =>
      validate(
        changed(
          client,
          "            recentContentIds,\n" + approvedConfirmedScriptSelection,
          "            recentContentIds,\n            allContentIds: [],\n" +
            approvedConfirmedScriptSelection,
        ),
      ),
    {
      name: "AssertionError",
      message: /complete approved confirmed-script selection and budget/,
    },
  );
  assert.throws(
    () => validate(changed(client, approvedScriptLibraryPublisher, "")),
    {
      name: "AssertionError",
      message:
        /complete approved current-before-React script publisher and ports/,
    },
  );
});

test("legal refresh variants reject wrong CAS, lost invalidation, authority-order drift and partially reversed guards", () => {
  const variants: [string, string][] = [
    ["          readCatalogCache &&", "          true &&"],
    [
      "catalogCache.current === readCatalogCache",
      "catalogCache.current !== readCatalogCache",
    ],
    [
      "readCatalogCache.value !== readCatalogValue",
      "readCatalogCache.value === readCatalogValue",
    ],
    ["void refresh();", "void Promise.resolve();"],
    ["return false;", "return true;"],
  ];
  for (const [before, after] of variants)
    assert.throws(
      () =>
        validate(
          changed(
            client,
            approvedScriptCatalogCas,
            spanChanged(approvedScriptCatalogCas, before, after),
          ),
        ),
      {
        name: "AssertionError",
        message: /complete approved same-object\/value CAS and drain/,
      },
    );
  for (const [before, after] of [
    ["version !== epoch.current", "version === epoch.current"],
    [
      "!conversationHistory.isSelectionCurrent(requestedScope)",
      "conversationHistory.isSelectionCurrent(requestedScope)",
    ],
  ])
    assert.throws(
      () =>
        validate(
          changed(
            client,
            originalScriptEpochSelectionGuard,
            spanChanged(originalScriptEpochSelectionGuard, before!, after!),
          ),
        ),
      {
        name: "AssertionError",
        message: /one approved epoch\/selection guard/,
      },
    );
  assert.throws(
    () =>
      validate(
        changed(
          client,
          originalScriptEpochSelectionGuard + approvedScriptCatalogCas,
          approvedScriptCatalogCas + originalScriptEpochSelectionGuard,
        ),
      ),
    {
      name: "AssertionError",
      message:
        /approved authority then epoch\/selection then CAS before any confirmation write/,
    },
  );
  assert.throws(
    () =>
      validate(
        changed(
          client,
          "if (finalNavigation.revisions.access !== navigation.revisions.access)",
          "if (finalNavigation.revisions.access === navigation.revisions.access)",
        ),
      ),
    {
      name: "AssertionError",
      message:
        /approved authority then epoch\/selection then CAS before any confirmation write/,
    },
  );
  let partial = client;
  for (const span of [
    approvedScriptLibraryPublisher,
    approvedScriptCatalogCapture,
    approvedConfirmedScriptSelection,
    approvedScriptCatalogCas,
  ])
    partial = changed(partial, span, "");
  assert.throws(() => inverseScriptCatalogPublicationFix(partial), {
    name: "AssertionError",
    message: /already-inverse original authority-before-confirmation position/,
  });
});

test("finite inverse preserves unapproved old Client mutations rather than erasing them or pretending equivalence", () => {
  const drift = changed(
    client,
    "function clearProtectedProjection() {\n    protectedReadGeneration.current++;",
    "function clearProtectedProjection() {\n    protectedReadGeneration.current += 0;",
  );
  const restored = inverseScriptCatalogPublicationFix(drift);
  assert.ok(restored.includes("protectedReadGeneration.current += 0;"));
  assert.notEqual(hash(restored), originalScriptPublicationClientSha);
  assert.throws(() => validate(drift), {
    name: "AssertionError",
    message:
      /complete actual Git b20 Client after only approved publication-fix inverse/,
  });
});
