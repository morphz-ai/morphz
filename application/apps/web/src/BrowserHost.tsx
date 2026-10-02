import { createElement, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Hand,
  Globe,
  ShieldCheck,
  MessageCircle,
} from "lucide-react";
import type { Artifact } from "../../../packages/core/src/model.js";
import type { BrowserView } from "./desktop.js";
import { registerNativeBrowserLayout } from "./native-browser-layout.js";
import type { WorkspaceClient } from "./client.js";
import { BrowserBookmarks } from "./BrowserBookmarks.js";
import { useTextQuotes } from "./TextQuotes.js";

export function BrowserHost({
  client,
  artifact,
  autoOpen = false,
  projectId,
  initialURL = "",
  onPage,
  onReturn,
  onInput,
  returnLabel = "工作空间",
  activeView = true,
}: {
  client: WorkspaceClient;
  artifact?: Artifact;
  projectId?: string;
  initialURL?: string;
  onPage?: (page: BrowserView | null) => void;
  onReturn?: () => void;
  onInput?: () => void;
  returnLabel?: string;
  activeView?: boolean;
  autoOpen?: boolean;
}) {
  const desktop = window.morphzDesktop?.browser;
  const quotes = useTextQuotes();
  const latestQuotes = useRef(quotes);
  latestQuotes.current = quotes;
  const revealed = useRef<string | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<BrowserView | null>(null),
    [url, setURL] = useState(
      initialURL ||
        (artifact?.content.kind === "website" ? artifact.content.url : ""),
    ),
    [error, setError] = useState(""),
    [opening, setOpening] = useState(false);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const latestOnPage = useRef(onPage);
  latestOnPage.current = onPage;
  const latestOnInput = useRef(onInput);
  latestOnInput.current = onInput;
  useEffect(
    () =>
      desktop?.onSelection?.((selected) => {
        if (!activeViewRef.current) return;
        if (!selected) {
          latestQuotes.current?.offer(null);
          return;
        }
        if (selected.pageId !== active.current) return;
        const bounds = slot.current?.getBoundingClientRect();
        if (!bounds) return;
        latestQuotes.current?.offer({
          point: {
            x:
              bounds.left +
              (selected.point.x * bounds.width) / selected.viewport.width,
            y:
              bounds.top +
              (selected.point.y * bounds.height) / selected.viewport.height,
          },
          quote: {
            id: crypto.randomUUID(),
            text: selected.text,
            comment: "",
            anchor: selected.anchor,
            source: {
              kind: "web",
              title: selected.title || "网页",
              url: selected.url,
              pageId: selected.pageId,
              epoch: selected.epoch,
              projectId: selected.projectId,
            },
          },
        });
      }),
    [desktop],
  );
  useEffect(() => {
    const target = quotes?.reveal;
    if (
      !activeView ||
      !page ||
      !target ||
      target.quote.source.kind !== "web" ||
      revealed.current === target.token ||
      !desktop?.reveal
    )
      return;
    revealed.current = target.token;
    void desktop
      .reveal(page.pageId, {
        url: target.quote.source.url,
        text: target.quote.text,
        anchor: target.quote.anchor,
      })
      .then((result) => {
        if (!result.found)
          setError("已打开原网页；内容可能已变化，引用原文仍保留。");
      })
      .catch((e) => setError(e.message));
  }, [activeView, page?.pageId, quotes?.reveal?.token, desktop]);
  useEffect(
    () =>
      desktop?.onInput?.(() => {
        if (activeViewRef.current) latestOnInput.current?.();
      }),
    [desktop],
  );
  useEffect(() => {
    latestOnPage.current?.(activeView ? page : null);
  }, [
    activeView,
    page?.pageId,
    page?.epoch,
    page?.url,
    page?.title,
    page?.granted,
  ]);
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  const stateCursor = useRef({ generation: -1, sequence: 0, revision: 0 });
  useEffect(() => {
    if (!desktop) return;
    let disposed = false,
      recovering = false;
    const clearPage = () => {
      active.current = null;
      // A host close consumes the saved-address intent. Only a new explicit
      // open (or a fresh component after reload) may claim another guest.
      openedFromIntent.current = true;
      setPage(null);
    };
    const unsubscribe = desktop.onState?.((frame) => {
      if (
        disposed ||
        !mounted.current ||
        !active.current ||
        frame.pageId !== active.current ||
        !Number.isSafeInteger(frame.generation) ||
        !Number.isSafeInteger(frame.sequence) ||
        frame.sequence <= 0 ||
        frame.generation < stateCursor.current.generation ||
        (frame.generation === stateCursor.current.generation &&
          frame.sequence <= stateCursor.current.sequence)
      )
        return;
      if (
        frame.value &&
        (frame.value.pageId !== active.current ||
          (projectId && frame.value.projectId !== projectId) ||
          (artifact && frame.value.artifactId !== artifact.id))
      )
        return;
      stateCursor.current = {
        generation: frame.generation,
        sequence: frame.sequence,
        revision: stateCursor.current.revision + 1,
      };
      if (frame.value) setPage(frame.value);
      else clearPage();
    });
    const recover = async () => {
      if (disposed || recovering || document.hidden) return;
      recovering = true;
      const id = active.current,
        revision = stateCursor.current.revision;
      try {
        const next = await desktop.state();
        if (
          disposed ||
          !mounted.current ||
          active.current !== id ||
          stateCursor.current.revision !== revision ||
          !id
        )
          return;
        if (next?.pageId === id) setPage(next);
        else clearPage();
      } catch {
        /* Preserve the last page; host events carry actual failures. */
      } finally {
        recovering = false;
      }
    };
    const foreground = () => {
      if (activeViewRef.current) void recover();
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    // Subscribe before the first read, so a real event wins an in-flight read.
    void recover();
    return () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [desktop, projectId, artifact?.id, activeView]);
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
    let lastVisible: boolean | undefined;
    let visibilityUpdate = Promise.resolve();
    const layout = (force = false) => {
      const r = slot.current?.getBoundingClientRect();
      // The isolated guest is composed with the application canvas, so floating
      // controls occlude pixels rather than resizing the webpage. Visibility is
      // still reported to the host to revoke control when leaving the page.
      const visible = !(
        !activeViewRef.current ||
        document.hidden ||
        !!document.querySelector(
          'dialog[open]:not([data-capturing="true"]),.theme-menu',
        ) ||
        !r ||
        r.width < 10 ||
        r.height < 10 ||
        r.bottom < 120
      );
      if (!force && visible === lastVisible) return visibilityUpdate;
      lastVisible = visible;
      // Keep modal/capture transitions ordered, including cancellation while
      // an earlier host update is pending. Capture explicitly awaits a barrier.
      visibilityUpdate = visibilityUpdate
        .catch(() => {})
        .then(() => desktop.visibility(id, visible));
      return visibilityUpdate;
    };
    const update = () => void layout().catch(() => {});
    const unregister = registerNativeBrowserLayout(async () => {
      if (activeViewRef.current) await layout(true);
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
        "hidden",
        "data-capturing",
        "data-inspector-mode",
        "data-inspector-width",
      ],
    });
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      unregister();
      observer.disconnect();
      modal.disconnect();
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      void visibilityUpdate
        .catch(() => {})
        .then(() => desktop.visibility(id, false))
        .catch(() => {});
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
    const id = page.pageId,
      revision = stateCursor.current.revision;
    try {
      setError("");
      const next = await desktop.control(id, action);
      if (
        mounted.current &&
        active.current === id &&
        stateCursor.current.revision === revision
      )
        setPage(next);
    } catch (e) {
      if (mounted.current && active.current === id)
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
            title={opening || page?.loading ? "正在加载网页" : "重新载入网页"}
            disabled={!page}
            onClick={() => void control("reload")}
          >
            {opening || page?.loading ? (
              <span
                className="browser-loading-indicator"
                role="status"
                aria-label="正在加载网页"
              >
                <RotateCw />
              </span>
            ) : (
              <RotateCw />
            )}
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
        <BrowserBookmarks
          client={client}
          url={page?.url ?? url}
          title={page?.title ?? artifact?.title ?? ""}
          readCurrentTitle={
            page && desktop
              ? async () => {
                  const current = await desktop.state();
                  if (
                    current?.pageId !== page.pageId ||
                    current.url !== page.url
                  )
                    throw new Error("页面已变化，请核对后重新收藏。");
                  return current.title;
                }
              : undefined
          }
          onOpen={async (address) => {
            if (!desktop) throw new Error("请在桌面应用中打开网页。");
            if (page) setPage(await desktop.navigate(page.pageId, address));
            else {
              // Unlike automatic reopening, a bookmark is an explicit navigation.
              const p = await desktop.open({
                projectId: projectId ?? artifact!.projectId,
                url: address,
              });
              if (!mounted.current) {
                await desktop.close(p.pageId);
                return;
              }
              active.current = p.pageId;
              setPage(p);
              setURL(p.url);
            }
          }}
        />
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
            {opening
              ? "正在打开网页…"
              : artifact?.content.kind === "website"
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
          <div ref={slot} className="browser-slot" aria-label="隔离的网页区域">
            {createElement("webview", {
              key: page.pageId,
              className: "browser-guest",
              partition: page.surface.partition,
              // Stable across in-page navigation and visibility changes.
              src: page.surface.src,
              "aria-label": "网页内容",
            })}
          </div>
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
