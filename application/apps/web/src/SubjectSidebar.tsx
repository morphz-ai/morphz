import { useRef, type ReactNode } from "react";
import {
  List,
  ShieldCheck,
  Clock3,
  SlidersHorizontal,
  ArrowLeft,
  Settings2,
  FolderKey,
} from "lucide-react";
import { BrandMark } from "./BrandMark.js";
import { InspectorPanel } from "./InspectorPanel.js";
import type { InspectorLayout } from "./inspector-layout.js";
import type { WorkspaceClient } from "./client.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import type { DirectoryState } from "./AgentDirectories.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { SubjectSchedules } from "./SubjectSchedules.js";
import { subjectStatus, type SubjectView } from "./subject-sidebar-model.js";
import "./subject-sidebar.css";

const tabs = [
  { id: "activity", label: "活动", icon: List },
  { id: "permissions", label: "授权", icon: ShieldCheck },
  { id: "schedules", label: "安排", icon: Clock3 },
  { id: "settings", label: "设定", icon: BrandMark },
] as const;

export function SubjectSidebar({
  client,
  view,
  onView,
  layout,
  onResize,
  onClose,
  detail,
  onBack,
  activity,
  onInspect,
  onOpen,
  onModels,
  onConnection,
  directories,
  directoryScope,
  directoryAvailable,
  onDirectories,
}: {
  client: WorkspaceClient;
  view: SubjectView;
  onView(view: SubjectView): void;
  layout: InspectorLayout;
  onResize(width: number): void;
  onClose(): void;
  detail: boolean;
  onBack(): void;
  activity: ReactNode;
  onInspect(scope: ExecutionScope): void;
  onOpen(id: string): void;
  onModels?: () => void;
  onConnection(): void;
  directories: DirectoryState;
  directoryScope: string;
  directoryAvailable: boolean;
  onDirectories(): void;
}) {
  const bar = useRef<HTMLDivElement>(null),
    boot = client.boot!,
    runtime = boot.runtime;
  const subject = boot.workspace.actants.find(
    (actor) => actor.kind === "agent",
  );
  const attention = runtime.attention;
  const permissionsReady =
    directories.scope === directoryScope && directories.ready;
  return (
    <InspectorPanel
      className="subject-sidebar"
      label="Morphz 信息"
      focusOnMount={false}
      title={subject?.name ?? "Morphz"}
      resizeLabel="调整 Morphz 信息栏宽度"
      layout={layout}
      onResize={onResize}
      onClose={onClose}
      headerContent={
        <div
          className="subject-tabs"
          role="tablist"
          aria-label="Morphz 信息分类"
          ref={bar}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const index = tabs.findIndex((tab) => tab.id === view);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowLeft" ? -1 : 1) +
                      tabs.length) %
                    tabs.length;
            onView(tabs[next]!.id);
            bar.current
              ?.querySelector<HTMLButtonElement>(
                `[data-view="${tabs[next]!.id}"]`,
              )
              ?.focus();
          }}
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              data-view={id}
              role="tab"
              id={`subject-tab-${id}`}
              aria-label={label}
              title={
                id === "activity"
                  ? `${label} · ${subjectStatus(runtime, client.online)}`
                  : label
              }
              aria-selected={view === id}
              aria-controls={`subject-view-${id}`}
              tabIndex={view === id ? 0 : -1}
              onClick={() => onView(id)}
            >
              <Icon />
            </button>
          ))}
        </div>
      }
    >
      {detail && view === "activity" && (
        <button
          className="subject-back"
          aria-label="返回活动列表"
          onClick={onBack}
        >
          <ArrowLeft />
          活动
        </button>
      )}
      <div
        role="tabpanel"
        id={`subject-view-${view}`}
        aria-labelledby={`subject-tab-${view}`}
        className="subject-content"
      >
        {view === "activity" && activity}
        {view === "permissions" && (
          <section className="subject-section">
            <h3>授权</h3>
            {!client.online || !runtime.connected || !attention?.available ? (
              <p className="muted">审批状态待核对</p>
            ) : attention.approvals.length ? (
              attention.approvals.map((entry) => (
                <ApprovalCard
                  key={entry.approval.fingerprint}
                  entry={entry}
                  client={client}
                  available={
                    client.online && runtime.connected && attention.available
                  }
                  origin={
                    boot.workspace.projects.find(
                      (p) => p.id === entry.scope.projectId,
                    )?.title
                  }
                  onInspect={() => onInspect(entry.scope)}
                />
              ))
            ) : (
              <p className="muted">没有待审批请求</p>
            )}
            {directoryAvailable && (
              <div className="subject-permissions">
                <h4>
                  <FolderKey />
                  当前对话的目录权限
                </h4>
                {permissionsReady &&
                  directories.grants.map((grant) => (
                    <p key={grant.grantId} title={grant.path}>
                      {grant.name}
                      <small>可读写</small>
                    </p>
                  ))}
                <button onClick={onDirectories}>查看和管理目录授权</button>
              </div>
            )}
          </section>
        )}
        {view === "schedules" && (
          <SubjectSchedules
            client={client}
            onOpen={onOpen}
            onInspect={onInspect}
          />
        )}
        {view === "settings" && (
          <section className="subject-section subject-settings">
            <h3>设定</h3>
            <dl>
              <dt>名字</dt>
              <dd>{subject?.name ?? "Morphz"}</dd>
              <dt>默认模型</dt>
              <dd>{runtime.model || "尚未配置"}</dd>
            </dl>
            {onModels && (
              <button onClick={onModels}>
                <Settings2 />
                模型与账号
              </button>
            )}
            <button onClick={onConnection}>
              <SlidersHorizontal />
              智能体连接
            </button>
            {runtime.harnesses?.length ? (
              <details>
                <summary>已安装执行方式</summary>
                {runtime.harnesses.map((h) => (
                  <p key={`${h.id}:${h.version}`}>
                    {h.id}
                    <small>{h.version}</small>
                  </p>
                ))}
              </details>
            ) : null}
          </section>
        )}
      </div>
    </InspectorPanel>
  );
}
