import React, { type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  MessageSquareText,
} from "lucide-react";
import { SidebarToggle } from "../../apps/web/src/SidebarToggle.js";
import type { WorkspaceToolbarSlots } from "../../apps/web/src/shell/WorkspaceTopbar.js";

export type TopbarScenario = {
  applicationWorkspaceOpen: boolean;
  prefs: {
    view: "dialogue" | "inbox" | "content" | "desk" | "projects";
    sidebar: boolean;
    projectOpen: boolean;
  };
  project: { title: string };
  artifact: { title: string; content: { kind: string } } | null;
  openingObject: boolean;
  creating: "document" | "project" | null;
  collaborationVisible: boolean;
  history: { index: number; length: number };
};
export type TopbarActions = {
  onToggleSidebar: () => void;
  onTravel: (direction: -1 | 1) => void;
  onNavigateView: () => void;
  onOpenProject: () => void;
  onToggleCollaboration: () => void;
};
export const topbarLabels = {
  dialogue: "对话",
  inbox: "事项",
  content: "内容库",
  desk: "工作台",
  projects: "项目",
};
export const initialTopbarScenario: TopbarScenario = {
  applicationWorkspaceOpen: false,
  prefs: { view: "desk", sidebar: true, projectOpen: false },
  project: { title: "项目 A" },
  artifact: null,
  openingObject: false,
  creating: null,
  collaborationVisible: false,
  history: { index: 1, length: 3 },
};

/** Frozen App.tsx:2228–2340 at HEAD 55988f3a. Only Host command closures,
 * direct setter refs and the ProjectMenu leaf are supplied by the fixture;
 * branch/DOM/attribute expressions are independent of the candidate owner. */
export function OriginalWorkspaceTopbar({
  scenario,
  slots,
  projectControls,
  actions,
}: {
  scenario: TopbarScenario;
  slots: WorkspaceToolbarSlots;
  projectControls: ReactNode;
  actions: TopbarActions;
}) {
  const {
    applicationWorkspaceOpen,
    prefs,
    project,
    artifact,
    openingObject,
    creating,
    collaborationVisible,
  } = scenario;
  const labels = topbarLabels;
  const setToolbarTarget = slots.application,
    setPageToolbarTarget = slots.page,
    setDetailToolbarTarget = slots.detail;
  const trail = {
    current: {
      index: scenario.history.index,
      places: Array.from({ length: scenario.history.length }),
    },
  };
  return React.createElement(
    React.Fragment,
    null,
    <header
      className="topbar"
      aria-label={`${applicationWorkspaceOpen ? project.title : labels[prefs.view]}工具栏`}
    >
      <SidebarToggle
        className="sidebar-toggle"
        side="left"
        expanded={prefs.sidebar}
        controls="workspace-sidebar"
        onClick={actions.onToggleSidebar}
      />
      <div className="navigation-history" role="group" aria-label="浏览位置">
        <button
          className="icon-button"
          aria-label="返回上一位置"
          title="后退 · ⌘[ / Alt+←"
          disabled={trail.current.index <= 0}
          onClick={() => actions.onTravel(-1)}
        >
          <ArrowLeft />
        </button>
        <button
          className="icon-button"
          aria-label="前往下一位置"
          title="前进 · ⌘] / Alt+→"
          disabled={trail.current.index >= trail.current.places.length - 1}
          onClick={() => actions.onTravel(1)}
        >
          <ArrowRight />
        </button>
      </div>
      <div
        className="application-toolbar-slot"
        ref={setToolbarTarget}
        hidden={!applicationWorkspaceOpen}
      />
      {!applicationWorkspaceOpen && artifact?.content.kind === "task" ? (
        <div className="breadcrumb task-breadcrumb">
          <button onClick={actions.onNavigateView}>{labels[prefs.view]}</button>
          <ChevronRight />
          <h1 className="toolbar-title">{artifact.title}</h1>
        </div>
      ) : (
        !applicationWorkspaceOpen && (
          <div className="breadcrumb">
            <h1 className="toolbar-title">
              {artifact ? (
                <button onClick={actions.onNavigateView}>
                  {labels[prefs.view]}
                </button>
              ) : (
                labels[prefs.view]
              )}
            </h1>
            {prefs.view === "projects" && prefs.projectOpen && (
              <>
                <ChevronRight />
                <button onClick={actions.onOpenProject}>{project.title}</button>
                {projectControls}
              </>
            )}
            {artifact && (
              <>
                <ChevronRight />
                <strong>{artifact.title}</strong>
              </>
            )}
          </div>
        )
      )}
      <div
        className="page-toolbar-slot"
        ref={setPageToolbarTarget}
        hidden={applicationWorkspaceOpen || !!artifact}
      ></div>
      <div
        className="detail-toolbar-slot"
        ref={setDetailToolbarTarget}
        hidden={openingObject || (!artifact && creating !== "document")}
      />
      <div className="top-actions">
        {artifact && (
          <button
            className="icon-button collaboration-panel-toggle"
            aria-label={collaborationVisible ? "收起批注栏" : "展开批注栏"}
            title={artifact ? "对象批注" : "打开对象后查看批注"}
            disabled={!artifact}
            aria-pressed={collaborationVisible}
            onClick={actions.onToggleCollaboration}
          >
            <MessageSquareText />
          </button>
        )}
      </div>
    </header>,
  );
}
