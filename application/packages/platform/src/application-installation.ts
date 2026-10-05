import type { SqlQuery } from "../../storage/src/sql.js";

export type ApplicationInstallationIdentity = {
  installationId: string;
  state: "active" | "disabled" | "unavailable";
  installedAt: string;
};

/** Internal, transaction-scoped acquisition after caller authentication and
 * validation. UI and domain installation share the tenant/app identity; this
 * does not grant consent, reactivate an installation or replace its first ID.
 */
export async function ensureApplicationInstallation(
  q: SqlQuery,
  request: {
    tenantId: string;
    appId: string;
    proposedInstallationId: string;
    installedAt: string;
  },
): Promise<ApplicationInstallationIdentity> {
  await q.change(
    "INSERT INTO app_installations(tenant_id,app_id,installation_id,state,installed_at) VALUES(?,?,?,'active',?) ON CONFLICT(tenant_id,app_id) DO NOTHING",
    [
      request.tenantId,
      request.appId,
      request.proposedInstallationId,
      request.installedAt,
    ],
  );
  const row = (
    await q.all<{
      installation_id: string;
      state: ApplicationInstallationIdentity["state"];
      installed_at: string;
    }>(
      "SELECT installation_id,state,installed_at FROM app_installations WHERE tenant_id=? AND app_id=?",
      [request.tenantId, request.appId],
    )
  )[0];
  if (!row)
    throw new Error(
      "Platform installation acquisition did not retain its identity.",
    );
  return {
    installationId: row.installation_id,
    state: row.state,
    installedAt: row.installed_at,
  };
}
