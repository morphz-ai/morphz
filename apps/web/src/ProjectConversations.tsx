import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Folder,
  MessageCircle,
  Pencil,
  SquarePen,
  Trash2,
} from "lucide-react";
import { ProjectMenu, type ProjectAction } from "./ProjectManagement.js";
import type { Project } from "../../../packages/core/src/projects.js";
import {
  discussionId,
  type Discussion,
} from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import { ComposerOptions } from "./ComposerOptions.js";

/** Project-local conversations live next to the project they belong to. */
export function ProjectConversations({
  client,
  projectId,
  title: projectTitle,
  active,
  selectedId,
  onOpen,
  onSelect,
  onCreate,
  defaultConversationId,
  startedIds,
  drafts,
  onManage,
  onDiscardDraft,
  discardedDrafts,
  onRestoreDraft,
}: {
  client: WorkspaceClient;
  projectId: string;
  title: string;
  active: boolean;
  selectedId: string;
  onOpen: () => void;
  onSelect: (id: string) => void;
  onCreate: (title: string) => Promise<void>;
  defaultConversationId: string;
  startedIds: Set<string>;
  drafts: { id: string; title: string }[];
  onManage: (project: Project, action: ProjectAction) => void;
  onDiscardDraft: (id: string) => void;
  discardedDrafts: { id: string; title: string }[];
  onRestoreDraft: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(active);
  const [archived, setArchived] = useState(false);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const state = client.boot!.workspace;
  // The project row is the default conversation entry. Legacy default records
  // stay in the store for history/routing, but are never extra sidebar children.
  // Filter by identity, not title: a user may name a Session "持续对话".
  const conversations = state.conversations.filter(
    (c) =>
      c.projectId === projectId &&
      c.id !== projectId &&
      c.id !== defaultConversationId &&
      startedIds.has(c.id),
  );
  const hasNamed =
    conversations.length > 0 || drafts.length > 0 || discardedDrafts.length > 0;
  const defaultSelected = active && selectedId === defaultConversationId;
  const archivedCount = conversations.filter((c) => c.archivedAt).length;
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active, selectedId]);
  function focusChoice(id: string) {
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>(
          '[data-conversation-id="' + id + '"] .conversation-choice',
        )
        ?.focus(),
    );
  }
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      let ordinal = conversations.length + 1;
      while (conversations.some((c) => c.title === "对话 " + ordinal))
        ordinal++;
      await onCreate("对话 " + ordinal);
      setExpanded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function update(
    c: Discussion,
    change: { title?: string; archived?: boolean },
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "update-conversation",
        conversationId: c.id,
        expectedRevision: c.revision,
        ...change,
      });
      setEditing(null);
      if (change.archived)
        requestAnimationFrame(() =>
          root.current
            ?.querySelector<HTMLButtonElement>(".project-archived-toggle")
            ?.focus(),
        );
      else focusChoice(c.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      ref={root}
      className="sidebar-project"
      data-project-id={projectId}
      data-active={active}
      aria-label={projectTitle + "的会话"}
      role="group"
    >
      <div className="sidebar-project-heading" data-active={defaultSelected}>
        <button
          className="project-link"
          aria-current={defaultSelected ? "true" : undefined}
          onClick={() => {
            setExpanded(true);
            onOpen();
          }}
          title={projectTitle}
        >
          <Folder />
          <span>{projectTitle}</span>
        </button>
        {hasNamed && (
          <button
            className="project-disclosure icon-button"
            aria-label={
              (expanded ? "收起" : "展开") + "项目会话：" + projectTitle
            }
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight />
          </button>
        )}
        <button
          className="project-new-conversation icon-button"
          aria-label={"新建项目对话：" + projectTitle}
          title="新建会话"
          disabled={busy}
          onClick={() => void create()}
        >
          <SquarePen />
        </button>
        <ProjectMenu
          project={state.projects.find((p) => p.id === projectId)!}
          onAction={onManage}
        />
      </div>
      {hasNamed && expanded && (
        <div className="project-conversation-list">
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="project-conversation-row"
              data-conversation-id={draft.id}
              data-draft="true"
              data-selected={active && draft.id === selectedId}
            >
              <button
                className="conversation-choice"
                aria-label={"继续草稿：" + draft.title}
                aria-current={
                  active && draft.id === selectedId ? "true" : undefined
                }
                onClick={() => onSelect(draft.id)}
              >
                <Pencil />
                <span>{draft.title}</span>
                <small>草稿</small>
              </button>
              <ComposerOptions
                label={`草稿操作：${draft.title}`}
                menuLabel="草稿操作"
                below
                options={[
                  {
                    label: `丢弃草稿：${draft.title}`,
                    text: "丢弃草稿",
                    icon: <Trash2 />,
                    disabled: busy,
                    onSelect: () => onDiscardDraft(draft.id),
                  },
                ]}
              />
            </div>
          ))}
          {[false, true].map((archivedSection) => (
            <div
              key={String(archivedSection)}
              className={
                archivedSection ? "archived-conversation-group" : undefined
              }
            >
              {archivedSection && archivedCount > 0 && (
                <button
                  className="project-archived-toggle"
                  aria-expanded={archived}
                  onClick={() => setArchived(!archived)}
                >
                  已归档 · {archivedCount}
                </button>
              )}
              {conversations
                .filter(
                  (c) =>
                    !!c.archivedAt === archivedSection &&
                    (!archivedSection || archived),
                )
                .map((c) => {
                  const running = client.boot!.runtime.deliveries.some(
                    (d) =>
                      ["queued", "sending", "running"].includes(d.state) &&
                      state.inputs.some(
                        (i) => i.id === d.inputId && discussionId(i) === c.id,
                      ),
                  );
                  return (
                    <div
                      key={c.id}
                      className="project-conversation-row"
                      data-conversation-id={c.id}
                      data-selected={active && c.id === selectedId}
                    >
                      {editing === c.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (title.trim()) void update(c, { title });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setEditing(null);
                              focusChoice(c.id);
                            }
                          }}
                        >
                          <input
                            autoFocus
                            aria-label="对话名称"
                            value={title}
                            maxLength={180}
                            onChange={(e) => setTitle(e.target.value)}
                          />
                          <button
                            aria-label="保存对话名称"
                            disabled={busy || !title.trim()}
                          >
                            <Check />
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            className="conversation-choice"
                            aria-label={"打开对话：" + c.title}
                            title={c.title}
                            aria-current={
                              active && c.id === selectedId ? "true" : undefined
                            }
                            onClick={() => onSelect(c.id)}
                          >
                            <MessageCircle />
                            <span>{c.title}</span>
                            {running && (
                              <span
                                className="conversation-running"
                                role="img"
                                aria-label="进行中"
                                title="进行中"
                              />
                            )}
                            {c.archivedAt && <small>已归档</small>}
                          </button>
                          {c.id !== defaultConversationId && (
                            <ComposerOptions
                              label={"对话操作：" + c.title}
                              menuLabel="对话选项"
                              below
                              options={[
                                {
                                  label: "重命名：" + c.title,
                                  text: "重命名",
                                  icon: <Pencil />,
                                  disabled: busy || !client.online,
                                  onSelect: () => {
                                    setEditing(c.id);
                                    setTitle(c.title);
                                  },
                                },
                                {
                                  label:
                                    (c.archivedAt ? "恢复" : "归档") +
                                    "：" +
                                    c.title,
                                  text: c.archivedAt ? "恢复" : "归档",
                                  icon: c.archivedAt ? (
                                    <ArchiveRestore />
                                  ) : (
                                    <Archive />
                                  ),
                                  disabled: busy || !client.online,
                                  onSelect: () =>
                                    void update(c, { archived: !c.archivedAt }),
                                },
                              ]}
                            />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
          {discardedDrafts.length > 0 && (
            <div className="discarded-drafts">
              <button
                className="project-archived-toggle"
                aria-expanded={showDiscarded}
                onClick={() => setShowDiscarded(!showDiscarded)}
              >
                已丢弃草稿 · {discardedDrafts.length}
              </button>
              {showDiscarded &&
                discardedDrafts.map((d) => (
                  <button
                    key={d.id}
                    className="conversation-choice"
                    aria-label={`恢复草稿：${d.title}`}
                    onClick={() => onRestoreDraft(d.id)}
                  >
                    <ArchiveRestore />
                    <span>{d.title}</span>
                    <small>恢复</small>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="project-conversation-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
