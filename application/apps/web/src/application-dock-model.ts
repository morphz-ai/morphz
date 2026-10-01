import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
  type ApplicationCatalogEntry,
} from "../../../packages/core/src/applications.js";
import type { Workspace } from "../../../packages/core/src/model.js";

export const applicationKey = (
  app: Pick<ApplicationCatalogEntry, "id" | "version">,
) => `${app.id}@${app.version}`;
export function authorizedApplications(
  state: Workspace,
  principalId: string,
  workspaceId: string,
) {
  const builtins = [
    browserApplication,
    readerApplication,
    scriptStudioApplication,
  ];
  const builtinKeys = new Set(builtins.map(applicationKey));
  const instances = state.applicationInstances.filter(
    (i) => i.workspaceId === workspaceId && i.status === "open",
  );
  return [
    ...builtins,
    ...state.applications.filter(
      (app) =>
        !builtinKeys.has(applicationKey(app)) &&
        (app.installedBy === principalId ||
          instances.some(
            (i) =>
              i.applicationId === app.id &&
              i.applicationVersion === app.version,
          )),
    ),
  ];
}
export function pinnedApplications(
  apps: ApplicationCatalogEntry[],
  keys?: string[],
) {
  const pinned = keys ?? [
    applicationKey(scriptStudioApplication),
    applicationKey(browserApplication),
  ];
  const catalog = new Map(apps.map((app) => [applicationKey(app), app]));
  return [...new Set(pinned)].flatMap((key) =>
    catalog.has(key) ? [catalog.get(key)!] : [],
  );
}
