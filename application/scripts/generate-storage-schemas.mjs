import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = [
  ["platform", "platform", "platformSchemaSql"],
  ["script-studio", "script-studio", "scriptStudioSchemaSql"],
  ["reader", "reader", "readerSchemaSql"],
  ["objects", "objects", "objectsSchemaSql"],
  ["browser", "browser", "browserSchemaSql"],
  [
    "managed-artifact-store",
    "managed-artifact-store",
    "managedArtifactStoreSchemaSql",
  ],
];

for (const [name, packageName, exportName] of schemas) {
  const source = `docs/storage-model-v1/${name}.sql`;
  const target = resolve(root, `packages/${packageName}/src/schema.ts`);
  const sql = readFileSync(resolve(root, source), "utf8");
  const generated = `// Generated from ${source} by scripts/generate-storage-schemas.mjs.\nexport const ${exportName} = ${JSON.stringify(sql)};\n`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await format(generated, { parser: "typescript" }));
}

const cloudSource = "docs/storage-model-v1/cloud-artifact-store-extension.sql";
const cloudSql = readFileSync(resolve(root, cloudSource), "utf8");
const cloudTarget = resolve(
  root,
  "packages/managed-artifact-store/src/cloud-schema.ts",
);
const cloudGenerated =
  `// Generated from ${cloudSource} by scripts/generate-storage-schemas.mjs.\n` +
  `import { managedArtifactStoreSchemaSql } from "./schema.js";\n\n` +
  `export const cloudByteBindingSchemaSql =\n  ${JSON.stringify(cloudSql)};\n` +
  `export const cloudArtifactStoreSchemaSql =\n  managedArtifactStoreSchemaSql + "\\n" + cloudByteBindingSchemaSql;\n`;
writeFileSync(
  cloudTarget,
  await format(cloudGenerated, { parser: "typescript" }),
);
