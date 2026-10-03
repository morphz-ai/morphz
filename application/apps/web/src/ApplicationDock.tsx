import { useLayoutEffect, useRef, useState } from "react";
import { Grid2X2, Pin, PinOff } from "lucide-react";
import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { AppIcon } from "./ApplicationIcon.js";
import {
  applicationKey,
  pinnedApplications,
} from "./application-dock-model.js";
import "./application-dock.css";

export function ApplicationDock({
  applications,
  pinned,
  activeKey,
  compactWithExchange = false,
  onPinned,
  onLaunch,
  onManage,
}: {
  applications: ApplicationCatalogEntry[];
  pinned?: string[];
  activeKey?: string;
  compactWithExchange?: boolean;
  onPinned(keys: string[]): void;
  onLaunch(app: ApplicationCatalogEntry): Promise<void>;
  onManage(): void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const launching = useRef(false);
  const shortcuts = useRef<HTMLDivElement>(null);
  const pins = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const panel = shortcuts.current?.closest<HTMLElement>(".exchange-panel");
    if (!panel) return;
    const measure = () => {
      const next = compactWithExchange && panel.clientWidth <= 440;
      // Move focus before hiding its current node. A CSS-only breakpoint would
      // leave an invisible focus target, or dismiss the unpinned input.
      if (next && pins.current?.contains(document.activeElement))
        launcher.current?.focus({ preventScroll: true });
      setCompact((previous) => (previous === next ? previous : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [compactWithExchange]);
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
    <div
      className="application-dock"
      aria-label="应用 Dock"
      data-compact={compact || undefined}
    >
      <div className="application-dock-buttons" ref={shortcuts}>
        <div className="application-dock-pins" ref={pins}>
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
        </div>
        <ComposerOptions
          triggerRef={launcher}
          label="全部应用"
          menuLabel="选择应用"
          triggerIcon={<Grid2X2 />}
          triggerClassName="application-dock-shortcut"
          menuClassName={`application-dock-menu application-dock-menu-${Math.min(4, Math.max(1, applications.length))}`}
          // Opening the Launcher does not select the first app or reveal its
          // secondary pin action. Tab enters the existing launch/pin sequence.
          initialFocus="panel"
          align="center"
          horizontalAnchorRef={shortcuts}
          options={[]}
          content={(close) => (
            <>
              <div
                className="application-dock-catalog"
                role="list"
                aria-label="已授权应用"
              >
                {applications.map((app) => {
                  const key = applicationKey(app),
                    selected = keys.includes(key);
                  return (
                    <div
                      key={key}
                      className="application-dock-entry"
                      role="listitem"
                    >
                      <button
                        className="application-dock-launch"
                        aria-label={`打开${app.title}`}
                        title={app.title}
                        disabled={busy}
                        onClick={() => {
                          close();
                          void launch(app);
                        }}
                      >
                        <span className="application-dock-app-icon">
                          <AppIcon app={app} presentation="tile" />
                        </span>
                        <span className="application-dock-app-name">
                          {app.title}
                        </span>
                      </button>
                      <button
                        className="icon-button application-dock-pin"
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
