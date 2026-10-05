import { useLayoutEffect, useRef, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";
import { ComposerOptions } from "./ComposerOptions.js";
import {
  AppIcon,
  ApplicationImage,
  ApplicationLauncherIcon,
} from "./ApplicationIcon.js";
import { pinnedPresentationApplications } from "./application-dock-model.js";
import {
  normalizeApplicationPresentation,
  presentationKey,
  presentationTitle,
  presentationVersion,
  type ApplicationPresentationEntry,
  type CognitiveApplicationEntry,
} from "./application-presentation.js";
import "./application-dock.css";
import { useApplicationDockInteraction } from "./use-application-dock.js";

export function ApplicationDock({
  applications,
  pinned,
  activeKey,
  compactWithExchange = false,
  onPinned,
  onLaunch,
  cognitiveChoice,
  onManage,
}: {
  applications: readonly (
    ApplicationCatalogEntry | ApplicationPresentationEntry
  )[];
  pinned?: string[];
  activeKey?: string;
  compactWithExchange?: boolean;
  onPinned(keys: string[]): void;
  onLaunch(app: ApplicationCatalogEntry): Promise<void>;
  cognitiveChoice?: {
    scopeKey: string;
    selectedKey?: string;
    disabled?: boolean;
    onChoose(entry: CognitiveApplicationEntry, scopeKey: string): void;
  };
  onManage(): void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const launching = useRef(false);
  const shortcuts = useRef<HTMLDivElement>(null);
  const pins = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const menuScope = useRef<string | undefined>(undefined);
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
  const entries = normalizeApplicationPresentation(applications);
  const fixed = pinnedPresentationApplications(entries, pinned);
  // A project-local catalog can hide pins belonging to another work scene.
  // Editing one visible shortcut must not remove those saved preferences.
  const keys = pinned ?? fixed.map(presentationKey);
  const interaction = useApplicationDockInteraction({
    keys,
    available: entries.map(presentationKey),
    busy,
    compact,
    shortcuts,
    onPinned,
  });
  const insertionKeys = fixed
    .map(presentationKey)
    .filter((key) => key !== interaction.preview?.key);
  async function launch(app: ApplicationPresentationEntry, scopeKey?: string) {
    if (app.kind === "cognitive") {
      if (!cognitiveChoice?.disabled && scopeKey !== undefined)
        cognitiveChoice?.onChoose(app, scopeKey);
      return;
    }
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    setError("");
    try {
      await onLaunch(app.application);
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
      data-dragging={interaction.preview ? true : undefined}
      {...interaction.handlers}
    >
      <div className="application-dock-buttons" ref={shortcuts}>
        <div
          className="application-dock-pins"
          ref={pins}
          data-drop-end={
            interaction.preview?.index === insertionKeys.length || undefined
          }
        >
          {fixed.map((app) => (
            <button
              className="application-dock-shortcut"
              key={presentationKey(app)}
              aria-label={
                app.kind === "cognitive"
                  ? `用于本次输入：${presentationTitle(app)} ${presentationVersion(app)}`
                  : `打开${presentationTitle(app)}`
              }
              title={
                app.kind === "cognitive"
                  ? `${presentationTitle(app)} ${presentationVersion(app)} · 用于本次输入`
                  : presentationTitle(app)
              }
              disabled={
                busy ||
                (app.kind === "cognitive" &&
                  (!cognitiveChoice || cognitiveChoice.disabled))
              }
              aria-pressed={
                app.kind === "cognitive"
                  ? cognitiveChoice?.selectedKey === app.key
                  : activeKey === presentationKey(app)
              }
              aria-description="拖动调整顺序，拖出仅移除快捷入口；也可按 Alt 加左右方向键排序，Delete 取消固定"
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete"
              data-dock-key={presentationKey(app)}
              data-dock-source="dock"
              data-drag-source={
                interaction.preview?.key === presentationKey(app) || undefined
              }
              data-drop-before={
                interaction.preview?.index ===
                  insertionKeys.indexOf(presentationKey(app)) || undefined
              }
              onKeyDown={(event) =>
                interaction.keyboard(event, presentationKey(app))
              }
              onClick={() => void launch(app, cognitiveChoice?.scopeKey)}
            >
              {app.kind === "builtin" ? (
                <AppIcon app={app.application} />
              ) : (
                <ApplicationImage
                  app={
                    app.kind === "cognitive" ? app.metadata : app.application
                  }
                />
              )}
            </button>
          ))}
        </div>
        <ComposerOptions
          triggerRef={launcher}
          label="全部应用"
          menuLabel="选择应用"
          triggerIcon={<ApplicationLauncherIcon />}
          triggerClassName="application-dock-shortcut"
          menuClassName={`application-dock-menu application-dock-menu-${Math.min(4, Math.max(1, entries.length))}`}
          // Opening the Launcher does not select the first app or reveal its
          // secondary pin action. Tab enters the existing launch/pin sequence.
          initialFocus="panel"
          align="center"
          horizontalAnchorRef={shortcuts}
          onOpenChange={(open) => {
            if (!open) menuScope.current = undefined;
            else if (menuScope.current === undefined)
              menuScope.current = cognitiveChoice?.scopeKey;
            interaction.setMenuOpen(open);
          }}
          options={[]}
          content={(close) => (
            <>
              <div
                className="application-dock-catalog"
                role="list"
                aria-label="已授权应用"
              >
                {entries.map((app) => {
                  const key = presentationKey(app),
                    selected = keys.includes(key);
                  return (
                    <div
                      key={key}
                      className="application-dock-entry"
                      role="listitem"
                    >
                      <button
                        className="application-dock-launch"
                        aria-label={
                          app.kind === "cognitive"
                            ? `用于本次输入：${presentationTitle(app)} ${presentationVersion(app)}`
                            : `打开${presentationTitle(app)}`
                        }
                        title={
                          app.kind === "cognitive"
                            ? `${presentationTitle(app)} ${presentationVersion(app)} · 用于本次输入`
                            : presentationTitle(app)
                        }
                        disabled={
                          busy ||
                          (app.kind === "cognitive" &&
                            (!cognitiveChoice || cognitiveChoice.disabled))
                        }
                        data-dock-key={key}
                        data-dock-source="launcher"
                        data-drag-source={
                          interaction.preview?.key === key || undefined
                        }
                        aria-description="拖到 Dock 固定；也可使用旁边的图钉"
                        onKeyDown={(event) => interaction.keyboard(event, key)}
                        onClick={() => {
                          const scope = menuScope.current;
                          close();
                          void launch(app, scope);
                        }}
                      >
                        <span className="application-dock-app-icon">
                          {app.kind === "builtin" ? (
                            <AppIcon
                              app={app.application}
                              presentation="tile"
                            />
                          ) : (
                            <ApplicationImage
                              app={
                                app.kind === "cognitive"
                                  ? app.metadata
                                  : app.application
                              }
                            />
                          )}
                        </span>
                        <span className="application-dock-app-name">
                          {presentationTitle(app)}
                          {app.kind === "cognitive"
                            ? ` ${presentationVersion(app)}`
                            : ""}
                        </span>
                      </button>
                      <button
                        className="icon-button application-dock-pin"
                        aria-label={`${selected ? "从 Dock 移除" : "固定到 Dock"}：${presentationTitle(app)}`}
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
      {interaction.preview && (
        <span className="application-dock-drag-hint" aria-hidden="true">
          {interaction.preview.removing
            ? "移除快捷入口（保留应用）"
            : interaction.preview.index !== null
              ? "松开固定到此处"
              : "拖到 Dock 固定"}
        </span>
      )}
      <span className="application-dock-announcement" role="status">
        {interaction.announcement}
      </span>
    </div>
  );
}
