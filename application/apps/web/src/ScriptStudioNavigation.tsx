import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronRight,
  Clapperboard,
  FilePlus2,
  FileText,
  LayoutDashboard,
  Plus,
  Users,
} from "lucide-react";
import {
  currentScriptDraft,
  type ScriptItem,
} from "../../../packages/core/src/script-studio.js";
import { scopedStorage } from "./client.js";
import { ComposerOptions } from "./ComposerOptions.js";

export const scriptCreateLabels: Record<ScriptItem["kind"], string> = {
  outline: "新建全剧大纲",
  episode: "新建一集",
  scene: "添加分场",
  character: "添加角色",
  setting: "添加设定",
  source: "添加参考资料",
};
const createKinds: ScriptItem["kind"][] = [
  "episode",
  "scene",
  "outline",
  "character",
  "setting",
  "source",
];
const statuses = {
  draft: "草稿",
  "in-review": "待审",
  approved: "已批准",
  locked: "已锁稿",
};

/** A view projection only: original IDs, kinds, order and parent links stay intact. */
export function scriptDirectory(items: ScriptItem[]) {
  const sorted = [...items].sort(
    (a, b) =>
      currentScriptDraft(a).order - currentScriptDraft(b).order ||
      a.id.localeCompare(b.id),
  );
  const episodes = sorted.filter((item) => item.kind === "episode");
  const episodeIds = new Set(episodes.map((item) => item.id));
  const scenes = new Map<string, ScriptItem[]>();
  const unassigned: ScriptItem[] = [];
  for (const item of sorted.filter((item) => item.kind === "scene")) {
    const parent = currentScriptDraft(item).parentId;
    if (!parent || !episodeIds.has(parent)) unassigned.push(item);
    else scenes.set(parent, [...(scenes.get(parent) ?? []), item]);
  }
  return {
    outlines: sorted.filter((item) => item.kind === "outline"),
    episodes,
    scenes,
    unassigned,
    people: sorted.filter(
      (item) => item.kind === "setting" || item.kind === "character",
    ),
    sources: sorted.filter((item) => item.kind === "source"),
  };
}

export function ScriptStudioNavigation({
  items,
  itemId,
  storageScope,
  locationKey,
  directoryId,
  open,
  compact,
  onClose,
  canWrite,
  onChoose,
  onCreate,
  onNotice,
}: {
  items: ScriptItem[];
  itemId: string;
  storageScope: string;
  locationKey: string;
  directoryId: string;
  open: boolean;
  compact: boolean;
  onClose: () => void;
  canWrite: boolean;
  onChoose: (id?: string) => void;
  onCreate: (kind: ScriptItem["kind"], parentId?: string) => void;
  onNotice: (message: string) => void;
}) {
  const directory = scriptDirectory(items);
  const storage = scopedStorage(storageScope);
  const id = useId();
  const nav = useRef<HTMLElement>(null);
  const wasOpen = useRef(open);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    storage.readLocal(locationKey, { people: true, sources: true }),
  );
  const selected = items.find((item) => item.id === itemId);
  const selectedGroup =
    selected?.kind === "outline"
      ? "outlines"
      : selected?.kind === "episode" || selected?.kind === "scene"
        ? "episodes"
        : selected?.kind === "source"
          ? "sources"
          : "people";
  const selectedParent = selected
    ? currentScriptDraft(selected).parentId
    : null;
  const choose = (id?: string) => {
    onChoose(id);
    if (compact) onClose();
  };
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const current = nav.current?.querySelector<HTMLButtonElement>(
      '[aria-current="true"]',
    );
    const target = current?.getClientRects().length
      ? current
      : nav.current?.querySelector<HTMLButtonElement>(".script-overview-link");
    target?.focus();
  }, [open]);
  useEffect(() => {
    if (!itemId) return;
    // A newly selected/created or reparented item must be reachable. Manual
    // folding after selection is still allowed and never changes the editor.
    setCollapsed((previous) => ({
      ...previous,
      [selectedGroup]: false,
      ...(selectedParent ? { [selectedParent]: false } : {}),
    }));
  }, [itemId, selectedGroup, selectedParent]);
  useEffect(() => {
    try {
      storage.writeLocal(locationKey, collapsed);
    } catch {
      onNotice("目录展开状态暂时无法保存；文稿和草稿未受影响。");
    }
  }, [collapsed, locationKey]);
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [itemId]);
  const toggle = (key: string) =>
    setCollapsed((previous) => ({ ...previous, [key]: !previous[key] }));
  const add = (kind: ScriptItem["kind"], parentId?: string) => (
    <button
      type="button"
      className="icon-button script-nav-add"
      aria-label={scriptCreateLabels[kind]}
      title={scriptCreateLabels[kind]}
      disabled={!canWrite}
      onClick={() => onCreate(kind, parentId)}
    >
      <Plus />
    </button>
  );
  const row = (item: ScriptItem, mixed = false) => {
    const title = currentScriptDraft(item).title;
    return (
      <button
        type="button"
        className="script-tree-row"
        aria-current={item.id === itemId ? "true" : undefined}
        title={title}
        onClick={() => choose(item.id)}
      >
        <span>{title}</span>
        <small>
          {mixed ? `${item.kind === "character" ? "角色" : "设定"} · ` : ""}
          {statuses[item.status]}
        </small>
      </button>
    );
  };
  const group = (
    key: string,
    label: string,
    icon: ReactNode,
    count: number,
    actions: ReactNode,
    children: ReactNode,
  ) => (
    <section className="script-nav-group" data-script-group={key}>
      <div
        className="script-nav-heading"
        data-contains-current={
          (!!selected && selectedGroup === key) || undefined
        }
      >
        <button
          type="button"
          className="script-nav-disclosure"
          aria-label={label}
          aria-expanded={!collapsed[key]}
          aria-controls={`${id}-${key}`}
          onClick={() => toggle(key)}
        >
          <ChevronRight className="script-chevron" />
          {icon}
          <span>{label}</span>
          <small aria-hidden="true">{count || ""}</small>
        </button>
        {actions}
      </div>
      <div
        id={`${id}-${key}`}
        hidden={!!collapsed[key]}
        className="script-nav-children"
      >
        {children}
      </div>
    </section>
  );
  return (
    <div className="script-directory" hidden={!open}>
      <nav
        id={directoryId}
        ref={nav}
        className="script-outline"
        aria-label="剧本目录"
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !(event.target as HTMLElement).closest("[popover]")
          ) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
            (event.target as HTMLElement).closest("[popover]")
          )
            return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ].filter(
            (button) =>
              button.getClientRects().length > 0 &&
              !button.closest("[popover]"),
          );
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (current < 0) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : Math.max(
                    0,
                    Math.min(
                      buttons.length - 1,
                      current + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
          buttons[next]?.focus();
        }}
      >
        <div className="script-outline-actions">
          <span>创作目录</span>
          <ComposerOptions
            label="添加剧本内容"
            menuLabel="添加剧本内容菜单"
            triggerIcon={<FilePlus2 />}
            triggerClassName="icon-button"
            below
            options={createKinds.map((kind) => ({
              label: scriptCreateLabels[kind],
              icon: <FileText />,
              disabled:
                !canWrite || (kind === "scene" && !directory.episodes.length),
              onSelect: () =>
                onCreate(
                  kind,
                  kind === "scene"
                    ? selected?.kind === "episode"
                      ? selected.id
                      : (selectedParent ?? undefined)
                    : undefined,
                ),
            }))}
          />
        </div>
        <button
          type="button"
          className="script-tree-row script-overview-link"
          aria-current={!selected ? "true" : undefined}
          onClick={() => choose()}
        >
          <LayoutDashboard />
          <span>概览</span>
        </button>
        {group(
          "outlines",
          "全剧大纲",
          <FileText />,
          directory.outlines.length,
          add("outline"),
          directory.outlines.length ? (
            directory.outlines.map((item) => (
              <div key={item.id}>{row(item)}</div>
            ))
          ) : (
            <p className="script-nav-empty">尚无全剧大纲</p>
          ),
        )}
        {group(
          "episodes",
          "分集剧本",
          <Clapperboard />,
          directory.episodes.length,
          add("episode"),
          <>
            {directory.episodes.map((episode) => {
              const scenes = directory.scenes.get(episode.id) ?? [];
              const title = currentScriptDraft(episode).title;
              return (
                <div key={episode.id} data-script-episode={episode.id}>
                  <div
                    className="script-nav-entry"
                    data-contains-current={
                      episode.id === itemId ||
                      selectedParent === episode.id ||
                      undefined
                    }
                  >
                    <button
                      type="button"
                      className="icon-button script-episode-toggle"
                      aria-label="分场目录"
                      title={`${collapsed[episode.id] ? "展开" : "收起"} ${title} 的分场`}
                      aria-expanded={!collapsed[episode.id]}
                      aria-controls={`${id}-${episode.id}`}
                      onClick={() => toggle(episode.id)}
                    >
                      <ChevronRight className="script-chevron" />
                    </button>
                    {row(episode)}
                    {add("scene", episode.id)}
                  </div>
                  <div
                    id={`${id}-${episode.id}`}
                    hidden={!!collapsed[episode.id]}
                    className="script-scene-list"
                  >
                    {scenes.length ? (
                      scenes.map((scene) => (
                        <div key={scene.id}>{row(scene)}</div>
                      ))
                    ) : (
                      <p className="script-nav-empty">尚无分场</p>
                    )}
                  </div>
                </div>
              );
            })}
            {!directory.episodes.length && (
              <p className="script-nav-empty">从任意一集开始</p>
            )}
            {directory.unassigned.length > 0 && (
              <div className="script-unassigned">
                <span>待归属分场</span>
                {directory.unassigned.map((scene) => (
                  <div key={scene.id}>{row(scene)}</div>
                ))}
              </div>
            )}
          </>,
        )}
        {group(
          "people",
          "设定与角色",
          <Users />,
          directory.people.length,
          <ComposerOptions
            label="添加设定或角色"
            menuLabel="设定与角色操作"
            triggerIcon={<Plus />}
            triggerClassName="icon-button script-nav-add"
            below
            options={["character", "setting"].map((kind) => ({
              label: scriptCreateLabels[kind as ScriptItem["kind"]],
              icon: <Users />,
              disabled: !canWrite,
              onSelect: () => onCreate(kind as ScriptItem["kind"]),
            }))}
          />,
          directory.people.length ? (
            directory.people.map((item) => (
              <div key={item.id}>{row(item, true)}</div>
            ))
          ) : (
            <p className="script-nav-empty">按创作需要随时补充</p>
          ),
        )}
        {group(
          "sources",
          "参考资料",
          <BookOpen />,
          directory.sources.length,
          add("source"),
          directory.sources.length ? (
            directory.sources.map((item) => (
              <div key={item.id}>{row(item)}</div>
            ))
          ) : (
            <p className="script-nav-empty">原作、调研与参考</p>
          ),
        )}
      </nav>
    </div>
  );
}
