import { useEffect, useRef, useState } from "react";
import { useModal } from "./useModal.js";
import { visibleProfileMenuTrigger } from "./profile-menu-focus.js";
import { Bell, X, Settings2 } from "lucide-react";
import { z } from "zod";
import { RequestError, scopedStorage, type WorkspaceClient } from "./client.js";
const schema = z.object({
  mode: z.enum(["all", "off"]),
  revision: z.number().int().nonnegative(),
  unread: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      artifactId: z.string(),
      title: z.string(),
      reason: z.string(),
      read: z.boolean(),
    }),
  ),
});
const notificationModes = [
  { value: "all", label: "全部提醒" },
  { value: "off", label: "不提示" },
] as const;
const pendingReadSchema = z.object({
  action: z.literal("read"),
  ids: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(200),
  commandId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
});

export function NotificationPreferences({
  client,
  onBusy,
}: {
  client: WorkspaceClient;
  onBusy: (busy: boolean) => void;
}) {
  const [view, setView] = useState<z.infer<typeof schema> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(false),
    pending = useRef(false),
    pendingChoice = useRef<{
      mode: "all" | "off";
      commandId: string;
      expectedRevision: number;
    } | null>(null),
    current = useRef(client);
  current.current = client;
  async function load() {
    setError("");
    try {
      const next = schema.parse(await current.current.notifications());
      if (alive.current) setView(next);
    } catch {
      if (alive.current) setError("暂时无法读取通知设置，请重试。");
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      onBusy(false);
    };
  }, [onBusy]);
  async function change(mode: "all" | "off") {
    if (pending.current || !view) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    const command =
      pendingChoice.current?.mode === mode
        ? pendingChoice.current
        : {
            mode,
            commandId: crypto.randomUUID(),
            expectedRevision: view.revision,
          };
    pendingChoice.current = command;
    try {
      const next = schema.parse(
        await current.current.notifications({ action: "settings", ...command }),
      );
      pendingChoice.current = null;
      window.dispatchEvent(new Event("morphz:notifications-changed"));
      if (alive.current) setView(next);
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 409) {
        pendingChoice.current = null;
        await load();
        if (alive.current) setError("通知设置已变化，请重新选择。");
      } else if (alive.current) setError("通知设置未确认保存，请重试。");
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <section className="notification-settings" aria-label="通知偏好">
      <header>
        <h2>通知</h2>
      </header>
      {error && <p role="alert">{error}</p>}
      {!view &&
        (error ? (
          <button className="secondary-action" onClick={() => void load()}>
            重试
          </button>
        ) : (
          <p role="status">正在读取通知设置…</p>
        ))}
      {view && (
        <fieldset
          className="notification-preferences"
          aria-busy={busy}
          aria-describedby="notification-mode-hint"
        >
          <legend>提醒范围</legend>
          <div className="notification-modes">
            {notificationModes.map((mode) => (
              <label key={mode.value}>
                <input
                  type="radio"
                  name="notification-mode"
                  value={mode.value}
                  checked={view.mode === mode.value}
                  aria-disabled={busy}
                  onClick={(event) => {
                    if (busy) event.preventDefault();
                  }}
                  onChange={() => {
                    if (!busy) void change(mode.value);
                  }}
                />
                <span>{mode.label}</span>
              </label>
            ))}
          </div>
          <p className="muted" id="notification-mode-hint">
            仅影响未读提示，不改变事项或通知记录。
          </p>
        </fieldset>
      )}
    </section>
  );
}

export function Notifications({
  client,
  onOpen,
  onSettings,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  onUnreadChange,
}: {
  client: WorkspaceClient;
  onOpen: (id: string) => void;
  onSettings: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  onUnreadChange?: (unread: number) => void;
}) {
  const [view, setView] = useState<z.infer<typeof schema>>({
      mode: "all",
      revision: 0,
      unread: 0,
      items: [],
    }),
    [localOpen, setLocalOpen] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState("");
  const open = controlledOpen ?? localOpen;
  function setOpen(next: boolean) {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  }
  useEffect(() => {
    onUnreadChange?.(view.unread);
  }, [view.unread, onUnreadChange]);
  const generation = useRef(0);
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
  const pendingBatch = useRef(
    pendingReadSchema
      .nullable()
      .catch(null)
      .parse(storage.readLocal("notification-read-batch", null)),
  );
  function rememberReads() {
    try {
      storage.writeLocal(
        "notification-reads",
        [...pendingReads.current].slice(-200),
      );
      storage.writeLocal("notification-read-batch", pendingBatch.current);
    } catch {
      /* Reading a task never depends on local receipt persistence. */
    }
  }
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    current = useRef(client);
  current.current = client;
  useEffect(() => {
    let alive = true,
      refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const version = generation.current;
      try {
        let next = schema.parse(await current.current.notifications());
        if (pendingReads.current.size) {
          if (!pendingBatch.current) {
            pendingBatch.current = {
              action: "read",
              ids: [...pendingReads.current].slice(0, 200),
              commandId: crypto.randomUUID(),
              expectedRevision: next.revision,
            };
            rememberReads();
          }
          try {
            const batch = pendingBatch.current;
            next = schema.parse(await current.current.notifications(batch));
            for (const id of batch.ids) pendingReads.current.delete(id);
            pendingBatch.current = null;
            rememberReads();
          } catch (reason) {
            if (
              reason instanceof RequestError &&
              [403, 409].includes(reason.status)
            ) {
              if (reason.status === 403) {
                const visible = new Set(next.items.map((item) => item.id));
                for (const id of pendingReads.current)
                  if (!visible.has(id)) pendingReads.current.delete(id);
              }
              pendingBatch.current = null;
              rememberReads();
            }
            // An unknown outcome keeps the same command ID for the next poll.
          }
        }
        if (alive && version === generation.current) {
          const pending = pendingReads.current;
          const items = next.items.map((item) => ({
            ...item,
            read: item.read || pending.has(item.id),
          }));
          setView({
            ...next,
            items,
            unread:
              next.mode === "all"
                ? items.filter((item) => !item.read).length
                : 0,
          });
          setLoadError("");
        }
      } catch {
        if (alive && version === generation.current)
          setLoadError("暂时无法同步通知。");
      } finally {
        refreshing = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    const changed = () => {
      generation.current++;
      void refresh();
    };
    window.addEventListener("morphz:notifications-changed", changed);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("morphz:notifications-changed", changed);
    };
  }, []);
  useModal(dialog, heading, open, visibleProfileMenuTrigger);
  function settings() {
    setOpen(false);
    trigger.current?.focus();
    onSettings();
  }
  return (
    <>
      {!hideTrigger && (
        <button
          ref={trigger}
          className="icon-button notification-trigger"
          aria-label={`通知${view.unread ? `，${view.unread} 项未读` : ""}`}
          title="通知"
          onClick={() => setOpen(true)}
        >
          <Bell size={17} />
          {view.unread > 0 && (
            <span className="notification-badge" aria-hidden="true">
              {view.unread > 99 ? "99+" : view.unread}
            </span>
          )}
        </button>
      )}
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
            <button
              className="icon-button"
              aria-label="通知设置"
              onClick={settings}
            >
              <Settings2 />
            </button>
            <button
              className="icon-button"
              aria-label="关闭通知"
              onClick={() => setOpen(false)}
            >
              <X />
            </button>
          </header>
          {(error || loadError) && <p role="alert">{error || loadError}</p>}
          <div className="notification-list">
            {view.items.map((i) => (
              <button
                key={i.id}
                data-unread={!i.read}
                aria-label={`${i.read ? "" : "未读，"}${i.title}，${i.reason}`}
                onClick={async () => {
                  setError("");
                  try {
                    // Navigation must not wait on a read receipt. Refresh first
                    // only to revalidate the current authorized workspace.
                    await current.current.verifyArtifact(i.artifactId);
                    pendingReads.current.add(i.id);
                    rememberReads();
                    setOpen(false);
                    onOpen(i.artifactId);
                    window.dispatchEvent(
                      new Event("morphz:notifications-changed"),
                    );
                  } catch (e) {
                    setError(
                      e instanceof RequestError &&
                        [401, 403, 404].includes(e.status)
                        ? "请重新登录或检查事项权限。"
                        : "暂时无法确认事项权限，请重试。",
                    );
                  }
                }}
              >
                <strong>{i.title}</strong>
                <small>{i.reason}</small>
              </button>
            ))}
            {!view.items.length && !error && !loadError && (
              <p className="notification-empty">暂无通知</p>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
