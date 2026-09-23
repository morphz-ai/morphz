import { BookOpen, ChevronDown, X } from "lucide-react";
import type {
  ReadingPosition,
  ReadingReference,
} from "../../../packages/core/src/reader.js";

export type ReadingFocus =
  | { reference: ReadingReference; selected: true }
  | { reference: ReadingPosition; selected: false };
export type ReadingSurface = {
  key: string;
  artifactId: string;
  revision: number;
  focus: ReadingFocus | null;
  capture: () => ReadingFocus | null;
};
export type ReadingContextChange = (
  key: string,
  surface: ReadingSurface | null,
) => void;

/** A compact, inspectable attachment; no second input or automatic model call. */
export function ReadingContext({
  focus,
  onRemove,
}: {
  focus: ReadingFocus | null;
  onRemove: () => void;
}) {
  const r = focus?.reference;
  return (
    <div
      className="composer-reading-context"
      role="group"
      aria-label="阅读引用"
    >
      <details>
        <summary
          title={
            r ? `${r.book.title} · ${r.chapter}` : "请稍后重试，或移除引用。"
          }
        >
          <BookOpen size={14} />
          <span role={r ? undefined : "status"}>
            {r
              ? `${focus!.selected ? "选文" : "当前阅读"} · ${r.chapter}`
              : "阅读位置暂不可用"}
          </span>
          <ChevronDown size={12} className="reading-context-chevron" />
        </summary>
        <div className="reading-context-preview">
          {r ? (
            <>
              <small>{r.book.title}</small>
              {focus?.selected && (
                <blockquote>{focus.reference.quote}</blockquote>
              )}
            </>
          ) : (
            <p>暂时无法获取阅读位置。请稍后重试，或移除引用。</p>
          )}
        </div>
      </details>
      <button
        type="button"
        className="icon-button"
        aria-label="移除阅读引用"
        title="移除引用"
        onClick={onRemove}
      >
        <X size={14} />
      </button>
    </div>
  );
}
