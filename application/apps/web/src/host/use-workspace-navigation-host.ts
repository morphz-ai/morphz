// Identity/lifecycle checks do not substitute for the caller's semantic
// destination checks against this current authorized projection.
import { useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceClient } from "../client.js";
import { scopedStorage } from "../local-preferences.js";
import {
  interfacePreferences,
  type InterfacePreferences,
} from "../interface-preferences.js";
import { sidebarPreference } from "../sidebar-layout.js";
import type { SubjectView } from "../subject-sidebar-model.js";
import type { TaskListOptions } from "../task-list.js";
import type { ReaderTarget } from "../../../../packages/core/src/reader.js";
import type { ScriptLocation } from "../../../../packages/core/src/script-delivery.js";
import type { LocalFileView } from "../../../../packages/core/src/local-files.js";
import type { InteractionMode } from "../interaction.js";
import type { WorkSurfaceView } from "./work-surface.js";
import type { CognitiveNavigationLocation } from "./cognitive-navigation-location.js";
import {
  useWorkspaceNavigationState,
  type PreferenceWriter,
  type CurrentDestination,
} from "./use-workspace-navigation.js";
import { contentVisits, visitContent } from "../recent-content.js";

type Projection = NonNullable<ReturnType<WorkspaceClient["getSnapshot"]>>;
export type NavigationIdentity = Readonly<
  Pick<Projection, "centerId" | "principalId" | "csrfToken">
>;

// The original Preferences shape and initialization, not a new route schema.
export type Preferences = InterfacePreferences & {
  subjectTab?: SubjectView;
  subjectOpen: boolean;
  dockApplications?: string[];
  taskList?: TaskListOptions;
  executionWidth?: number;
  inspectorWidth?: number;
  view: WorkSurfaceView;
  projectId: string;
  artifactId: string | null;
  artifactRevision: number | null;
  artifactPage?: number | null;
  readerMode?: boolean;
  readingTarget?: ReaderTarget | null;
  collaboration: boolean;
  composer: boolean;
  conversation: boolean | null;
  sidebar: boolean;
  sidebarWidth?: number;
  sidebarCompact?: boolean;
  projectOpen: boolean;
  applications?: Record<string, string | null>;
  scriptLocation?:
    | (ScriptLocation & { requestId: string; view?: "library" | "editor" })
    | null;
  cognitiveLocation?: CognitiveNavigationLocation | null;
  interactions?: Record<string, InteractionMode>;
  exchangeHeights?: Record<string, number>;
  pinnedInputs?: Record<string, boolean>;
  pinnedHistories?: Record<string, boolean>;
  selectedConversations?: Record<string, string>;
  localFile?: { projectId: string; reference: LocalFileView["reference"] };
};
const defaultPrefs: Preferences = {
  ...interfacePreferences({}),
  view: "desk",
  projectId: "first-project",
  artifactId: null,
  artifactRevision: null,
  collaboration: false,
  subjectOpen: false,
  composer: true,
  conversation: null,
  sidebar: true,
  projectOpen: false,
};

// A synchronous witness evaluated afresh, not a retained Boot or request queue.
export type { CurrentDestination } from "./use-workspace-navigation.js";
const persistenceMessages = {
  settings: "设置暂时无法持久保存。",
  position: "当前位置暂时无法持久保存。",
  recent: "最近打开记录暂时无法保存，内容不受影响。",
} as const;
type PersistenceNotice =
  "" | (typeof persistenceMessages)[keyof typeof persistenceMessages];

export function useWorkspaceNavigationHost({
  identity,
  getSnapshot,
}: {
  identity: NavigationIdentity;
  getSnapshot: WorkspaceClient["getSnapshot"];
}) {
  const [scope] = useState<NavigationIdentity>(() => ({ ...identity }));
  const [storage] = useState(() =>
    scopedStorage(`${scope.centerId}:${scope.principalId}`),
  );
  const { readLocal, writeLocal } = storage;
  const [recentContentVisits, setRecentContentVisits] = useState(() =>
    contentVisits(readLocal<unknown>("recent-content", [])),
  );
  const [prefs, setPrefs] = useState<Preferences>(() => {
    const p = readLocal<Partial<Preferences>>("preferences", {});
    return {
      ...defaultPrefs,
      ...p,
      ...interfacePreferences(p),
      ...sidebarPreference(p.sidebarWidth, p.sidebarCompact),
      subjectOpen: p.subjectOpen === true,
      subjectTab: ["activity", "permissions", "schedules", "settings"].includes(
        p.subjectTab ?? "",
      )
        ? p.subjectTab
        : "activity",
      collaboration: p.subjectOpen === true ? false : p.collaboration === true,
      projectOpen: p.projectOpen ?? p.view === "projects",
      view: ["dialogue", "inbox", "content", "desk", "projects"].includes(
        p.view ?? "",
      )
        ? p.view!
        : defaultPrefs.view,
    };
  });
  const [persistenceNotice, setPersistenceNotice] =
    useState<PersistenceNotice>("");
  const state = useWorkspaceNavigationState();
  const lifetime = useRef({ active: false, incarnation: 0 });
  function activate() {
    lifetime.current.active = true;
    lifetime.current.incarnation++;
  }
  function retire() {
    lifetime.current.active = false;
    lifetime.current.incarnation++;
    state.beginIntent();
  }
  function currentProjection() {
    const current = getSnapshot();
    return current &&
      current.centerId === scope.centerId &&
      current.principalId === scope.principalId &&
      current.csrfToken === scope.csrfToken
      ? current
      : null;
  }
  function isCurrentHost() {
    return lifetime.current.active && !!currentProjection();
  }
  function captureCommit(): CurrentDestination {
    const incarnation = lifetime.current.incarnation;
    return () =>
      lifetime.current.active && lifetime.current.incarnation === incarnation;
  }
  function permitted(incarnation: number, destination: CurrentDestination) {
    if (
      !lifetime.current.active ||
      lifetime.current.incarnation !== incarnation
    )
      return false;
    const current = currentProjection();
    return !!current && destination(current);
  }
  function writePreferences(
    update: Parameters<PreferenceWriter<Preferences>>[0],
    failure: Parameters<PreferenceWriter<Preferences>>[1],
    destination: CurrentDestination,
  ) {
    const incarnation = lifetime.current.incarnation;
    if (!permitted(incarnation, destination)) return;
    setPrefs((previous) => {
      // React may defer/replay this updater across cleanup or identity change.
      if (!permitted(incarnation, destination)) return previous;
      const next = update(previous);
      try {
        writeLocal("preferences", next);
      } catch {
        // This feedback belongs to this same Host, never an unmounted child.
        setPersistenceNotice(persistenceMessages[failure]);
      }
      return next;
    });
  }
  function recordContentVisit(id: string, destination: CurrentDestination) {
    const incarnation = lifetime.current.incarnation;
    if (!permitted(incarnation, destination)) return;
    setRecentContentVisits((previous) => {
      if (!permitted(incarnation, destination)) return previous;
      const next = visitContent(previous, id);
      try {
        writeLocal("recent-content", next);
      } catch {
        setPersistenceNotice(persistenceMessages.recent);
      }
      return next;
    });
  }
  return {
    prefs,
    persistenceNotice,
    dismissPersistenceNotice: () => setPersistenceNotice(""),
    storage,
    recentContentVisits,
    // The original state/intent/trail methods remain the sole navigation owner.
    navigation: {
      ...state,
      isCurrent: (generation: number) =>
        isCurrentHost() && state.isCurrent(generation),
    },
    isCurrentHost,
    captureCommit,
    activate,
    retire,
    currentProjection,
    writePreferences,
    recordContentVisit,
  };
}
export type WorkspaceNavigationHost = ReturnType<
  typeof useWorkspaceNavigationHost
>;

/** Render this zero-DOM sibling before the private tree: React commits sibling
 * layout effects in order, including StrictMode cleanup/replay. No protected
 * projection is read or retained by this lifetime registration. */
export function NavigationHostLifetime({
  host,
}: {
  host: Pick<WorkspaceNavigationHost, "activate" | "retire">;
}) {
  useLayoutEffect(() => {
    host.activate();
    return host.retire;
  }, []);
  return null;
}

// Ordinary private UI callbacks must keep their old unmount semantics. This
// lifetime does not invalidate Host intents on a same-identity permission clear.
export function useWorkspaceNavigationOrigin(
  host: Pick<WorkspaceNavigationHost, "isCurrentHost">,
) {
  const lifetime = useRef({ active: false, incarnation: 0 });
  function activate() {
    lifetime.current.active = true;
    lifetime.current.incarnation++;
  }
  function retire() {
    lifetime.current.active = false;
    lifetime.current.incarnation++;
  }
  function isActive() {
    return lifetime.current.active && host.isCurrentHost();
  }
  function capturePrivateCommit(): CurrentDestination {
    const incarnation = lifetime.current.incarnation;
    return () =>
      lifetime.current.active && lifetime.current.incarnation === incarnation;
  }
  return { isActive, capturePrivateCommit, activate, retire };
}
export type WorkspaceNavigationOrigin = ReturnType<
  typeof useWorkspaceNavigationOrigin
>;

/** The same sibling-layout ordering as the Host, but this lease retires with
 * every protected-tree removal, including same-identity permission refresh. */
export function NavigationOriginLifetime({
  origin,
}: {
  origin: Pick<WorkspaceNavigationOrigin, "activate" | "retire">;
}) {
  useLayoutEffect(() => {
    origin.activate();
    return origin.retire;
  }, []);
  return null;
}
