import { createHash } from "node:crypto";
import type { ObjectsByteReference } from "../packages/objects/src/store.js";
import type { SqlQuery } from "../packages/storage/src/sql.js";

/** A small CURRENT-schema initial state for an already-stored Objects PDF.
 * There is no public Objects PDF creation operation. This fixture is not a
 * Workspace importer or evidence of a successful Human PDF creation flow;
 * subsequent reads, title revisions and authorization use real domain APIs.
 */
export async function seedExistingPdf(
  q: SqlQuery,
  value: {
    tenantId: string;
    objectId: string;
    projectId: string;
    author: { principalId: string; actantId: string };
    reference: ObjectsByteReference;
    versions: { title: string; pages: string[] }[];
  },
) {
  const { tenantId, objectId, projectId, author, reference, versions } = value;
  const at = "2026-09-30T00:00:00.000Z";
  await q.change(
    "INSERT INTO objects(tenant_id,object_id,kind,head_revision,created_by_principal_id,created_by_actant_id,created_at,updated_at,origin_project_id) VALUES(?,?,'pdf',?,?,?,?,?,?)",
    [
      tenantId,
      objectId,
      versions.length,
      author.principalId,
      author.actantId,
      at,
      at,
      projectId,
    ],
  );
  for (const [index, version] of versions.entries()) {
    const revision = index + 1;
    const body = JSON.stringify({
      kind: "pdf",
      assetId: reference.sha256,
      pages: version.pages,
    });
    await q.change(
      "INSERT INTO object_versions(tenant_id,object_id,revision,title,kind,payload_body,payload_sha256,historical_project_id,author_principal_id,author_actant_id,created_at) VALUES(?,?,?,?,'pdf',?,?,?,?,?,?)",
      [
        tenantId,
        objectId,
        revision,
        version.title,
        body,
        createHash("sha256").update(body).digest("hex"),
        projectId,
        author.principalId,
        author.actantId,
        at,
      ],
    );
    await q.change(
      "INSERT INTO object_version_bytes(tenant_id,object_id,object_revision,store_id,artifact_id,artifact_revision,sha256,byte_length,mime) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        tenantId,
        objectId,
        revision,
        reference.storeId,
        reference.artifactId,
        reference.revision,
        reference.sha256,
        reference.byteLength,
        reference.mime,
      ],
    );
  }
}
