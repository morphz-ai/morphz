import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SidebarToggle } from "./SidebarToggle.js";
import {
  inspectorLayout,
  INSPECTOR_MIN_WIDTH,
  type InspectorLayout,
} from "./inspector-layout.js";

export function useInspectorLayout(preferred: number) {
  const [workspace, setWorkspace] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  const ref = useCallback(
    (node: HTMLDivElement | null) => setWorkspace(node),
    [],
  );
  useLayoutEffect(() => {
    if (!workspace) return;
    const measure = () => setAvailable(workspace.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [workspace]);
  return { ref, layout: inspectorLayout(available, preferred) };
}

/** One non-modal Host inspector. Only its contents and provenance vary. */
export function InspectorPanel({
  className,
  label,
  title,
  context,
  leading,
  actions,
  resizeLabel,
  layout,
  onResize,
  onClose,
  children,
  footer,
}: {
  className: string;
  label: string;
  title: string;
  context?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  resizeLabel: string;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <aside
      id="workspace-inspector"
      className={`workspace-inspector ${className}`}
      aria-label={label}
      data-inspector-mode={layout.mode}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {layout.mode === "docked" && (
        <div
          className="inspector-resizer"
          role="separator"
          aria-label={resizeLabel}
          aria-orientation="vertical"
          aria-valuemin={INSPECTOR_MIN_WIDTH}
          aria-valuemax={layout.maxWidth}
          aria-valuenow={layout.width}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onResize(
                Math.max(
                  INSPECTOR_MIN_WIDTH,
                  Math.min(
                    layout.maxWidth,
                    layout.width + (event.key === "ArrowLeft" ? 16 : -16),
                  ),
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const right =
              event.currentTarget.parentElement!.getBoundingClientRect().right;
            onResize(
              Math.max(
                INSPECTOR_MIN_WIDTH,
                Math.min(layout.maxWidth, right - event.clientX),
              ),
            );
          }}
          onPointerUp={(event) =>
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        />
      )}
      <header className="inspector-header">
        {leading}
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <span className="inspector-context" title={context}>
          {context}
        </span>
        {actions}
        <SidebarToggle
          side="right"
          expanded
          controls="workspace-inspector"
          onClick={onClose}
        />
      </header>
      <div className="inspector-scroll">{children}</div>
      {footer}
    </aside>
  );
}
