import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronDown, History, Maximize2, Minimize2, Pin } from "lucide-react";
import { ComposerToolButtons } from "./ComposerToolButtons.js";
import type { InteractionMode } from "./interaction.js";

/** One reading/writing surface; floating history still reserves the input below. */
export function ExchangePanel({
  open,
  scopeRef,
  children,
}: {
  open: boolean;
  scopeRef: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = panel.current;
    const dock = root?.querySelector<HTMLElement>(".composer-dock");
    if (!root || !dock) return;
    let floating: HTMLElement | null = null;
    const measure = () => {
      const next = root.querySelector<HTMLElement>(".composer-floating-tools");
      if (next !== floating) {
        if (floating) observer.unobserve(floating);
        floating = next;
        if (floating) observer.observe(floating);
      }
      const toolsHeight = floating?.getBoundingClientRect().height ?? 0;
      if (!floating || toolsHeight > 0)
        root.style.setProperty("--composer-tools-height", `${toolsHeight}px`);
      const height = dock.getBoundingClientRect().height;
      // Screenshot selection temporarily hides the surface. Keep its last
      // occupied height so restoring the same input does not flash or jump.
      if (height > 0)
        root.parentElement?.style.setProperty(
          "--composer-dock-height",
          `${height}px`,
        );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    // Draft navigation can replace the tool group without remounting the panel.
    const children = new MutationObserver(measure);
    children.observe(dock, { childList: true, subtree: true });
    measure();
    return () => {
      observer.disconnect();
      children.disconnect();
    };
  }, []);
  return (
    <div className="exchange-panel" data-open={open || undefined} ref={panel}>
      {open && (
        <div className="exchange-panel-header">
          <div className="exchange-scope" ref={scopeRef} />
        </div>
      )}
      {children}
    </div>
  );
}

export function ExchangeControls({
  conversationVisible,
  historyVisible,
  pinned,
  unread,
  onInteraction,
  onPin,
  onHide,
}: {
  conversationVisible: boolean;
  historyVisible: boolean;
  pinned: boolean;
  unread: boolean;
  onInteraction: (mode: InteractionMode) => void;
  onPin: () => void;
  onHide: () => void;
}) {
  return (
    <>
      <ComposerToolButtons
        unread={unread}
        options={[
          {
            id: "history-visibility",
            label: conversationVisible ? "收起交流记录" : "查看交流记录",
            icon: <History />,
            pressed: conversationVisible,
            onSelect: () =>
              onInteraction(conversationVisible ? "input" : "recent"),
          },
          {
            id: "history-size",
            label: historyVisible ? "返回工作内容" : "展开完整记录",
            icon: historyVisible ? <Minimize2 /> : <Maximize2 />,
            pressed: historyVisible,
            onSelect: () =>
              onInteraction(historyVisible ? "recent" : "history"),
          },
          {
            id: "pin",
            label: pinned ? "取消固定输入框" : "固定输入框",
            icon: <Pin />,
            pressed: pinned,
            onSelect: onPin,
          },
        ]}
      />
      <button
        className="icon-button"
        aria-label="收起 AI 输入框"
        title="收起 AI 输入框"
        onClick={onHide}
      >
        <ChevronDown />
      </button>
    </>
  );
}
