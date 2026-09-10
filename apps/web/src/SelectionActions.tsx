import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

export function SelectionActions({
  root,
  onAction,
}: {
  root: RefObject<HTMLElement | null>;
  onAction(action: "ask" | "annotate" | "read", text: string): void;
}) {
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
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
            ["ask", "询问 Morphz"],
            ["annotate", "批注"],
            ["read", "朗读"],
          ] as const
        ).map(([action, label]) => (
          <button
            key={action}
            onClick={() => {
              onAction(action, selection.text);
              setSelection(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>,
      document.body,
    )
  );
}
