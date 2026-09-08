import { useEffect, useRef, useState } from "react";
import { useModal } from "./useModal.js";
import { Bell, X } from "lucide-react";
import { z } from "zod";
import type { WorkspaceClient } from "./client.js";
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
  const dialog = useRef<HTMLDialogElement>(null),
    current = useRef(client);
  current.current = client;
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void current.current
        .notifications()
        .then((v) => {
          if (alive) {
            setView(schema.parse(v));
            setError("");
          }
        })
        .catch(() => {
          if (alive) setError("暂时无法同步通知。");
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useModal(dialog, undefined, open);
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
        {view.unread > 0 && <small>{view.unread}</small>}
      </button>
      {open && (
        <dialog
          className="create-dialog notification-dialog"
          aria-label="通知"
          ref={dialog}
          onCancel={() => setOpen(false)}
        >
          <header>
            <h2>通知</h2>
            <button
              className="icon-button"
              aria-label="关闭通知"
              onClick={() => setOpen(false)}
            >
              <X />
            </button>
          </header>
          <label>
            提醒范围
            <select
              aria-label="通知提醒范围"
              value={view.mode}
              onChange={(e) =>
                void change({
                  action: "settings",
                  mode: e.target.value as "all" | "high" | "off",
                })
              }
            >
              <option value="all">全部事项</option>
              <option value="high">仅高优先级</option>
              <option value="off">不显示未读提示</option>
            </select>
          </label>
          <p className="muted">
            设置与已读状态跟随当前身份。文字修订不会反复生成提醒。
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="notification-list">
            {view.items.map((i) => (
              <button
                key={i.id}
                data-unread={!i.read}
                onClick={async () => {
                  if (await change({ action: "read", ids: [i.id] })) {
                    setOpen(false);
                    onOpen(i.artifactId);
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
            {!view.items.length && <p>目前没有需要提醒的事项。</p>}
          </div>
        </dialog>
      )}
    </>
  );
}
