// Fixed cb7246a258262d3024fdeb6f58cb654a49b3d005 oracle. Function bodies are
// copied from that commit's App.tsx/ApplicationHost.tsx, not the new owner.
// Only render bindings/ref/React setter ports are adapted below; no production
// navigation implementation is imported at runtime.
import {
  browserApplication,
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
  type ApplicationCatalogEntry,
  type ApplicationInstance,
} from "../../packages/core/src/applications.js";
import {
  spaceKind,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../packages/core/src/model.js";
import type { NavigationPreferences } from "../../apps/web/src/host/use-workspace-navigation.js";
import type { WorkSurfaceView } from "../../apps/web/src/host/work-surface.js";

export type FixedNavigationBindings = {
  navigation: {
    navigationGeneration: { current: number };
    beginIntent(): number;
    beginOpen(): number;
    finishOpen(generation: number): void;
  };
  client: {
    execute(operation: Operation): Promise<Receipt>;
    boot?: { workspace: Workspace } | null;
  };
  state: Workspace | undefined;
  project: Workspace["projects"][number] | undefined;
  prefs: NavigationPreferences;
  activeInstance: ApplicationInstance | undefined;
  historyVisible: boolean;
  exchangeKey: string;
  personalSpace(
    kind: "desk" | "inbox" | "dialogue",
  ): Workspace["projects"][number] | undefined;
  prefer(change: Partial<NavigationPreferences>): void;
  setWebsiteIntent(value: string | null): void;
  setCreating(value: null): void;
  setExecutions(value: null): void;
  setContentScope(value: string): void;
  setNotice(message: string): void;
};

export function createFixedApplicationNavigation({
  navigation,
  client,
  state,
  project,
  prefs,
  activeInstance,
  historyVisible,
  exchangeKey,
  personalSpace,
  prefer,
  setWebsiteIntent,
  setCreating,
  setExecutions,
  setContentScope,
  setNotice,
}: FixedNavigationBindings) {
  const navigationGeneration = navigation.navigationGeneration;
  type View = WorkSurfaceView;

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
      setNotice((e as Error).message);
    }
  }
  async function openScriptLibrary() {
    const owner = personalSpace("desk");
    if (!owner) return;
    const generation = navigation.beginIntent();
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: owner.id,
        applicationId: scriptStudioApplication.id,
        applicationVersion: scriptStudioApplication.version,
        scriptTarget: null,
      });
      if (generation !== navigationGeneration.current) return;
      prefer({
        view: "desk",
        scriptLocation: null,
        artifactId: null,
        applications: { ...prefs.applications, [owner.id]: receipt.entityId },
      });
    } catch (e) {
      if (generation === navigationGeneration.current)
        setNotice((e as Error).message);
    }
  }
  async function openWorkspaceContents() {
    if (project && spaceKind(project) !== "project") {
      setContentScope("all");
      navigate("content");
      return;
    }
    if (!project) return;
    const generation = navigation.beginOpen();
    try {
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId: project.id,
        applicationId: objectsApplication.id,
        applicationVersion: objectsApplication.version,
        artifactId: null,
      });
      if (generation !== navigationGeneration.current) return;
      activateApplication(receipt.entityId);
    } catch (error) {
      if (generation === navigationGeneration.current)
        setNotice((error as Error).message);
    } finally {
      navigation.finishOpen(generation);
    }
  }
  function activateApplication(
    id: string | null,
    expectedNavigation = navigationGeneration.current,
  ) {
    if (expectedNavigation !== navigationGeneration.current) return;
    if (!project) return;
    setWebsiteIntent(null);
    setCreating(null);
    prefer({
      applications: { ...prefs.applications, [project.id]: id },
      readerMode:
        state?.applicationInstances.find((i) => i.id === id)?.applicationId ===
        readerApplication.id,
      artifactId: null,
      artifactRevision: null,
      readingTarget: null,
      ...(id === null ? { scriptLocation: null } : {}),
      ...(historyVisible
        ? { interactions: { [exchangeKey]: "recent" as const } }
        : {}),
    });
  }
  function navigate(view: View) {
    setWebsiteIntent(null);
    setCreating(null);
    setExecutions(null);
    prefer({ view, artifactId: null, projectOpen: false });
  }
  async function openBrowser(url?: string) {
    if (!project) return;
    const generation = navigation.beginIntent();
    try {
      const result = await client.execute({
        type: "launch-application",
        workspaceId: project.id,
        applicationId: browserApplication.id,
        applicationVersion: browserApplication.version,
      });
      if (generation !== navigationGeneration.current) return;
      if (url) {
        const instance = client.boot?.workspace.applicationInstances.find(
          (i) => i.id === result.entityId,
        );
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
      setNotice(e instanceof Error ? e.message : "浏览器未能打开。");
    }
  }
  return {
    readingLibrary,
    openScriptLibrary,
    openWorkspaceContents,
    activateApplication,
    navigate,
    openBrowser,
  };
}

export type FixedHostBindings = {
  client: FixedNavigationBindings["client"];
  workspaceId: string;
  activeId: string | null;
  instances: ApplicationInstance[];
  navigationId: number;
  onActivate(id: string | null, expectedNavigation: number): void;
  onOpenContents(): Promise<void>;
  onNotice(message: string): void;
  launching: { current: boolean };
  setBusy(value: boolean): void;
};

export function createFixedApplicationHostActions({
  client,
  workspaceId,
  activeId,
  instances,
  navigationId,
  onActivate,
  onOpenContents,
  onNotice,
  launching,
  setBusy,
}: FixedHostBindings) {
  async function launch(app: ApplicationCatalogEntry, contents = false) {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    try {
      if (contents) {
        await onOpenContents();
        return;
      }
      const receipt = await client.execute({
        type: "launch-application",
        workspaceId,
        applicationId: app.id,
        applicationVersion: app.version,
      });
      // Persisting an application may finish after the user has chosen another
      // tab or document. Its receipt must not take over that newer navigation.
      onActivate(receipt.entityId, navigationId);
    } catch (error) {
      onNotice((error as Error).message);
    } finally {
      launching.current = false;
      setBusy(false);
    }
  }
  async function close(instance: ApplicationInstance) {
    try {
      await client.execute({
        type: "close-application",
        instanceId: instance.id,
        expectedRevision: instance.revision,
      });
      if (activeId === instance.id) {
        const index = instances.findIndex((i) => i.id === instance.id);
        onActivate(
          instances[index + 1]?.id ?? instances[index - 1]?.id ?? null,
          navigationId,
        );
      }
    } catch (error) {
      onNotice((error as Error).message);
    }
  }
  return { launch, close };
}
