import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Highlighter, Volume2 } from "lucide-react";
import { useTextQuotes } from "./TextQuotes.js";
import { captureTextQuote, type QuoteSelection } from "./text-quote-dom.js";

export function SelectionActions({
  root,
  onAction,
}: {
  root: RefObject<HTMLElement | null>;
  onAction(action: "ask" | "annotate" | "read", text: string): void;
}) {
  const quotes = useTextQuotes();
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
    quote: QuoteSelection | null;
  } | null>(null);
  useEffect(() => {
    const refresh = () => {
      const selected = window.getSelection();
      if (
        !selected?.rangeCount ||
        !selected.toString().trim() ||
        !root.current?.contains(selected.anchorNode) ||
        !root.current?.contains(selected.focusNode)
      ) {
        setSelection(null);
        return;
      }
      const rect = selected.getRangeAt(0).getBoundingClientRect();
      setSelection({
        quote: captureTextQuote(),
        text: selected.toString().trim(),
        x: Math.max(12, Math.min(innerWidth - 300, rect.left)),
        y: Math.max(8, Math.min(innerHeight - 50, rect.bottom + 8)),
      });
    };
    document.addEventListener("selectionchange", refresh);
    document.addEventListener("scroll", refresh, true);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("scroll", refresh, true);
    };
  }, [root]);
  return (
    selection &&
    createPortal(
      <div
        className="selection-actions"
        role="toolbar"
        aria-label="选中文本操作"
        style={{ left: selection.x, top: selection.y }}
        onPointerDown={(e) => e.preventDefault()}
      >
        {(
          [
            ["ask", "评论", "评论选中文字", MessageCircle],
            ["annotate", "批注", "批注", Highlighter],
            ["read", "朗读", "朗读", Volume2],
          ] as const
        ).map(([action, label, name, Icon]) => (
          <button
            key={action}
            aria-label={name}
            title={name}
            onClick={() => {
              if (action === "ask") quotes?.comment(selection.quote);
              else onAction(action, selection.text);
              setSelection(null);
            }}
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>,
      document.body,
    )
  );
}
