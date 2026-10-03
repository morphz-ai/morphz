import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { WorkspaceTopbar } from "../../apps/web/src/shell/WorkspaceTopbar.js";
import {
  OriginalWorkspaceTopbar,
  initialTopbarScenario,
  topbarLabels,
  type TopbarScenario,
} from "./workspace-topbar-baseline.js";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/ui.css";
import "../../apps/web/src/visual-system.css";
import "../../apps/web/src/inspector.css";

const baseline = new URLSearchParams(location.search).has("baseline");
const events: string[] = [],
  mounts: Record<string, number> = {},
  cleanups: Record<string, number> = {},
  remembered = new Map<string, Element>();
let command: (patch: Partial<TopbarScenario>) => void, current: TopbarScenario;
let removeHeader: () => void,
  targetsConnected = false;
const actions = {
  onToggleSidebar: () => events.push("sidebar"),
  onTravel: (direction: -1 | 1) => events.push(`travel:${direction}`),
  onNavigateView: () => events.push("view"),
  onOpenProject: () => events.push("project"),
  onToggleCollaboration: () => events.push("collaboration"),
};
function PortalTool({ name }: { name: string }) {
  const [value, setValue] = useState("original " + name);
  useEffect(() => {
    mounts[name] = (mounts[name] ?? 0) + 1;
    return () => {
      cleanups[name] = (cleanups[name] ?? 0) + 1;
    };
  }, []);
  return (
    <div
      className={
        name === "application" ? "application-strip" : "object-toolbar"
      }
    >
      <input
        data-portal-input={name}
        aria-label={`${name} input`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="button"
        data-portal-button={name}
        onClick={() => events.push(`portal:${name}`)}
      >
        工具
      </button>
    </div>
  );
}
function Fixture() {
  const [scenario, setScenario] = useState(initialTopbarScenario);
  const [mounted, setMounted] = useState(true);
  const [application, setApplication] = useState<HTMLDivElement | null>(null),
    [page, setPage] = useState<HTMLDivElement | null>(null),
    [detail, setDetail] = useState<HTMLDivElement | null>(null);
  current = scenario;
  targetsConnected = !!(application && page && detail);
  removeHeader = () => flushSync(() => setMounted(false));
  command = (patch) =>
    flushSync(() => setScenario((previous) => ({ ...previous, ...patch })));
  // These are the same three stable state-setter refs as the Host seam. The
  // slots object may be new each render; its ref fields must pass through raw.
  const slots = {
    application: setApplication,
    page: setPage,
    detail: setDetail,
  };
  const projectControls = (
    <button
      type="button"
      data-project-controls
      onClick={() => events.push("project-menu")}
    >
      项目菜单
    </button>
  );
  const topbar = baseline ? (
    <OriginalWorkspaceTopbar
      scenario={scenario}
      slots={slots}
      projectControls={projectControls}
      actions={actions}
    />
  ) : (
    <WorkspaceTopbar
      view={{
        applicationWorkspaceOpen: scenario.applicationWorkspaceOpen,
        view: scenario.prefs.view,
        viewLabel: topbarLabels[scenario.prefs.view],
        projectTitle: scenario.project.title,
        projectOpen: scenario.prefs.projectOpen,
        artifact: scenario.artifact
          ? {
              title: scenario.artifact.title,
              kind: scenario.artifact.content.kind,
            }
          : null,
        openingObject: scenario.openingObject,
        creating: scenario.creating,
        collaborationVisible: scenario.collaborationVisible,
      }}
      history={scenario.history}
      sidebarExpanded={scenario.prefs.sidebar}
      slots={slots}
      projectControls={projectControls}
      {...actions}
    />
  );
  return (
    <div
      className="app sidebar-hidden without-collaboration"
      data-accent="teal"
      data-appearance="light"
    >
      <div className="workspace">
        {mounted && topbar}
        <div className="workspace-inspector-controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Inspector fixture"
          >
            右栏
          </button>
        </div>
        <div className="workspace-body">
          <main aria-label="Fixture canvas">
            <button id="outside">Outside</button>
          </main>
        </div>
        {application &&
          createPortal(<PortalTool name="application" />, application)}
        {page && createPortal(<PortalTool name="page" />, page)}
        {detail && createPortal(<PortalTool name="detail" />, detail)}
      </div>
    </div>
  );
}
Reflect.set(window, "topbarFixture", {
  run(patch: Partial<TopbarScenario>) {
    command(patch);
  },
  remember(selector: string, key: string) {
    const node = document.querySelector(selector);
    if (!node) throw new Error("Missing node: " + selector);
    remembered.set(key, node);
  },
  same(selector: string, key: string) {
    return remembered.get(key) === document.querySelector(selector);
  },
  report() {
    return {
      scenario: current,
      events: [...events],
      mounts: { ...mounts },
      cleanups: { ...cleanups },
      active:
        (document.activeElement as HTMLElement)?.dataset.portalInput ??
        document.activeElement?.id,
      ready: document.querySelectorAll("[data-portal-input]").length === 3,
    };
  },
  clearEvents() {
    events.length = 0;
  },
  closeHeader() {
    removeHeader();
  },
  targetsConnected() {
    return targetsConnected;
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
