import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const smoke = read("application/scripts/reader-ocr-desktop-smoke.mjs");
const interactions = read(
  "application/apps/web/src/data/reader-interactions.ts",
);
const pdfPage = read("application/apps/web/src/PdfReader.tsx");
const workflows = [
  ".github/workflows/application.yml",
  ".github/workflows/application-native-regressions.yml",
].map((path) => ({ path, source: read(path) }));

// These are fixture/CI contract gates, not evidence that Electron or OCR ran.
function verifyReadyPhases(source) {
  const clientDeadline = Number(
    interactions.match(/signal: AbortSignal\.timeout\((\d+)\)/)?.[1],
  );
  const importBudget = Number(
    source
      .match(/const importReadyTimeout = ([\d_]+);/)?.[1]
      .replaceAll("_", ""),
  );
  const pdfBudget = Number(
    source.match(/const pdfReadyTimeout = ([\d_]+);/)?.[1].replaceAll("_", ""),
  );
  assert.ok(clientDeadline > 0);
  assert.ok(importBudget >= clientDeadline);
  assert.ok(importBudget <= clientDeadline + 5_000);
  assert.ok(pdfBudget > 0 && pdfBudget <= 20_000);
  const importReady = source.indexOf(
    ").toBeVisible({ timeout: importReadyTimeout });",
  );
  const pdfReady = source.indexOf('beginPhase("pdf-ready");');
  const renderedPage = source.indexOf(
    'await expect(page.locator(".reading-app:visible .pdf-page")).toHaveAttribute(\n    "aria-busy",\n    "false",\n    { timeout: pdfReadyTimeout },\n  );',
  );
  const text = source.indexOf(
    'page.locator(".reading-app:visible .pdf-text-layer"),\n  ).toContainText("DESIGN NOTES");',
  );
  const ocr = source.indexOf('beginPhase("ocr");');
  assert.ok(source.includes('name: "阅读 TEST OCR 本地识别"'));
  assert.ok(source.includes('beginPhase("import");'));
  assert.ok(importReady >= 0 && pdfReady > importReady);
  assert.ok(renderedPage > pdfReady && text > renderedPage && ocr > text);
  assert.match(source, /\/DESIGN\\s\*NOTES\/,\s*\{ timeout: 90000 \},/);
}

test("reader OCR fixture waits for bounded import and canvas/text readiness without weakening content or OCR assertions", () => {
  assert.match(
    pdfPage,
    /await Promise\.all\(\[render\.promise, textRendering\]\);\s*if \(!stopped\) setReady\(true\);/,
  );
  assert.match(pdfPage, /aria-busy=\{!ready\}/);
  verifyReadyPhases(smoke);
});

test("reader OCR readiness gate rejects missing phases, busy pages or relaxed content/OCR checks", () => {
  for (const changed of [
    smoke.replace(
      ").toBeVisible({ timeout: importReadyTimeout });",
      ").toBeVisible();",
    ),
    smoke.replace(
      '"false",\n    { timeout: pdfReadyTimeout }',
      '"true",\n    { timeout: pdfReadyTimeout }',
    ),
    smoke.replace(').toContainText("DESIGN NOTES");', ').toContainText("");'),
    smoke.replace("{ timeout: 90000 }", "{ timeout: 180000 }"),
    smoke.replace(
      "const importReadyTimeout = 40_000;",
      "const importReadyTimeout = 120_000;",
    ),
  ])
    assert.throws(() => verifyReadyPhases(changed));
});

function verifyFailureDiagnosis(source) {
  const failure = source.slice(source.lastIndexOf("} catch (error) {"));
  assert.match(failure, /ocr-failure\.png/);
  assert.match(failure, /ocr-failure\.json/);
  for (const field of [
    "error: error.stack ?? String(error)",
    "phase,",
    "phaseElapsedMilliseconds: Date.now() - phaseStarted",
    "elapsedMilliseconds: Date.now() - fixtureStarted",
    "phaseTimings,",
  ])
    assert.ok(failure.includes(field), `failure diagnostic missing ${field}`);
  for (const phase of [
    "import",
    "pdf-ready",
    "ocr",
    "verification",
    "complete",
  ])
    assert.ok(source.includes(`beginPhase("${phase}");`));
  assert.match(source, /let phase = "init"/);
  assert.match(source, /phaseTimings\.push\(timing\)/);
}

test("reader OCR failure preserves the actual error, active phase and prior stage timings", () => {
  verifyFailureDiagnosis(smoke);
  for (const removed of [
    "phase,",
    "phaseElapsedMilliseconds: Date.now() - phaseStarted,",
    "phaseTimings,",
    "error: error.stack ?? String(error),",
  ]) {
    const offset = smoke.lastIndexOf("} catch (error) {");
    const changed =
      smoke.slice(0, offset) + smoke.slice(offset).replace(removed, "");
    assert.throws(() => verifyFailureDiagnosis(changed));
  }
});

function verifyArtifact(source) {
  assert.match(
    source,
    /application\/test-results\/morphz-embedded-electron-\*\/ocr-failure\.png/,
  );
  assert.match(
    source,
    /run: node --test \.\.\/scripts\/tests\/application-reader-ocr-smoke\.test\.mjs/,
  );
}

for (const { path, source } of workflows) {
  test(`${path}: reader OCR failure screenshot accompanies the JSON diagnosis`, () => {
    verifyArtifact(source);
    assert.throws(() =>
      verifyArtifact(
        source.replace(
          "application/test-results/morphz-embedded-electron-*/ocr-failure.png",
          "",
        ),
      ),
    );
  });
}
