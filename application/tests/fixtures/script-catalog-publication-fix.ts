import assert from "node:assert/strict";
import {
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableStatement,
} from "typescript/unstable/ast";
import {
  parseReaderSources,
  readerFunction,
  readerImport,
  readerVariable,
} from "./reader-reads-contract.js";
import { legacyConfirmationBlock } from "./local-input-delivery-32c52210.js";

// Only the approved script-catalog publication fix. These literal seams were
// independently compared with actual Git b20d4acdc19; ordinary CI needs no Git.
// The old domain gates still check their original full Client hashes/rules.
export const originalScriptPublicationClientSha =
  "109337c7773855727b8eb62e5dee7f9e75ccb155766ee9fd78e2de6bbac1b1f7";
export const approvedScriptLibraryPublisher = `    publishScriptLibrary: (entries) => {
      const latest = current.current;
      if (!latest) return;
      if (
        latest.scriptLibrary.length === entries.length &&
        latest.scriptLibrary.every((existing, index) => {
          const entry = entries[index]!;
          return (
            existing.id === entry.id &&
            existing.contentId === entry.contentId &&
            existing.projectId === entry.projectId &&
            existing.title === entry.title &&
            existing.updatedAt === entry.updatedAt &&
            existing.catalogRevision === entry.catalogRevision &&
            existing.activityRevision === entry.activityRevision
          );
        })
      )
        return;
      const updated = { ...latest, scriptLibrary: entries };
      current.current = updated;
      setBoot(updated);
    },
`;
const legacyContentRegistration = `  const contentReads = createContentReads({
    platform,
    current,
    protectedReadGeneration,
    catalogCache,
    publishCatalog: setContentCatalog,
    publishArtifact: (updated) => {
      current.current = updated;
      setBoot(updated);
    },
    refresh,
  });
`;
const approvedContentRegistration = legacyContentRegistration.replace(
  "    publishArtifact:",
  approvedScriptLibraryPublisher + "    publishArtifact:",
);
export const approvedScriptCatalogCapture = `        const readCatalogCache = catalogCache.current;
        const readCatalogValue = readCatalogCache?.value;
`;
const legacySelection = `          {
            scope: requestedScope,
            preferences: { ...preferences, contentScope },
            recentContentIds,
          },
`;
export const approvedConfirmedScriptSelection = `            confirmedScriptContentIds: [
              ...new Set(
                (readCatalogValue?.contents ?? [])
                  .filter(
                    (entry) =>
                      entry.appId === "morphz.script-studio" &&
                      entry.kind === "script" &&
                      entry.availability === "available" &&
                      !readCatalogValue?.headContents.some(
                        (head) => head.id === entry.id,
                      ),
                  )
                  .map((entry) => entry.id),
              ),
            ].slice(0, 150),
`;
const approvedSelection = legacySelection.replace(
  "            recentContentIds,\n",
  "            recentContentIds,\n" + approvedConfirmedScriptSelection,
);
export const originalScriptEpochSelectionGuard = `        if (
          version !== epoch.current ||
          !conversationHistory.isSelectionCurrent(requestedScope)
        )
          return false;
`;
export const approvedScriptCatalogCas = `        if (
          readCatalogCache &&
          catalogCache.current === readCatalogCache &&
          readCatalogCache.value !== readCatalogValue
        ) {
          // An explicit content read published a newer authorized projection.
          // Re-read through the existing drain before any snapshot writes.
          void refresh();
          return false;
        }
`;
const authorityGuard = `        const finalNavigation = await source.navigationRuntime(
          signal,
          requestedScope,
        );
        if (finalNavigation.revisions.access !== navigation.revisions.access)
          clearProtectedProjection();
        if (!navigationReadStillCurrent(navigation, finalNavigation))
          throw new RequestError(
            409,
            "目录在读取期间已更新，请重试。",
            "navigation_changed",
          );
`;
const beforeConfirmation = `        // Read at publication time: a refresh may have started before the user
        // clicked Send. Only an authoritative same-ID input removes its overlay.
        const savedProjection = `;
const originalInlineConfirmationPosition =
  authorityGuard +
  beforeConfirmation.slice(
    0,
    beforeConfirmation.indexOf("        const savedProjection"),
  ) +
  "        " +
  legacyConfirmationBlock +
  "\n";
const capturePosition = `          platform.current = source;
          setOnline(true);
          setError("");
          return true;
        }
`;
const beforeRead =
  "        const {\n          workspace,\n          runtime,\n";
const commitPosition =
  "        };\n        conversationHistory.commitProjection(\n";
const originalCommitPosition =
  "        };\n" +
  originalScriptEpochSelectionGuard +
  "        conversationHistory.commitProjection(\n";

function once(source: string, span: string, rule: string) {
  assert.equal(source.split(span).length, 2, rule);
}

/** Validate all approved fix seams before restoring the original source. A
 * nested old owner inverse may call this again, but partially restored fixes
 * and unknown changes are never silently stripped. Unrelated old mutations
 * remain in the returned source for their original domain gate to reject. */
export function inverseScriptCatalogPublicationFix(clientText: string) {
  const client = parseReaderSources({ Client: clientText }).get("Client")!;
  const registration = readerVariable(client, "contentReads"),
    statement = registration.parent.parent,
    workspace = readerFunction(client, "useWorkspace");
  assert.ok(
    isVariableStatement(statement) &&
      statement.parent === workspace.body &&
      registration.initializer &&
      isCallExpression(registration.initializer) &&
      isIdentifier(registration.initializer.expression) &&
      registration.initializer.arguments.length === 1 &&
      isObjectLiteralExpression(registration.initializer.arguments[0]!),
    "actual typed content-read publisher registration",
  );
  const imported = readerImport(
    client,
    "./data/content-reads.js",
    "createContentReads",
  );
  once(
    clientText,
    'import { createContentReads } from "./data/content-reads.js";\n',
    "actual runtime content-read publisher import",
  );
  assert.equal(
    client.symbols.get(registration.initializer.expression),
    imported.symbol,
    "actual typed content-read publisher factory",
  );

  const hasFix = [
    "publishScriptLibrary",
    "readCatalogCache",
    "readCatalogValue",
    "confirmedScriptContentIds",
  ].some((name) => clientText.includes(name));
  if (!hasFix) {
    assert.equal(
      statement.getText(),
      legacyContentRegistration.trim(),
      "already-inverse original content-read registration",
    );
    once(clientText, legacySelection, "already-inverse original selection");
    once(
      clientText,
      capturePosition + beforeRead,
      "already-inverse original catalog read position",
    );
    assert.equal(
      clientText.split(authorityGuard + beforeConfirmation).length -
        1 +
        clientText.split(originalInlineConfirmationPosition).length -
        1,
      1,
      "already-inverse original authority-before-confirmation position",
    );
    once(
      clientText,
      originalCommitPosition,
      "already-inverse original epoch/selection-before-commit position",
    );
    once(
      clientText,
      originalScriptEpochSelectionGuard,
      "one original epoch/selection guard",
    );
    return clientText;
  }

  assert.equal(
    statement.getText(),
    approvedContentRegistration.trim(),
    "complete approved current-before-React script publisher and ports",
  );
  once(
    clientText,
    approvedContentRegistration,
    "one approved script publisher registration",
  );
  once(
    clientText,
    capturePosition + approvedScriptCatalogCapture + beforeRead,
    "approved same-object/value capture immediately before workspace read",
  );
  const capturedCache = readerVariable(client, "readCatalogCache"),
    capturedValue = readerVariable(client, "readCatalogValue"),
    savedProjection = readerVariable(client, "savedProjection");
  assert.equal(
    capturedCache.parent.parent.parent,
    savedProjection.parent.parent.parent,
    "catalog capture belongs to actual publication read block",
  );
  assert.equal(
    capturedValue.parent.parent.parent,
    capturedCache.parent.parent.parent,
  );
  once(
    clientText,
    approvedSelection,
    "complete approved confirmed-script selection and budget",
  );
  once(
    clientText,
    originalScriptEpochSelectionGuard,
    "one approved epoch/selection guard",
  );
  once(
    clientText,
    approvedScriptCatalogCas,
    "complete approved same-object/value CAS and drain",
  );
  once(
    clientText,
    authorityGuard +
      originalScriptEpochSelectionGuard +
      approvedScriptCatalogCas +
      beforeConfirmation,
    "approved authority then epoch/selection then CAS before any confirmation write",
  );
  once(
    clientText,
    commitPosition,
    "approved epoch guard moved only from original commit position",
  );

  const restored = clientText
    .replace(approvedContentRegistration, legacyContentRegistration)
    .replace(approvedScriptCatalogCapture, "")
    .replace(approvedSelection, legacySelection)
    .replace(originalScriptEpochSelectionGuard + approvedScriptCatalogCas, "")
    .replace(commitPosition, originalCommitPosition);
  assert.ok(
    ![
      "publishScriptLibrary",
      "readCatalogCache",
      "readCatalogValue",
      "confirmedScriptContentIds",
    ].some((name) => restored.includes(name)),
    "no partial or unknown script-publication seam after approved inverse",
  );
  return restored;
}
