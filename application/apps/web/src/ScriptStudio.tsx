import { useState } from "react";
import type { ScriptLocation } from "../../../packages/core/src/script-delivery.js";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FilePlus2,
  Folder,
  PanelLeft,
  Sparkles,
  Settings2,
  X,
} from "lucide-react";
import type { ApplicationInstance } from "../../../packages/core/src/applications.js";
import {
  emptyScriptDraft,
  scriptItemKinds,
  scriptKindLabels,
  scriptStructureIssues,
  scriptImpact,
  type ScriptGeneration,
  type ScriptItem,
} from "../../../packages/core/src/script-studio.js";
import { contentOwnershipTitle } from "../../../packages/core/src/content.js";
import { ContentMetadata } from "./ContentMetadata.js";
import type { WorkspaceClient } from "./client.js";
import { StudioDialog } from "./features/script/StudioDialog.js";
import { ScriptItemEditor } from "./ScriptStudioEditor.js";
import {
  scriptDisplayTime,
  scriptStatusLabels,
} from "../../../packages/core/src/script-studio-presentation.js";
import type { ScriptEditorProduction } from "./script-editor-reader.js";
import type { ScriptDirectoryItem } from "../../../packages/core/src/script-editor.js";
import {
  ScriptStudioNavigation,
  scriptCreateLabels,
} from "./ScriptStudioNavigation.js";
import "./script-studio.css";
import { ScriptStudioLibrary } from "./ScriptStudioLibrary.js";
import { ComposerOptions, type ComposerOption } from "./ComposerOptions.js";
import {
  useScriptStudioWorkspace,
  type ScriptRun,
} from "./features/script/useScriptStudioWorkspace.js";

type Props = {
  client: WorkspaceClient;
  instance: ApplicationInstance;
  activeView: boolean;
  locationRequest?: ScriptLocation & {
    requestId: string;
    view?: "library" | "editor";
  };
  onNavigate?: (
    productionId: string,
    itemId: string,
    view: "library" | "editor",
  ) => void;
  onCompose: (
    text: string,
    generation?: ScriptGeneration,
  ) => ScriptComposeResult;
  onConceive: () => void;
  globalLibrary?: boolean;
  onOpenScript: (id: string, itemId?: string) => void;
  onLibrary: () => void;
  onNotice: (text: string) => void;
  onNativeDialog?: (open: boolean) => void;
};
export type ScriptComposeResult = { ok: true } | { ok: false; error: string };
export type { ScriptRun } from "./features/script/useScriptStudioWorkspace.js";
export { StudioDialog } from "./features/script/StudioDialog.js";
export { scriptStatusLabels } from "../../../packages/core/src/script-studio-presentation.js";

export function ScriptStudio({
  client,
  instance,
  activeView,
  locationRequest,
  onNavigate,
  onCompose,
  onConceive,
  globalLibrary = false,
  onOpenScript,
  onLibrary,
  onNotice,
  onNativeDialog,
}: Props) {
  const {
    boot,
    space,
    productionId,
    itemId,
    query,
    organizing,
    dialog,
    createDefaults,
    error,
    busy,
    saving,
    exportStatus,
    directoryId,
    compactDirectory,
    directoryOpen,
    historyOpen,
    exportSelection,
    editorRead,
    production,
    issuesOpen,
    reviewRead,
    issues,
    exportRead,
    item,
    sorted,
    library,
    canWrite,
    executionIssue,
    deliveryTarget,
    studio,
    directoryTrigger,
    exportTrigger,
    exportHistory,
    choose,
    showLibrary,
    closeDirectory,
    openCreate,
    run,
    restoreEditorFocus,
    download,
    toggleDirectory,
    openOrganization,
    openProductionDialog,
    openSettingsDialog,
    beginExport,
    showExportHistory,
    closeExportStatus,
    libraryReady,
    openLibraryProduction,
    issuesToggle,
    historyToggle,
    closeOrganization,
    organizationSaved,
    closeDialog,
    submitProduction,
    itemCreated,
    closeExportSelection,
    submitExport,
    queryChanged,
  } = useScriptStudioWorkspace({
    client,
    instance,
    activeView,
    locationRequest,
    onNavigate,
    globalLibrary,
    onOpenScript,
    onLibrary,
    onNotice,
    onNativeDialog,
  });
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const studioOptions: ComposerOption[] = [
    {
      label: "剧本设置",
      icon: <Settings2 />,
      onSelect: openSettingsDialog,
      disabled: !canWrite,
    },
    {
      label: "设置项目",
      text: contentOwnershipTitle(space),
      icon: <Folder />,
      onSelect: openOrganization,
      disabled: !canWrite,
    },
    {
      label: "构思新剧",
      icon: <Sparkles />,
      onSelect: onConceive,
      disabled: !canWrite,
    },
    {
      label: "手动新建剧本",
      icon: <FilePlus2 />,
      onSelect: openProductionDialog,
      disabled: !canWrite,
    },
  ];
  return (
    <section
      ref={studio}
      className="script-studio"
      aria-label="剧本工作区"
      aria-busy={busy}
    >
      <header className="script-toolbar" data-library={library || undefined}>
        {!library && (
          <button
            ref={directoryTrigger}
            type="button"
            className="script-directory-toggle"
            aria-label="剧本目录开关"
            aria-expanded={directoryOpen}
            aria-controls={directoryId}
            title={`${directoryOpen ? "收起" : "展开"}目录 · ${item ? item.title : "概览"}`}
            onClick={toggleDirectory}
          >
            <PanelLeft />
          </button>
        )}
        {!library && (
          <button
            type="button"
            className="icon-button script-library-back"
            aria-label="全部剧本"
            title="全部剧本"
            onClick={showLibrary}
            disabled={!activeView || busy || saving}
          >
            <ArrowLeft />
          </button>
        )}
        <div className="script-location">
          <h2
            aria-label={library ? "剧本列表" : "当前剧本"}
            title={
              library
                ? "剧本"
                : `${production?.title ?? ""} · 归属项目：${contentOwnershipTitle(space)}`
            }
            tabIndex={-1}
            data-script-focus-anchor={!item || library || undefined}
          >
            {library ? "剧本" : production?.title}
          </h2>
          {!library && item && (
            <span
              className="script-item-location"
              title={`${scriptKindLabels[item.kind]} · ${item.title}`}
            >
              <ChevronRight aria-hidden="true" />
              <span>{item.title}</span>
            </span>
          )}
          {library ? (
            <span
              className="script-project"
              title={
                library && globalLibrary
                  ? "全部剧本"
                  : `归属项目：${contentOwnershipTitle(space)}`
              }
            >
              <Folder />
              <span>
                {library && globalLibrary
                  ? "全部剧本"
                  : contentOwnershipTitle(space)}
              </span>
            </span>
          ) : null}
        </div>
        {library ? (
          <>
            <button
              type="button"
              className={library ? "primary" : undefined}
              onClick={onConceive}
              disabled={!canWrite}
            >
              构思新剧
            </button>
            <button
              type="button"
              className={library ? "secondary-action" : "icon-button"}
              title="手动新建剧本"
              aria-label="手动新建剧本"
              onClick={openProductionDialog}
              disabled={!canWrite}
            >
              <FilePlus2 />
              {library && <span>手动新建剧本</span>}
            </button>
          </>
        ) : item ? (
          <div className="script-item-controls" ref={setToolbarTarget} />
        ) : production ? (
          <ComposerOptions
            label="剧本选项"
            menuLabel="剧本选项菜单"
            below
            options={studioOptions}
          />
        ) : null}
        {!library && production && (
          <button
            ref={exportTrigger}
            type="button"
            className="icon-button"
            aria-label="导出 Word"
            title="导出 Word"
            disabled={!canWrite}
            onClick={beginExport}
          >
            <Download />
          </button>
        )}
      </header>
      {!library &&
        exportStatus?.productionId === production?.id &&
        exportStatus && (
          <div className="script-export-status" role="status">
            <span>{exportStatus.message}</span>
            <button
              type="button"
              className="text-button"
              onClick={showExportHistory}
            >
              查看导出历史
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭导出提示"
              title="关闭导出提示"
              onClick={closeExportStatus}
            >
              <X />
            </button>
          </div>
        )}
      {executionIssue && (
        <p className="script-warning" role="status">
          {executionIssue} 手动编辑不受影响。
        </p>
      )}
      {(error ||
        (issuesOpen && reviewRead.error) ||
        (historyOpen && exportRead.error)) && (
        <p className="script-error" role="alert">
          {error ||
            (issuesOpen && reviewRead.error) ||
            (historyOpen && exportRead.error)}
        </p>
      )}
      {library ? (
        <ScriptStudioLibrary
          client={client}
          projectId={instance.workspaceId}
          projects={boot.workspace.projects}
          global={globalLibrary}
          lastOpenedId={productionId}
          query={query}
          onQuery={queryChanged}
          onReady={libraryReady}
          disabled={!activeView || busy || saving}
          onOpen={openLibraryProduction}
        />
      ) : !production ? (
        <p className="script-hint" role={editorRead.error ? "alert" : "status"}>
          {editorRead.error || "正在打开剧本…"}
        </p>
      ) : (
        <div
          className="script-layout"
          data-directory-open={directoryOpen}
          data-compact={compactDirectory}
        >
          <ScriptStudioNavigation
            key={`${boot.centerId}:${boot.principalId}:${instance.id}:${production.id}`}
            items={production.items}
            itemId={itemId}
            storageScope={`${boot.centerId}:${boot.principalId}`}
            locationKey={`script-directory:${instance.id}:${production.id}`}
            directoryId={directoryId}
            open={directoryOpen}
            compact={compactDirectory}
            onClose={closeDirectory}
            canWrite={canWrite}
            onChoose={(id) => choose(production.id, id)}
            onCreate={openCreate}
            onNotice={onNotice}
          />
          <div className="script-main">
            {item ? (
              <ScriptItemEditor
                key={`${boot.centerId}:${boot.principalId}:${production.id}:${item.id}`}
                client={client}
                production={production}
                item={item}
                deliveryTarget={
                  deliveryTarget?.itemId === item.id
                    ? deliveryTarget
                    : undefined
                }
                run={run}
                canWrite={canWrite}
                onCompose={onCompose}
                onReady={restoreEditorFocus}
                toolbarTarget={toolbarTarget}
                studioOptions={studioOptions}
              />
            ) : (
              <div className="script-overview">
                <section className="script-writing-start" aria-label="创作入口">
                  <header>
                    <h2>
                      {production.items.some(
                        (value) =>
                          value.kind === "episode" || value.kind === "outline",
                      )
                        ? "继续创作"
                        : "开始创作"}
                    </h2>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={!canWrite}
                      onClick={() => openCreate("episode")}
                    >
                      新建一集
                    </button>
                  </header>
                  {sorted.some(
                    (value) =>
                      value.kind === "episode" || value.kind === "outline",
                  ) ? (
                    <div className="script-writing-list">
                      {sorted
                        .filter(
                          (value) =>
                            value.kind === "outline" ||
                            value.kind === "episode",
                        )
                        .map((value) => (
                          <button
                            type="button"
                            key={value.id}
                            onClick={() => choose(production.id, value.id)}
                            title={value.title}
                          >
                            <span>{value.title}</span>
                            <small>
                              {scriptKindLabels[value.kind]} ·{" "}
                              {scriptStatusLabels[value.status]}
                            </small>
                          </button>
                        ))}
                    </div>
                  ) : (
                    <p className="script-hint">
                      从任意一集开始，也可以先
                      <button
                        type="button"
                        className="text-button"
                        disabled={!canWrite}
                        onClick={() => openCreate("outline")}
                      >
                        写全剧大纲
                      </button>
                      。设定、角色和资料可随时补充。
                    </p>
                  )}
                </section>
                <section className="script-brief" aria-label="创作简报">
                  <header>
                    <h2>创作简报</h2>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={!canWrite}
                      onClick={openSettingsDialog}
                    >
                      编辑简报
                    </button>
                  </header>
                  <p className="script-brief-format">
                    {production.brief.mode === "adaptation" ? "改编" : "原创"} ·{" "}
                    {production.brief.episodeCount} 集 · 每集{" "}
                    {production.brief.episodeSeconds} 秒
                  </p>
                  <dl>
                    {(
                      [
                        ["题材", production.brief.genre],
                        ["受众", production.brief.audience],
                        ["风格", production.brief.style],
                        ["创作限制", production.brief.constraints],
                      ] as const
                    )
                      .filter(([, value]) => value.trim())
                      .map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                  </dl>
                  {!production.brief.genre &&
                    !production.brief.audience &&
                    !production.brief.style &&
                    !production.brief.constraints && (
                      <p className="script-hint">
                        可补充题材、受众、风格与制作限制；不影响先写正文。
                      </p>
                    )}
                  <button
                    type="button"
                    className="text-button script-permission"
                    disabled={!canWrite}
                    onClick={openSettingsDialog}
                  >
                    资料来源与使用说明：查看
                  </button>
                </section>
                <details
                  className="script-overview-details"
                  key={`issues:${production.id}`}
                  onToggle={issuesToggle}
                >
                  <summary>
                    结构检查与修改影响（
                    {issues.length +
                      (reviewRead.value
                        ? 0
                        : production.items.reduce(
                            (sum, item) => sum + item.blockingReviewCount,
                            0,
                          ))}
                    ）
                  </summary>
                  <small>
                    仅检查版本依赖、分集归属和阻断意见，不代表戏剧质量审查。
                  </small>
                  {issues.map((issue, n) => (
                    <p key={n}>
                      <button
                        type="button"
                        onClick={() => choose(production.id, issue.itemId)}
                      >
                        {issue.message}
                      </button>
                    </p>
                  ))}
                  {production.items
                    .filter(
                      (i) =>
                        scriptImpact(
                          { head: production, items: production.items },
                          [i.id],
                        ).length,
                    )
                    .map((i) => (
                      <p key={i.id}>
                        {i.title} →{" "}
                        {scriptImpact(
                          { head: production, items: production.items },
                          [i.id],
                        )
                          .map(
                            (id) =>
                              production.items.find((x) => x.id === id)!.title,
                          )
                          .join("、")}
                      </p>
                    ))}
                </details>
                <details
                  className="script-overview-details"
                  key={`exports:${production.id}`}
                  ref={exportHistory}
                  open={historyOpen}
                  onToggle={historyToggle}
                >
                  <summary>导出历史（{production.totals.exports}）</summary>
                  <small>
                    按保存的版本和模板重新生成；不代表制作方已收到。
                  </small>
                  {(exportRead.value ?? []).map((record) => (
                    <article className="script-export-record" key={record.id}>
                      <time>{scriptDisplayTime(record.createdAt)}</time>
                      <small>
                        {" "}
                        · {record.workingCopy ? "创作文稿" : "正式交付"}
                      </small>
                      <p>{record.titles.join("；")}</p>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={!canWrite}
                        onClick={(event) =>
                          void download(
                            production,
                            record.id,
                            event.currentTarget,
                          )
                        }
                      >
                        重新下载
                      </button>
                      <details>
                        <summary>追溯信息</summary>
                        <small>
                          导出记录：{record.id} · 剧本规范 v
                          {record.contextRevision}
                        </small>
                      </details>
                    </article>
                  ))}
                </details>
              </div>
            )}
          </div>
        </div>
      )}
      {organizing && (
        <ContentMetadata
          entry={organizing}
          projects={boot.workspace.projects}
          client={client}
          mode="move"
          onClose={closeOrganization}
          onSaved={organizationSaved}
        />
      )}
      {dialog === "production" && (
        <CreateDialog
          title="手动新建剧本"
          onClose={closeDialog}
          onSubmit={submitProduction}
        />
      )}
      {dialog === "item" && production && (
        <CreateItemDialog
          production={production}
          initialKind={createDefaults.kind}
          initialParent={createDefaults.parentId}
          run={run}
          onClose={closeDialog}
          onCreated={itemCreated}
        />
      )}
      {dialog === "settings" && production && (
        <ProductionSettings
          key={production.id}
          production={production}
          client={client}
          run={run}
          onClose={closeDialog}
        />
      )}
      {exportSelection && (
        <ExportDialog
          production={exportSelection.production}
          onClose={closeExportSelection}
          onSubmit={submitExport}
        />
      )}
    </section>
  );
}
function ExportDialog({
  production,
  onClose,
  onSubmit,
}: {
  production: ScriptEditorProduction;
  onClose: () => void;
  onSubmit: (
    selection: { itemId: string; revision: number }[],
    workingCopy: boolean,
  ) => void;
}) {
  const [workingCopy, setWorkingCopy] = useState(true);
  const items = production.items
    .filter((i) => i.kind === "episode" || i.kind === "scene")
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const issues = scriptStructureIssues({
    head: production,
    items: production.items,
  });
  const ready = (item: ScriptDirectoryItem) =>
    item.status === "locked" &&
    !!item.approval &&
    item.approvalCurrent &&
    item.blockingReviewCount === 0 &&
    !issues.some((issue) => issue.itemId === item.id) &&
    item.dependencies.every((ref) => {
      const dependency = production.items.find((i) => i.id === ref.itemId);
      return (
        !!dependency?.approval &&
        dependency.approval.revision === ref.revision &&
        dependency.approvalCurrent
      );
    });
  const deliveryEligible = new Set(
    items
      .filter(
        (item) =>
          ready(item) &&
          (item.kind !== "scene" ||
            items.some(
              (parent) => parent.id === item.parentId && ready(parent),
            )),
      )
      .map((i) => i.id),
  );
  const copyEligible = new Set(
    items
      .filter(
        (item) =>
          item.hasText ||
          (item.kind === "episode" &&
            items.some((child) => child.parentId === item.id && child.hasText)),
      )
      .map((item) => item.id),
  );
  const eligible = workingCopy ? copyEligible : deliveryEligible;
  const [selected, setSelected] = useState(() => new Set(copyEligible));
  return (
    <StudioDialog title="导出 Word" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.size)
            onSubmit(
              items
                .filter((i) => selected.has(i.id))
                .map((i) => ({ itemId: i.id, revision: i.revision })),
              workingCopy,
            );
        }}
      >
        <label>
          导出用途
          <select
            aria-label="导出用途"
            value={workingCopy ? "working-copy" : "delivery"}
            onChange={(event) => {
              const copy = event.target.value === "working-copy";
              setWorkingCopy(copy);
              setSelected(new Set(copy ? copyEligible : deliveryEligible));
            }}
          >
            <option value="working-copy">创作文稿 · 无需审阅</option>
            <option value="delivery">正式交付 · 仅已审阅锁稿版本</option>
          </select>
        </label>
        <p className="script-hint">
          {workingCopy
            ? "导出已保存的正文，不改变文稿状态；文件标记为创作副本，不含本机未保存的修改。"
            : "正式交付只包含审阅有效的锁定稿。"}
          选择分场时同时包含所属集。
        </p>
        <fieldset className="script-export-items">
          <legend>导出内容</legend>
          {items.map((item) => (
            <label key={item.id} className="script-checkbox">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                disabled={!eligible.has(item.id)}
                onChange={(event) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (event.target.checked) {
                      next.add(item.id);
                      const parentId = item.parentId;
                      if (parentId) next.add(parentId);
                    } else {
                      next.delete(item.id);
                      for (const child of items)
                        if (child.parentId === item.id) next.delete(child.id);
                    }
                    return next;
                  })
                }
              />
              {scriptKindLabels[item.kind]} · {item.title} · v{item.revision}
              {!eligible.has(item.id) &&
                (workingCopy ? " · 尚无已保存正文" : " · 需完成审阅锁稿")}
            </label>
          ))}
          {!items.length && <p>尚无分集或分场。</p>}
        </fieldset>
        <footer>
          <button className="primary" type="submit" disabled={!selected.size}>
            导出所选
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
function CreateDialog({
  title,
  onClose,
  onSubmit,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <StudioDialog title={title} onClose={onClose} compact>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(name);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-input-row">
          <input
            aria-label="剧本名称"
            placeholder="剧本名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={180}
            required
          />
          <footer>
            <button
              className="primary"
              type="submit"
              disabled={busy || !name.trim()}
            >
              创建
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={onClose}
            >
              取消
            </button>
          </footer>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </StudioDialog>
  );
}
function CreateItemDialog({
  production,
  initialKind,
  initialParent,
  run,
  onClose,
  onCreated,
}: {
  production: ScriptEditorProduction;
  initialKind: ScriptItem["kind"];
  initialParent?: string;
  run: ScriptRun;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<ScriptItem["kind"]>(initialKind);
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState(initialParent ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <StudioDialog title={scriptCreateLabels[kind]} onClose={onClose} compact>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const draft = emptyScriptDraft(title, production.items.length);
            if (kind === "scene") {
              const episode = production.items.find(
                (i) => i.id === parent && i.kind === "episode",
              );
              if (!episode) throw new Error("请先选择所属分集。");
              draft.parentId = episode.id;
              draft.dependencies = [
                { itemId: episode.id, revision: episode.revision },
              ];
            }
            const receipt = await run({
              action: "create-item",
              productionId: production.id,
              kind,
              draft,
            });
            onCreated(receipt.entityId);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          类型
          <select
            aria-label="条目类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as ScriptItem["kind"])}
          >
            {scriptItemKinds.map((k) => (
              <option key={k} value={k}>
                {scriptKindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input
            aria-label="条目标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={180}
          />
        </label>
        {kind === "scene" && (
          <label>
            所属分集
            <select
              aria-label="所属分集"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              required
            >
              <option value="">请选择</option>
              {production.items
                .filter((i) => i.kind === "episode")
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="primary"
            type="submit"
            disabled={busy || !title.trim()}
          >
            创建条目
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
function ProductionSettings({
  production,
  client,
  run,
  onClose,
}: {
  production: ScriptEditorProduction;
  client: WorkspaceClient;
  run: ScriptRun;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => structuredClone(production));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const brief = value.brief;
  const template = value.template;
  const people = client.boot!.workspace.actants.filter(
    (a) =>
      a.kind === "human" &&
      client
        .boot!.workspace.projects.find((p) => p.id === production.projectId)
        ?.members.includes(a.principalId),
  );
  return (
    <StudioDialog title="剧本设置" onClose={onClose}>
      <form
        className="script-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await run({
              action: "update-production",
              productionId: value.id,
              expectedRevision: value.revision,
              title: value.title,
              brief,
              reviewerPrincipalIds: value.reviewerPrincipalIds,
              template,
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="script-hint">
          创作要求、资料说明或审阅人变更需要重新审阅；改名和 Word
          排版不影响已批准的稿件。
        </p>
        <label>
          剧名
          <input
            value={value.title}
            required
            maxLength={180}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
        </label>
        <div className="script-form-grid">
          <label>
            创作方式
            <select
              value={brief.mode}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: {
                    ...brief,
                    mode: e.target.value as "original" | "adaptation",
                  },
                })
              }
            >
              <option value="original">原创</option>
              <option value="adaptation">改编</option>
            </select>
          </label>
          <label>
            集数
            <input
              type="number"
              min={1}
              max={500}
              value={brief.episodeCount}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: { ...brief, episodeCount: Number(e.target.value) },
                })
              }
            />
          </label>
          <label>
            每集秒数
            <input
              type="number"
              min={15}
              max={14400}
              value={brief.episodeSeconds}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: { ...brief, episodeSeconds: Number(e.target.value) },
                })
              }
            />
          </label>
        </div>
        {(
          [
            ["audience", "受众", 2000],
            ["genre", "题材", 500],
            ["style", "风格", 5000],
            ["constraints", "制作约束", 10000],
            ["rightsStatement", "资料来源与使用说明", 5000],
          ] as const
        ).map(([field, label, max]) => (
          <label key={field}>
            {label}
            <textarea
              rows={2}
              maxLength={max}
              value={brief[field]}
              onChange={(e) =>
                setValue({
                  ...value,
                  brief: { ...brief, [field]: e.target.value },
                })
              }
            />
          </label>
        ))}
        <fieldset>
          <legend>指定审阅人（人工）</legend>
          {people.map((a) => (
            <label key={a.id} className="script-checkbox">
              <input
                type="checkbox"
                checked={value.reviewerPrincipalIds.includes(a.principalId)}
                onChange={(e) =>
                  setValue({
                    ...value,
                    reviewerPrincipalIds: e.target.checked
                      ? [
                          ...new Set([
                            ...value.reviewerPrincipalIds,
                            a.principalId,
                          ]),
                        ]
                      : value.reviewerPrincipalIds.filter(
                          (id) => id !== a.principalId,
                        ),
                  })
                }
              />
              {a.name}
            </label>
          ))}
        </fieldset>
        <details>
          <summary>Word 交付模板</summary>
          <label>
            模板标题
            <input
              value={template.title}
              maxLength={100}
              required
              onChange={(e) =>
                setValue({
                  ...value,
                  template: { ...template, title: e.target.value },
                })
              }
            />
          </label>
          <label>
            场景标题前缀
            <input
              value={template.sceneHeading}
              maxLength={80}
              required
              onChange={(e) =>
                setValue({
                  ...value,
                  template: { ...template, sceneHeading: e.target.value },
                })
              }
            />
          </label>
          <div className="script-form-grid">
            <label>
              字体
              <select
                value={template.font}
                onChange={(e) =>
                  setValue({
                    ...value,
                    template: {
                      ...template,
                      font: e.target.value as typeof template.font,
                    },
                  })
                }
              >
                {["宋体", "等线", "Microsoft YaHei", "Arial"].map((font) => (
                  <option key={font}>{font}</option>
                ))}
              </select>
            </label>
            <label>
              字号
              <input
                type="number"
                min={9}
                max={24}
                value={template.fontSize}
                onChange={(e) =>
                  setValue({
                    ...value,
                    template: { ...template, fontSize: Number(e.target.value) },
                  })
                }
              />
            </label>
          </div>
          {(
            [
              ["includeNotes", "包含制作说明"],
              ["includeContinuity", "包含连续性说明"],
              ["pageBreakEpisodes", "按分集分页"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="script-checkbox">
              <input
                type="checkbox"
                checked={template[key]}
                onChange={(e) =>
                  setValue({
                    ...value,
                    template: { ...template, [key]: e.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
        </details>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            className="primary"
            type="submit"
            disabled={busy || !value.reviewerPrincipalIds.length}
          >
            保存规范
          </button>
          <button className="secondary-action" type="button" onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </StudioDialog>
  );
}
