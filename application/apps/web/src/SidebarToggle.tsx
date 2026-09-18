import { PanelLeft, PanelRight } from "lucide-react";

/** The same visibility control for the two sides of the Host window. */
export function SidebarToggle({
  side,
  expanded,
  controls,
  className = "",
  title,
  onClick,
}: {
  side: "left" | "right";
  expanded: boolean;
  controls: string;
  className?: string;
  title?: string;
  onClick: () => void;
}) {
  const label =
    side === "left"
      ? expanded
        ? "隐藏侧边栏"
        : "显示侧边栏"
      : expanded
        ? "隐藏右侧栏"
        : "显示右侧栏";
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <button
      className={`icon-button sidebar-visibility-toggle ${className}`}
      aria-label={label}
      title={title ?? label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
    >
      <Icon />
    </button>
  );
}
