import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  isContentArtifact,
  spaceKind,
  type Workspace,
} from "../../../../packages/core/src/model.js";
import {
  objectsApplication,
  browserApplication,
  readerApplication,
  scriptStudioApplication,
  type ApplicationCatalogEntry,
  type ApplicationInstance,
} from "../../../../packages/core/src/applications.js";
import { contentText } from "../../../../packages/core/src/retrieval.js";
import type {
  ReaderTarget,
  ReadingLocation,
} from "../../../../packages/core/src/reader.js";
import type { LocalFileView } from "../../../../packages/core/src/local-files.js";
import type { ScriptLocation } from "../../../../packages/core/src/script-delivery.js";
import type { WorkspaceClient } from "../client.js";
import type { ExchangePreferences } from "./use-exchange-controller.js";
import type {
  WorkSurfacePreferences,
  deriveWorkSurface,
} from "./work-surface.js";

export type NavigationPreferences = WorkSurfacePreferences &
  ExchangePreferences & {
    artifactRevision: number | null;
    artifactPage?: number | null;
    readerMode?: boolean;
    readingTarget?: ReaderTarget | null;
    scriptLocation?:
      | (ScriptLocation & { requestId: string; view?: "library" | "editor" })
      | null;
    collaboration: boolean;
    subjectOpen: boolean;
    localFile?: { projectId: string; reference: LocalFileView["reference"] };
  };
export type NavigationPlace = Pick<
  NavigationPreferences,
  | "view"
  | "projectId"
  | "projectOpen"
  | "artifactId"
  | "artifactRevision"
  | "artifactPage"
  | "readerMode"
  | "applications"
  | "scriptLocation"
>;
type NavigationTrail = { places: NavigationPlace[]; index: number };
export type PreferenceWriter<P> = (
  update: (previous: P) => P,
  failure: "settings" | "position",
) => void;

export function isNavigationPreferenceChange(
  change: Partial<NavigationPreferences>,
) {
  return (
    "view" in change ||
    "projectId" in change ||
    "artifactId" in change ||
    "applications" in change ||
    "scriptLocation" in change ||
    "selectedConversations" in change
  );
}

/** The original preference patch, including presence-based resets and the
 * four explicitly merged maps. It retains all unrelated preference fields. */
export function mergeNavigationPreferences<P extends NavigationPreferences>(
  previous: P,
  change: Partial<P>,
): P {
  return {
    ...previous,
    ...("view" in change ||
    "projectId" in change ||
    "selectedConversations" in change ||
    typeof change.artifactId === "string"
      ? { scriptLocation: null }
      : {}),
    ...("view" in change ||
    "projectId" in change ||
    "artifactId" in change ||
    "applications" in change ||
    "selectedConversations" in change
      ? { localFile: undefined }
      : {}),
    ...("artifactId" in change ? { artifactRevision: null } : {}),
    ...change,
    ...(change.collaboration === true ? { subjectOpen: false } : {}),
    ...(change.selectedConversations
      ? {
          selectedConversations: {
            ...previous.selectedConversations,
            ...change.selectedConversations,
          },
        }
      : {}),
    ...(change.interactions
      ? { interactions: { ...previous.interactions, ...change.interactions } }
      : {}),
    ...(change.pinnedInputs
      ? { pinnedInputs: { ...previous.pinnedInputs, ...change.pinnedInputs } }
      : {}),
    ...(change.exchangeHeights
      ? {
          exchangeHeights: {
            ...previous.exchangeHeights,
            ...change.exchangeHeights,
          },
        }
      : {}),
  };
}

/** The existing in-memory trail: a new branch drops forward places and keeps
 * at most 100. This is not a second persisted route or an undo snapshot. */
export function appendNavigationPlace(
  current: NavigationTrail,
  place: NavigationPlace,
  placeKey: string,
): boolean {
  if (JSON.stringify(current.places[current.index]) === placeKey) return false;
  current.places = [...current.places.slice(0, current.index + 1), place].slice(
    -100,
  );
  current.index = current.places.length - 1;
  return true;
}

/** Only navigation lifecycle state. No effects, commands, persistence, latest
 * snapshots or second WorkSurface are created during this hook's render. */
export function useWorkspaceNavigationState() {
  const [openingObject, setOpeningObject] = useState(false);
  const [restoredPlace, setRestoredPlace] = useState<NavigationPlace | null>(
    null,
  );
  const trail = useRef<NavigationTrail>({ places: [], index: -1 });
  const [trailVersion, setTrailVersion] = useState(0);
  const restoring = useRef(false);
  const [websiteIntent, setWebsiteIntent] = useState<string | null>(null);
  const navigationGeneration = useRef(0);

  function beginIntent() {
    return ++navigationGeneration.current;
  }
  function beginOpen() {
    const generation = beginIntent();
    setOpeningObject(true);
    return generation;
  }
  function isCurrent(generation: number) {
    return generation === navigationGeneration.current;
  }
  function finishOpen(generation: number) {
    if (isCurrent(generation)) setOpeningObject(false);
  }
  function resetPreferenceNavigation() {
    setRestoredPlace(null);
    setOpeningObject(false);
  }
  function recordPlace(place: NavigationPlace, placeKey: string) {
    if (openingObject) return;
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    if (appendNavigationPlace(trail.current, place, placeKey))
      setTrailVersion((v) => v + 1);
  }
  function restorePlace(
    current: NavigationTrail,
    index: number,
    next: NavigationPlace,
    commitPreferences: () => void,
  ) {
    current.index = index;
    restoring.current = true;
    setRestoredPlace(next);
    commitPreferences();
    setTrailVersion((v) => v + 1);
  }
  return {
    navigationGeneration,
    openingObject,
    restoredPlace,
    trail,
    trailVersion,
    websiteIntent,
    beginIntent,
    beginOpen,
    isCurrent,
    finishOpen,
    resetPreferenceNavigation,
    setExplicitWebsiteIntent: setWebsiteIntent,
    recordPlace,
    restorePlace,
  };
}
export type NavigationOwner = ReturnType<typeof useWorkspaceNavigationState>;
type NavigationSurface = Pick<
  ReturnType<typeof deriveWorkSurface>,
  "project" | "applicationWorkspaceOpen" | "exchangeKey" | "activeInstance"
>;
type NavigationClient = Pick<
  WorkspaceClient,
  "resolveArtifact" | "resolveScriptLocation" | "execute"
>;
type ApplicationReceipt = Awaited<ReturnType<NavigationClient["execute"]>>;

/** Facts captured by ApplicationHost's render, not a refreshed projection or
 * an invocation-time generation. Closing only changes the visible selection. */
export type ApplicationNavigationSnapshot = {
  readonly workspaceId: string;
  readonly navigationId: number;
  readonly activeId: string | null;
  readonly instances: readonly ApplicationInstance[];
};
export type ApplicationNavigationActions = {
  activate(id: string | null, expectedNavigation?: number): void;
  launch(
    app: Pick<ApplicationCatalogEntry, "id" | "version">,
    captured: ApplicationNavigationSnapshot,
    contents?: boolean,
  ):
    | { kind: "contents"; pending: Promise<void> }
    | {
        kind: "application";
        pending: Promise<ApplicationReceipt>;
        commit(receipt: ApplicationReceipt): void;
      };
  close(
    instance: ApplicationInstance,
    captured: ApplicationNavigationSnapshot,
  ): { pending: Promise<ApplicationReceipt>; commit(): void };
};

/** A render-local command closure, not a hook or a store. Construction only
 * captures the existing authorized client/surface; effects start on invocation. */
export function createWorkspaceNavigationCommands<
  P extends NavigationPreferences,
>({
  owner,
  client,
  workspace,
  surface,
  preferences: prefs,
  prefer,
  writePreferences,
  shell,
  recordContentVisit,
  onNotice,
  application,
}: {
  owner: NavigationOwner;
  client: NavigationClient;
  workspace: Workspace | undefined;
  surface: NavigationSurface;
  preferences: P;
  prefer: (change: Partial<NavigationPreferences>) => void;
  writePreferences: PreferenceWriter<P>;
  shell: { finishCreation(): void; dismissExecutionInspector(): void };
  recordContentVisit: (id: string) => void;
  onNotice: (message: string) => void;
  application: {
    historyVisible: boolean;
    personalDesk(): Workspace["projects"][number] | undefined;
    readCapturedInstance(id: string): ApplicationInstance | undefined;
    selectAllContent(): void;
  };
}) {
  const { project, applicationWorkspaceOpen, exchangeKey, activeInstance } =
    surface;
  async function travel(direction: number) {
    const current = owner.trail.current,
      index = current.index + direction,
      next = current.places[index];
    if (!next) return;
    if (
      !next.artifactId &&
      !next.scriptLocation &&
      !workspace?.projects.some((p) => p.id === next.projectId)
    ) {
      onNotice("原位置已不可用或无访问权限。");
      return;
    }
    const generation = owner.beginOpen();
    try {
      if (next.artifactId) {
        const resolved = await client.resolveArtifact(
          next.artifactId,
          next.artifactRevision ?? undefined,
        );
        if (!resolved) throw new Error("原位置已不可用或无访问权限。");
      }
      if (next.scriptLocation) {
        const resolved = await client.resolveScriptLocation(
          next.scriptLocation,
        );
        if (!resolved) throw new Error("原位置已不可用或无访问权限。");
      }
      if (!owner.isCurrent(generation)) return;
      shell.finishCreation();
      owner.setExplicitWebsiteIntent(null);
      shell.dismissExecutionInspector();
      owner.restorePlace(current, index, next, () => {
        writePreferences((previous) => ({ ...previous, ...next }), "position");
      });
    } catch (cause) {
      if (owner.isCurrent(generation))
        onNotice(
          cause instanceof Error ? cause.message : "原位置暂时无法读取。",
        );
    } finally {
      owner.finishOpen(generation);
    }
  }
  async function openScriptLocation(target: ScriptLocation) {
    const generation = owner.beginOpen();
    try {
      const resolved = await client.resolveScriptLocation(target);
      if (!owner.isCurrent(generation)) return;
      if (!resolved) {
        onNotice("剧本结果已不可用或无访问权限。");
        return;
      }
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: resolved.production.projectId,
        applicationId: scriptStudioApplication.id,
        applicationVersion: scriptStudioApplication.version,
        scriptTarget: target,
      });
      if (!owner.isCurrent(generation)) return;
      shell.finishCreation();
      if (resolved.production.contentId)
        recordContentVisit(resolved.production.contentId);
      prefer({
        artifactId: null,
        scriptLocation: { ...target, requestId: receipt.commandId },
        applications: {
          ...prefs.applications,
          [resolved.production.projectId]: receipt.entityId,
        },
        interactions: { [exchangeKey]: "hidden" },
      });
    } catch (error) {
      if (owner.isCurrent(generation)) onNotice((error as Error).message);
    } finally {
      owner.finishOpen(generation);
    }
  }
  async function openObject(
    workspaceId: string,
    id: string,
    revision?: number,
    page?: number,
    readerMode = false,
    reading?: ReadingLocation,
    expectedQuote?: string,
  ) {
    const generation = owner.beginOpen();
    try {
      const opened = await client.resolveArtifact(id, revision);
      if (!owner.isCurrent(generation)) return;
      if (!opened || opened.projectId !== workspaceId)
        throw new Error("内容暂时无法读取，请检查连接或访问权限后重试。");
      if (expectedQuote) {
        const exact = opened.versions.find(
          (version) => version.revision === (revision ?? opened.revision),
        );
        if (!exact || !contentText(exact.content).includes(expectedQuote))
          throw new Error("引用与当前原件版本不一致，请重新搜索后再试。");
      }
      const readingView =
        readerMode ||
        opened.content.kind === "publication" ||
        opened.content.kind === "pdf";
      const application = readingView ? readerApplication : objectsApplication;
      const result = applicationWorkspaceOpen
        ? await client.execute({
            type: "launch-application",
            workspaceId,
            applicationId: application.id,
            applicationVersion: application.version,
            artifactId: id,
          })
        : null;
      if (!owner.isCurrent(generation)) return;
      shell.finishCreation();
      prefer({
        artifactId: id,
        artifactRevision: revision ?? null,
        artifactPage: page ?? null,
        readerMode: readingView,
        readingTarget: reading
          ? {
              artifactId: id,
              revision: revision ?? opened.revision,
              location: reading,
              requestId: crypto.randomUUID(),
            }
          : null,
        ...(prefs.interactions?.[exchangeKey] === "history"
          ? { interactions: { [exchangeKey]: "recent" as const } }
          : {}),
        ...(result
          ? {
              applications: {
                ...prefs.applications,
                [workspaceId]: result.entityId,
              },
            }
          : {}),
      });
      if (isContentArtifact(opened)) recordContentVisit(id);
      // prefer synchronously invalidates the old intent. Consumers need the
      // updated epoch, not the one captured before the authorized reads.
      return owner.navigationGeneration.current;
    } catch (e) {
      // Preserve this branch's original error semantics; unlike script/travel,
      // its catch was not generation-gated. Race fixes are a separate change.
      onNotice((e as Error).message);
    } finally {
      owner.finishOpen(generation);
    }
  }
  async function launchDockApplication(
    app: Pick<ApplicationCatalogEntry, "id" | "version">,
  ) {
    // This handler is only exposed by App when a real project is present.
    const workspaceProject = project!;
    const generation = owner.beginIntent();
    const receipt = await client.execute({
      type: "launch-application",
      workspaceId: workspaceProject.id,
      applicationId: app.id,
      applicationVersion: app.version,
    });
    if (!owner.isCurrent(generation)) return;
    prefer({
      view: spaceKind(workspaceProject) === "project" ? "projects" : "desk",
      projectId: workspaceProject.id,
      projectOpen: true,
      artifactId: null,
      artifactRevision: null,
      scriptLocation: null,
      readerMode: app.id === readerApplication.id,
      applications: {
        ...prefs.applications,
        [workspaceProject.id]: receipt.entityId,
      },
    });
  }
  async function readingLibrary() {
    if (
      !activeInstance ||
      activeInstance.applicationId !== readerApplication.id
    ) {
      prefer({ artifactId: null, readerMode: false, readingTarget: null });
      return;
    }
    try {
      await client.execute({
        type: "set-application-state",
        instanceId: activeInstance.id,
        expectedRevision: activeInstance.revision,
        state: { ...activeInstance.state, artifactId: "" },
      });
      activateApplication(activeInstance.id);
    } catch (e) {
      onNotice((e as Error).message);
    }
  }
  async function openScriptLibrary() {
    const desk = application.personalDesk();
    if (!desk) return;
    const generation = owner.beginIntent();
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: desk.id,
        applicationId: scriptStudioApplication.id,
        applicationVersion: scriptStudioApplication.version,
        scriptTarget: null,
      });
      if (!owner.isCurrent(generation)) return;
      prefer({
        view: "desk",
        scriptLocation: null,
        artifactId: null,
        applications: { ...prefs.applications, [desk.id]: receipt.entityId },
      });
    } catch (e) {
      if (owner.isCurrent(generation)) onNotice((e as Error).message);
    }
  }
  async function openWorkspaceContents() {
    if (project && spaceKind(project) !== "project") {
      application.selectAllContent();
      navigate("content");
      return;
    }
    if (!project) return;
    const generation = owner.beginOpen();
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: project.id,
        applicationId: objectsApplication.id,
        applicationVersion: objectsApplication.version,
        artifactId: null,
      });
      if (!owner.isCurrent(generation)) return;
      activateApplication(receipt.entityId);
    } catch (error) {
      if (owner.isCurrent(generation)) onNotice((error as Error).message);
    } finally {
      owner.finishOpen(generation);
    }
  }
  function activateApplication(
    id: string | null,
    expectedNavigation = owner.navigationGeneration.current,
  ) {
    if (!owner.isCurrent(expectedNavigation)) return;
    if (!project) return;
    owner.setExplicitWebsiteIntent(null);
    shell.finishCreation();
    prefer({
      applications: { ...prefs.applications, [project.id]: id },
      readerMode:
        workspace?.applicationInstances.find((i) => i.id === id)
          ?.applicationId === readerApplication.id,
      artifactId: null,
      artifactRevision: null,
      readingTarget: null,
      ...(id === null ? { scriptLocation: null } : {}),
      ...(application.historyVisible
        ? { interactions: { [exchangeKey]: "recent" as const } }
        : {}),
    });
  }
  function navigate(view: NavigationPreferences["view"]) {
    owner.setExplicitWebsiteIntent(null);
    shell.finishCreation();
    shell.dismissExecutionInspector();
    prefer({ view, artifactId: null, projectOpen: false });
  }
  async function openBrowser(url?: string) {
    if (!project) return;
    const generation = owner.beginIntent();
    try {
      const result = await client.execute({
        type: "launch-application",
        workspaceId: project.id,
        applicationId: browserApplication.id,
        applicationVersion: browserApplication.version,
      });
      if (!owner.isCurrent(generation)) return;
      if (url) {
        // The port retains App's captured client.boot lookup. It is not a
        // refreshed Client snapshot or a second authorization read.
        const instance = application.readCapturedInstance(result.entityId);
        if (instance)
          await client.execute({
            type: "set-application-state",
            instanceId: instance.id,
            expectedRevision: instance.revision,
            state: { ...instance.state, url },
          });
      }
      prefer({
        view: spaceKind(project) === "project" ? "projects" : "desk",
        projectId: project.id,
        projectOpen: true,
        artifactId: null,
        applications: { ...prefs.applications, [project.id]: result.entityId },
      });
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "浏览器未能打开。");
    }
  }
  // Host keeps its original await/catch/finally and local busy lifecycle. These
  // synchronous preparations return the original command promise, so commit
  // and Host cleanup still share the original execute continuation.
  const applicationActions: ApplicationNavigationActions = {
    activate: activateApplication,
    launch(app, captured, contents = false) {
      if (contents)
        return { kind: "contents", pending: openWorkspaceContents() };
      return {
        kind: "application",
        pending: client.execute({
          type: "launch-application",
          workspaceId: captured.workspaceId,
          applicationId: app.id,
          applicationVersion: app.version,
        }),
        commit(receipt) {
          activateApplication(receipt.entityId, captured.navigationId);
        },
      };
    },
    close(instance, captured) {
      return {
        pending: client.execute({
          type: "close-application",
          instanceId: instance.id,
          expectedRevision: instance.revision,
        }),
        commit() {
          if (captured.activeId === instance.id) {
            const index = captured.instances.findIndex(
              (i) => i.id === instance.id,
            );
            activateApplication(
              captured.instances[index + 1]?.id ??
                captured.instances[index - 1]?.id ??
                null,
              captured.navigationId,
            );
          }
        },
      };
    },
  };
  return {
    travel,
    openObject,
    openScriptLocation,
    launchDockApplication,
    readingLibrary,
    openScriptLibrary,
    openWorkspaceContents,
    activateApplication,
    navigate,
    openBrowser,
    applicationActions,
  };
}

/** Register at the original trail/keyboard seam, after canvas restoration and
 * before exchange focus commits. Object identities are intentionally not deps. */
export function useWorkspaceNavigationCommit(
  owner: NavigationOwner,
  {
    place,
    travel,
  }: { place: NavigationPlace; travel: (direction: number) => Promise<void> },
) {
  const placeKey = JSON.stringify(place);
  const { openingObject, trailVersion } = owner;
  useLayoutEffect(
    () => owner.recordPlace(place, placeKey),
    [placeKey, openingObject],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest(
          "input, textarea, [contenteditable=true], dialog[open]",
        )
      )
        return;
      const direction =
        (e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "[")
          ? -1
          : (e.altKey && e.key === "ArrowRight") || (e.metaKey && e.key === "]")
            ? 1
            : 0;
      if (direction) {
        e.preventDefault();
        travel(direction);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [trailVersion, placeKey]);
}
