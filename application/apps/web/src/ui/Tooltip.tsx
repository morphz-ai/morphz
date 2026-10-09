import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
} from "react";

/** A name hint, not an action or a replacement for the control's accessible
 * name. One native target; no wrapper that changes layout or hit testing. */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const keyboardFocus = useRef(false);
  const clearTimers = useCallback(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
  }, []);
  const close = useCallback(() => {
    clearTimers();
    setAnchor(null);
  }, [clearTimers]);
  useEffect(() => clearTimers, [clearTimers]);

  useLayoutEffect(() => {
    const element = hint.current;
    if (!anchor || !element) return;
    // The same native top layer used by our menus: inherits the local theme,
    // works inside modal dialogs, and cannot be clipped by a scroll container.
    element.showPopover();
    let zoom = (element as HTMLElement & { currentCSSZoom?: number })
      .currentCSSZoom;
    if (!zoom) {
      zoom = 1;
      for (
        let node: HTMLElement | null = element;
        node;
        node = node.parentElement
      )
        zoom *= Number.parseFloat(getComputedStyle(node).zoom) || 1;
    }
    const rect = anchor.getBoundingClientRect();
    const width = innerWidth / zoom;
    const height = innerHeight / zoom;
    element.style.maxWidth = `${Math.max(1, width - 16)}px`;
    const left =
      (rect.left + rect.right) / (2 * zoom) - element.offsetWidth / 2;
    const above = rect.top / zoom - element.offsetHeight - 6;
    element.style.left = `${Math.max(8, Math.min(left, width - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(above >= 8 ? above : rect.bottom / zoom + 6, height - element.offsetHeight - 8))}px`;

    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("wheel", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor, label, close]);

  function leave() {
    clearTimers();
    if (!keyboardFocus.current) hideTimer.current = setTimeout(close, 120);
  }
  const props = children.props;
  return (
    <>
      {cloneElement(children, {
        // Avoid two competing hints; aria-label remains the actual action name.
        title: undefined,
        "aria-describedby":
          [props["aria-describedby"], anchor && id].filter(Boolean).join(" ") ||
          undefined,
        onPointerEnter: (event) => {
          props.onPointerEnter?.(event);
          if (event.pointerType === "touch") return;
          clearTimers();
          const target = event.currentTarget;
          if (anchor) setAnchor(target);
          else showTimer.current = setTimeout(() => setAnchor(target), 300);
        },
        onPointerLeave: (event) => {
          props.onPointerLeave?.(event);
          leave();
        },
        onFocus: (event) => {
          props.onFocus?.(event);
          keyboardFocus.current = event.currentTarget.matches(":focus-visible");
          if (keyboardFocus.current) {
            clearTimers();
            setAnchor(event.currentTarget);
          }
        },
        onBlur: (event) => {
          props.onBlur?.(event);
          keyboardFocus.current = false;
          close();
        },
        onPointerDown: (event) => {
          close();
          props.onPointerDown?.(event);
        },
        onClick: (event) => {
          close();
          props.onClick?.(event);
        },
      })}
      {anchor && (
        <span
          ref={hint}
          id={id}
          role="tooltip"
          popover="manual"
          className="ui-tooltip"
          onPointerEnter={clearTimers}
          onPointerLeave={leave}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {label}
        </span>
      )}
    </>
  );
}
