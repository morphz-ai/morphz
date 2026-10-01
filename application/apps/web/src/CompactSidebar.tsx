import { Bell, MoreHorizontal, Palette, Search, Settings } from "lucide-react";
import { ComposerOptions, type ComposerOption } from "./ComposerOptions.js";
import type { SettingsSection } from "./SettingsDialog.js";

/** The rail reuses the five original navigation buttons; only utilities fold. */
export function CompactSidebar({
  unreadNotifications,
  onSearch,
  onSettings,
  onNotifications,
}: {
  unreadNotifications: number;
  onSearch: () => void;
  onSettings: (section?: SettingsSection) => void;
  onNotifications: () => void;
}) {
  const options: ComposerOption[] = [
    { label: "搜索资料", text: "搜索", icon: <Search />, onSelect: onSearch },
    {
      label: "外观设置",
      text: "外观",
      icon: <Palette />,
      onSelect: () => onSettings("appearance"),
    },
    {
      label: `通知${unreadNotifications ? `，${unreadNotifications} 项未读` : ""}`,
      text: "通知",
      icon: <Bell />,
      onSelect: onNotifications,
    },
    { label: "设置", icon: <Settings />, onSelect: () => onSettings() },
  ];
  return (
    <div className="compact-sidebar-controls">
      <ComposerOptions
        label="更多"
        description={
          unreadNotifications ? `${unreadNotifications} 项未读通知` : undefined
        }
        menuLabel="侧栏选项"
        triggerClassName="icon-button compact-sidebar-button compact-sidebar-more"
        triggerIcon={
          <>
            <MoreHorizontal />
            {unreadNotifications > 0 && (
              <span className="compact-sidebar-unread" aria-hidden="true" />
            )}
          </>
        }
        options={[]}
        content={(close) =>
          options.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-label={option.label}
              onClick={() => {
                close();
                option.onSelect();
              }}
            >
              {option.icon}
              <span>{option.text ?? option.label}</span>
            </button>
          ))
        }
      />
    </div>
  );
}
