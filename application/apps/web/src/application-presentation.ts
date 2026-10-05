import {
  browserApplication,
  readerApplication,
  objectsApplication,
  scriptStudioApplication,
  type ApplicationCatalogEntry,
} from "../../../packages/core/src/applications.js";
import type {
  CognitiveAppCatalogDto,
  CognitiveAppConnectionDto,
} from "../../../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppApplicationTarget,
  type CognitiveAppApplicationTarget,
} from "../../../packages/core/src/cognitive-app-application-target.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import { projectStatus } from "../../../packages/core/src/projects.js";
import { authorizedApplications } from "./application-dock-model.js";

export type CognitiveApplicationMetadata =
  CognitiveAppCatalogDto["versions"][number];
type LegacyEntry<K extends "builtin" | "ui-only"> = Readonly<{
  kind: K;
  key: string;
  application: ApplicationCatalogEntry;
}>;
export type CognitiveApplicationEntry = Readonly<{
  kind: "cognitive";
  key: string;
  metadata: CognitiveApplicationMetadata;
  connections: readonly CognitiveAppConnectionDto[];
  inputAvailability:
    | "selectable"
    | "project-unavailable"
    | "installation-inactive"
    | "not-granted"
    | "no-active-connection";
  gui: "absent" | "host-not-accepted";
}>;
export type ApplicationPresentationEntry =
  LegacyEntry<"builtin"> | LegacyEntry<"ui-only"> | CognitiveApplicationEntry;
export type ApplicationPresentationDirectory = Readonly<{
  /** Includes registered management facts, not only operational versions. */
  entries: readonly ApplicationPresentationEntry[];
  /** Current quick actions; this is presentation, never a business permit. */
  quickEntries: readonly ApplicationPresentationEntry[];
}>;

function isBundledApplication(
  app: Pick<ApplicationCatalogEntry, "id" | "version">,
) {
  return (
    app === browserApplication ||
    app === readerApplication ||
    app === scriptStudioApplication ||
    app === objectsApplication
  );
}

/** Installed legacy headers and restored windows share this exact-classification
 * guard. A registered cognitive definition cannot borrow the old UI-only bridge,
 * even without an active grant or GUI; canonical bundled objects stay unchanged. */
export function cognitiveApplicationForPackage(
  app: Pick<ApplicationCatalogEntry, "id" | "version">,
  versions: readonly CognitiveApplicationMetadata[],
): CognitiveApplicationMetadata | undefined {
  if (isBundledApplication(app)) return undefined;
  return versions.find(
    (metadata) =>
      metadata.appId === app.id &&
      (metadata.version === app.version ||
        metadata.ui?.packageVersion === app.version),
  );
}

function legacyEntry(
  app: ApplicationCatalogEntry,
): ApplicationPresentationEntry {
  return {
    kind: isBundledApplication(app) ? "builtin" : "ui-only",
    key: `${app.id}@${app.version}`,
    application: app,
  };
}

/** One compatibility normalization for actual old UI-only/historical callers.
 * New production consumers pass this module's discriminated projection. */
export function normalizeApplicationPresentation(
  input: readonly (ApplicationCatalogEntry | ApplicationPresentationEntry)[],
): readonly ApplicationPresentationEntry[] {
  return input.map((entry) => ("kind" in entry ? entry : legacyEntry(entry)));
}

export const presentationKey = (entry: ApplicationPresentationEntry) =>
  entry.key;
export const presentationTitle = (entry: ApplicationPresentationEntry) =>
  entry.kind === "cognitive" ? entry.metadata.title : entry.application.title;
export const presentationVersion = (entry: ApplicationPresentationEntry) =>
  entry.kind === "cognitive"
    ? entry.metadata.version
    : entry.application.version;
export const presentationDescription = (entry: ApplicationPresentationEntry) =>
  entry.kind === "cognitive"
    ? entry.metadata.description
    : entry.application.description;

export function cognitiveAvailabilityReason(entry: CognitiveApplicationEntry) {
  switch (entry.inputAvailability) {
    case "selectable":
      return "";
    case "project-unavailable":
      return "当前项目不可用于新输入。";
    case "installation-inactive":
      return "应用安装已停用或不可用，可在工作台管理。";
    case "not-granted":
      return "尚未允许数据访问，可在工作台管理。";
    case "no-active-connection":
      return "没有已启用的数据连接，可在工作台管理。";
  }
}

/** Preserve exact definitions and actual connections from the authenticated
 * owner's existing complete catalog. No fetch, cache, grant, Harness readiness,
 * online inference or second directory is introduced by this pure projection. */
export function projectApplicationPresentation({
  workspace,
  principalId,
  workspaceId,
  cognitiveCatalog,
}: {
  workspace: Workspace;
  principalId: string;
  workspaceId: string;
  cognitiveCatalog?: Pick<CognitiveAppCatalogDto, "versions" | "connections">;
}): ApplicationPresentationDirectory {
  const project = workspace.projects.find((entry) => entry.id === workspaceId);
  const currentProject = !!project && projectStatus(project) === "active";
  const versions = cognitiveCatalog?.versions ?? [];
  const legacy = authorizedApplications(workspace, principalId, workspaceId)
    .filter((app) => !cognitiveApplicationForPackage(app, versions))
    .map(legacyEntry);
  const cognitive: CognitiveApplicationEntry[] = versions.map((metadata) => {
    const connections = (cognitiveCatalog?.connections ?? []).filter(
      (connection) => connection.appId === metadata.appId,
    );
    const inputAvailability: CognitiveApplicationEntry["inputAvailability"] =
      !currentProject
        ? "project-unavailable"
        : metadata.installationState !== "active"
          ? "installation-inactive"
          : metadata.grant?.state !== "active" ||
              metadata.grant.appId !== metadata.appId ||
              metadata.grant.version !== metadata.version
            ? "not-granted"
            : !connections.some((connection) => connection.state === "active")
              ? "no-active-connection"
              : "selectable";
    return {
      kind: "cognitive",
      key: `cognitive:${metadata.appId}@${metadata.version}#${metadata.definitionHash}`,
      metadata,
      connections,
      inputAvailability,
      gui: metadata.ui === null ? "absent" : "host-not-accepted",
    };
  });
  const entries = [...legacy, ...cognitive];
  return {
    entries,
    quickEntries: entries.filter(
      (entry) =>
        entry.kind !== "cognitive" || entry.inputAvailability === "selectable",
    ),
  };
}

/** These are explicit options, not a selected/default connection. The Host
 * still checks current policy and installed Harness on actual input admission. */
export function cognitiveApplicationTargets(
  entry: CognitiveApplicationEntry,
): readonly CognitiveAppApplicationTarget[] {
  if (entry.inputAvailability !== "selectable") return [];
  return entry.connections
    .filter((connection) => connection.state === "active")
    .map((connection) =>
      parseCognitiveAppApplicationTarget({
        connectionId: connection.connectionId,
        authority: {
          appId: entry.metadata.appId,
          version: entry.metadata.version,
          definitionHash: entry.metadata.definitionHash,
          instanceId: connection.instanceId,
          serviceId: connection.serviceId,
          dataAuthorityId: connection.dataAuthorityId,
        },
      }),
    );
}
