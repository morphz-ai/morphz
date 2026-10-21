import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ControlIcon } from "./design/control-icons.js";
import { IconButton } from "./ui/IconButton.js";
import { ComposerOptions } from "./ComposerOptions.js";
import {
  ComposerToolButtons,
  type ComposerTool,
} from "./ComposerToolButtons.js";
import type { InteractionMode } from "./interaction.js";
import {
  ExchangeResizeHandle,
  type ExchangeResizeOptions,
} from "./ExchangeResizeHandle.js";

/** One shared reading/writing surface, floating above cognitive applications. */
export function ExchangePanel({
  open,
  conversationVisible,
  scopeRef,
  resize,
  children,
  controls,
}: {
  open: boolean;
  conversationVisible: boolean;
  scopeRef: (element: HTMLDivElement | null) => void;
  resize?: ExchangeResizeOptions;
  children: ReactNode;
  controls?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = panel.current;
    const dock = root?.querySelector<HTMLElement>(".composer-dock");
    if (!root) return;
    const workspace = root.closest<HTMLElement>(".primary-panel");
    let floating: HTMLElement | null = null;
    let controls: HTMLElement | null = null;
    const heights = new Map<Element, number>();
    const publish = () => {
      // ResizeObserver has already computed these border boxes in layout CSS
      // pixels. Reading offsetHeight here would synchronously lay out the long
      // conversation again after another observer/React commit changed it.
      const panelHeight = heights.get(root);
      if (
        panelHeight === undefined ||
        (floating && !heights.has(floating)) ||
        (controls && !heights.has(controls))
      )
        return;
      const toolsHeight = Math.max(
        floating ? heights.get(floating)! : 0,
        controls ? heights.get(controls)! : 0,
      );
      const toolsValue = `${toolsHeight}px`;
      // Read styles before writing either custom property. A genuine tools
      // size change may resize the panel; its next border-box notification
      // then publishes that real geometry, without a read/write/read flush.
      const margin = parseFloat(getComputedStyle(root).marginBottom) || 0;
      const overlayValue = `${Math.ceil(panelHeight + toolsHeight + margin)}px`;
      if (
        ((!floating && !controls) || toolsHeight > 0) &&
        root.style.getPropertyValue("--composer-tools-height") !== toolsValue
      )
        root.style.setProperty("--composer-tools-height", toolsValue);
      if (
        workspace &&
        workspace.style.getPropertyValue("--exchange-overlay-height") !==
          overlayValue
      )
        workspace.style.setProperty("--exchange-overlay-height", overlayValue);
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize[0];
        if (box) heights.set(entry.target, Math.round(box.blockSize));
      }
      publish();
    });
    const syncTargets = () => {
      let changed = false;
      const next = root.querySelector<HTMLElement>(".application-dock");
      if (next !== floating) {
        if (floating) {
          observer.unobserve(floating);
          heights.delete(floating);
        }
        floating = next;
        if (floating) observer.observe(floating, { box: "border-box" });
        changed = true;
      }
      const nextControls = root.querySelector<HTMLElement>(
        ".exchange-controls-slot",
      );
      if (nextControls !== controls) {
        if (controls) {
          observer.unobserve(controls);
          heights.delete(controls);
        }
        controls = nextControls;
        if (controls) observer.observe(controls, { box: "border-box" });
        changed = true;
      }
      // Draft text and live status mutate descendants without replacing these
      // targets. Such mutations do not need another synchronous measurement.
      if (changed) publish();
    };
    observer.observe(root, { box: "border-box" });
    // Draft navigation can replace the tool group without remounting the panel.
    const children = new MutationObserver(syncTargets);
    if (dock) children.observe(dock, { childList: true, subtree: true });
    // The stable exchange controls live beside the reading/writing content.
    // Observe only this root's direct mounts, not each streamed message node.
    children.observe(root, { childList: true });
    syncTargets();
    return () => {
      observer.disconnect();
      children.disconnect();
      workspace?.style.removeProperty("--exchange-overlay-height");
    };
  }, []);
  return (
    <div className="exchange-panel" data-open={open || undefined} ref={panel}>
      {open && conversationVisible && resize && (
        <ExchangeResizeHandle key={resize.scope} options={resize} />
      )}
      {open && conversationVisible && (
        <div className="exchange-panel-header">
          <div className="exchange-scope" ref={scopeRef} />
        </div>
      )}
      {controls && <div className="exchange-controls-slot">{controls}</div>}
      {children}
    </div>
  );
}

export function ExchangeControls({
  inputVisible = true,
  conversationVisible,
  readingSelected = conversationVisible,
  historyVisible,
  pinned,
  historyPinned = false,
  unread,
  onInteraction,
  onPin,
  onHistoryPin,
  onHide,
}: {
  inputVisible?: boolean;
  conversationVisible: boolean;
  readingSelected?: boolean;
  historyVisible: boolean;
  pinned: boolean;
  historyPinned?: boolean;
  unread: boolean;
  onInteraction: (mode: InteractionMode) => void;
  onPin: () => void;
  onHistoryPin?: () => void;
  onHide: () => void;
}) {
  const tools = useRef<HTMLDivElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const root = tools.current;
    const panel = root?.closest<HTMLElement>(".exchange-panel");
    if (!root || !panel) return;
    let previous = false;
    const measure = () => {
      // Layout pixels, not the zoomed visible rect, define available space.
      const next = panel.clientWidth <= 620;
      if (next === previous) return;
      previous = next;
      const history = root.querySelector<HTMLButtonElement>(":scope > button");
      const focused = document.activeElement;
      if (
        focused &&
        root.contains(focused) &&
        focused !== history &&
        focused !== hide.current
      )
        history?.focus({ preventScroll: true });
      setCompact(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, []);
  const secondaryOptions: ComposerTool[] = [
    {
      id: "history-size",
      label: historyVisible ? "返回工作内容" : "展开完整记录",
      iconId: historyVisible ? "minimize" : "maximize",
      pressed: historyVisible,
      onSelect: () =>
        onInteraction(
          historyVisible
            ? inputVisible
              ? "recent"
              : "recent-only"
            : inputVisible
              ? "history"
              : "history-only",
        ),
    },
    ...(conversationVisible && onHistoryPin
      ? [
          {
            id: "history-pin",
            label: historyPinned ? "取消固定交流记录" : "固定交流记录",
            iconId: "pin" as const,
            pressed: historyPinned,
            onSelect: onHistoryPin,
          },
        ]
      : []),
    ...(inputVisible
      ? [
          {
            id: "pin",
            label: pinned ? "取消固定输入框" : "固定输入框",
            iconId: "pin" as const,
            pressed: pinned,
            groupStart: conversationVisible && !!onHistoryPin,
            onSelect: onPin,
          },
        ]
      : []),
  ];
  return (
    <div
      className="exchange-view-tools"
      role="group"
      aria-label="交流面板操作"
      data-compact={compact || undefined}
      ref={tools}
    >
      <ComposerToolButtons
        unread={unread}
        options={[
          {
            id: "history-visibility",
            label: readingSelected ? "收起交流记录" : "查看交流记录",
            iconId: "message-square-text",
            pressed: readingSelected,
            onSelect: () =>
              onInteraction(
                readingSelected
                  ? inputVisible
                    ? "input"
                    : "hidden"
                  : "recent",
              ),
          },
        ]}
      />
      {compact ? (
        <ComposerOptions
          label="更多交流选项"
          menuLabel="交流选项"
          below={conversationVisible}
          options={secondaryOptions.map(({ iconId, ...option }) => ({
            ...option,
            icon: <ControlIcon name={iconId} />,
          }))}
        />
      ) : (
        <ComposerToolButtons options={secondaryOptions} />
      )}
      {inputVisible && (
        <IconButton
          controlRole="exchange-operation"
          iconId="chevron-down"
          ref={hide}
          className="icon-button"
          aria-label="收起 AI 输入框"
          title="收起 AI 输入框"
          onClick={onHide}
        />
      )}
    </div>
  );
}
