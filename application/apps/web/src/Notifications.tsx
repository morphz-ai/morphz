import { useEffect, useRef, useState } from "react";
import { useModal } from "./useModal.js";
import { visibleProfileMenuTrigger } from "./profile-menu-focus.js";
import { Bell, X, Settings2 } from "lucide-react";
import { z } from "zod";
import { RequestError, scopedStorage, type WorkspaceClient } from "./client.js";
import { createRefreshDrain } from "./refresh-drain.js";

type NotificationReadScope = {
  isCurrent: () => boolean;
  isActive: () => boolean;
};

/** A change hint is invalidation, not notification data. Idle views never poll;
 * foreground/open/manual intent reconciles missed hints. Only an unknown read
 * receipt gets two bounded, same-command recovery attempts. */
function useNotificationRefresh(
  client: WorkspaceClient,
  read: (scope: NotificationReadScope) => Promise<boolean>,
) {
  const latest = useRef({ read, online: client.online });
  latest.current = { read, online: client.online };
  const controller = useRef<(() => void) | null>(null);
  const request = () => controller.current?.();
  useEffect(() => {
    let alive = true,
      generation = 0,
      receiptRetries = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const active = () => alive && latest.current.online;
    const drain = createRefreshDrain(async () => {
      if (!active() || !visible()) return false;
      const version = generation;
      const retryReceipt = await latest.current.read({
        isActive: active,
        isCurrent: () => active() && visible() && version === generation,
      });
      if (
        retryReceipt &&
        active() &&
        visible() &&
        version === generation &&
        receiptRetries < 2
      ) {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(
          () => {
            timer = undefined;
            receiptRetries++;
            invalidate(false);
          },
          1000 * (receiptRetries + 1),
        );
      }
      return true;
    });
    function invalidate(explicit = true) {
      generation++;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (explicit) receiptRetries = 0;
      if (active() && visible()) void drain.request().catch(() => {});
    }
    controller.current = invalidate;
    const changed = () => invalidate();
    const foreground = () => {
      if (visible()) invalidate();
      else {
        generation++;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      }
    };
    window.addEventListener("morphz:notifications-changed", changed);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    // The revision effect below includes the initial authenticated read.
    return () => {
      alive = false;
      controller.current = null;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("morphz:notifications-changed", changed);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, []);
  useEffect(() => {
    if (client.online) request();
  }, [client.online, client.workspaceChangeRevision]);
  return request;
}

function notificationIdentity(client: WorkspaceClient) {
  const boot = client.boot;
  return boot
    ? `${boot.centerId}:${boot.principalId}:${boot.csrfToken}`
    : "disconnected";
}
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

type NotificationPreferencesProps = {
  client: WorkspaceClient;
  onBusy: (busy: boolean) => void;
};
export function NotificationPreferences(props: NotificationPreferencesProps) {
  return (
    <ScopedNotificationPreferences
      key={notificationIdentity(props.client)}
      {...props}
    />
  );
}

function ScopedNotificationPreferences({
  client,
  onBusy,
}: NotificationPreferencesProps) {
  const [view, setView] = useState<z.infer<typeof schema> | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
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
  async function load(scope: NotificationReadScope) {
    if (pending.current || !scope.isActive()) return false;
    try {
      const next = schema.parse(await current.current.notifications());
      if (scope.isCurrent()) {
        setView(next);
        setLoadError("");
      }
    } catch {
      if (scope.isCurrent()) setLoadError("暂时无法读取通知设置，请重试。");
    }
    return false;
  }
  const refresh = useNotificationRefresh(client, load);
  useEffect(() => {
    alive.current = true;
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
      if (!alive.current) return;
      pendingChoice.current = null;
      window.dispatchEvent(new Event("morphz:notifications-changed"));
      if (alive.current) setView(next);
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 409) {
        pendingChoice.current = null;
        refresh();
        if (alive.current) setError("通知设置已变化，请重新选择。");
      } else if (alive.current) setError("通知设置未确认保存，请重试。");
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        onBusy(false);
        refresh();
      }
    }
  }
  return (
    <section className="notification-settings" aria-label="通知偏好">
      <header>
        <h2>通知</h2>
      </header>
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
      {view && loadError && (
        <button className="secondary-action" onClick={refresh}>
          重试
        </button>
      )}
      {!view &&
        (error || loadError ? (
          <button className="secondary-action" onClick={refresh}>
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

type NotificationsProps = {
  client: WorkspaceClient;
  onOpen: (id: string) => void;
  onSettings: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  onUnreadChange?: (unread: number) => void;
};
export function Notifications(props: NotificationsProps) {
  return (
    <ScopedNotifications key={notificationIdentity(props.client)} {...props} />
  );
}

function ScopedNotifications({
  client,
  onOpen,
  onSettings,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  onUnreadChange,
}: NotificationsProps) {
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
  const alive = useRef(true);
  const storage = useState(() =>
    scopedStorage(
      client.boot
        ? `${client.boot.centerId}:${client.boot.principalId}`
        : "disconnected",
    ),
  )[0];
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
  async function load(scope: NotificationReadScope) {
    let retryReceipt = false;
    try {
      let next = schema.parse(await current.current.notifications());
      if (!scope.isCurrent()) return false;
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
          if (!scope.isActive()) return false;
          for (const id of batch.ids) pendingReads.current.delete(id);
          pendingBatch.current = null;
          rememberReads();
        } catch (reason) {
          if (!scope.isActive()) return false;
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
            retryReceipt = reason.status === 409;
          } else {
            // Unknown acknowledgements retry only twice, retaining this
            // immutable command. Afterwards foreground/open/manual intent
            // can reconcile it; healthy idle never repeats writes or reads.
            retryReceipt = true;
          }
        }
      }
      if (scope.isCurrent()) {
        const pending = pendingReads.current;
        const items = next.items.map((item) => ({
          ...item,
          read: item.read || pending.has(item.id),
        }));
        setView({
          ...next,
          items,
          unread:
            next.mode === "all" ? items.filter((item) => !item.read).length : 0,
        });
        setLoadError(retryReceipt ? "通知已打开，已读状态尚未确认。" : "");
      }
    } catch {
      if (scope.isCurrent()) setLoadError("暂时无法同步通知。");
    }
    return retryReceipt;
  }
  const refresh = useNotificationRefresh(client, load);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) refresh();
  }, [open]);
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
          {loadError && (
            <button className="secondary-action" onClick={refresh}>
              重试同步
            </button>
          )}
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
                    if (!alive.current || !current.current.online) return;
                    pendingReads.current.add(i.id);
                    rememberReads();
                    setOpen(false);
                    onOpen(i.artifactId);
                    window.dispatchEvent(
                      new Event("morphz:notifications-changed"),
                    );
                  } catch (e) {
                    if (!alive.current) return;
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
