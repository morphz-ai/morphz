import { useEffect, useRef, type RefObject } from "react";

/** Leaving the exchange changes layout only; drafts and work remain untouched. */
export function useExchangeFocus(options: {
  root: RefObject<HTMLDivElement | null>;
  scope: string;
  visible: boolean;
  pinned: boolean;
  suspended: boolean;
  onLeave: () => void;
}) {
  const latest = useRef(options);
  const openGeneration = useRef(0);
  latest.current = options;
  useEffect(() => {
    let engaged: string | null = null;
    let pointerDown = false;
    let outsidePress: typeof options | null = null;
    const pending = new Set<number>();
    // The full-width layout wrapper includes gutters. Only the visible reading
    // column and composer count as "inside", not the blank space beside them.
    const inside = (target: EventTarget | null) => {
      const element =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      const region = element?.closest(".composer, .conversation");
      return !!region && !!latest.current.root.current?.contains(region);
    };
    function leave(snapshot: typeof options, windowBlur = false) {
      const generation = openGeneration.current;
      const frame = requestAnimationFrame(() => {
        pending.delete(frame);
        // A button outside the exchange can explicitly open it. Its click is
        // observed in capture phase before the action runs; don't let that old
        // leave callback win over the user's newer intent to compose.
        if (generation !== openGeneration.current) return;
        const current = latest.current;
        if (
          snapshot.pinned ||
          snapshot.suspended ||
          document.querySelector("dialog[open]")
        )
          return;
        if (
          current.scope === snapshot.scope &&
          (current.pinned ||
            current.suspended ||
            !current.visible ||
            (!windowBlur && inside(document.activeElement)))
        )
          return;
        if (engaged === snapshot.scope) engaged = null;
        snapshot.onLeave();
      });
      pending.add(frame);
    }
    function press(event: PointerEvent) {
      pointerDown = true;
      const current = latest.current;
      if (inside(event.target)) {
        engaged = current.scope;
        outsidePress = null;
      } else {
        outsidePress =
          current.visible &&
          (engaged === current.scope ||
            (event.target instanceof Node &&
              current.root.current?.contains(event.target)))
            ? current
            : null;
      }
    }
    function release() {
      pointerDown = false;
    }
    function click(event: MouseEvent) {
      if (outsidePress && !inside(event.target)) leave(outsidePress);
      outsidePress = null;
    }
    function focus(event: FocusEvent) {
      if (inside(event.target)) {
        // Refocusing is a newer intent than a pending blur/leave callback,
        // including focus restored after a modal or an iframe layout change.
        openGeneration.current++;
        engaged = latest.current.scope;
      } else if (
        !pointerDown &&
        latest.current.visible &&
        engaged === latest.current.scope
      )
        leave(latest.current);
    }
    function unfocus(event: FocusEvent) {
      // Disabling the textarea while a send is pending is not the user leaving.
      if (
        event.target instanceof HTMLElement &&
        event.target.matches(":disabled")
      )
        return;
      if (!pointerDown && inside(event.target) && !inside(event.relatedTarget))
        leave(latest.current);
    }
    function blur() {
      if (latest.current.visible && engaged === latest.current.scope)
        leave(latest.current, true);
    }
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("click", click, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", unfocus, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", unfocus, true);
      window.removeEventListener("blur", blur);
      pending.forEach(cancelAnimationFrame);
    };
  }, []);
  return () => {
    openGeneration.current++;
  };
}
