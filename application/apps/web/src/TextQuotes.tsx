import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, X, ArrowUpLeft, Check } from "lucide-react";
import {
  sameQuote,
  textQuotesSchema,
  quoteSourceLabel,
  type TextQuote,
} from "../../../packages/core/src/text-quotes.js";
import {
  captureTextQuote,
  locateTextQuote,
  locateTextQuoteField,
  revealTextQuote,
  type QuotePoint,
  type QuoteSelection,
} from "./text-quote-dom.js";

type QuoteActions = {
  reveal?: { quote: TextQuote; token: string } | null;
  comment: (selection?: QuoteSelection | null) => string | undefined;
  offer: (selection: QuoteSelection | null) => void;
  edit: (id: string, point?: QuotePoint) => void;
  remove: (id: string) => void;
};
const Context = createContext<QuoteActions | null>(null);
export const useTextQuotes = () => useContext(Context);

/** One selection/comment controller for every work surface, never another composer. */
export function TextQuoteProvider({
  quotes,
  scope,
  disabled,
  reveal,
  onChange,
  onEngage,
  onFocusComposer,
  onOpen,
  onNotice,
  children,
}: {
  reveal?: { quote: TextQuote; token: string } | null;
  quotes: TextQuote[];
  scope: string;
  disabled: boolean;
  onChange: (quotes: TextQuote[]) => void;
  onEngage: () => void;
  onFocusComposer: () => void;
  onOpen: (quote: TextQuote) => void;
  onNotice: (text: string) => void;
  children?: ReactNode;
}) {
  const latest = useRef({
    quotes,
    disabled,
    onChange,
    onEngage,
    onFocusComposer,
    onOpen,
    onNotice,
  });
  latest.current = {
    quotes,
    disabled,
    onChange,
    onEngage,
    onFocusComposer,
    onOpen,
    onNotice,
  };
  const [offer, setOffer] = useState<QuoteSelection | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    point: QuotePoint;
  } | null>(null);
  const [markers, setMarkers] = useState<
    { id: string; index: number; point: QuotePoint }[]
  >([]);
  const panel = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 320, height: 240 });
  useEffect(() => {
    setOffer(null);
    setEditing(null);
  }, [scope]);
  useEffect(() => {
    if (
      !reveal ||
      ["message", "web", "surface"].includes(reveal.quote.source.kind)
    )
      return;
    let finished = false;
    const highlight = () => {
      if (finished) return;
      finished = revealTextQuote(reveal.quote);
    };
    const observer = new MutationObserver(highlight);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-text-source"],
    });
    highlight();
    const timeout = setTimeout(() => {
      observer.disconnect();
      if (!finished)
        latest.current.onNotice(
          "已打开来源；原文位置暂时无法精确定位，引用内容仍保留。",
        );
    }, 5000);
    return () => {
      clearTimeout(timeout);
      observer.disconnect();
    };
  }, [reveal?.token]);
  const finish = (focus = false) => {
    setEditing(null);
    if (focus) latest.current.onFocusComposer();
  };
  function edit(id: string, point?: QuotePoint) {
    if (latest.current.disabled) return;
    const quote = latest.current.quotes.find((q) => q.id === id);
    if (!quote) return;
    const rect = (
      locateTextQuote(quote) ?? locateTextQuoteField(quote)
    )?.getBoundingClientRect();
    latest.current.onEngage();
    setOffer(null);
    setEditing({
      id,
      point:
        point ??
        (rect && rect.bottom > 0 && rect.top < innerHeight
          ? { x: rect.right, y: rect.bottom }
          : { x: innerWidth / 2, y: innerHeight / 2 }),
    });
  }
  function comment(selection = captureTextQuote()) {
    if (!selection || latest.current.disabled) return;
    const existing = latest.current.quotes.find((q) =>
      sameQuote(q, selection.quote),
    );
    const quote = existing ?? selection.quote;
    if (!existing) {
      const result = textQuotesSchema.safeParse([
        ...latest.current.quotes,
        quote,
      ]);
      if (!result.success) {
        latest.current.onNotice("引用内容过长，请分次发送。");
        return;
      }
      latest.current.onChange(result.data);
    }
    latest.current.onEngage();
    setEditing({ id: quote.id, point: selection.point });
    setOffer(null);
    window.getSelection()?.removeAllRanges();
    return quote.id;
  }
  function remove(id: string) {
    if (latest.current.disabled) return;
    latest.current.onEngage();
    latest.current.onChange(latest.current.quotes.filter((q) => q.id !== id));
    if (editing?.id === id) setEditing(null);
    // Removing the focused chip must not look like leaving the exchange.
    latest.current.onFocusComposer();
  }
  useEffect(() => {
    let frame = 0,
      dragging = false;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (dragging || latest.current.disabled) return;
        const selection = captureTextQuote();
        const root = selection?.range?.commonAncestorContainer;
        const el = root instanceof Element ? root : root?.parentElement;
        // Readers retain their highlight/note toolbar and invoke the same comment action.
        if (el?.closest("[data-quote-menu='local']")) {
          setOffer(null);
          return;
        }
        setOffer(selection);
      });
    };
    const press = () => {
      dragging = true;
    };
    const release = () => {
      dragging = false;
      update();
    };
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || e.target.closest("[data-quote-ui]"))
        return;
      setEditing(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setEditing(null);
      setOffer(null);
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("pointerdown", press);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useLayoutEffect(() => {
    if (!editing || !panel.current) return;
    const el = panel.current;
    const resize = new ResizeObserver(() =>
      setBounds({ width: el.offsetWidth, height: el.offsetHeight }),
    );
    resize.observe(el);
    return () => resize.disconnect();
  }, [editing?.id]);
  useEffect(() => {
    if (!quotes.length) {
      setMarkers([]);
      CSS.highlights?.delete("morphz-text-quotes");
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const ranges: Range[] = [];
        const next = quotes.flatMap((q, index) => {
          const range = locateTextQuote(q),
            field = locateTextQuoteField(q),
            rect = range?.getClientRects()[0] ?? field?.getBoundingClientRect();
          if (range) ranges.push(range);
          if (
            !rect ||
            rect.bottom < 0 ||
            rect.top > innerHeight ||
            rect.right < 0
          )
            return [];
          // Don't place markers over a scrolled-out message or under another work surface.
          const at = document.elementFromPoint(
            Math.min(innerWidth - 1, Math.max(0, rect.left + 2)),
            Math.max(0, rect.top + 2),
          );
          const root = (field ?? range?.startContainer.parentElement)?.closest(
            "[data-text-source]",
          );
          if (at && !root?.contains(at) && !at.closest("[data-quote-ui]"))
            return [];
          return [
            {
              id: q.id,
              index,
              point: {
                x: Math.min(innerWidth - 24, Math.max(4, rect.left - 22)),
                y: Math.max(4, rect.top),
              },
            },
          ];
        });
        setMarkers(next);
        if (typeof Highlight !== "undefined" && CSS.highlights)
          CSS.highlights.set("morphz-text-quotes", new Highlight(...ranges));
      });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    // Observe work-surface replacement, not our own portalled badges.
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (r) =>
            !(
              r.target instanceof Element ? r.target : r.target.parentElement
            )?.closest("[data-quote-ui]"),
        )
      )
        update();
    });
    const work = document.querySelector(".primary-panel");
    if (work)
      observer.observe(work, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      CSS.highlights?.delete("morphz-text-quotes");
    };
  }, [quotes, scope]);
  const quote = editing && quotes.find((q) => q.id === editing.id);
  const index = quote ? quotes.indexOf(quote) + 1 : 0;
  const host = document.querySelector(".app");
  const position = (point: QuotePoint, width: number, height: number) => ({
    left: Math.max(8, Math.min(point.x - width, innerWidth - width - 8)),
    top: Math.max(8, Math.min(point.y + 8, innerHeight - height - 8)),
  });
  return (
    <Context.Provider
      value={{ comment, offer: setOffer, edit, remove, reveal }}
    >
      {children}
      {host &&
        createPortal(
          <>
            {!disabled && !editing && offer && (
              <button
                data-quote-ui="true"
                type="button"
                className="text-quote-select"
                style={position(offer.point, 80, 34)}
                aria-label="评论选中文字"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => comment(offer)}
              >
                <MessageSquarePlus size={15} />
                评论
              </button>
            )}
            {markers.map((m) => (
              <button
                data-quote-ui="true"
                key={m.id}
                className="text-quote-marker"
                style={{ left: m.point.x, top: m.point.y }}
                aria-label={`编辑引用 ${m.index + 1} 的评论`}
                onClick={() => edit(m.id, m.point)}
              >
                {m.index + 1}
              </button>
            ))}
            {quote && editing && (
              <div
                ref={panel}
                data-quote-ui="true"
                className="text-quote-editor"
                role="dialog"
                aria-label={`引用 ${index} 的评论`}
                style={position(editing.point, bounds.width, bounds.height)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    finish(true);
                  }
                }}
              >
                <header>
                  <span className="text-quote-number">{index}</span>
                  <span title={quoteSourceLabel(quote.source)}>
                    {quoteSourceLabel(quote.source)}
                    {quote.draft ? " · 编辑中" : ""}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭评论"
                    title="关闭评论"
                    onClick={() => finish(true)}
                  >
                    <X size={16} />
                  </button>
                </header>
                <blockquote>{quote.text}</blockquote>
                <textarea
                  key={quote.id}
                  autoFocus
                  rows={3}
                  aria-label={`引用 ${index} 的评论（可选）`}
                  placeholder="写下你的评论…"
                  maxLength={10000}
                  disabled={disabled}
                  value={quote.comment}
                  onChange={(e) =>
                    onChange(
                      quotes.map((q) =>
                        q.id === quote.id
                          ? { ...q, comment: e.target.value }
                          : q,
                      ),
                    )
                  }
                />
                <footer>
                  <button
                    type="button"
                    className="text-quote-origin"
                    onClick={() => {
                      finish();
                      onOpen(quote);
                    }}
                  >
                    <ArrowUpLeft size={14} />
                    查看原文
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => finish(true)}
                  >
                    <Check size={14} />
                    完成
                  </button>
                </footer>
              </div>
            )}
          </>,
          host,
        )}
    </Context.Provider>
  );
}

export function TextQuoteDrafts({
  quotes,
  disabled,
}: {
  quotes: TextQuote[];
  disabled: boolean;
}) {
  const actions = useTextQuotes();
  return (
    <div
      className="text-quote-drafts"
      data-quote-ui="true"
      role="group"
      aria-label="选文与评论"
    >
      {quotes.map((q, index) => (
        <div className="text-quote-chip" key={q.id}>
          <button
            type="button"
            disabled={disabled}
            title={`${quoteSourceLabel(q.source)}\n${q.text}${q.comment ? `\n${q.comment}` : ""}`}
            aria-label={`编辑引用 ${index + 1} 的评论`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              actions?.edit(q.id, { x: r.right, y: r.top - 250 });
            }}
          >
            <span className="text-quote-number">{index + 1}</span>
            <span>{q.comment || q.text}</span>
            {q.comment && (
              <span className="text-quote-comment-dot" aria-label="已评论" />
            )}
          </button>
          <button
            type="button"
            className="text-quote-remove"
            disabled={disabled}
            aria-label={`移除引用 ${index + 1}`}
            onClick={() => actions?.remove(q.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
export function SentTextQuotes({
  quotes,
  onOpen,
}: {
  quotes: TextQuote[];
  onOpen: (q: TextQuote) => void;
}) {
  return (
    <div
      className="sent-text-quotes"
      data-quote-ignore="true"
      aria-label="引用与评论"
    >
      {quotes.map((q, index) => (
        <div key={q.id}>
          <button
            className="sent-text-quote"
            title="查看原文"
            aria-label={`查看引用 ${index + 1} 的原文`}
            onClick={() => onOpen(q)}
          >
            <span className="text-quote-number">{index + 1}</span>
            <span>
              <small>{quoteSourceLabel(q.source)}</small>
              <span>{q.text}</span>
            </span>
            <ArrowUpLeft size={14} />
          </button>
          {q.comment && <p className="text-quote-comment">{q.comment}</p>}
        </div>
      ))}
    </div>
  );
}
