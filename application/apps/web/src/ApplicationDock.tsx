import { useRef, useState } from "react";
import { Grid2X2, Pin, PinOff } from "lucide-react";
import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { AppIcon } from "./ApplicationHost.js";
import {
  applicationKey,
  pinnedApplications,
} from "./application-dock-model.js";
import "./application-dock.css";

export function ApplicationDock({
  applications,
  pinned,
  activeKey,
  onPinned,
  onLaunch,
  onManage,
}: {
  applications: ApplicationCatalogEntry[];
  pinned?: string[];
  activeKey?: string;
  onPinned(keys: string[]): void;
  onLaunch(app: ApplicationCatalogEntry): Promise<void>;
  onManage(): void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const launching = useRef(false);
  const fixed = pinnedApplications(applications, pinned);
  // A project-local catalog can hide pins belonging to another work scene.
  // Editing one visible shortcut must not remove those saved preferences.
  const keys = pinned ?? fixed.map(applicationKey);
  async function launch(app: ApplicationCatalogEntry) {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    setError("");
    try {
      await onLaunch(app);
    } catch (e) {
      setError(e instanceof Error ? e.message : "应用暂时无法打开。");
    } finally {
      launching.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="application-dock" aria-label="应用 Dock">
      <div className="application-dock-buttons">
        {fixed.map((app) => (
          <button
            className="application-dock-shortcut"
            key={applicationKey(app)}
            aria-label={`打开${app.title}`}
            title={app.title}
            disabled={busy}
            aria-pressed={activeKey === applicationKey(app)}
            onClick={() => void launch(app)}
          >
            <AppIcon app={app} />
          </button>
        ))}
        <ComposerOptions
          label="全部应用"
          menuLabel="选择应用"
          triggerIcon={<Grid2X2 />}
          triggerClassName="application-dock-shortcut"
          menuClassName="application-dock-menu"
          options={[]}
          content={(close) => (
            <>
              <div className="application-dock-catalog">
                {applications.map((app) => {
                  const key = applicationKey(app),
                    selected = keys.includes(key);
                  return (
                    <div key={key} className="application-dock-entry">
                      <button
                        disabled={busy}
                        onClick={() => {
                          close();
                          void launch(app);
                        }}
                      >
                        <AppIcon app={app} />
                        <span>{app.title}</span>
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`${selected ? "从 Dock 移除" : "固定到 Dock"}：${app.title}`}
                        title={selected ? "从 Dock 移除" : "固定到 Dock"}
                        aria-pressed={selected}
                        onClick={() =>
                          onPinned(
                            selected
                              ? keys.filter((id) => id !== key)
                              : [...keys, key],
                          )
                        }
                      >
                        {selected ? <PinOff /> : <Pin />}
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                className="application-dock-manage"
                onClick={() => {
                  close();
                  onManage();
                }}
              >
                在工作台管理应用
              </button>
            </>
          )}
        />
      </div>
      {error && (
        <p role="alert" className="application-dock-error">
          {error}
        </p>
      )}
    </div>
  );
}
