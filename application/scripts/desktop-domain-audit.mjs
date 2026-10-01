import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Read the real isolated Host's narrow domains; never recreate /api/workspace
 * or serialize app originals into a replacement workspace snapshot. */
export async function platformRead(origin, path) {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.ok, true, `${path}: HTTP ${response.status}`);
  return response.json();
}

export function hostDeliveryAudit(dataDirectory) {
  const database = new DatabaseSync(join(dataDirectory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      inputs: database
        .prepare("SELECT key FROM runtime_deliveries ORDER BY key")
        .all(),
      sessions: database
        .prepare("SELECT key FROM runtime_sessions ORDER BY key")
        .all(),
      events: database
        .prepare(
          "SELECT session_id,key FROM runtime_session_events ORDER BY session_id,key",
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

export async function contentOwnershipAudit(origin, dataDirectory) {
  const [content, appViews, conversations] = await Promise.all([
    platformRead(origin, "/api/platform/content?limit=100"),
    platformRead(origin, "/api/platform/app-views"),
    platformRead(origin, "/api/platform/conversations/navigation?limit=100"),
  ]);
  return {
    content,
    appViews,
    conversations,
    delivery: hostDeliveryAudit(dataDirectory),
  };
}
