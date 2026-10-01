import {
  Bell,
  ChevronsUpDown,
  LogOut,
  Palette,
  Search,
  Settings,
  UserRound,
} from "lucide-react";
import { ComposerOptions, type ComposerOption } from "./ComposerOptions.js";

export function ProfileMenu({
  name,
  status,
  connected,
  compact = false,
  unreadNotifications = 0,
  onSearch,
  onAppearance,
  onNotifications,
  onSettings,
  onLogout,
}: {
  name: string;
  status: string;
  connected: boolean;
  compact?: boolean;
  unreadNotifications?: number;
  onSearch?: () => void;
  onAppearance?: () => void;
  onNotifications?: () => void;
  onSettings: () => void;
  onLogout?: () => void;
}) {
  const identity = (
    <>
      <span className="avatar" aria-hidden="true">
        <UserRound />
        {unreadNotifications > 0 && <span className="profile-unread" />}
      </span>
      {!compact && (
        <span className="profile-identity">
          <span className="profile-name" title={name}>
            {name}
          </span>
          <span className="profile-status">
            <span
              className="presence-dot"
              data-online={connected}
              aria-hidden="true"
            />
            <span>{status}</span>
          </span>
        </span>
      )}
      {!compact && (
        <ChevronsUpDown className="sidebar-entry-chevron" aria-hidden="true" />
      )}
      {!connected && (
        <span className="profile-warning" aria-label={status}>
          !
        </span>
      )}
    </>
  );
  const options: ComposerOption[] = [
    ...(onSearch
      ? [
          {
            label: "搜索资料",
            text: "搜索",
            icon: <Search />,
            shortcut: /Mac/.test(navigator.platform) ? "⌘K" : "Ctrl+K",
            keyShortcut: /Mac/.test(navigator.platform)
              ? "Meta+K"
              : "Control+K",
            onSelect: onSearch,
          },
        ]
      : []),
    ...(onAppearance
      ? [
          {
            label: "外观设置",
            text: "外观",
            icon: <Palette />,
            onSelect: onAppearance,
          },
        ]
      : []),
    ...(onNotifications
      ? [
          {
            label: `通知${unreadNotifications ? `，${unreadNotifications} 项未读` : ""}`,
            text: "通知",
            icon: <Bell />,
            onSelect: onNotifications,
          },
        ]
      : []),
    { label: "设置", icon: <Settings />, onSelect: onSettings },
    ...(onLogout
      ? [
          {
            label: "退出当前身份",
            text: "退出登录",
            icon: <LogOut />,
            onSelect: onLogout,
          },
        ]
      : []),
  ];
  return (
    <div
      className={`profile-controls${compact ? " profile-controls-compact" : ""}`}
    >
      <ComposerOptions
        label="用户菜单"
        description={`${name} · ${status}${unreadNotifications ? ` · ${unreadNotifications} 项未读通知` : ""}`}
        menuLabel="用户菜单"
        below={compact}
        placement="right"
        triggerClassName={
          compact ? "icon-button profile-compact" : "profile-trigger"
        }
        menuClassName="profile-menu"
        triggerIcon={identity}
        header={
          <div className="profile-menu-summary">
            <strong title={name}>{name}</strong>
            <span>
              <span className="presence-dot" data-online={connected} />
              {status}
            </span>
          </div>
        }
        options={options}
      />
    </div>
  );
}
