import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { MoreHorizontal } from "lucide-react";

export type ComposerOption = {
  label: string;
  text?: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
  shortcut?: string;
  keyShortcut?: string;
};

/** A local, nonmodal popover: no new input scope and no draft mutation. */
export function ComposerOptions({
  model,
  unread,
  options,
  label = "更多输入选项",
  description,
  menuLabel = "输入选项",
  below = false,
  align = "end",
  horizontalAnchorRef,
  placement = "vertical",
  matchTriggerWidth = false,
  modelControl,
  triggerIcon = <MoreHorizontal />,
  triggerClassName = "icon-button composer-more",
  menuClassName = "",
  header,
  content,
  persistentContent,
  triggerRef,
  initialFocus = "control",
  onOpenChange,
}: {
  model?: string;
  unread?: boolean;
  options: ComposerOption[];
  label?: string;
  description?: string;
  menuLabel?: string;
  below?: boolean;
  /** Left-side input tools open towards the content, not over navigation. */
  align?: "start" | "center" | "end";
  /** Launcher centres over its shortcut group, not the last trigger button. */
  horizontalAnchorRef?: RefObject<HTMLElement | null>;
  /** Sidebar identity menus open beside their button into the content. */
  placement?: "vertical" | "right";
  /** Expanded sidebar menus share both edges with their full-width trigger. */
  matchTriggerWidth?: boolean;
  modelControl?: ReactNode;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
  header?: ReactNode;
  content?: (close: () => void) => ReactNode;
  /** Keep stateful input tools mounted while this menu is closed. */
  persistentContent?: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** A settings group can receive initial focus without selecting a value. */
  initialFocus?: "control" | "panel";
  /** Persistent input controls may read only while their popover is open. */
  onOpenChange?(open: boolean): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);

  useLayoutEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useLayoutEffect(() => {
    const element = panel.current!;
    if (!open) return;
    // Use the top layer so the working canvas cannot clip this compact menu.
    element.showPopover();
    const position = () => {
      // Rects include CSS zoom, whereas offset dimensions and left/top use
      // layout pixels. Keep all positioning in the popover's layout space;
      // do not infer zoom from its animated (possibly scaled) visible rect.
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
      const rect = trigger.current!.getBoundingClientRect();
      const horizontalRect =
        horizontalAnchorRef?.current?.getBoundingClientRect() ?? rect;
      const anchor = {
        left: rect.left / zoom,
        right: rect.right / zoom,
        top: rect.top / zoom,
        bottom: rect.bottom / zoom,
      };
      const viewport = { width: innerWidth / zoom, height: innerHeight / zoom };
      const sideSpace = viewport.width - anchor.right - 16;
      const right = placement === "right" && sideSpace >= 160;
      element.style.width = matchTriggerWidth
        ? `${anchor.right - anchor.left}px`
        : "";
      element.style.minWidth = matchTriggerWidth ? "0" : "";
      element.style.maxWidth = `${Math.max(1, right ? sideSpace : viewport.width - 16)}px`;
      element.style.maxHeight = `${Math.max(80, (placement === "right" || below ? viewport.height : anchor.top) - 16)}px`;
      // Anchor using stable layout dimensions, independent of reveal effects.
      const bounds = {
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
      const left = right
        ? anchor.right + 8
        : align === "center"
          ? (horizontalRect.left + horizontalRect.right) / (2 * zoom) -
            bounds.width / 2
          : align === "start"
            ? anchor.left
            : anchor.right - bounds.width;
      element.style.left = `${Math.max(8, Math.min(left, viewport.width - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(placement === "right" ? anchor.bottom - bounds.height : below ? anchor.bottom + 4 : anchor.top - bounds.height - 8, viewport.height - bounds.height - 8))}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(element);
    if (matchTriggerWidth) resize.observe(trigger.current!);
    // The shortcut group has an intrinsic width: its position can move when
    // a containing work surface resizes without changing the group itself.
    // Observe that actual layout chain too (including CSS-zoom changes), not
    // just the panel/group dimensions or an early window resize notification.
    for (
      let anchor = horizontalAnchorRef?.current ?? null;
      anchor;
      anchor = anchor.parentElement
    )
      resize.observe(anchor);
    if (initialFocus === "panel") element.focus({ preventScroll: true });
    else
      Array.from(
        element.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary",
        ),
      )
        .find((control) => control.getClientRects().length > 0)
        ?.focus();
    const outside = (event: Event) => {
      if (
        !element.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      element.hidePopover();
      resize.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [
    open,
    below,
    align,
    horizontalAnchorRef,
    placement,
    matchTriggerWidth,
    initialFocus,
  ]);

  function closeToTrigger() {
    // Modal hooks capture the stable trigger, never a disappearing menu item.
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }

  return (
    <>
      <button
        ref={(element) => {
          trigger.current = element;
          if (triggerRef) triggerRef.current = element;
        }}
        className={triggerClassName}
        aria-label={label}
        aria-description={description}
        title={description ? `${label} · ${description}` : label}
        aria-controls={id}
        aria-expanded={open}
        aria-describedby={unread ? `${id}-unread` : undefined}
        onClick={(event) => {
          setKeyboardNavigation(event.detail === 0);
          setOpen(!open);
        }}
      >
        {triggerIcon}
        {unread && (
          <span className="unread-label" id={`${id}-unread`}>
            有新回复
          </span>
        )}
      </button>
      <div
        ref={panel}
        id={id}
        popover="manual"
        inert={!open}
        className={`composer-options ${menuClassName}`}
        role="group"
        aria-label={menuLabel}
        tabIndex={initialFocus === "panel" ? -1 : undefined}
        data-keyboard-navigation={keyboardNavigation || undefined}
        onPointerDownCapture={() => setKeyboardNavigation(false)}
        onKeyDown={(event) => {
          if (
            ["Tab", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          )
            setKeyboardNavigation(true);
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeToTrigger();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
            !(
              event.target instanceof Element &&
              event.target.matches("select,input,textarea")
            )
          ) {
            event.preventDefault();
            const buttons = Array.from(
              panel.current!.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ).filter((button) => button.getClientRects().length > 0);
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }
        }}
      >
        {header}
        {persistentContent}
        {open && content?.(closeToTrigger)}
        {options.map((option) => (
          <button
            key={option.label}
            aria-label={option.label}
            title={option.title}
            aria-pressed={option.pressed}
            aria-keyshortcuts={option.keyShortcut}
            disabled={option.disabled}
            onClick={() => {
              closeToTrigger();
              option.onSelect();
            }}
          >
            {option.icon}
            <span>{option.text ?? option.label}</span>
            {option.shortcut && <kbd>{option.shortcut}</kbd>}
          </button>
        ))}
        {open && modelControl}
        {model && !modelControl && (
          <div className="composer-model">
            <span>当前模型</span>
            <span>{model}</span>
          </div>
        )}
      </div>
    </>
  );
}
