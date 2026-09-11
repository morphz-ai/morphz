import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";

type Option = {
  label: string;
  text?: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
};

/** A local, nonmodal popover: no new input scope and no draft mutation. */
export function ComposerOptions({
  model,
  unread,
  options,
  label = "更多输入选项",
  menuLabel = "输入选项",
  below = false,
  modelControl,
}: {
  model?: string;
  unread?: boolean;
  options: Option[];
  label?: string;
  menuLabel?: string;
  below?: boolean;
  modelControl?: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const element = panel.current!;
    if (!open) return;
    // Use the top layer so the working canvas cannot clip this compact menu.
    element.showPopover();
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      element.style.maxHeight = `${Math.max(80, (below ? innerHeight : anchor.top) - 16)}px`;
      // Anchor using stable layout dimensions, independent of reveal effects.
      const bounds = {
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
      element.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, below ? Math.min(anchor.bottom + 4, innerHeight - bounds.height - 8) : anchor.top - bounds.height - 8)}px`;
    };
    position();
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
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
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, below]);

  function closeToTrigger() {
    // Modal hooks capture the stable trigger, never a disappearing menu item.
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }

  return (
    <>
      <button
        ref={trigger}
        className="icon-button composer-more"
        aria-label={label}
        title={label}
        aria-controls={id}
        aria-expanded={open}
        aria-describedby={unread ? `${id}-unread` : undefined}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal />
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
        className="composer-options"
        role="group"
        aria-label={menuLabel}
        onKeyDown={(event) => {
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
            );
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
        {options.map((option) => (
          <button
            key={option.label}
            aria-label={option.label}
            title={option.title}
            aria-pressed={option.pressed}
            disabled={option.disabled}
            onClick={() => {
              closeToTrigger();
              option.onSelect();
            }}
          >
            {option.icon}
            <span>{option.text ?? option.label}</span>
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
