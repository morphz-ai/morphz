import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Hand,
  Globe,
  ShieldCheck,
  Bookmark,
  MessageCircle,
} from "lucide-react";
import type { Artifact } from "../../../packages/core/src/model.js";
import type { BrowserView } from "./desktop.js";
import { registerNativeBrowserLayout } from "./native-browser-layout.js";

export function BrowserHost({
  artifact,
  autoOpen = false,
  projectId,
  initialURL = "",
  onPage,
  onSave,
  savedURLs = [],
  onReturn,
  onInput,
  returnLabel = "工作空间",
  activeView = true,
}: {
  artifact?: Artifact;
  projectId?: string;
  initialURL?: string;
  onPage?: (page: BrowserView | null) => void;
  onSave?: (url: string, title: string) => Promise<void>;
  savedURLs?: readonly string[];
  onReturn?: () => void;
  onInput?: () => void;
  returnLabel?: string;
  activeView?: boolean;
  autoOpen?: boolean;
}) {
  const desktop = window.morphzDesktop?.browser;
  const slot = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<BrowserView | null>(null),
    [url, setURL] = useState(
      initialURL ||
        (artifact?.content.kind === "website" ? artifact.content.url : ""),
    ),
    [error, setError] = useState(""),
    [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const latestOnPage = useRef(onPage);
  latestOnPage.current = onPage;
  useEffect(() => {
    latestOnPage.current?.(activeView ? page : null);
  }, [activeView, page?.pageId, page?.epoch, page?.url, page?.granted]);
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    if (page?.url) setURL(page.url);
  }, [page?.url]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latestOnPage.current?.(null);
      if (active.current) void desktop?.close(active.current).catch(() => {});
    };
  }, [desktop]);
  useEffect(() => {
    if (!desktop || !page) return;
    const id = page.pageId;
    const layout = async () => {
      const r = slot.current?.getBoundingClientRect();
      // Native WebContentsView sits above DOM. Clip its bounds rather than
      // replacing/reloading the user's page when a non-modal inspector opens.
      const inspector = document
        .querySelector<HTMLElement>(
          '.workspace > .workspace-inspector[data-inspector-mode="overlay"]',
        )
        ?.getBoundingClientRect();
      const visibleWidth = r
        ? Math.max(0, Math.min(r.right, inspector?.left ?? r.right) - r.left)
        : 0;
      // Floating input tools can extend above the in-flow composer. A native
      // page is a separate surface: keep its bottom clear of those controls
      // without adding a toolbar row or reopening/navigating the page.
      const inputTools = document
        .querySelector<HTMLElement>(".composer-floating-tools")
        ?.getBoundingClientRect();
      const visibleHeight = r
        ? Math.max(
            0,
            Math.min(
              r.bottom,
              inputTools?.height ? inputTools.top - 4 : r.bottom,
            ) - r.top,
          )
        : 0;
      const hidden =
        !activeViewRef.current ||
        document.hidden ||
        !!document.querySelector(
          'dialog[open]:not([data-capturing="true"]),.theme-menu',
        ) ||
        !r ||
        visibleWidth < 10 ||
        visibleHeight < 10 ||
        r.bottom < 120;
      await desktop.layout(
        id,
        hidden
          ? null
          : { x: r.x, y: r.y, width: visibleWidth, height: visibleHeight },
      );
    };
    const update = () => void layout().catch(() => {});
    const unregister = registerNativeBrowserLayout(async () => {
      if (activeViewRef.current) await layout();
    });
    const observer = new ResizeObserver(update);
    if (slot.current) observer.observe(slot.current);
    const modal = new MutationObserver(update);
    modal.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "open",
        "data-capturing",
        "data-inspector-mode",
        "data-inspector-width",
      ],
    });
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    const timer = setInterval(() => {
      update();
      void desktop
        .state()
        .then((next) => {
          if (!mounted.current || active.current !== id) return;
          if (next?.pageId === id) setPage(next);
          else {
            // Another workspace may have replaced the single native page.
            // A hidden application must not reclaim it in the background.
            active.current = null;
            openedFromIntent.current = false;
            setPage(null);
          }
        })
        .catch(() => {});
    }, 600);
    update();
    return () => {
      unregister();
      observer.disconnect();
      modal.disconnect();
      clearInterval(timer);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      void desktop.layout(id, null).catch(() => {});
    };
  }, [desktop, page?.pageId]);
  const pending = useRef(false);
  const openedFromIntent = useRef(false);
  async function start(address?: string) {
    if (!desktop || pending.current) return;
    pending.current = true;
    setOpening(true);
    try {
      setError("");
      const p = await desktop.open(
        artifact && !address
          ? artifact.id
          : {
              projectId: projectId ?? artifact!.projectId,
              url: normalizeAddress(address ?? url),
            },
      );
      if (!mounted.current) {
        await desktop.close(p.pageId);
        return;
      }
      active.current = p.pageId;
      setPage(p);
      setURL(p.url);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "打开失败。");
    } finally {
      pending.current = false;
      if (mounted.current) setOpening(false);
    }
  }
  useEffect(() => {
    if (
      activeView &&
      (autoOpen || !!initialURL) &&
      desktop &&
      !active.current &&
      !openedFromIntent.current
    ) {
      openedFromIntent.current = true;
      void start();
    }
  }, [autoOpen, desktop, activeView, page?.pageId]);
  async function control(
    action:
      | "grant"
      | "takeover"
      | "back"
      | "forward"
      | "reload"
      | "approve"
      | "reject",
  ) {
    if (!desktop || !page) return;
    try {
      setError("");
      setPage(await desktop.control(page.pageId, action));
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败。");
    }
  }
  return (
    <section className="browser-host">
      <div className="browser-toolbar">
        {onReturn && (
          <button
            className="application-return"
            aria-label="返回工作空间"
            title="返回工作空间，保留浏览位置"
            onClick={onReturn}
          >
            <ArrowLeft />
            <span>{returnLabel}</span>
          </button>
        )}
        <div className="browser-navigation" role="group" aria-label="网页导航">
          <button
            aria-label="网页后退"
            disabled={!page?.canGoBack}
            onClick={() => void control("back")}
          >
            <ChevronLeft />
          </button>
          <button
            aria-label="网页前进"
            disabled={!page?.canGoForward}
            onClick={() => void control("forward")}
          >
            <ChevronRight />
          </button>
          <button
            aria-label="重新载入网页"
            disabled={!page}
            onClick={() => void control("reload")}
          >
            <RotateCw />
          </button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!desktop || opening) return;
            try {
              setError("");
              if (page)
                setPage(
                  await desktop.navigate(page.pageId, normalizeAddress(url)),
                );
              else await start(url);
            } catch (err) {
              setError(err instanceof Error ? err.message : "地址无效。");
            }
          }}
        >
          <input
            aria-label="网站地址"
            autoFocus={!artifact}
            placeholder="输入网址"
            value={url}
            onChange={(e) => setURL(e.target.value)}
          />
        </form>
        {onSave && (
          <button
            aria-label="保存网页到内容"
            aria-pressed={!!page && savedURLs.includes(page.url)}
            title={
              page && savedURLs.includes(page.url)
                ? "已保存到内容"
                : "保存网页到内容"
            }
            disabled={!page || saving || savedURLs.includes(page.url)}
            onClick={async () => {
              if (!page) return;
              setSaving(true);
              try {
                await onSave(page.url, page.title);
              } catch (e) {
                setError(e instanceof Error ? e.message : "保存失败。");
              } finally {
                setSaving(false);
              }
            }}
          >
            <Bookmark />
          </button>
        )}
        <button
          className="browser-assistance"
          aria-label={page?.granted ? "我来接管" : "允许 Agent 协助"}
          disabled={!page}
          title="开启后允许读取、填写；点击操作仍需逐次确认"
          onClick={() => void control(page?.granted ? "takeover" : "grant")}
        >
          {page?.granted ? <Hand /> : <ShieldCheck />}
          <span>{page?.granted ? "我来接管" : "允许 Agent 协助"}</span>
        </button>
        {onInput && (
          <button
            aria-label="向 Morphz 输入"
            title="围绕当前网页输入 · ⌘J"
            onClick={onInput}
          >
            <MessageCircle />
          </button>
        )}
      </div>
      {!page ? (
        <div className="browser-start">
          <Globe size={30} />
          <p>
            {artifact?.content.kind === "website"
              ? artifact.content.url
              : "输入网址，开始浏览"}
          </p>
          <p className="muted">
            网站使用独立的浏览器配置。登录由你完成；开启协助后，Agent
            可读取和填写页面，点击需逐次确认。
          </p>
          {artifact && (
            <button
              className="primary"
              disabled={!desktop || opening}
              onClick={() => void start()}
            >
              {!desktop
                ? "请在桌面应用中打开网站"
                : opening
                  ? "打开中…"
                  : autoOpen
                    ? "重新打开网站"
                    : "打开网站"}
            </button>
          )}
          {!desktop && !artifact && <p>网页操作需要桌面应用。</p>}
        </div>
      ) : (
        <>
          {page.pending && (
            <div className="browser-confirm" role="status">
              <span>
                Agent 请求点击：
                <strong>{page.pending.label || "无名称元素"}</strong>
                。请核对页面及填写内容。
              </span>
              <button onClick={() => void control("reject")}>拒绝</button>
              <button
                className="primary"
                onClick={() => void control("approve")}
              >
                允许这次点击
              </button>
            </div>
          )}
          <div
            ref={slot}
            className="browser-slot"
            aria-label="隔离的网页区域"
          />
        </>
      )}
      {(error || page?.error) && (
        <p role="alert" className="form-error">
          {error || page?.error}
        </p>
      )}
    </section>
  );
}

function normalizeAddress(value: string) {
  const text = value.trim();
  if (!text) throw new Error("请输入网址。");
  return /^[a-z][a-z\d+.-]*:/i.test(text) && !/^localhost:\d+/i.test(text)
    ? text
    : `https://${text}`;
}
