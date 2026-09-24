import { useLayoutEffect, useRef, useState } from "react";
import { Bell, Keyboard, Palette, Plug, Settings2, X } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import { ModelSettings } from "./ModelSettings.js";
import { ConnectionSettings } from "./ConnectionDetails.js";
import { NotificationPreferences } from "./Notifications.js";
import { useModal } from "./useModal.js";
import { AppearanceChoices } from "./AppearanceControls.js";
import type { InterfacePreferences } from "./interface-preferences.js";

export type SettingsSection =
  "models" | "appearance" | "input" | "notifications" | "connection";

export function SettingsDialog({
  client,
  initialSection,
  prefs,
  onPreference,
  onClose,
}: {
  client: WorkspaceClient;
  initialSection?: SettingsSection;
  prefs: InterfacePreferences;
  onPreference: (update: Partial<InterfacePreferences>) => void;
  onClose: () => void;
}) {
  const sections = [
    ...(client.boot!.capabilities.modelSettings
      ? [{ id: "models" as const, label: "模型与账号", icon: Settings2 }]
      : []),
    { id: "appearance" as const, label: "外观", icon: Palette },
    { id: "input" as const, label: "输入", icon: Keyboard },
    { id: "notifications" as const, label: "通知", icon: Bell },
    { id: "connection" as const, label: "智能体连接", icon: Plug },
  ];
  const first =
    sections.find((s) => s.id === initialSection)?.id ?? sections[0]!.id;
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const [active, setActive] = useState<SettingsSection>(first);
  const [visited, setVisited] = useState<SettingsSection[]>([first]);
  const [modelBusy, setModelBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const busy = modelBusy || connectionBusy || notificationBusy;
  const dialog = useRef<HTMLDialogElement>(null),
    content = useRef<HTMLDivElement>(null),
    closeButton = useRef<HTMLButtonElement>(null);
  useModal(dialog, closeButton, true, (origin) =>
    origin.matches(".profile-settings")
      ? ([...document.querySelectorAll<HTMLElement>(".profile-settings")].find(
          (button) => button.getClientRects().length > 0,
        ) ?? null)
      : null,
  );
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [active]);
  function select(section: SettingsSection) {
    if (busy) return;
    setVisited((previous) =>
      previous.includes(section) ? previous : [...previous, section],
    );
    setActive(section);
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog settings-dialog"
      aria-label="设置"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>设置</h2>
        <button
          ref={closeButton}
          className="icon-button"
          aria-label="关闭设置"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="settings-layout">
        <nav
          className="settings-navigation"
          aria-label="设置分类"
          onKeyDown={(event) => {
            if (
              ![
                "ArrowDown",
                "ArrowUp",
                "ArrowLeft",
                "ArrowRight",
                "Home",
                "End",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (["ArrowDown", "ArrowRight"].includes(event.key)
                        ? 1
                        : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={active === id ? "page" : undefined}
              disabled={busy}
              onClick={() => select(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={content}>
          {visited.includes("models") && (
            <section hidden={active !== "models"} aria-label="模型与账号">
              <ModelSettings
                embedded
                onChanged={() => void client.refresh()}
                onBusy={setModelBusy}
                exitLocked={busy}
                onClose={onClose}
                closeButton={closeButton}
              />
            </section>
          )}
          {visited.includes("appearance") && (
            <section
              hidden={active !== "appearance"}
              className="appearance-settings"
              aria-label="外观设置面板"
            >
              <header>
                <h2>外观</h2>
              </header>
              <AppearanceChoices prefs={prefs} onPreference={onPreference} />
              <label className="settings-row">
                <span>
                  阅读字号<small>消息与文档正文，不改变 PDF 或网页。</small>
                </span>
                <select
                  aria-label="阅读字号"
                  value={prefs.textSize}
                  onChange={(event) =>
                    onPreference({
                      textSize: event.target
                        .value as InterfacePreferences["textSize"],
                    })
                  }
                >
                  <option value="standard">标准</option>
                  <option value="large">较大</option>
                  <option value="larger">更大</option>
                </select>
              </label>
              <p className="reading-size-preview" data-size={prefs.textSize}>
                让内容更容易阅读。Aa 123
              </p>
              <label className="settings-row">
                <span>
                  动画效果<small>减少界面动效和回复文字的渐入。</small>
                </span>
                <select
                  aria-label="动画效果"
                  value={prefs.motion}
                  onChange={(event) =>
                    onPreference({
                      motion: event.target
                        .value as InterfacePreferences["motion"],
                    })
                  }
                >
                  <option value="system">跟随系统</option>
                  <option value="reduce">减少动画</option>
                </select>
              </label>
            </section>
          )}
          {visited.includes("input") && (
            <section hidden={active !== "input"} aria-label="输入设置面板">
              <header>
                <h2>输入</h2>
              </header>
              <label className="settings-row">
                <span>
                  发送快捷键
                  <small>
                    {prefs.sendShortcut === "enter"
                      ? "Shift + Enter 换行。"
                      : "Enter 换行，避免长文本误发送。"}
                  </small>
                </span>
                <select
                  aria-label="发送快捷键"
                  value={prefs.sendShortcut}
                  onChange={(event) =>
                    onPreference({
                      sendShortcut: event.target
                        .value as InterfacePreferences["sendShortcut"],
                    })
                  }
                >
                  <option value="enter">Enter 发送</option>
                  <option value="mod-enter">{modifier} + Enter 发送</option>
                </select>
              </label>
              <h3 className="settings-subheading">常用快捷键</h3>
              <dl className="settings-shortcuts">
                <div>
                  <dt>搜索资料</dt>
                  <dd>
                    <kbd>{modifier} K</kbd>
                  </dd>
                </div>
                <div>
                  <dt>显示／隐藏输入框</dt>
                  <dd>
                    <kbd>{modifier} J</kbd>
                  </dd>
                </div>
                <div>
                  <dt>关闭弹窗或菜单</dt>
                  <dd>
                    <kbd>Esc</kbd>
                  </dd>
                </div>
              </dl>
              <p className="settings-note">
                对话页使用 {modifier} J 聚焦输入框。
              </p>
            </section>
          )}
          {visited.includes("notifications") && (
            <div hidden={active !== "notifications"}>
              <NotificationPreferences
                client={client}
                onBusy={setNotificationBusy}
              />
            </div>
          )}
          {visited.includes("connection") && (
            <div hidden={active !== "connection"}>
              <ConnectionSettings
                embedded
                client={client}
                onClose={onClose}
                closeButton={closeButton}
                onModels={() => select("models")}
                onBusy={setConnectionBusy}
              />
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
