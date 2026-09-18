import { ChevronsUpDown, LogOut, Settings, UserRound } from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";

export function ProfileMenu({
  name,
  status,
  connected,
  compact = false,
  onSettings,
  onLogout,
}: {
  name: string;
  status: string;
  connected: boolean;
  compact?: boolean;
  onSettings: () => void;
  onLogout?: () => void;
}) {
  const identity = (
    <>
      <span className="avatar" aria-hidden="true">
        <UserRound />
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
      {!compact && onLogout && (
        <ChevronsUpDown className="sidebar-entry-chevron" aria-hidden="true" />
      )}
      {!connected && (
        <span className="profile-warning" aria-label={status}>
          !
        </span>
      )}
    </>
  );
  return (
    <div
      className={`profile-controls${compact ? " profile-controls-compact" : ""}`}
    >
      {onLogout ? (
        <ComposerOptions
          label="用户菜单"
          description={`${name} · ${status}`}
          menuLabel="用户菜单"
          below={compact}
          triggerClassName={
            compact ? "icon-button profile-compact" : "profile-trigger"
          }
          menuClassName="profile-menu"
          triggerIcon={identity}
          header={
            compact ? (
              <div className="profile-menu-summary">
                <strong title={name}>{name}</strong>
                <span>
                  <span className="presence-dot" data-online={connected} />
                  {status}
                </span>
              </div>
            ) : undefined
          }
          options={[
            {
              label: "退出当前身份",
              text: "退出登录",
              icon: <LogOut />,
              onSelect: onLogout,
            },
          ]}
        />
      ) : (
        <div
          className={
            compact
              ? "profile-compact profile-summary"
              : "profile-trigger profile-summary"
          }
          role="group"
          aria-label="当前身份"
          aria-description={`${name} · ${status}`}
          title={`${name} · ${status}`}
        >
          {identity}
        </div>
      )}
      <button
        type="button"
        className="icon-button profile-settings"
        aria-label="设置"
        title="设置"
        onClick={onSettings}
      >
        <Settings />
      </button>
    </div>
  );
}
