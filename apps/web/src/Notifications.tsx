import { useEffect, useRef, useState } from "react";
import { useModal } from "./useModal.js";
import { Bell, X } from "lucide-react";
import { z } from "zod";
import { RequestError, scopedStorage, type WorkspaceClient } from "./client.js";
const schema = z.object({
  mode: z.enum(["all", "high", "off"]),
  unread: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      artifactId: z.string(),
      title: z.string(),
      priority: z.enum(["high", "normal", "low"]),
      reason: z.string(),
      read: z.boolean(),
    }),
  ),
});
const notificationModes = [
  { value: "all", label: "全部事项" },
  { value: "high", label: "仅高优先级" },
  { value: "off", label: "不提示" },
] as const;
export function Notifications({
  client,
  onOpen,
}: {
  client: WorkspaceClient;
  onOpen: (id: string) => void;
}) {
  const [view, setView] = useState<z.infer<typeof schema>>({
      mode: "all",
      unread: 0,
      items: [],
    }),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const storage = useState(() => scopedStorage())[0];
  const pendingReads = useRef(
    new Set(
      z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(200)
        .catch([])
        .parse(storage.readLocal("notification-reads", [])),
    ),
  );
  function rememberReads() {
    try {
      storage.writeLocal(
        "notification-reads",
        [...pendingReads.current].slice(-200),
      );
    } catch {
      /* Reading a task never depends on local receipt persistence. */
    }
  }
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    current = useRef(client);
  current.current = client;
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (pendingReads.current.size) {
        const ids = [...pendingReads.current];
        try {
          await current.current.notifications({
            action: "read",
            ids,
          });
          for (const id of ids) pendingReads.current.delete(id);
          rememberReads();
        } catch {
          /* Retain pending acknowledgments for the next connected refresh. */
        }
      }
      return current.current
        .notifications()
        .then((v) => {
          if (alive) {
            const next = schema.parse(v);
            const visible = new Set(next.items.map((i) => i.id));
            for (const id of pendingReads.current)
              if (!visible.has(id)) pendingReads.current.delete(id);
            rememberReads();
            setView(next);
            setError("");
          }
        })
        .catch(() => {
          if (alive) setError("暂时无法同步通知。");
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useModal(dialog, heading, open);
  async function change(
    command: Parameters<WorkspaceClient["notifications"]>[0],
  ) {
    try {
      setView(schema.parse(await client.notifications(command)));
      setError("");
      return true;
    } catch {
      setError("通知设置未保存，请重试。");
      return false;
    }
  }
  return (
    <>
      <button
        className="icon-button notification-trigger"
        aria-label={`通知${view.unread ? `，${view.unread} 项未读` : ""}`}
        onClick={() => setOpen(true)}
      >
        <Bell size={17} />
        {view.unread > 0 && (
          <span className="notification-badge" aria-hidden="true">
            {view.unread > 99 ? "99+" : view.unread}
          </span>
        )}
      </button>
      {open && (
        <dialog
          className="create-dialog notification-dialog"
          aria-label="通知"
          ref={dialog}
          onCancel={() => setOpen(false)}
        >
          <header>
            <h2 ref={heading} tabIndex={-1}>
              通知
            </h2>
            <fieldset
              className="notification-preferences"
              aria-describedby="notification-mode-hint"
              title="提醒范围：仅影响未读提示，不改变事项或通知记录。"
            >
              <legend className="visually-hidden">提醒范围</legend>
              <div className="notification-modes">
                {notificationModes.map((mode) => (
                  <label key={mode.value}>
                    <input
                      type="radio"
                      name="notification-mode"
                      value={mode.value}
                      checked={view.mode === mode.value}
                      onChange={() =>
                        void change({ action: "settings", mode: mode.value })
                      }
                    />
                    <span>{mode.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              className="icon-button"
              aria-label="关闭通知"
              onClick={() => setOpen(false)}
            >
              <X />
            </button>
          </header>
          <p className="visually-hidden" id="notification-mode-hint">
            仅影响未读提示，不改变事项或通知记录。
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="notification-list">
            {view.items.map((i) => (
              <button
                key={i.id}
                data-unread={!i.read}
                aria-label={`${i.read ? "" : "未读，"}${i.title}，${i.priority === "high" ? "高优先级，" : ""}${i.reason}`}
                onClick={async () => {
                  try {
                    // Navigation must not wait on a read receipt. Refresh first
                    // only to revalidate the current authorized workspace.
                    await current.current.verifyArtifact(i.artifactId);
                    pendingReads.current.add(i.id);
                    rememberReads();
                    setOpen(false);
                    onOpen(i.artifactId);
                    void current.current
                      .notifications({ action: "read", ids: [i.id] })
                      .then(() => {
                        pendingReads.current.delete(i.id);
                        rememberReads();
                      })
                      .catch(() => setError("事项已打开，已读状态待同步。"));
                  } catch (e) {
                    setError(
                      e instanceof RequestError && [401, 403].includes(e.status)
                        ? "请重新登录或检查事项权限。"
                        : "暂时无法确认事项权限，请重试。",
                    );
                  }
                }}
              >
                <strong>{i.title}</strong>
                <small>
                  {i.priority === "high" ? "高优先级 · " : ""}
                  {i.reason}
                </small>
              </button>
            ))}
            {!view.items.length && !error && (
              <p className="notification-empty">暂无通知</p>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
