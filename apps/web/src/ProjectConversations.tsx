import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  MessageCircle,
  Pencil,
  Plus,
} from "lucide-react";
import {
  discussionId,
  type Discussion,
} from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";

/** Conversation management stays inside the project, not in global navigation. */
export function ProjectConversations({
  client,
  projectId,
  selected,
  onSelect,
}: {
  client: WorkspaceClient;
  projectId: string;
  selected: Discussion;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null),
    [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const state = client.boot!.workspace;
  const conversations = state.conversations.filter(
    (c) => c.projectId === projectId,
  );
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, []);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const receipt = await client.execute({
        type: "create-conversation",
        projectId,
        title: `对话 ${conversations.length + 1}`,
      });
      onSelect(receipt.entityId);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function update(
    c: Discussion,
    change: { title?: string; archived?: boolean },
  ) {
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
      if (change.archived !== undefined && c.id === selected.id) setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="project-conversations"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="conversation-switch"
        aria-label="项目对话"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setError("");
          setEditing(null);
        }}
      >
        <MessageCircle />
        <span>{selected.title}</span>
        {selected.archivedAt && <small>已归档</small>}
        <ChevronDown />
      </button>
      {open && (
        <section
          className="project-conversation-menu"
          aria-label="项目对话列表"
        >
          <header>
            <strong>项目对话</strong>
            <button
              aria-label="新建项目对话"
              disabled={busy || !client.online}
              onClick={() => void create()}
            >
              <Plus />
              新对话
            </button>
          </header>
          <div className="conversation-list">
            {conversations
              .filter((c) => !!c.archivedAt === archived)
              .map((c) => {
                const pending = client.boot!.runtime.deliveries.some(
                  (d) =>
                    ["queued", "sending", "running"].includes(d.state) &&
                    state.inputs.some(
                      (i) => i.id === d.inputId && discussionId(i) === c.id,
                    ),
                );
                return (
                  <div
                    className="project-conversation-row"
                    key={c.id}
                    data-selected={c.id === selected.id}
                  >
                    {editing === c.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (title.trim()) void update(c, { title });
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
                          aria-label={`打开对话：${c.title}`}
                          aria-current={
                            c.id === selected.id ? "true" : undefined
                          }
                          onClick={() => {
                            onSelect(c.id);
                            setOpen(false);
                          }}
                        >
                          <span>{c.title}</span>
                          {pending && <small>进行中</small>}
                          {c.id === selected.id && <Check />}
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`重命名：${c.title}`}
                          disabled={busy}
                          onClick={() => {
                            setEditing(c.id);
                            setTitle(c.title);
                          }}
                        >
                          <Pencil />
                        </button>
                        {c.id !== projectId && (
                          <button
                            className="icon-button"
                            aria-label={`${c.archivedAt ? "恢复" : "归档"}：${c.title}`}
                            disabled={busy || !client.online}
                            onClick={() =>
                              void update(c, { archived: !c.archivedAt })
                            }
                          >
                            {c.archivedAt ? <ArchiveRestore /> : <Archive />}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            {!conversations.some((c) => !!c.archivedAt === archived) && (
              <p className="muted">没有已归档的对话</p>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button
              onClick={() => {
                setArchived(!archived);
                setEditing(null);
              }}
            >
              {archived
                ? "返回对话列表"
                : `已归档 · ${conversations.filter((c) => c.archivedAt).length}`}
            </button>
            <small>共享项目资料，分别保留交流记录</small>
          </footer>
        </section>
      )}
    </div>
  );
}
