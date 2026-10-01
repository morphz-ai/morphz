import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_ICON_WIDTH,
  resizeSidebar,
  sidebarLayout,
  stepSidebar,
  type SidebarPreference,
} from "./sidebar-layout.js";

export function useSidebarLayout(preference: SidebarPreference) {
  const [available, setAvailable] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const measure = () => setAvailable(window.innerWidth);
    window.addEventListener("resize", measure);
    measure();
    return () => window.removeEventListener("resize", measure);
  }, []);
  return sidebarLayout(available, preference);
}

/** Pointer frames paint only shell geometry; commit local layout once on release. */
export function SidebarResizeHandle({
  preference,
  scope,
  onCommit,
}: {
  preference: SidebarPreference;
  scope: string;
  onCommit: (preference: SidebarPreference) => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const latest = useRef({ preference, scope, onCommit });
  latest.current = { preference, scope, onCommit };
  const drag = useRef<{
    pointer: number;
    x: number;
    startX: number;
    startWidth: number;
    preference: SidebarPreference;
    scope: string;
    moved: boolean;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [range, setRange] = useState({
    width: SIDEBAR_DEFAULT_WIDTH,
    maxWidth: 360,
    compact: false,
  });

  function paint() {
    const root = handle.current?.closest<HTMLElement>(".app");
    if (!root) return;
    const gesture = drag.current;
    const base = sidebarLayout(root.clientWidth, latest.current.preference);
    const preferred = gesture?.moved
      ? resizeSidebar(
          gesture.startWidth + gesture.x - gesture.startX,
          base.maxWidth,
          gesture.preference,
        )
      : latest.current.preference;
    const layout = sidebarLayout(root.clientWidth, preferred);
    root.style.setProperty("--sidebar-width", `${layout.width}px`);
    root.classList.toggle(
      "sidebar-compact",
      !root.classList.contains("sidebar-hidden") && layout.compact,
    );
    root.toggleAttribute("data-sidebar-resizing", !!gesture?.moved);
    setRange((old) =>
      old.width === layout.width &&
      old.maxWidth === layout.maxWidth &&
      old.compact === layout.compact
        ? old
        : {
            width: layout.width,
            maxWidth: layout.maxWidth,
            compact: layout.compact,
          },
    );
  }

  function finish(commit: boolean) {
    const gesture = drag.current;
    if (!gesture) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setCapturing(false);
    if (handle.current?.hasPointerCapture(gesture.pointer))
      handle.current.releasePointerCapture(gesture.pointer);
    if (commit && gesture.moved && gesture.scope === latest.current.scope) {
      const root = handle.current!.closest<HTMLElement>(".app")!;
      latest.current.onCommit(
        resizeSidebar(
          gesture.startWidth + gesture.x - gesture.startX,
          sidebarLayout(root.clientWidth, gesture.preference).maxWidth,
          gesture.preference,
        ),
      );
    } else paint();
    handle.current?.closest(".app")?.removeAttribute("data-sidebar-resizing");
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const gesture = drag.current;
      if (!gesture || event.pointerId !== gesture.pointer) return;
      gesture.x = event.clientX;
      gesture.moved ||= Math.abs(gesture.x - gesture.startX) >= 3;
      if (frame.current === null)
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          paint();
        });
    };
    const release = (event: PointerEvent) => {
      const gesture = drag.current;
      if (!gesture || event.pointerId !== gesture.pointer) return;
      gesture.x = event.clientX;
      gesture.moved ||= Math.abs(gesture.x - gesture.startX) >= 3;
      finish(true);
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === drag.current?.pointer) finish(false);
    };
    const blur = () => finish(false);
    const resize = () => {
      finish(false);
      paint();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      drag.current = null;
      handle.current?.closest(".app")?.removeAttribute("data-sidebar-resizing");
    };
  }, []);
  useLayoutEffect(() => {
    finish(false);
    paint();
  }, [preference.sidebarWidth, preference.sidebarCompact, scope]);

  return (
    <>
      {capturing &&
        createPortal(
          <div className="sidebar-resize-shield" aria-hidden="true" />,
          document.body,
        )}
      <div
        ref={handle}
        className="sidebar-resizer"
        role="separator"
        aria-label="调整左侧栏宽度"
        aria-controls="workspace-sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_ICON_WIDTH}
        aria-valuemax={range.maxWidth}
        aria-valuenow={range.width}
        aria-valuetext={
          range.compact ? "图标模式" : `侧栏宽度 ${range.width} 像素`
        }
        title="拖动调整侧栏宽度"
        tabIndex={0}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            startX: event.clientX,
            startWidth: range.width,
            preference: latest.current.preference,
            scope: latest.current.scope,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setCapturing(true);
        }}
        onLostPointerCapture={() => finish(false)}
        onDoubleClick={() =>
          latest.current.onCommit({
            sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
            sidebarCompact: false,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
            return;
          }
          if (drag.current) return;
          const next = stepSidebar(
            range.width,
            event.key,
            event.shiftKey,
            range.maxWidth,
            latest.current.preference,
          );
          if (next) {
            event.preventDefault();
            event.stopPropagation();
            latest.current.onCommit(next);
          }
        }}
      />
    </>
  );
}
