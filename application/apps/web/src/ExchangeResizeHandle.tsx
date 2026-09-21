import { useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { InteractionMode } from "./interaction.js";
import {
  preferredExchangeHeight,
  resolveExchangeSize,
  stepExchangeSize,
  type ExchangeSize,
} from "./exchange-resize.js";

export type ExchangeResizeOptions = {
  scope: string;
  mode: InteractionMode;
  height?: number;
  onStart: () => void;
  onPreview: (mode: "recent" | null) => void;
  onCommit: (size: ExchangeSize) => void;
};

/** Resize only this view. Pointer frames never rewrite preferences or rerender
 * the Host's message model; one committed gesture updates the shared layout. */
export function ExchangeResizeHandle({
  options,
}: {
  options: ExchangeResizeOptions;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  latest.current = options;
  const drag = useRef<{
    scope: string;
    pointer: number;
    startY: number;
    startHeight: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const [range, setRange] = useState({ height: 0, max: 0 });
  const [capturing, setCapturing] = useState(false);

  function geometry() {
    const root = panel.current!;
    const workspace = root.closest(".primary-panel")!;
    const chrome =
      (root.querySelector(".composer-dock")?.getBoundingClientRect().height ??
        0) +
      (root.querySelector(".exchange-panel-header")?.getBoundingClientRect()
        .height ?? 0) +
      parseFloat(getComputedStyle(root).borderTopWidth) +
      parseFloat(getComputedStyle(root).borderBottomWidth);
    const available = Math.max(
      0,
      workspace.getBoundingClientRect().height -
        parseFloat(getComputedStyle(root).marginBottom),
    );
    const reading = root.querySelector<HTMLElement>(":scope > .conversation");
    const readingStyle = reading ? getComputedStyle(reading) : null;
    // Flex items cannot shrink below their own padding. Keep the input anchored
    // while dragging through the snap zone, including an empty conversation.
    const readingFloor = readingStyle
      ? parseFloat(readingStyle.paddingTop) +
        parseFloat(readingStyle.paddingBottom)
      : 0;
    return {
      root,
      chrome,
      readingFloor,
      available,
      max: Math.max(0, available - chrome),
    };
  }

  function paint() {
    if (!panel.current) return;
    const { root, chrome, readingFloor, available, max } = geometry();
    const gesture = drag.current;
    const preferred = preferredExchangeHeight(latest.current.height);
    const requested = gesture?.moved
      ? gesture.startHeight + gesture.startY - gesture.y
      : latest.current.mode === "recent" && preferred !== undefined
        ? chrome + preferred
        : undefined;
    root.toggleAttribute("data-resized", requested !== undefined);
    root.toggleAttribute("data-resizing", !!gesture?.moved);
    if (requested !== undefined) {
      root.style.setProperty(
        "--exchange-height",
        `${Math.min(available, Math.max(chrome + readingFloor, requested))}px`,
      );
      root.style.setProperty("--exchange-max-height", `${available}px`);
    } else {
      root.style.removeProperty("--exchange-height");
      root.style.removeProperty("--exchange-max-height");
    }
    const height = Math.round(
      Math.max(0, root.getBoundingClientRect().height - chrome),
    );
    setRange((old) =>
      old.height === height && old.max === Math.round(max)
        ? old
        : { height, max: Math.round(max) },
    );
  }

  function finish(commit: boolean) {
    const gesture = drag.current;
    if (!gesture) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const { chrome, max } = geometry();
    drag.current = null;
    setCapturing(false);
    if (handle.current?.hasPointerCapture(gesture.pointer))
      handle.current.releasePointerCapture(gesture.pointer);
    if (gesture.scope === latest.current.scope) {
      if (commit && gesture.moved)
        latest.current.onCommit(
          resolveExchangeSize(
            gesture.startHeight + gesture.startY - gesture.y - chrome,
            max,
          ),
        );
      else latest.current.onPreview(null);
    }
  }

  function move(event: PointerEvent) {
    const gesture = drag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture.y = event.clientY;
    if (!gesture.moved && Math.abs(gesture.y - gesture.startY) < 4) return;
    if (!gesture.moved) {
      gesture.moved = true;
      latest.current.onPreview("recent");
    }
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        paint();
      });
  }

  function release(event: PointerEvent) {
    const gesture = drag.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture.y = event.clientY;
    // Native/coalesced input can deliver the final position without an earlier
    // move. Measure the revealed header before committing this single frame.
    if (!gesture.moved && Math.abs(gesture.y - gesture.startY) >= 4) {
      gesture.moved = true;
      flushSync(() => latest.current.onPreview("recent"));
    }
    finish(true);
  }

  function cancel(event: PointerEvent) {
    if (drag.current?.pointer === event.pointerId) finish(false);
  }

  useLayoutEffect(() => {
    // A child's layout effect runs before its parent's ref is attached. Resolve
    // the mounted frame from our own attached handle instead of a parent ref.
    const root = handle.current!.closest<HTMLDivElement>(".exchange-panel")!;
    panel.current = root;
    const observer = new ResizeObserver(paint);
    for (const element of [
      root,
      root.closest(".primary-panel"),
      root.querySelector(".composer-dock"),
      root.querySelector(".exchange-panel-header"),
    ])
      if (element) observer.observe(element);
    const blur = () => finish(false);
    window.addEventListener("blur", blur);
    // A native release can land on the temporary shield rather than the handle
    // (even after setPointerCapture). Finish the gesture in either case.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", cancel, true);
    paint();
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", cancel, true);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      drag.current = null;
      root.removeAttribute("data-resized");
      root.removeAttribute("data-resizing");
      root.style.removeProperty("--exchange-height");
      root.style.removeProperty("--exchange-max-height");
      panel.current = null;
    };
  }, []);
  useLayoutEffect(paint, [options.mode, options.height, capturing]);

  return (
    <>
      {capturing &&
        createPortal(
          <div className="exchange-resize-shield" aria-hidden="true" />,
          document.body,
        )}
      <div
        ref={handle}
        className="exchange-resizer"
        role="separator"
        aria-label="调整消息区高度"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={range.max}
        aria-valuenow={Math.min(range.height, range.max)}
        aria-valuetext={
          options.mode === "input"
            ? "交流记录已收起"
            : options.mode === "history"
              ? "完整记录"
              : `消息区高度 ${range.height} 像素`
        }
        title="拖动调整消息区高度"
        tabIndex={0}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          latest.current.onStart();
          drag.current = {
            scope: options.scope,
            pointer: event.pointerId,
            startY: event.clientY,
            startHeight: panel.current!.getBoundingClientRect().height,
            y: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          // Electron guests can consume motion outside the host frame despite
          // pointer capture. A temporary host hit surface keeps the gesture in
          // this document without resizing, hiding or reloading the guest.
          setCapturing(true);
        }}
        onLostPointerCapture={(event) => cancel(event.nativeEvent)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
            return;
          }
          if (drag.current) return;
          const size = stepExchangeSize(
            options.mode,
            range.height,
            range.max,
            event.key,
            event.shiftKey,
          );
          if (!size) return;
          event.preventDefault();
          event.stopPropagation();
          options.onStart();
          options.onCommit(size);
        }}
      />
    </>
  );
}
