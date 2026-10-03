import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
  type MouseEvent,
  type DragEvent,
  type RefObject,
} from "react";
import {
  dockMagnification,
  placeDockApplication,
  removeDockApplication,
  sameDockOrder,
} from "./application-dock-interaction.js";

type Source = "dock" | "launcher";
type Preview = {
  key: string;
  index: number | null;
  removing: boolean;
  x: number;
  y: number;
};
type Gesture = {
  pointerId: number;
  source: Source;
  key: string;
  element: HTMLElement;
  x: number;
  y: number;
  saved: string[];
  catalog: string[];
  moved: boolean;
};

/** A gesture is local, cancellable UI intent. Only onPinned persists an order;
 * it never launches applications, mutates drafts or invokes domain operations. */
export function useApplicationDockInteraction({
  keys,
  available,
  busy,
  compact,
  shortcuts,
  onPinned,
}: {
  keys: string[];
  available: string[];
  busy: boolean;
  compact: boolean;
  shortcuts: RefObject<HTMLDivElement | null>;
  onPinned(keys: string[]): void;
}) {
  const latest = useRef({ keys, available, busy, compact, onPinned });
  latest.current = { keys, available, busy, compact, onPinned };
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const reorderFocus = useRef<{ keys: string[]; element: HTMLElement } | null>(
    null,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const hoverFrame = useRef(0);

  function clearMagnification() {
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    shortcuts.current
      ?.querySelectorAll<HTMLElement>(".application-dock-shortcut")
      .forEach((button) => {
        button.style.removeProperty("--dock-scale");
        button.style.removeProperty("--dock-lift");
        delete button.dataset.dockMagnified;
      });
  }
  function cancel(update = true) {
    const previous = gesture.current;
    gesture.current = null;
    if (previous?.element.hasPointerCapture(previous.pointerId))
      previous.element.releasePointerCapture(previous.pointerId);
    if (previous?.moved) suppressClick.current = true;
    if (update) setPreview(null);
    clearMagnification();
  }
  function currentGesture() {
    const current = gesture.current,
      state = latest.current;
    if (!current) return null;
    if (
      state.busy ||
      state.compact ||
      !sameDockOrder(current.saved, state.keys) ||
      !sameDockOrder(current.catalog, state.available)
    ) {
      cancel();
      return null;
    }
    return current;
  }
  useLayoutEffect(() => {
    currentGesture();
    const request = reorderFocus.current;
    if (request) {
      reorderFocus.current = null;
      if (
        sameDockOrder(request.keys, keys) &&
        request.element.isConnected &&
        (document.activeElement === document.body ||
          document.activeElement === request.element)
      )
        request.element.focus({ preventScroll: true });
    }
  }, [keys.join("\0"), available.join("\0"), busy, compact]);
  useLayoutEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const blur = () => cancel();
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", blur);
      cancel(false);
    };
  }, []);
  useLayoutEffect(() => {
    if (menuOpen) clearMagnification();
  }, [menuOpen]);
  useLayoutEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = matchMedia("(hover: hover) and (pointer: fine)");
    const changed = () => {
      clearMagnification();
      if (!pointer.matches) cancel();
    };
    motion.addEventListener("change", changed);
    pointer.addEventListener("change", changed);
    window.addEventListener("morphz:motion-preference-changed", changed);
    return () => {
      motion.removeEventListener("change", changed);
      pointer.removeEventListener("change", changed);
      window.removeEventListener("morphz:motion-preference-changed", changed);
    };
  }, []);

  function target(x: number, y: number, current: Gesture): Preview {
    const group = shortcuts.current!;
    const box = group.getBoundingClientRect();
    const viewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const within =
      viewport &&
      x >= box.left - 12 &&
      x <= box.right + 12 &&
      y >= box.top - 12 &&
      y <= box.bottom + 12;
    let index: number | null = null;
    if (within) {
      // Stable button rects: glyph paint magnification never affects insertion.
      const buttons = [
        ...group.querySelectorAll<HTMLElement>(
          ".application-dock-pins [data-dock-key]",
        ),
      ].filter((button) => button.dataset.dockKey !== current.key);
      index = buttons.findIndex((button) => {
        const rect = button.getBoundingClientRect();
        return x < (rect.left + rect.right) / 2;
      });
      if (index < 0) index = buttons.length;
    }
    return {
      key: current.key,
      index,
      removing: current.source === "dock" && !within && viewport,
      x,
      y,
    };
  }
  function commit(next: string[], message: string, element?: HTMLElement) {
    if (sameDockOrder(next, latest.current.keys)) return;
    if (element && document.activeElement === element)
      reorderFocus.current = { keys: next, element };
    latest.current.onPinned(next);
    setAnnouncement(message);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false;
    if (
      event.button !== 0 ||
      event.pointerType !== "mouse" ||
      !matchMedia("(hover: hover) and (pointer: fine)").matches ||
      busy ||
      compact
    )
      return;
    const element = (event.target as Element).closest<HTMLElement>(
      "[data-dock-key][data-dock-source]",
    );
    const key = element?.dataset.dockKey;
    if (!element || !key || !available.includes(key)) return;
    gesture.current = {
      pointerId: event.pointerId,
      key,
      source: element.dataset.dockSource as Source,
      element,
      x: event.clientX,
      y: event.clientY,
      saved: [...keys],
      catalog: [...available],
      moved: false,
    };
    element.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = currentGesture();
    if (current && current.pointerId === event.pointerId) {
      if (
        !current.moved &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6
      )
        return;
      current.moved = true;
      event.preventDefault();
      clearMagnification();
      setPreview(target(event.clientX, event.clientY, current));
      return;
    }
    if (
      menuOpen ||
      preview ||
      busy ||
      compact ||
      event.buttons !== 0 ||
      event.pointerType !== "mouse" ||
      !matchMedia("(hover: hover) and (pointer: fine)").matches ||
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.appMotion === "reduce"
    ) {
      clearMagnification();
      return;
    }
    cancelAnimationFrame(hoverFrame.current);
    const x = event.clientX;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      shortcuts.current
        ?.querySelectorAll<HTMLElement>(".application-dock-shortcut")
        .forEach((button) => {
          const rect = button.getBoundingClientRect();
          const paint = dockMagnification(x - (rect.left + rect.right) / 2);
          button.style.setProperty("--dock-scale", String(paint.scale));
          button.style.setProperty("--dock-lift", `${paint.lift}px`);
          if (paint.scale > 1) button.dataset.dockMagnified = "true";
          else delete button.dataset.dockMagnified;
        });
    });
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = currentGesture();
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved) {
      cancel();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const destination = target(event.clientX, event.clientY, current);
    cancel();
    if (destination.index !== null)
      commit(
        placeDockApplication(
          latest.current.keys,
          latest.current.available,
          current.key,
          destination.index,
        ),
        "已更新 Dock 顺序",
        current.element,
      );
    else if (destination.removing) {
      if (document.activeElement === current.element)
        shortcuts.current
          ?.querySelector<HTMLButtonElement>('button[aria-label="全部应用"]')
          ?.focus({ preventScroll: true });
      commit(
        removeDockApplication(latest.current.keys, current.key),
        "已从 Dock 移除快捷入口；应用仍保留",
      );
    }
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    const visible = [...new Set(keys.filter((id) => available.includes(id)))];
    const index = visible.indexOf(key);
    if (index < 0 || busy) return;
    if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      commit(
        placeDockApplication(
          keys,
          available,
          key,
          Math.max(
            0,
            Math.min(
              visible.length - 1,
              index + (event.key === "ArrowLeft" ? -1 : 1),
            ),
          ),
        ),
        "已更新 Dock 顺序",
        event.currentTarget,
      );
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      // Move focus before removing its node; a hidden trigger must not own it.
      shortcuts.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="全部应用"]')
        ?.focus({ preventScroll: true });
      commit(
        removeDockApplication(keys, key),
        "已从 Dock 移除快捷入口；应用仍保留",
      );
    }
  }
  return {
    preview,
    announcement,
    setMenuOpen,
    keyboard,
    handlers: {
      onPointerDownCapture: pointerDown,
      onPointerMove: pointerMove,
      onPointerUp: pointerUp,
      onPointerCancel: () => cancel(),
      onLostPointerCapture: () => cancel(),
      onPointerLeave: () => {
        if (!gesture.current) clearMagnification();
      },
      onDragStart: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (suppressClick.current && event.detail !== 0) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}
