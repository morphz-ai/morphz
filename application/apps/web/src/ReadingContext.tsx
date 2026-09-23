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
      aria-label="阅读上下文"
    >
      <details>
        <summary
          title={
            r
              ? `${r.book.title} · ${r.chapter}；${focus!.selected ? "附带选文及必要上下文" : "仅附带位置，不发送正文"}。`
              : "阅读内容尚未就绪；可以稍后发送，或取消本条阅读引用。"
          }
        >
          <BookOpen size={14} />
          <span role={r ? undefined : "status"}>
            {r
              ? `${focus!.selected ? "选文" : "当前阅读"} · ${r.chapter}`
              : "阅读内容尚未就绪"}
          </span>
          <ChevronDown size={12} className="reading-context-chevron" />
        </summary>
        <div className="reading-context-preview">
          {r ? (
            <>
              <small>
                {r.book.title} · {r.spoilers ? "可引用后文" : "不剧透"}
              </small>
              {focus?.selected ? (
                <>
                  <blockquote>{focus.reference.quote}</blockquote>
                  <small>附带选文及必要前后文，不发送整本书。</small>
                </>
              ) : (
                <p>
                  仅附带书籍和位置，不发送正文。讨论原文时，Morphz
                  可按需读取；普通闲聊不读取。
                </p>
              )}
            </>
          ) : (
            <p>
              尚未取得可核实的原文位置，不会凭书名猜测内容。可以稍后发送，或取消本条阅读引用。
            </p>
          )}
        </div>
      </details>
      <button
        type="button"
        className="icon-button"
        aria-label="不附带阅读上下文"
        onClick={onRemove}
      >
        <X size={14} />
      </button>
    </div>
  );
}
