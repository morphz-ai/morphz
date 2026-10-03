import type { ReactNode, Ref } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  MessageSquareText,
} from "lucide-react";
import { SidebarToggle } from "../SidebarToggle.js";
import type { WorkSurfaceView } from "../host/work-surface.js";

/** Read-only chrome facts, not a workspace, preference writer or navigation owner. */
export type WorkspaceTopbarView = Readonly<{
  applicationWorkspaceOpen: boolean;
  view: WorkSurfaceView;
  viewLabel: string;
  projectTitle: string;
  projectOpen: boolean;
  artifact: Readonly<{ title: string; kind: string }> | null;
  openingObject: boolean;
  creating: "document" | "project" | null;
  collaborationVisible: boolean;
}>;

export type WorkspaceToolbarSlots = Readonly<{
  application: Ref<HTMLDivElement>;
  page: Ref<HTMLDivElement>;
  detail: Ref<HTMLDivElement>;
}>;

/** One persistent native header and three persistent portal destinations.
 * The Host retains the original ref registrations and command implementations. */
export function WorkspaceTopbar({
  view,
  history,
  sidebarExpanded,
  slots,
  projectControls,
  onToggleSidebar,
  onTravel,
  onNavigateView,
  onOpenProject,
  onToggleCollaboration,
}: {
  view: WorkspaceTopbarView;
  history: Readonly<{ index: number; length: number }>;
  sidebarExpanded: boolean;
  slots: WorkspaceToolbarSlots;
  projectControls: ReactNode;
  onToggleSidebar: () => void;
  onTravel: (direction: -1 | 1) => void;
  onNavigateView: () => void;
  onOpenProject: () => void;
  onToggleCollaboration: () => void;
}) {
  return (
    <header
      className="topbar"
      aria-label={`${view.applicationWorkspaceOpen ? view.projectTitle : view.viewLabel}工具栏`}
    >
      <SidebarToggle
        className="sidebar-toggle"
        side="left"
        expanded={sidebarExpanded}
        controls="workspace-sidebar"
        onClick={onToggleSidebar}
      />
      <div className="navigation-history" role="group" aria-label="浏览位置">
        <button
          className="icon-button"
          aria-label="返回上一位置"
          title="后退 · ⌘[ / Alt+←"
          disabled={history.index <= 0}
          onClick={() => onTravel(-1)}
        >
          <ArrowLeft />
        </button>
        <button
          className="icon-button"
          aria-label="前往下一位置"
          title="前进 · ⌘] / Alt+→"
          disabled={history.index >= history.length - 1}
          onClick={() => onTravel(1)}
        >
          <ArrowRight />
        </button>
      </div>
      <div
        className="application-toolbar-slot"
        ref={slots.application}
        hidden={!view.applicationWorkspaceOpen}
      />
      {!view.applicationWorkspaceOpen && view.artifact?.kind === "task" ? (
        <div className="breadcrumb task-breadcrumb">
          <button onClick={onNavigateView}>{view.viewLabel}</button>
          <ChevronRight />
          <h1 className="toolbar-title">{view.artifact.title}</h1>
        </div>
      ) : (
        !view.applicationWorkspaceOpen && (
          <div className="breadcrumb">
            <h1 className="toolbar-title">
              {view.artifact ? (
                <button onClick={onNavigateView}>{view.viewLabel}</button>
              ) : (
                view.viewLabel
              )}
            </h1>
            {view.view === "projects" && view.projectOpen && (
              <>
                <ChevronRight />
                <button onClick={onOpenProject}>{view.projectTitle}</button>
                {projectControls}
              </>
            )}
            {view.artifact && (
              <>
                <ChevronRight />
                <strong>{view.artifact.title}</strong>
              </>
            )}
          </div>
        )
      )}
      <div
        className="page-toolbar-slot"
        ref={slots.page}
        hidden={view.applicationWorkspaceOpen || !!view.artifact}
      ></div>
      <div
        className="detail-toolbar-slot"
        ref={slots.detail}
        hidden={
          view.openingObject || (!view.artifact && view.creating !== "document")
        }
      />
      <div className="top-actions">
        {view.artifact && (
          <button
            className="icon-button collaboration-panel-toggle"
            aria-label={view.collaborationVisible ? "收起批注栏" : "展开批注栏"}
            title={view.artifact ? "对象批注" : "打开对象后查看批注"}
            disabled={!view.artifact}
            aria-pressed={view.collaborationVisible}
            onClick={onToggleCollaboration}
          >
            <MessageSquareText />
          </button>
        )}
      </div>
    </header>
  );
}
