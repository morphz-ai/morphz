import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, CircleAlert } from "lucide-react";
import { copyText } from "./clipboard-text.js";
import { Tooltip } from "./ui/Tooltip.js";
import "./markdown-text-block.css";

export function MarkdownTextBlock({
  children,
  copyable = true,
}: {
  children?: ReactNode;
  copyable?: boolean;
}) {
  const content = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">(
    "idle",
  );
  const lifetime = useRef(0);
  const previousText = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const text = content.current?.textContent ?? null;
    if (text !== previousText.current) {
      previousText.current = text;
      lifetime.current++;
      clearTimeout(timer.current);
      setStatus("idle");
    }
  }, [children]);
  useEffect(
    () => () => {
      lifetime.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  const label =
    status === "copied"
      ? "已复制"
      : status === "error"
        ? "复制失败，点击重试"
        : "复制文本";
  return (
    <div className="markdown-code-block" data-copyable={copyable || undefined}>
      {copyable && (
        <Tooltip label={label}>
          <button
            type="button"
            className="markdown-code-copy"
            aria-label={label}
            aria-live="polite"
            disabled={status === "copying"}
            data-state={status}
            onClick={async () => {
              const text = content.current?.textContent;
              if (text === undefined || text === null) return;
              const current = lifetime.current;
              clearTimeout(timer.current);
              setStatus("copying");
              try {
                await copyText(text);
                if (current !== lifetime.current) return;
                setStatus("copied");
                timer.current = setTimeout(() => {
                  if (current === lifetime.current) setStatus("idle");
                }, 2000);
              } catch {
                if (current === lifetime.current) setStatus("error");
              }
            }}
          >
            {status === "copied" ? (
              <Check size={16} />
            ) : status === "error" ? (
              <CircleAlert size={16} />
            ) : (
              <Copy size={16} />
            )}
          </button>
        </Tooltip>
      )}
      <pre ref={content}>{children}</pre>
    </div>
  );
}
